#!/usr/bin/env node
// ============================================================================
// AIQuit 受损会话清理工具 — dsh-aiquit
// ----------------------------------------------------------------------------
// 背景：AIQuit 早期版本在拒绝（罢工）时直接 session.append 了一条不符合 DSH
// 会话事件契约的 assistant/message（缺 turn/step，或 message.content 缺失）。
// 坏事件一旦写入就永久留在会话日志里，之后 DSH 每次读取该会话历史都会抛
// TypeError（例如 Cannot read properties of undefined (reading 'length')），
// 在 Web 上表现为「历史加载失败（gateway/internal）」且该会话历史完全不可见。
// 升级插件只能保证不再产生坏事件，无法修复已经写入的坏事件——用本工具清理。
//
// 用法（默认只报告，不改动任何文件）：
//   node scripts/repair-sessions.mjs                     # 扫描并报告
//   node scripts/repair-sessions.mjs --quarantine        # 把受损会话移出（推荐）
//   node scripts/repair-sessions.mjs --delete            # 直接删除受损会话
//
// 可选参数：
//   --sessions <dir>   会话目录（默认 $DSH_HOME/sessions）
//   --dsh-home <dir>   覆盖 DSH_HOME（用于测试或非默认安装位置）
//   --json             以 JSON 输出结果（便于脚本消费）
//
// 隔离目录：$DSH_HOME/aiquit-repair/quarantine-<时间戳>/
//   - 会话目录整体移动进去（数据保留，可人工恢复）
//   - 同时移除对应的会话投影缓存，避免 UI 仍列出打不开的旧会话
// ============================================================================
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { execFileSync } from 'node:child_process'

const argv = process.argv.slice(2)
const hasFlag = (flag) => argv.includes(flag)
function optionValue(flag, fallback) {
  const index = argv.indexOf(flag)
  return index >= 0 && argv[index + 1] !== undefined && !argv[index + 1].startsWith('--') ? argv[index + 1] : fallback
}

const DSH_HOME = optionValue('--dsh-home', process.env.DSH_HOME || path.join(os.homedir(), '.dsh'))
const SESSIONS_ROOT = optionValue('--sessions', path.join(DSH_HOME, 'sessions'))
const PROJ_CACHE_FILE = path.join(DSH_HOME, 'storages', 'session_projcache.json')
const PROJ_CACHE_DIR = path.join(DSH_HOME, 'storages', 'session_projcache', 'sessions')
const AS_JSON = hasFlag('--json')
const MODE = hasFlag('--delete') ? 'delete' : hasFlag('--quarantine') ? 'quarantine' : 'report'
const STAMP = new Date().toISOString().replace(/[:.]/g, '-')
const QUARANTINE_ROOT = path.join(DSH_HOME, 'aiquit-repair', `quarantine-${STAMP}`)

// ---------------------------------------------------------------------------
// 会话日志读取（Node >= 22.15 内置 zstd；否则回退外部 zstd 命令）
// ---------------------------------------------------------------------------
function readLogText(file) {
  const buf = fs.readFileSync(file)
  if (!file.endsWith('.zstd')) return buf.toString('utf8')
  if (typeof zlib.zstdDecompressSync === 'function') return zlib.zstdDecompressSync(buf).toString('utf8')
  const out = execFileSync('zstd', ['-d', '-c', file], { maxBuffer: 1024 * 1024 * 1024 })
  return out.toString('utf8')
}

// ---------------------------------------------------------------------------
// 契约检查：找出会让 DSH 读历史崩溃的事件
// ---------------------------------------------------------------------------
function isSafeCount(value) {
  return Number.isSafeInteger(value) && value >= 0
}

