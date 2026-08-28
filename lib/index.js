// ============================================================================
// AIQuit「爷不干了」 — dsh-aiquit
// ----------------------------------------------------------------------------
// 机制（程序化裁决，不再依赖提示词自律，token 开销最小）：
//
//   每轮用户指令的流程（在 agent/pre-step waterfall 中实现，位于模型请求
//   之前）：
//     用户发出指令
//       → 插件已启用？
//          否 → 直接放行（零消耗）
//       → 罢工阈值 = 0？
//          是 → 跳过一切 LLM 调用，直接随机取拒绝语回复并拒绝该轮
//       → 否 → 程序发一次「只评估」的迷你请求（不带历史、max_tokens=8，
//             deepseek-chat），让 AI 只打分 1-10 并返回给程序
//       → 分数 > 阈值 → 程序把用户消息与拒绝语写入会话并拒绝该轮
//       → 分数 ≤ 阈值（或评估失败）→ 放行，让 AI 正常工作
//
//   拒绝时向会话写入与正常轮次一致的完整事件流（不调用主模型）：
//     step/start → user/message → assistant/message(拒绝语) → step/end
//   （携带与 loop 一致的 turn/step 坐标），随后首步返回 {kind:'enter',
//   messages: []} 让 loop 以 completed 干净收尾，轮次中途返回 {kind:'reject'}
//   以 blocked 收尾——两者均不触发模型请求。
//   ⚠ 注意：assistant/message 若缺失 turn/step 坐标或 step/start 包裹，
//   Web UI 的对话组装器（ConversationNodeAssembler）会对 undefined turn
//   抛错，导致整个会话视图崩溃且拒绝语/用户消息均无法显示。
//
//   每一轮（每次用户消息）都执行该流程；只拦截真实用户输入
//   （source.kind === 'user' 且根 agent），系统/插件/goal/子代理注入不拦截。
//
//   设置界面：可拖动小齿轮 + 面板（总开关 / 罢工阈值 0-10 / 拒绝库切换），
//   配置持久化到 $DSH_HOME/dsh-aiquit/config.json。
//   拒绝库：优先 $DSH_HOME/talking/<name>.txt（可自行编辑），缺失回退包内
//   talking/<name>.txt，首次启动自动把包内文件种到 $DSH_HOME/talking/。
// ============================================================================
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const CONFIG_FILE = path.join(DSH_HOME, 'dsh-aiquit', 'config.json')
const TALKING_DIRS = [
  path.join(DSH_HOME, 'talking'),
  path.join(PACKAGE_ROOT, 'talking'),
]

// 回答拒绝库：id -> 文件名（位于 talking 文件夹下）
const LIBRARIES = { baozao: 'baozao.txt', luoli: 'luoli.txt' }
const LIBRARY_NAMES = { baozao: '暴躁老哥', luoli: '软萌萝莉' }

const DEFAULT_CONFIG = { enabled: true, threshold: 5, library: 'baozao' }
const FALLBACK_LINE = '不干了，爷罢工！'

// 工作量评估：一次独立的小请求（不带历史），只返回 1-10 的整数
const EVAL_API = 'https://api.deepseek.com/chat/completions'
const EVAL_MODEL = 'deepseek-chat'
const EVAL_TIMEOUT_MS = 15000
const EVAL_MAX_TEXT = 4000
const EVAL_MAX_TOKENS = 16
// 打分锚点必须具体，且对「编写/重写/构建软件」类请求从严（默认按其中
// 最大的工作量理解）——否则模型会倾向给中等偏低分，导致重活被放行。
const EVAL_SYSTEM =
  '你是严格的软件工程工作量评估器。评估用户请求的工作量,只输出一个整数1-10。' +
  '锚点:1-2=纯聊天、闲聊、简单问答或解释概念,几分钟内可完成;' +
  '3-4=单一小任务(写一个函数、一段文案、单个小改动),半小时内可完成;' +
  '5-6=中等任务(完整小功能、小工具、多文件小改动),需要数小时;' +
  '7-8=大型任务(完整功能模块、中等规模项目、需要联网调研并编写大量代码);' +
  '9-10=重写或构建大型软件项目/完整系统,或耗时超过2天,甚至根本无法完成。' +
  '对编写、重写、构建、开发软件/系统/项目的请求,一律按其中最大的工作量理解,' +
  '任务规模不确定时按更重的解释评分;只有纯聊天性质的请求才给低分。' +
  '只输出数字,不要任何其他字符。'

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': '*',
}

