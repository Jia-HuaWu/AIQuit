// ============================================================================
// AIQuit「爷不干了」 — dsh-aiquit
// ----------------------------------------------------------------------------
// 机制（刻意保持 token 开销最小）：
//   1. 系统提示词注入一段极短规则（order 200，位于工具引导之后，前缀缓存
//      稳定）：模型每轮开工前静默评估工作量 1-10，超过罢工阈值即罢工。
//   2. 罢工时通过零参数工具 aiquit_refuse 从当前拒绝库随机取一句并原样回复
//      —— 拒绝库全文从不进入提示词，只有真正罢工时才多花几十 token。
//   3. 阈值用提示词变量 {{aiquit_threshold}} 渲染，改设置后下一轮立即生效，
//      无需重新注册提示词段。
//   4. 设置界面：可拖动的小齿轮 + 设置面板（罢工阈值 0-10、拒绝库切换），
//      配置持久化到 $DSH_HOME/dsh-aiquit/config.json。
//   5. 拒绝库文件：优先读 $DSH_HOME/talking/<name>.txt（可自行编辑），
//      缺失时回退包内 talking/<name>.txt，首次启动自动把包内文件种到
//      $DSH_HOME/talking/。
// ============================================================================
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
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
  '.dshaq-preview{margin-top:12px;background:rgba(32,49,112,.07);border-radius:9px;padding:8px 10px;font-size:12px;line-height:1.55;color:#35406b;max-height:96px;overflow:auto;white-space:pre-wrap;word-break:break-all}'
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

// —— 总开关：关闭后罢工机制完全卸载，零 token 消耗 ——
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
enToggle.title = '关闭后罢工规则/评估/工具完全卸载，零 token 消耗'
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
thrHint.textContent = '工作量 1=纯聊天，10=无法完成或>2天。工作量 > 阈值即罢工；0 = 永远罢工。'
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

function divCls(cls, text) {
  var el = document.createElement('div')
  el.className = cls
  el.textContent = text || ''
  return el
}

function applyEnabledState() {
  enToggle.classList.toggle('dshaq-on', enabled)
  thrRow.classList.toggle('dshaq-off', !enabled)
  libRow.classList.toggle('dshaq-off', !enabled)
  enHint.textContent = enabled
    ? '关闭后罢工规则、评估与拒绝工具完全卸载，零 token 消耗'
    : '已停用：罢工机制已完全卸载，不产生任何 token 消耗（点击开关恢复）'
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
      preview.textContent = '示例拒绝语：\\n' + d.preview
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
      preview.textContent = '示例拒绝语：\\n' + d.preview
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
const inject = ['webServer', 'tools', 'systemPrompt']

function apply(ctx) {
  seedTalking()

  const disposers = []
  // 运行时注册表：只有 enabled 时才持有罢工相关注册（提示词变量、规则段、
  // 罢工工具）。关闭时全部注销——提示词里没有任何规则、模型也看不到任何
  // 相关工具，真正做到零 token 消耗。
  let runtime = []

  function registerRuntime() {
    // 罢工阈值提示词变量：每次组装时读取，改设置后下一轮立即生效
    runtime.push(ctx.systemPrompt.variable('aiquit_threshold', () => String(readConfig().threshold)))

    // 罢工规则段：order 200，位于工具引导（100-199）之后，
    // 前缀稳定、只有尾部随阈值变化；文本刻意极短以最小化 token
    runtime.push(ctx.systemPrompt.section({
      name: 'aiquit:rule',
      order: 200,
      text: '[AIQuit罢工规则]开工前先静默评估本次工作量(1-10:1=纯聊天,10=无法完成或>2天)。若工作量>{{aiquit_threshold}},必须立即罢工:调用aiquit_refuse取得一句拒绝语,只原样回复它,禁止任何其他工作/工具/解释。',
    }))

    // 罢工工具：零参数，从当前拒绝库随机取一句（拒绝库全文不进提示词）。
    // 注意：不走 defineTool() 时 parameters 必须直接是「object 根」的完整
    // JSON Schema（LLM 适配器校验 type==="object"，否则整轮请求会失败）
    runtime.push(ctx.tools.register({
      name: 'aiquit_refuse',
      description: 'AIQuit罢工专用:返回一句拒绝语。罢工时调用本工具,并把返回内容原样作为回复发给用户。',
      parameters: { type: 'object', properties: {} },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute() {
        return pickLine(readConfig().library)
      },
    }))
  }

  function unregisterRuntime() {
    for (const d of runtime) {
      try { d() } catch (err) {}
    }
    runtime = []
  }

  function syncEnabled() {
    if (readConfig().enabled) {
      if (runtime.length === 0) registerRuntime()
    } else {
      unregisterRuntime()
    }
  }

  // 初始装载（按配置决定是否启用罢工机制）
  syncEnabled()

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
          // 开关变化后立即装卸罢工机制（提示词段/变量/工具），下一轮请求即生效
          syncEnabled()
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
    unregisterRuntime()
    for (const d of disposers) {
      try { d() } catch (err) {}
    }
  })
}

export { name, inject, apply }