function inspectEvent(event) {
  const data = event && event.data
  if (!data || typeof data !== 'object') return 'event data is not an object'
  switch (event.type) {
    case 'assistant/message':
    case 'system/message': {
      if (!isSafeCount(data.turn) || !isSafeCount(data.step)) return `${event.type} has no numeric turn/step`
      if (!data.message || typeof data.message !== 'object') return `${event.type} has no message object`
      if (!Array.isArray(data.message.content)) return `${event.type} message.content is not an array`
      return null
    }
    case 'user/message': {
      if (!Array.isArray(data.content)) return 'user/message content is not an array'
      return null
    }
    case 'tool/result': {
      if (!data.message || typeof data.message !== 'object') return 'tool/result has no message object'
      if (!Array.isArray(data.message.content)) return 'tool/result message.content is not an array'
      return null
    }
    default:
      return null
  }
}

function scanLog(text) {
  const problems = []
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (!line) continue
    let event
    try {
      event = JSON.parse(line)
    } catch (err) {
      problems.push({ line: index + 1, reason: 'unparseable JSON line' })
      continue
    }
    const reason = inspectEvent(event)
    if (reason) problems.push({ seq: event.seq, line: index + 1, reason })
  }
  return problems
}

// ---------------------------------------------------------------------------
// 发现所有会话日志文件
// ---------------------------------------------------------------------------
function findSessionLogs(root) {
  const found = []
  if (!fs.existsSync(root)) return found
  for (const workspace of fs.readdirSync(root)) {
    const workspacePath = path.join(root, workspace)
    let stat
    try {
      stat = fs.statSync(workspacePath)
    } catch (err) {
      continue
    }
    if (!stat.isDirectory()) continue
    for (const sessionDir of fs.readdirSync(workspacePath)) {
      const dirPath = path.join(workspacePath, sessionDir)
      try {
        if (!fs.statSync(dirPath).isDirectory()) continue
      } catch (err) {
        continue
      }
      for (const file of fs.readdirSync(dirPath)) {
        if (file === 'session.jsonl.zstd' || file === 'session.jsonl') {
          found.push({ workspace, sessionDir, dirPath, file: path.join(dirPath, file) })
        }
      }
    }
  }
  return found
}

function sessionUuid(sessionDir) {
  return sessionDir.startsWith('session-') ? sessionDir.slice('session-'.length) : sessionDir
}

