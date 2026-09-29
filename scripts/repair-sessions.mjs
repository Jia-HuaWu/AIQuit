#!/usr/bin/env node
// ============================================================================
// AIQuit 受损会话清理工具 — dsh-aiquit
// ----------------------------------------------------------------------------
// 背景：AIQuit 早期版本在拒绝（罢工）时直接 session.append 了一条不符合 DSH
// 会话事件契约的 assistant/message。坏事件一旦写入就永久留在会话日志里，之后
// DSH 每次读取该会话历史都会抛 TypeError，在 Web 上表现为「历史加载失败
// （gateway/internal）」且该会话历史完全不可见。升级插件只能保证不再产生坏
// 事件，无法修复已经写入的坏事件——用本工具清理。
//
// 已确认的两条崩溃路径（都表现为 Cannot read properties of undefined
// (reading 'length')）：
//   1) 缺 turn/step 或 message.content —— dsh-session / dsh-client-connection /
//      dsh-agent-loop / dsh-token-meter 读历史时都会访问 content.length；
//   2) 缺 stream —— dsh-token-meter 的 usageOf() 在 usage 缺失时无条件读
//      event.data.stream，交给 dsh-llm 的 lastAssistantStreamChunk() 取 .length
//      （assistant/attempt 同样如此）。stream 在事件契约里是必填数组字段。
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
//
// 会话日志读取说明：DSH 写出的 .jsonl.zstd 是**多帧串联**容器（每帧带校验和），
// 且文件名带格式版本（session.jsonl.zstd / session.v3.jsonl.zstd /
// session.v4.jsonl.zstd …）。Node 的 zstdDecompressSync 只解第一帧就“成功”
// 返回，会静默截断——所以这里按帧边界逐帧解码再拼接。
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

// 会话日志命名带格式版本（generation）：session.jsonl(.zstd) / session.v3.jsonl(.zstd)
// DSH 取同一会话目录里代数最高的那份日志；低代文件是历史遗留，不能按现行契约判损。
const SESSION_LOG_PATTERN = /^session(\.v(\d+))?\.jsonl(\.zstd)?$/
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 解析日志文件名里的格式代数（无版本号记 0）；不匹配返回 undefined。 */
function parseLogGeneration(fileName) {
  const match = SESSION_LOG_PATTERN.exec(fileName)
  if (match === null) return undefined
  return match[2] === undefined ? 0 : Number(match[2])
}

// ---------------------------------------------------------------------------
// 会话日志读取（Node >= 22.15 内置 zstd；否则回退外部 zstd 命令）
// ---------------------------------------------------------------------------
/**
 * 解压多帧串联的 zstd 容器。
 * 帧自带校验和，因此可以贪心切分：以魔数为候选边界逐帧解压；若该切片解压
 * 失败（命中的是负载里的伪魔数，或帧尚未结束），就把边界合并到下一个候选
 * 再试。最后一帧可能被中断（DSH 允许撕裂的尾部帧），此时保留已解出的完整部分。
 * @returns {{ plaintext: string, tornTail: boolean }}
 */
function decodeZstdContainer(buf) {
  const starts = []
  for (let at = buf.indexOf(ZSTD_MAGIC); at !== -1; at = buf.indexOf(ZSTD_MAGIC, at + 4)) starts.push(at)
  if (starts.length === 0) throw new Error('no Zstandard frame found')
  if (starts[0] !== 0) throw new Error(`unexpected ${starts[0]} leading bytes before the first Zstandard frame`)

  const parts = []
  let cursor = 0
  let tornTail = false
  while (cursor < starts.length) {
    let endIndex = cursor + 1
    let decoded = null
    while (endIndex <= starts.length) {
      const end = endIndex < starts.length ? starts[endIndex] : buf.length
      try {
        decoded = zlib.zstdDecompressSync(buf.subarray(starts[cursor], end))
        break
      } catch (err) {
        decoded = null
      }
      endIndex += 1
    }
    if (decoded === null) {
      tornTail = true
      break
    }
    parts.push(decoded)
    cursor = endIndex
  }
  if (parts.length === 0) throw new Error('every Zstandard frame failed to decode')
  return { plaintext: Buffer.concat(parts).toString('utf8'), tornTail }
}

function readLogText(file) {
  const buf = fs.readFileSync(file)
  if (!file.endsWith('.zstd')) return { plaintext: buf.toString('utf8'), tornTail: false }
  if (typeof zlib.zstdDecompressSync === 'function') return decodeZstdContainer(buf)
  const out = execFileSync('zstd', ['-d', '-c', file], { maxBuffer: 1024 * 1024 * 1024 })
  return { plaintext: out.toString('utf8'), tornTail: false }
}

// ---------------------------------------------------------------------------
// 契约检查：找出会让 DSH 读历史崩溃的事件
// ---------------------------------------------------------------------------
function isSafeCount(value) {
  return Number.isSafeInteger(value) && value >= 0
}

/**
 * 判断缺失 stream 是否构成「会让 DSH 崩溃」的损坏。
 * 只看两件有证据的事：事件确由 AIQuit 写入（id 前缀），或同一份日志里存在
 * 带 stream 的正常 assistant 事件（说明该日志的写入方本就会写 stream）。
 * 旧格式日志（本身不含 stream）不会被误判。
 */
