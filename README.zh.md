# dsh-migrate

[English](README.md) | 中文

[![npm version](https://img.shields.io/npm/v/%40ersss%2Fdsh-migrate)](https://www.npmjs.com/package/@ersss/dsh-migrate)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js ≥ 22.13](https://img.shields.io/badge/Node.js-%E2%89%A5%2022.13-339933?logo=node.js&logoColor=white)](package.json)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)

把其他 AI agent 的聊天记录和记忆迁移到 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。

换 harness 不应该丢上下文。`dsh-migrate` 读取其他 agent 留在磁盘上的会话记录和记忆文件，写成 DeepSeek Harness 原生会话日志——可搜索、可在 Trajectory 视图中查看、可继续(resume/fork)，就像它们本来就是 DSH 记录的一样。

两种用法：DSH 内的 **`/migrate` 斜杠命令**，以及独立 **CLI**(`npx @ersss/dsh-migrate`)——整机自动扫描，写盘前 dry-run 预览。

## 支持的来源

| Agent | 会话 | 记忆 |
|---|---|---|
| **Claude Code** | `~/.claude/projects/**.jsonl`(text、thinking、tool_use/tool_result) | `~/.claude/CLAUDE.md`、项目 `memory/*.md` |
| **Codex CLI** | `~/.codex/sessions/**/rollout-*.jsonl`(消息、推理、函数调用) | `~/.codex/AGENTS.md`、`instructions.md` |
| **Gemini CLI** | `~/.gemini/tmp/**/chats/session-*.json`(消息、thoughts、toolCalls) | `~/.gemini/GEMINI.md` |
| **Cursor** | `~/.cursor/projects/*/agent-transcripts/*/*.jsonl`(text、tool_use；结果存在 Cursor 的 bubble store，未记录) | — |
| **Kimi CLI** | `~/.kimi/sessions/*/*/wire.jsonl`(text、thinking、工具调用；cwd 经 `kimi.json` 恢复) | — |
| **ChatGPT(网页导出)** | 数据导出里的 `conversations.json`(DAG 线程还原；工具消息降级为文本) | — |
| **Cline / Roo Code** | VS Code `globalStorage/*/tasks/*/api_conversation_history.json` | — |
| **OpenCode** | `~/.local/share/opencode/**` 消息/part JSON | — |
| **Aider** | `**/.aider.chat.history.md`(有界扫描) | `CONVENTIONS.md` |
| **Hermes Agent** | `~/.hermes/state.db`(SQLite sessions+messages,只读) | `~/.hermes/memories/MEMORY.md`、`USER.md` |
| **OpenClaw** | `~/.openclaw/agents/*/agent/openclaw-agent.sqlite`(transcript_events,只读) | 工作区 `MEMORY.md`、`memory/*.md` |

所有适配器都是容错读取：坏行和未知行类型直接跳过，不会中断。缺字段时优雅降级（模型未知 → `imported`,cwd 未知 → `_no-cwd` 项目）。

## 安装

```sh
# 1. 把插件装进 DSH web profile
dsh plugin --profile web add @ersss/dsh-migrate

# 2. 重启 DSH
dsh web
```

包内声明了 `dsh.bundle` patch 层，安装后自动做两件事:

- 注册 **`/migrate`** 斜杠命令；
- 把 DSH 会话存储指向 `$DSH_HOME/sessions-imported`(raw JSONL 模式)——专为迁移日志准备的独立根目录，不会和默认存储的编码混在一起。

> **注意:** bundle patch 会替换*默认*会话根目录，安装插件之前记录在旧 `sessions/` 根的会话将不再列出。如果你已经有想保留的 DSH 会话，可以把 patch 里的两行合并到 `$DSH_HOME/profiles/web/cordis.patch.yml`，按需用 `--patch` 切换；或者用 CLI 的 `--out` 指定到你的现有根目录（前提是它用 `compression: 'none'` 建的)。全新安装不受影响。

## 使用

DSH 内部（Web UI / TUI / headless):

```
/migrate list                 # 列出各 agent 在磁盘上的数据
/migrate run                  # 全部导入
/migrate run --source claude-code --limit 10
```

也可以在 DSH 未运行时直接用 CLI（大批量迁移推荐）:

```sh
npx @ersss/dsh-migrate list
npx @ersss/dsh-migrate run                       # → $DSH_HOME/sessions-imported
npx @ersss/dsh-migrate run --out /path/to/root   # 自定义输出目录
npx @ersss/dsh-migrate run --write-instructions .  # 同时把记忆写入 ./AGENTS.md
```

导入的会话按原始项目目录分组显示在侧边栏，Trajectory 视图中可以看到完整事件流——prompt、推理、工具调用和结果。

## 写入格式

DSH 的会话日志是 append-only 的 JSONL 事件流（`SESSION_FORMAT_VERSION 0`)。每个源会话写一个日志：