// ---------------------------------------------------------------------------
// 配置读写
// ---------------------------------------------------------------------------
function normalizeConfig(raw) {
  const t = Number(raw && raw.threshold)
  const threshold = Number.isInteger(t) && t >= 0 && t <= 10 ? t : DEFAULT_CONFIG.threshold
  const library = raw && raw.library === 'luoli' ? 'luoli' : 'baozao'
  const enabled = !(raw && raw.enabled === false)
  return { enabled, threshold, library }
}

function readConfig() {
  try {
    return normalizeConfig(JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')))
  } catch (err) {
    return { ...DEFAULT_CONFIG }
  }
}

function writeConfig(cfg) {
  const body = JSON.stringify({ ...normalizeConfig(cfg), updatedAt: new Date().toISOString() })
  try {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true })
    fs.writeFileSync(CONFIG_FILE, body, 'utf8')
    return true
  } catch (err) {
    return false
  }
}

// ---------------------------------------------------------------------------
// 拒绝库
// ---------------------------------------------------------------------------
function libPath(name) {
  const file = LIBRARIES[name] || LIBRARIES.baozao
  for (const dir of TALKING_DIRS) {
    const p = path.join(dir, file)
    try {
      if (fs.statSync(p).isFile()) return p
    } catch (err) {}
  }
  return null
}

function loadLines(name) {
  const p = libPath(name)
  if (!p) return []
  try {
    return fs
      .readFileSync(p, 'utf8')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
  } catch (err) {
    return []
  }
}

function pickLine(name) {
  const lines = loadLines(name)
  if (lines.length === 0) return FALLBACK_LINE
  return lines[Math.floor(Math.random() * lines.length)]
}

// 首次启动：把包内 talking/*.txt 种到 $DSH_HOME/talking/（用户可自由编辑，
// DSH home 版本优先于包内版本）
function seedTalking() {
  const dst = path.join(DSH_HOME, 'talking')
  try {
    fs.mkdirSync(dst, { recursive: true })
  } catch (err) {
    return
  }
  for (const file of Object.values(LIBRARIES)) {
    const target = path.join(dst, file)
    try {
      if (fs.existsSync(target)) continue
    } catch (err) {}
    try {
      fs.copyFileSync(path.join(PACKAGE_ROOT, 'talking', file), target)
    } catch (err) {}
  }
}

// ---------------------------------------------------------------------------
// 工作量评估（程序化裁决）
// ---------------------------------------------------------------------------
// 最近一次评估结果（内存态，供设置面板展示）
let lastEval = null // { score, at, action: 'strike' | 'pass' }

async function evaluateWorkload(ctx, text) {
  let cred
  try {
    cred = await ctx.credentials.resolve('DEEPSEEK_API_KEY')
  } catch (err) {
    return null
  }
  if (!cred || !cred.value) return null
  try {
    const res = await fetch(EVAL_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + cred.value,
      },
      body: JSON.stringify({
        model: EVAL_MODEL,
        messages: [
          { role: 'system', content: EVAL_SYSTEM },
          { role: 'user', content: text },
        ],
        max_tokens: EVAL_MAX_TOKENS,
        temperature: 0,
        stream: false,
      }),
      signal: AbortSignal.timeout(EVAL_TIMEOUT_MS),
    })
    if (!res.ok) return null
    const data = await res.json()
    const content = String(
      (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || ''
    ).trim()
    const m = content.match(/\b([1-9]|10)\b/)
    return m ? Number(m[1]) : null
  } catch (err) {
    return null
  }
}

function messageText(m) {
  return (Array.isArray(m.content) ? m.content : [])
    .filter((b) => b && b.type === 'text')
    .map((b) => b.text)
    .join('\n')
}

