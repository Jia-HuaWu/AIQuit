# AIQuit「爷不干了」

DeepSeek Harness 罢工插件：**程序化裁决**——每次用户发出指令后，程序先让 AI
评估本次工作量（1-10），一旦超过「罢工阈值」，就拒绝干活，并从「回答拒绝库」
里随机挑一句带脾气的话回复你。不再依赖 AI 自觉，阈值 0 时**连评估都不做、
直接拒绝、零 token 消耗**。

## 每轮指令的流程

```
用户发出指令
  ├─ 插件已停用？ ──────────────── 直接放行（零消耗）
  ├─ 罢工阈值 = 0？ ───────────── 跳过一切 LLM 调用，直接随机拒绝语 + 拒绝该轮
  └─ 否则 → 程序发一次「只评估」的迷你请求
            （不带历史、max_tokens=8 的 deepseek-chat，AI 只打分 1-10 返回给程序）
       ├─ 分数 > 阈值 → 程序写入拒绝语，拒绝该轮（主模型零调用）
       └─ 分数 ≤ 阈值（或评估失败）→ 放行，让 AI 正常工作
```

每一轮对话都执行这个流程（不是只在对话开始时）。只拦截真实用户输入
（系统注入、Goal 自动推进、子代理派活不拦截）。

## 特性

- **工作量评估（1-10）**：1 = 纯聊天这种简单对话；10 = 永远无法完成，或完成耗时
  超过 2 天。评估请求极小：不带历史、只输出一个数字。
- **罢工机制**：评估结果 > 罢工阈值 时程序直接拒绝该轮——用户消息与拒绝语以
  **符合 DSH 事件契约的完整 step 生命周期**写入会话并展示，主模型完全没有被调用。
  拒绝语从当前拒绝库随机选取。
- **设置界面**：网页右下角一个**可自由拖动的小齿轮图标**，点击打开设置面板：
  - **启用 AIQuit（总开关）**：关闭后不评估、不拦截，**零 token 消耗**。
  - **罢工阈值**：滑块 0-10，默认 **5**；**0 = 跳过评估、每轮直接拒绝**。
  - **回答拒绝库**：`暴躁老哥`（`talking/baozao.txt`）或 `软萌萝莉`
    （`talking/luoli.txt`），点击即切换；面板显示**最近一次评估结果**
    （如 `最近评估：8/10 · 已罢工`）与随机拒绝语预览。
  - 所有设置即时保存，无需重启。
- **最小化 token**：
  - 主模型提示词中**不再包含任何 AIQuit 规则**（程序拦截取代提示词自律）；
  - 阈值 0 或插件停用时主模型零开销；
  - 评估请求不带历史（约 60 token 输入 + 1 个数字输出），拒绝库全文从不进任何提示词。

## 安装

```sh
dsh plugin --profile web add link:E:/DeepseekHarness/AIQuit
```

然后重启 `dsh web`（插件随 profile 启动加载）。

## 使用

1. 拖动右下角齿轮可随意摆放；点击齿轮打开设置面板。
2. 用「启用 AIQuit」总开关随时开启/关闭整个插件（关闭即零消耗）。
3. 调整罢工阈值（0-10）与拒绝库，改动即保存。
4. 给 AI 派一个明显超纲的活，看它罢工。

## 自定义拒绝语

拒绝库文件位于插件的 `talking/` 文件夹：

- `talking/baozao.txt` —— 暴躁老哥（一行一条）
- `talking/luoli.txt` —— 软萌萝莉（一行一条）