```
$DSH_HOME/sessions-imported/--<项目目录>--/<id>/session.jsonl

  {"type":"session","version":0,"id":"…","createdAt":…,"delegationDepth":0,"cwd":"…"}
  {"type":"turn/start","seq":0,"time":…,"data":{"turn":1}}
  {"type":"user/message","seq":1,…,"data":{"role":"user","source":{"kind":"user","via":"dsh-migrate:claude-code"},…},"surfaceOp":"append"}
  {"type":"step/start",…} {"type":"assistant/message",…} {"type":"tool/call",…} {"type":"tool/result",…} {"type":"step/end",…}
  {"type":"turn/end",…,"data":{"turn":1,"reason":{"kind":"completed"}}}
  …
  {"type":"session/end-seed",…}        ← 标记整段为导入的种子历史
```

映射决策简述：

- **轮次。** 源会话的一个用户 prompt（及其触发的助手工作）映射为一个 `turn/start…turn/end`。纯工具结果的用户行（Claude Code、Cline）挂到待完成的 `tool/call` 上，不会开新轮。
- **消息。** 用户和系统文本成为 `user/message`;assistant 的 text/reasoning/tool-call 合成每个 step 一条 `assistant/message`；工具结果按 call id 配对为 `tool/result`。
- **溯源而非伪装。** 导入的 assistant 消息保留原始 provider 和 model(`provider: "dsh-migrate:anthropic", model: "claude-fable-5"`)。导入的用户消息用 `kind: "user"`(trajectory 视图和历史推导需要），导入方标记在可扩展的 `via` 字段上（`via: "dsh-migrate:claude-code"`)。
- **时间戳与 id。** 源记录了时间戳就保留（强制单调）；缺 call id 时生成新 UUID；会话 id 一律用新 UUID（绝不沿用源 id)，导入不可能覆盖在线会话。日志头带 `importedSource` / `importedSourceId`，无需遍历事件流即可筛选导入会话。
- **记忆。** 每个来源的记忆记录合成一个 "Imported memory" 会话（可读、可搜、可续）；`--write-instructions <项目>` 会额外把它们写进该项目的 `AGENTS.md`，用 `<!-- dsh-migrate … -->` 标记包裹（重复执行幂等）。
- **只追加。** 写入用 `wx`（不覆盖）;id 冲突时换新 id 重试；已有日志永不修改。

## 续聊原理

日志末尾的 `session/end-seed` 事件把整段导入日志标记为*种子历史*：继续一个导入的会话时，DSH 把日志作为继承上下文回放，然后开始干净的 live 段——模型看到的历史与 DSH 自己记录的完全一致。当前运行时的 preset 和工具照常生效；旧 agent 有而 DSH 没有的工具只作为历史存在。

## 说明与限制

- **对源只读。** 导入器从不写源 agent 的目录。
- **图片和附件**不导入（DSH 附件是内容寻址的宿主对象）；其上下文文本会保留。
- 源会话里的**压缩历史**会展平成普通消息。
- 各源格式的**固有缺口**:Cursor transcript 不记录工具结果(调用无结果导入);ChatGPT 导出没有结构化工具调用(工具消息变文本);Kimi CLI 镜像到主线程的子代理事件(`SubagentEvent`)跳过(需要的话可直接导入 `subagents/<id>/wire.jsonl`)。
- **SQLite 来源用不可变只读方式打开**(`mode=ro&immutable=1`),正在运行的 Hermes/OpenClaw gateway 完全不受影响。OpenClaw 的每个 `session_window` 都会导入;reset/rollover 产生的窗口在源端就是独立 transcript,导入后同样是独立会话。
- **Aider 扫描根**:`$DSH_MIGRATE_SCAN`（路径列表）、`~/projects`、`~/code`、`~/dev`、`~/work`，外加 `$HOME` 浅扫——它的历史文件在项目目录里，固定的 home 相对路径找不到。
- 格式漂移：这些目录结构是各 agent 的未公开内部格式，会随版本变化。适配器对不认识的行一律跳过；如果你用的版本较新导致导入不全，欢迎提 issue 并附（脱敏后的）示例行。

## 开发

```sh
npm install
npm run build      # tsc → dist/
npm test           # 基于 fixture 的端到端测试（用真实 DSH codec 回放）
```

测试会把生成的日志送进真实 `@deepseek-ai/dsh-session` codec(`decodeStorageRecord` + `foldSurface`，取自运行中的 DSH profile）回放，格式回归会直接报错。

## 贡献新源适配器

一个适配器 = `src/formats/` 下一个文件，实现：

```ts
interface SourceAdapter {
  key: string
  label: string
  detect(home: string): Promise<DiscoveredSource | undefined>
  readSessions(home: string, options?: { limit?: number }): Promise<IrSession[]>
  readMemories(home: string): Promise<IrMemory[]>
}
```

在 `src/formats/index.ts` 注册，并加一个 fixture 测试。参考实现见 `src/formats/claude-code.ts`。

## License

MIT