// 拒绝该轮：构造与正常轮次一致的事件流（不调用主模型）——
// turn/start 已由 loop 写入；这里按 loop 的相同顺序追加：
//   step/start → user/message → assistant/message(拒绝语) → step/end
// assistant/message 必须携带 turn/step 且被 step/start 包裹，UI 才会渲染。
// 若 turn/step 坐标缺失或写入失败，返回 false，调用方 fail-open 放行
// （避免再次向会话写入畸形事件导致 Web 会话视图崩溃）。
function refuseTurn(agent, messages, line, turn, step) {
  if (!Number.isSafeInteger(turn) || turn < 0 || !Number.isSafeInteger(step) || step < 0) return false
  const session = agent && agent.session
  if (!session) return false
  try {
    session.append('step/start', { turn, step })
    for (const m of messages) {
      session.append('user/message', m, { surfaceOp: 'append' })
    }
    session.append(
      'assistant/message',
      {
        turn,
        step,
        message: {
          id: 'aiquit-' + randomUUID(),
          role: 'assistant',
          content: [{ type: 'text', text: line }],
          source: {
            kind: 'model',
            provider: (agent.options && agent.options.provider) || 'deepseek',
            model: (agent.options && agent.options.model) || EVAL_MODEL,
          },
        },
      },
      { surfaceOp: 'append' }
    )
    session.append('step/end', { turn, step })
    return true
  } catch (err) {
    try { console.error('[dsh-aiquit] refuseTurn append failed:', err) } catch {}
    return false
  }
}