插件首次启动时会把这两个文件**自动复制到 `$DSH_HOME/talking/`**（即
`C:\Users\<你>\ .dsh\talking\`）。之后插件**优先读取 `$DSH_HOME/talking/` 下的
版本**——直接编辑那里的文件即可自定义，不用碰 node_modules；改完立刻生效
（下次罢工时就会用到新台词）。

## 工作原理

| 组件 | 实现 |
|---|---|
| 每轮拦截 | `agent/pre-step` waterfall（模型请求之前）：写入拒绝事件后统一返回官方的 `{kind:'reject'}`，主模型零调用 |
| 工作量评估 | 独立迷你请求（deepseek-chat，max_tokens=16，不带历史），分数返回给程序判定 |
| 拒绝写入 | 构造与正常轮次一致的完整事件流 `step/start → user/message → assistant/message(拒绝语) → step/end`（携带 `turn`/`step` 坐标与必填的 `stream: []`），UI 正常显示 |
| 拦截范围 | 仅 `source.kind === 'user'` 的真实用户输入 + 根 agent（子代理/Goal 注入不拦） |
| 设置面板 | `webServer.register()` + `tapIndex()` 注入零依赖前端脚本 |
| 配置持久化 | `$DSH_HOME/dsh-aiquit/config.json`（开关 + 阈值 + 当前库） |

## ⚠️ 已知问题与修复（v1.0.0 / v1.0.1 → v1.0.2）

罢工写出的 `assistant/message` 必须逐字节满足 DSH 的会话事件契约。历史上漏过
**两个互不相关的必填字段**，各自都会让该会话的历史**永久**加载失败：

| 版本 | 缺失字段 | 崩溃点 |
|---|---|---|
| v1.0.0 | `turn` / `step`、`message.content` | 读历史时访问 `data.message.content.length`（dsh-session / dsh-client-connection / dsh-agent-loop / dsh-token-meter） |
| v1.0.1 | `stream` | `dsh-token-meter` 的 `usageOf()` 在 `usage` 缺失时读 `event.data.stream`，由 `dsh-llm` 的 `lastAssistantStreamChunk()` 取 `.length` |

两者的症状相同：

```
历史加载失败：Cannot read properties of undefined (reading 'length')（gateway/internal）
```

会话历史完全不可见、对话直接作废，且**升级插件无法修复已写入的坏事件**
（新版本只保证不再产生新的坏事件）。

**v1.0.2 的修复内容**：

1. 事件的 `data` 补齐 `stream: []`（罢工没有模型流，空数组即语义正确）；
2. 写入前校验**完整事件数据形状**（`turn`/`step` 为安全整数、`stream` 为数组、
   `message.content` 为数组），任一不满足即 fail-open 放行——绝不写坏事件；
3. 拒绝统一返回官方的 `{kind:'reject'}` 决策，不依赖 agent-loop 内部状态
   （v1.0.1 已修，历史版本曾用 `{kind:'enter', messages:[]}` 技巧，在缺少对应
   分支的 DSH 版本上会真的发起模型请求）。

### 修复已受损的会话

升级插件**不能**让已经损坏的会话恢复，请用附带的清理工具处理（默认只扫描报告，
不改动任何文件）：

```sh
# 1) 先扫描报告（安全，只读）
node scripts/repair-sessions.mjs

# 2) 把受损会话移到隔离目录（数据保留，可人工恢复）
node scripts/repair-sessions.mjs --quarantine

# 3) 或直接删除受损会话
node scripts/repair-sessions.mjs --delete
```

- 工具零依赖（Node ≥ 22.15 自带 zstd），会自动定位 `$DSH_HOME/sessions`；
- 正确处理 DSH 写出的**带格式版本的多帧 zstd 日志**（`session.v3.jsonl.zstd` /
  `session.v4.jsonl.zstd` …）：按帧边界逐帧解码——直接用 Node 的
  `zstdDecompressSync` 只会解出第一帧并“成功”返回，从而给出误导性的“一切正常”；
- 每个会话只检查 DSH 实际使用的**最高代数**日志，旧格式日志不会被误判；
- 隔离目录：`$DSH_HOME/aiquit-repair/quarantine-<时间戳>/`；
- 同时清理这些会话的投影缓存，避免会话列表里仍残留打不开的条目；
- 处理完重启 `dsh web` 即可恢复会话列表。