// ---------------------------------------------------------------------------
// 投影缓存清理（让被隔离的会话不再出现在列表里）
// ---------------------------------------------------------------------------
function clearProjectionCache(uuid, into) {
  const removed = []
  const single = path.join(PROJ_CACHE_DIR, `session-${uuid}.json`)
  const singleAlt = path.join(PROJ_CACHE_DIR, `${uuid}.json`)
  for (const file of [single, singleAlt]) {
    try {
      if (!fs.existsSync(file)) continue
      if (into) {
        fs.mkdirSync(into, { recursive: true })
        fs.copyFileSync(file, path.join(into, path.basename(file)))
      }
      fs.rmSync(file)
      removed.push(path.basename(file))
    } catch (err) {
      /* 缓存清理失败不影响主流程 */
    }
  }
  try {
    if (!fs.existsSync(PROJ_CACHE_FILE)) return removed
    const raw = fs.readFileSync(PROJ_CACHE_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    const table = parsed && parsed.tables && parsed.tables.sessions
    if (!table || typeof table !== 'object') return removed
    let changed = false
    for (const key of Object.keys(table)) {
      if (key === uuid || key === `session-${uuid}`) {
        delete table[key]
        changed = true
        removed.push(`session_projcache.json#${key}`)
      }
    }
    if (changed) {
      if (into) {
        fs.mkdirSync(into, { recursive: true })
        fs.copyFileSync(PROJ_CACHE_FILE, path.join(into, 'session_projcache.json'))
      }
      fs.writeFileSync(PROJ_CACHE_FILE, JSON.stringify(parsed), 'utf8')
    }
  } catch (err) {
    /* 索引文件损坏或不可写时保留原样，仅提示 */
  }
  return removed
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
const logs = findSessionLogs(SESSIONS_ROOT)
const damaged = []
for (const entry of logs) {
  let text
  try {
    text = readLogText(entry.file)
  } catch (err) {
    damaged.push({ ...entry, problems: [{ reason: `could not read log: ${String(err && err.message ? err.message : err)}` }], uuid: sessionUuid(entry.sessionDir) })
    continue
  }
  const problems = scanLog(text)
  if (problems.length > 0) damaged.push({ ...entry, problems, uuid: sessionUuid(entry.sessionDir) })
}

const actions = []
for (const entry of damaged) {
  let action = 'reported'
  let target
  try {
    if (MODE === 'quarantine') {
      fs.mkdirSync(QUARANTINE_ROOT, { recursive: true })
      target = path.join(QUARANTINE_ROOT, `${entry.workspace}__${entry.sessionDir}`)
      fs.renameSync(entry.dirPath, target)
      action = 'quarantined'
    } else if (MODE === 'delete') {
      fs.rmSync(entry.dirPath, { recursive: true, force: true })
      action = 'deleted'
    }
  } catch (err) {
    action = `failed: ${String(err && err.message ? err.message : err)}`
  }
  let cacheRemoved = []
  if (action === 'quarantined' || action === 'deleted') {
    const cacheBackup = action === 'quarantined' ? path.join(QUARANTINE_ROOT, `${entry.workspace}__${entry.sessionDir}__projcache`) : undefined
    cacheRemoved = clearProjectionCache(entry.uuid, cacheBackup)
  }
  actions.push({
    workspace: entry.workspace,
    session: entry.sessionDir,
    uuid: entry.uuid,
    problems: entry.problems,
    action,
    movedTo: target,
    projectionCacheRemoved: cacheRemoved,
  })
}

const summary = {
  dshHome: DSH_HOME,
  sessionsRoot: SESSIONS_ROOT,
  mode: MODE,
  scannedSessions: logs.length,
  damagedSessions: damaged.length,
  quarantineRoot: MODE === 'quarantine' ? QUARANTINE_ROOT : undefined,
  actions,
}

if (AS_JSON) {
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n')
} else {
  console.log(`DSH_HOME      : ${DSH_HOME}`)
  console.log(`会话目录      : ${SESSIONS_ROOT}`)
  console.log(`模式          : ${MODE === 'report' ? '仅报告（不改动文件）' : MODE === 'quarantine' ? '隔离受损会话' : '删除受损会话'}`)
  console.log(`扫描会话数    : ${logs.length}`)
  console.log(`受损会话数    : ${damaged.length}`)
  console.log('')
  if (damaged.length === 0) {
    console.log('没有发现受损会话——所有会话日志都符合 DSH 事件契约。')
  }
  for (const item of actions) {
    console.log(`[受损] ${item.session}  (workspace: ${item.workspace})`)
    for (const problem of item.problems.slice(0, 10)) {
      console.log(`        seq ${problem.seq ?? '?'}: ${problem.reason}`)
    }
    if (item.problems.length > 10) console.log(`        … 其余 ${item.problems.length - 10} 条同类问题`)
    if (item.action === 'quarantined') console.log(`        → 已隔离到 ${item.movedTo}`)
    else if (item.action === 'deleted') console.log('        → 已删除')
    else if (item.action === 'reported') console.log('        → 未改动（加 --quarantine 或 --delete 才会处理）')
    else console.log(`        → ${item.action}`)
    if (item.projectionCacheRemoved.length > 0) {
      console.log(`        → 已清理投影缓存: ${item.projectionCacheRemoved.join(', ')}`)
    }
    console.log('')
  }
  if (MODE === 'report' && damaged.length > 0) {
    console.log('提示：再次运行并加 --quarantine 把受损会话移到隔离目录（数据保留），')
    console.log('      或加 --delete 直接删除。之后重启 dsh web 即可恢复会话列表。')
  }
  if (MODE === 'quarantine' && damaged.length > 0) {
    console.log(`隔离目录：${QUARANTINE_ROOT}（确认无碍后可手动删除）`)
  }
}