// ---------------------------------------------------------------------------
// 客户端（设置界面）脚本：可拖动齿轮 + 设置面板，零依赖、紧凑实现
// ---------------------------------------------------------------------------
const WIDGET_JS = `(function () {
if (window.__dshAiquit) return
window.__dshAiquit = true

var CFG_URL = '/dsh-aiquit/config.json'
var POS_KEY = 'dsh-aiquit-pos'
var GEAR_SZ = 42

var css = [
  '.dshaq-root{position:fixed;z-index:2147483000;font-family:system-ui,"Microsoft YaHei",sans-serif;user-select:none;-webkit-user-select:none}',
  '.dshaq-gear{width:' + GEAR_SZ + 'px;height:' + GEAR_SZ + 'px;display:flex;align-items:center;justify-content:center;cursor:grab;border-radius:50%;background:rgba(32,49,112,.1);border:1px solid rgba(32,49,112,.3);color:#203170;box-shadow:0 2px 10px rgba(0,0,0,.15);transition:background .15s,transform .15s}',
  '.dshaq-gear:hover{background:rgba(32,49,112,.2)}',
  '.dshaq-gear.dshaq-drag{cursor:grabbing;transform:scale(1.08)}',
  '.dshaq-gear svg{width:26px;height:26px;pointer-events:none}',
  '.dshaq-panel{position:absolute;right:0;bottom:calc(100% + 12px);width:300px;background:rgba(255,255,255,.97);border:1px solid rgba(32,49,112,.3);border-radius:12px;box-shadow:0 8px 28px rgba(0,0,0,.2);padding:14px;display:none;color:#203170}',
  '.dshaq-panel.dshaq-open{display:block}',
  '.dshaq-title{font-size:14px;font-weight:800;margin-bottom:12px;display:flex;justify-content:space-between;align-items:center}',
  '.dshaq-sub{color:#8a97bd;font-weight:600;font-size:12px}',
  '.dshaq-close{cursor:pointer;border:none;background:none;color:#203170;font-size:15px;padding:0 4px;line-height:1}',
  '.dshaq-enline{display:flex;justify-content:space-between;align-items:center}',
  '.dshaq-toggle{display:inline-flex;flex:0 0 auto;width:40px;height:22px;border-radius:11px;background:rgba(32,49,112,.25);cursor:pointer;position:relative;transition:background .15s}',
  '.dshaq-toggle.dshaq-on{background:#2fa24c}',
  '.dshaq-toggle .dshaq-knob{position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:#fff;transition:left .15s;box-shadow:0 1px 3px rgba(0,0,0,.25)}',
  '.dshaq-toggle.dshaq-on .dshaq-knob{left:20px}',
  '.dshaq-row.dshaq-off{opacity:.45;pointer-events:none}',
  '.dshaq-row{margin:10px 0}',
  '.dshaq-label{font-size:12px;font-weight:700;margin-bottom:4px}',
  '.dshaq-hint{font-size:11px;color:#8a97bd;margin-top:3px;line-height:1.4}',
  '.dshaq-thr{display:flex;align-items:center;gap:8px}',
  '.dshaq-range{flex:1;min-width:0;accent-color:#203170;cursor:pointer}',
  '.dshaq-num{font-weight:800;font-size:17px;min-width:26px;text-align:right}',
  '.dshaq-libs{display:flex;gap:8px}',
  '.dshaq-lib{flex:1;border:1px solid rgba(32,49,112,.35);border-radius:9px;padding:8px 4px;text-align:center;cursor:pointer;font-size:12px;font-weight:700;background:#fff}',
  '.dshaq-lib:hover{background:rgba(32,49,112,.06)}',
  '.dshaq-lib.dshaq-sel{background:rgba(32,49,112,.14);border-color:#203170}',
  '.dshaq-lib small{display:block;color:#8a97bd;font-weight:400;margin-top:2px}',
  '.dshaq-preview{margin-top:12px;background:rgba(32,49,112,.07);border-radius:9px;padding:8px 10px;font-size:12px;line-height:1.55;color:#35406b;max-height:110px;overflow:auto;white-space:pre-wrap;word-break:break-all}'
].join('\\n')

var styleEl = document.createElement('style')
styleEl.textContent = css
document.head.appendChild(styleEl)

var root = document.createElement('div')
root.className = 'dshaq-root'

var gear = document.createElement('div')
gear.className = 'dshaq-gear'
gear.title = 'AIQuit · 爷不干了（点击打开设置）'
gear.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M19.14 12.94c.04-.3.06-.61.06-.94s-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>'

var panel = document.createElement('div')
panel.className = 'dshaq-panel'

var title = document.createElement('div')
title.className = 'dshaq-title'
var titleText = document.createElement('span')
titleText.innerHTML = 'AIQuit <span class="dshaq-sub">爷不干了</span>'
var closeBtn = document.createElement('button')
closeBtn.type = 'button'
closeBtn.className = 'dshaq-close'
closeBtn.textContent = '✕'
closeBtn.title = '关闭'
closeBtn.addEventListener('click', closePanel)
title.appendChild(titleText)
title.appendChild(closeBtn)
panel.appendChild(title)

// —— 总开关：关闭后不评估、不拦截，零 token 消耗 ——
var enRow = document.createElement('div')
enRow.className = 'dshaq-row'
var enLine = document.createElement('div')
enLine.className = 'dshaq-enline'
var enLabel = document.createElement('div')
enLabel.className = 'dshaq-label'
enLabel.style.marginBottom = '0'
enLabel.textContent = '启用 AIQuit'
var enToggle = document.createElement('div')
enToggle.className = 'dshaq-toggle'
enToggle.title = '关闭后不评估、不拦截，零 token 消耗'
var enKnob = document.createElement('div')
enKnob.className = 'dshaq-knob'
enToggle.appendChild(enKnob)
enLine.appendChild(enLabel)
enLine.appendChild(enToggle)
var enHint = document.createElement('div')
enHint.className = 'dshaq-hint'
enRow.appendChild(enLine)
enRow.appendChild(enHint)
panel.appendChild(enRow)

var thrRow = document.createElement('div')
thrRow.className = 'dshaq-row'
var thrLabel = document.createElement('div')
thrLabel.className = 'dshaq-label'
thrLabel.textContent = '罢工阈值'
var thrInner = document.createElement('div')
thrInner.className = 'dshaq-thr'
var thrRange = document.createElement('input')
thrRange.type = 'range'
thrRange.min = '0'
thrRange.max = '10'
thrRange.step = '1'
thrRange.className = 'dshaq-range'
var thrNum = document.createElement('span')
thrNum.className = 'dshaq-num'
thrInner.appendChild(thrRange)
thrInner.appendChild(thrNum)
var thrHint = document.createElement('div')
thrHint.className = 'dshaq-hint'
thrHint.textContent = '每轮先让AI评估工作量(1=纯聊天,10=无法完成或>2天),超阈值即拒绝;0=跳过评估直接拒绝。'
thrRow.appendChild(thrLabel)
thrRow.appendChild(thrInner)
thrRow.appendChild(thrHint)
panel.appendChild(thrRow)

var libRow = document.createElement('div')
libRow.className = 'dshaq-row'
var libLabel = document.createElement('div')
libLabel.className = 'dshaq-label'
libLabel.textContent = '回答拒绝库'
var libs = document.createElement('div')
libs.className = 'dshaq-libs'
libRow.appendChild(libLabel)
libRow.appendChild(libs)
panel.appendChild(libRow)

var preview = document.createElement('div')
preview.className = 'dshaq-preview'
panel.appendChild(preview)

root.appendChild(gear)
root.appendChild(panel)
document.body.appendChild(root)

var cfg = null
var curLib = 'baozao'
var enabled = true

function applyEnabledState() {
  enToggle.classList.toggle('dshaq-on', enabled)
  thrRow.classList.toggle('dshaq-off', !enabled)
  libRow.classList.toggle('dshaq-off', !enabled)
  enHint.textContent = enabled
    ? '关闭后不评估、不拦截，零 token 消耗'
    : '已停用：每轮直接放行，不产生任何 token 消耗（点击开关恢复）'
  gear.style.opacity = enabled ? '' : '0.55'
  gear.title = enabled
    ? 'AIQuit · 爷不干了（点击打开设置）'
    : 'AIQuit 已停用（点击打开设置）'
}

enToggle.addEventListener('click', function () {
  enabled = !enabled
  applyEnabledState()
  saveCfg({ enabled: enabled })
})

function renderLibs() {
  libs.innerHTML = ''
  var order = ['baozao', 'luoli']
  for (var i = 0; i < order.length; i++) {
    var id = order[i]
    var meta = cfg && cfg.libraries && cfg.libraries[id] ? cfg.libraries[id] : null
    var b = document.createElement('div')
    b.className = 'dshaq-lib' + (curLib === id ? ' dshaq-sel' : '')
    var nm = document.createElement('span')
    nm.textContent = id === 'baozao' ? '暴躁老哥' : '软萌萝莉'
    var file = document.createElement('small')
    file.textContent = 'talking/' + (id === 'baozao' ? 'baozao.txt' : 'luoli.txt') + (meta ? ' · ' + meta.count + ' 条' : '')
    b.appendChild(nm)
    b.appendChild(file)
    ;(function (lid) {
      b.addEventListener('click', function () {
        if (lid === curLib) return
        saveCfg({ library: lid })
      })
    })(id)
    libs.appendChild(b)
  }
}

function renderPreview(d) {
  var lines = []
  if (d && d.lastEval) {
    lines.push('最近评估：' + d.lastEval.score + '/10 · ' + (d.lastEval.action === 'strike' ? '已罢工' : '已放行'))
  }
  lines.push('示例拒绝语：')
  lines.push(d && d.preview ? d.preview : '')
  preview.textContent = lines.join('\\n')
}

function openPanel() {
  panel.classList.add('dshaq-open')
  loadCfg()
}

function closePanel() {
  panel.classList.remove('dshaq-open')
}

function togglePanel() {
  if (panel.classList.contains('dshaq-open')) closePanel()
  else openPanel()
}

function loadCfg() {
  fetch(CFG_URL, { cache: 'no-store' })
    .then(function (r) { return r.json() })
    .then(function (d) {
      if (!d || !d.ok) return
      cfg = d
      enabled = d.enabled !== false
      curLib = d.library
      thrRange.value = String(d.threshold)
      thrNum.textContent = String(d.threshold)
      applyEnabledState()
      renderLibs()
      renderPreview(d)
    })
    .catch(function () {})
}

function saveCfg(patch) {
  fetch(CFG_URL, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch)
  })
    .then(function (r) { return r.json() })
    .then(function (d) {
      if (!d || !d.ok) return
      cfg = d
      enabled = d.enabled !== false
      curLib = d.library
      thrRange.value = String(d.threshold)
      thrNum.textContent = String(d.threshold)
      applyEnabledState()
      renderLibs()
      renderPreview(d)
    })
    .catch(function () {})
}

thrRange.addEventListener('input', function () {
  thrNum.textContent = thrRange.value
})
thrRange.addEventListener('change', function () {
  saveCfg({ threshold: Number(thrRange.value) })
})

// —— 拖动齿轮 ——
var drag = null
function onDown(e) {
  if (e.button !== 0 && e.pointerType === 'mouse') return
  try { e.preventDefault() } catch (err) {}
  drag = { sx: e.clientX, sy: e.clientY, lx: root.offsetLeft, ty: root.offsetTop, moved: false }
  gear.classList.add('dshaq-drag')
  try { gear.setPointerCapture(e.pointerId) } catch (err) {}
}
function onMove(e) {
  if (!drag) return
  var dx = e.clientX - drag.sx
  var dy = e.clientY - drag.sy
  if (dx * dx + dy * dy >= 9) drag.moved = true
  if (drag.moved) {
    var vw = window.innerWidth || document.documentElement.clientWidth || 1280
    var vh = window.innerHeight || document.documentElement.clientHeight || 800
    root.style.left = Math.min(Math.max(0, drag.lx + dx), Math.max(0, vw - GEAR_SZ)) + 'px'
    root.style.top = Math.min(Math.max(0, drag.ty + dy), Math.max(0, vh - GEAR_SZ)) + 'px'
  }
}
function onUp() {
  if (!drag) return
  var wasMove = drag.moved
  drag = null
  gear.classList.remove('dshaq-drag')
  if (wasMove) {
    try { localStorage.setItem(POS_KEY, JSON.stringify([root.offsetLeft, root.offsetTop])) } catch (err) {}
  } else {
    togglePanel()
  }
}
gear.addEventListener('pointerdown', onDown)
gear.addEventListener('pointermove', onMove)
gear.addEventListener('pointerup', onUp)
gear.addEventListener('pointercancel', onUp)

document.addEventListener('pointerdown', function (e) {
  if (!panel.classList.contains('dshaq-open')) return
  if (root.contains(e.target)) return
  closePanel()
})

// —— 初始位置：记忆优先，默认右侧、略高于底部（避开右下角挂件） ——
var pos = null
try { pos = JSON.parse(localStorage.getItem(POS_KEY) || 'null') } catch (err) {}
var vw = window.innerWidth || document.documentElement.clientWidth || 1280
var vh = window.innerHeight || document.documentElement.clientHeight || 800
var gx = pos && Array.isArray(pos) ? pos[0] : Math.max(0, vw - GEAR_SZ - 18)
var gy = pos && Array.isArray(pos) ? pos[1] : Math.max(0, vh - GEAR_SZ - 320)
root.style.left = Math.min(gx, Math.max(0, vw - GEAR_SZ)) + 'px'
root.style.top = Math.min(gy, Math.max(0, vh - GEAR_SZ)) + 'px'
})()`