function streamProblem(type, data, ctx) {
  if (Array.isArray(data.stream)) return null
  const message = data.message
  const isAiquitAuthored = !!message && typeof message.id === 'string' && message.id.startsWith('aiquit-')
  if (isAiquitAuthored) {
    return `${type} has no stream array (AIQuit-authored event: dsh-token-meter usageOf() reads stream.length and throws)`
  }
  if (data.usage === undefined && ctx.streamBearingEvents > 0) {
    return `${type} has no stream array (usage also absent and this log normally carries stream: usageOf() reads stream.length and throws)`
  }
  return null
}

function inspectEvent(type, data, ctx) {
  switch (type) {
    case 'assistant/message': {
      if (!isSafeCount(data.turn) || !isSafeCount(data.step)) return 'assistant/message has no numeric turn/step'
      if (!data.message || typeof data.message !== 'object') return 'assistant/message has no message object'
      if (!Array.isArray(data.message.content)) return 'assistant/message message.content is not an array'
      return streamProblem(type, data, ctx)
    }
    case 'assistant/attempt': {
      if (!isSafeCount(data.turn) || !isSafeCount(data.step)) return 'assistant/attempt has no numeric turn/step'
      return streamProblem(type, data, ctx)
    }
    case 'system/message': {
      if (!isSafeCount(data.turn) || !isSafeCount(data.step)) return 'system/message has no numeric turn/step'
      if (!data.message || typeof data.message !== 'object') return 'system/message has no message object'
      if (!Array.isArray(data.message.content)) return 'system/message message.content is not an array'
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

function scanLog(plaintext, generation) {
  const lines = plaintext.split('\n')
  // 预扫描：确认这份日志是否使用「带 stream」的现行写入形状（供误判防护）
  let streamBearingEvents = 0
  for (const line of lines) {
    if (!line) continue
    let event
    try {
      event = JSON.parse(line)
    } catch (err) {
      continue
    }
    const data = event && event.data
    if ((event.type === 'assistant/message' || event.type === 'assistant/attempt') && data && Array.isArray(data.stream)) {
      streamBearingEvents += 1
    }
  }

  const ctx = { generation, streamBearingEvents }
  const problems = []
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
    if (!event || typeof event !== 'object') {
      problems.push({ line: index + 1, reason: 'record is not an object' })
      continue
    }
    // 每条日志的第一条是会话头部记录（type: "session"），不是事件
    if (event.type === 'session') continue
    const data = event.data
    if (!data || typeof data !== 'object') {
      problems.push({ seq: event.seq, line: index + 1, reason: `event data is not an object (type ${String(event.type)})` })
      continue
    }
    const reason = inspectEvent(event.type, data, ctx)
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
      // 同一会话目录可能同时存在多代日志；只检查 DSH 实际使用的那份（代数最高）
      let chosen
      for (const file of fs.readdirSync(dirPath)) {
        const generation = parseLogGeneration(file)
        if (generation === undefined) continue
        const candidate = { workspace, sessionDir, dirPath, fileName: file, file: path.join(dirPath, file), generation }
        if (chosen === undefined || candidate.generation > chosen.generation) chosen = candidate
      }
      if (chosen !== undefined) found.push(chosen)
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
let unreadable = 0
let inspectedEvents = 0
for (const entry of logs) {
  let plaintext
  let tornTail = false
  try {
    const decoded = readLogText(entry.file)
    plaintext = decoded.plaintext
    tornTail = decoded.tornTail
  } catch (err) {
    unreadable += 1
    damaged.push({
      ...entry,
      uuid: sessionUuid(entry.sessionDir),
      problems: [{ reason: `could not read log: ${String(err && err.message ? err.message : err)}` }],
      tornTail: false,
    })
    continue
  }
  inspectedEvents += plaintext.split('\n').filter(Boolean).length
  const problems = scanLog(plaintext, entry.generation)
  if (problems.length > 0) damaged.push({ ...entry, uuid: sessionUuid(entry.sessionDir), problems, tornTail })
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
    logFile: entry.fileName,
    problems: entry.problems,
    tornTail: entry.tornTail === true,
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
  inspectedEvents,
  unreadableSessions: unreadable,
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
  console.log(`扫描会话数    : ${logs.length}（事件行 ${inspectedEvents}）`)
  console.log(`无法读取会话  : ${unreadable}`)
  console.log(`受损会话数    : ${damaged.length}`)
  console.log('')
  if (damaged.length === 0) {
    console.log('没有发现受损会话——所有会话日志都符合 DSH 事件契约。')
  }
  for (const item of actions) {
    console.log(`[受损] ${item.session}  (${item.logFile ?? '?'} @ ${item.workspace})`)
    for (const problem of item.problems.slice(0, 10)) {
      console.log(`        seq ${problem.seq ?? '?'}: ${problem.reason}`)
    }
    if (item.problems.length > 10) console.log(`        … 其余 ${item.problems.length - 10} 条同类问题`)
    if (item.tornTail) console.log('        注：日志尾部有未写完的帧，仅检查了完整帧')
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