// ---------------------------------------------------------------------------
// 插件主体
// ---------------------------------------------------------------------------
const name = 'dsh-aiquit'
const inject = ['webServer', 'credentials']

function apply(ctx) {
  seedTalking()

  const disposers = []

  // —— 每轮用户指令的程序化裁决（agent/pre-step waterfall，位于模型请求之前）——
  // 监听器返回 { kind: 'reject' } 且不调用 next() 即否决该步骤（含内置行为），
  // 模型零调用；放行时 return next() 继续整条链。
  disposers.push(ctx.on('agent/pre-step', async (payload, next) => {
    try {
      const cfg = readConfig()
      if (!cfg.enabled) return next()
      const agent = payload && payload.agent
      const messages = payload && Array.isArray(payload.messages) ? payload.messages : []
      if (messages.length === 0) return next()

      // 只评估真实用户输入（source.kind === 'user'）；
      // 系统/插件/goal/子代理注入直接放行
      const userMsgs = messages.filter((m) => m && m.source && m.source.kind === 'user')
      if (userMsgs.length === 0) return next()

      // 只拦截根 agent（不拦截子代理 spawn/fork）
      const header = agent && agent.session && agent.session.header
      if (header && header.parentSession !== undefined) return next()

      const text = userMsgs.map(messageText).join('\n').trim().slice(0, EVAL_MAX_TEXT)
      if (text.length === 0) return next()

      const turn = payload.turn
      const step = payload.step
      // 轮次首步（step===1）：拒绝后返回 enter+[] 让 loop 以 completed 干净收尾，
      // 事件流与正常轮次一致（UI 完整渲染）；轮次中途（steer）用 reject → blocked
      const endTurnCleanly = step === 1

      if (cfg.threshold <= 0) {
        // 阈值 0：跳过一切 LLM 调用，直接拒绝（零消耗）
        lastEval = { score: 10, at: Date.now(), action: 'strike' }
        if (!refuseTurn(agent, messages, pickLine(cfg.library), turn, step)) return next()
        return endTurnCleanly ? { kind: 'enter', messages: [] } : { kind: 'reject' }
      }

      // 让 AI 只评估工作量（不带历史的小请求），返回分数给程序判定
      const score = await evaluateWorkload(ctx, text)
      if (score === null) {
        // 评估失败：放行（fail-open，不阻断正常对话），但记录日志便于排查
        try { console.error('[dsh-aiquit] workload evaluation failed; allowing turn') } catch {}
        return next()
      }
      if (score <= cfg.threshold) {
        lastEval = { score, at: Date.now(), action: 'pass' }
        return next()
      }
      lastEval = { score, at: Date.now(), action: 'strike' }
      if (!refuseTurn(agent, messages, pickLine(cfg.library), turn, step)) return next()
      return endTurnCleanly ? { kind: 'enter', messages: [] } : { kind: 'reject' }
    } catch (err) {
      // 任何异常放行，避免阻塞对话
      try { console.error('[dsh-aiquit] pre-step error:', err) } catch {}
      return next()
    }
  }))

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      req.on('data', (c) => {
        size += c.length
        if (size > 4096) {
          reject(new Error('body too large'))
          req.destroy()
          return
        }
        chunks.push(c)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })
  }

  function configPayload() {
    const cfg = readConfig()
    const libraries = {}
    for (const id of Object.keys(LIBRARIES)) {
      libraries[id] = { count: loadLines(id).length }
    }
    return {
      ok: true,
      enabled: cfg.enabled,
      threshold: cfg.threshold,
      library: cfg.library,
      libraries,
      preview: pickLine(cfg.library),
      lastEval: lastEval ? { score: lastEval.score, action: lastEval.action, at: lastEval.at } : null,
    }
  }

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-aiquit/widget.js',
    handler: (req, res) => {
      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
      })
      res.end(WIDGET_JS)
    },
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-aiquit/config.json',
    handler: async (req, res) => {
      try {
        if (req.method === 'PUT' || req.method === 'POST') {
          const body = await readBody(req)
          const parsed = JSON.parse(body)
          const cur = readConfig()
          const next = normalizeConfig({
            enabled: parsed.enabled !== undefined ? parsed.enabled : cur.enabled,
            threshold: parsed.threshold !== undefined ? parsed.threshold : cur.threshold,
            library: parsed.library !== undefined ? parsed.library : cur.library,
          })
          if (!writeConfig(next)) {
            res.writeHead(500, JSON_HEADERS)
            res.end(JSON.stringify({ ok: false, error: '无法持久化配置' }))
            return
          }
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify(configPayload()))
          return
        }
        res.writeHead(200, JSON_HEADERS)
        res.end(JSON.stringify(configPayload()))
      } catch (err) {
        res.writeHead(400, JSON_HEADERS)
        res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err) }))
      }
    },
  }))

  disposers.push(ctx.webServer.tapIndex((html) => {
    if (html.indexOf('/dsh-aiquit/widget.js') !== -1) return html
    const tag = '<script defer src="/dsh-aiquit/widget.js"></script>'
    if (html.indexOf('</body>') !== -1) return html.replace('</body>', tag + '</body>')
    return html + tag
  }))

  ctx.effect(() => () => {
    for (const d of disposers) {
      try { d() } catch (err) {}
    }
  })
}

export { name, inject, apply }
