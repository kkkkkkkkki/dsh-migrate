# dsh-migrate

English | [中文](README.zh.md)

[![npm version](https://img.shields.io/npm/v/%40ersss%2Fdsh-migrate)](https://www.npmjs.com/package/@ersss/dsh-migrate)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js ≥ 22.13](https://img.shields.io/badge/Node.js-%E2%89%A5%2022.13-339933?logo=node.js&logoColor=white)](package.json)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)

Import chat history and memory from other AI agents into [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

Switching harnesses should not mean losing your context. `dsh-migrate` reads the transcripts and memory stores other agents leave on disk and writes them as native DeepSeek Harness session logs — searchable, inspectable in the Trajectory view, and resumable (`--fork`-style continue) as if they had been recorded by DSH itself.

It works two ways: a **`/migrate` slash command** inside DSH, and a **standalone CLI** (`npx @ersss/dsh-migrate`) that scans the whole machine and previews with a dry run before writing anything.

## Supported sources

| Agent | Sessions | Memory |
|---|---|---|
| **Claude Code** | `~/.claude/projects/**.jsonl` (text, thinking, tool_use/tool_result) | `~/.claude/CLAUDE.md`, project `memory/*.md` |
| **Codex CLI** | `~/.codex/sessions/**/rollout-*.jsonl` (messages, reasoning, function calls) | `~/.codex/AGENTS.md`, `instructions.md` |
| **Gemini CLI** | `~/.gemini/tmp/**/chats/session-*.json` (messages, thoughts, toolCalls) | `~/.gemini/GEMINI.md` |
| **Cursor** | `~/.cursor/projects/*/agent-transcripts/*/*.jsonl` (text, tool_use; results live in Cursor's bubble store and are not recorded) | — |
| **Kimi CLI** | `~/.kimi/sessions/*/*/wire.jsonl` (text, thinking, tool calls; cwd recovered via `kimi.json`) | — |
| **ChatGPT (web export)** | `conversations.json` from the data export (DAG-mapped threads; tool messages folded to text) | — |
| **Cline / Roo Code** | VS Code `globalStorage/*/tasks/*/api_conversation_history.json` | — |
| **OpenCode** | `~/.local/share/opencode/**` message/part JSON files | — |
| **Aider** | `**/.aider.chat.history.md` (bounded scan) | `CONVENTIONS.md` files |
| **Hermes Agent** | `~/.hermes/state.db` (SQLite sessions+messages, read-only) | `~/.hermes/memories/MEMORY.md`, `USER.md` |
| **OpenClaw** | `~/.openclaw/agents/*/agent/openclaw-agent.sqlite` (transcript_events, read-only) | workspace `MEMORY.md`, `memory/*.md` |

Every adapter is tolerant: malformed lines and unknown row types are skipped, never fatal. Missing fields degrade gracefully (unknown model → `imported`, unknown cwd → the `_no-cwd` project).

## Install

```sh
# 1. Install the plugin into your DSH web profile
dsh plugin --profile web add @ersss/dsh-migrate

# 2. Restart DSH
dsh web
```

The package declares a `dsh.bundle` patch layer, so installing it does two things at once:

- registers the **`/migrate`** slash command, and
- points DSH's session store at `$DSH_HOME/sessions-imported` in raw-JSONL mode — a dedicated root for imported logs that never mixes with the default store's encoding.

> **Heads-up:** the bundled patch relocates the *default* session root, which means sessions you recorded before installing the plugin stay in the old `sessions/` root and stop being listed. If you have existing DSH sessions you still want listed, either merge the patch's two rows into `$DSH_HOME/profiles/web/cordis.patch.yml` and keep both roots by alternating `--patch`, or simply run the CLI with `--out` pointed at your *live* root (raw JSONL reads fine under a zstd root only if the root was created with `compression: 'none'`). Fresh installs are unaffected.

## Use

From inside DSH (Web UI, TUI, headless):

```
/migrate list                 # show what each agent has on disk
/migrate run                  # import everything
/migrate run --source claude-code --limit 10
```

From a terminal, without DSH running (also the right choice for big archives):

```sh
npx @ersss/dsh-migrate list
npx @ersss/dsh-migrate run                       # → $DSH_HOME/sessions-imported
npx @ersss/dsh-migrate run --out /path/to/root   # anywhere you like
npx @ersss/dsh-migrate run --write-instructions .  # also fold memory into ./AGENTS.md
```

Imported sessions appear in the sidebar grouped by their original project directory, and in the Trajectory view with their full event stream — prompts, reasoning, tool calls, and results.

## What gets written

DSH's session log is an append-only JSONL event stream (`SESSION_FORMAT_VERSION 0`). For every source session, `dsh-migrate` writes one log:

```
$DSH_HOME/sessions-imported/--<project>--/<id>/session.jsonl

  {"type":"session","version":0,"id":"…","createdAt":…,"delegationDepth":0,"cwd":"…"}
  {"type":"turn/start","seq":0,"time":…,"data":{"turn":1}}
  {"type":"user/message","seq":1,…,"data":{"role":"user","source":{"kind":"user","via":"dsh-migrate:claude-code"},"content":[{"type":"text","text":"…"}]},"surfaceOp":"append"}
  {"type":"step/start",…} {"type":"assistant/message",…} {"type":"tool/call",…} {"type":"tool/result",…} {"type":"step/end",…}
  {"type":"turn/end",…,"data":{"turn":1,"reason":{"kind":"completed"}}}
  …
  {"type":"session/end-seed",…}        ← marks the log as imported seed history
```

Mapping decisions, briefly:

- **Turns.** One source user prompt (plus the assistant work it triggered) becomes one `turn/start…turn/end` bracket. Tool-result-only user rows (Claude Code, Cline) attach to the pending `tool/call` instead of opening a turn.
- **Messages.** User and system text become `user/message` events; assistant text/reasoning/tool-calls become one `assistant/message` per step; tool results become `tool/result` paired by call id.
- **Provenance, not impersonation.** Imported assistant messages keep the original provider and model (`provider: "dsh-migrate:anthropic", model: "claude-fable-5"`). Imported user messages are `kind: "user"` — required for the trajectory view and history derivation — with the importer declared on the merge-extensible `via` channel (`via: "dsh-migrate:claude-code"`).
- **Timestamps and ids.** Original timestamps are preserved when the source records them (monotonicity enforced); missing call ids get fresh UUIDs; session ids are fresh UUIDs (never the source's) so an import can never shadow a live session. The header carries `importedSource` / `importedSourceId`, so imported sessions are filterable without walking the event stream.
- **Memory.** Each source's memory records become one "Imported memory" session (readable, searchable, resumable), and `--write-instructions <project>` additionally folds them into that project's `AGENTS.md` between `<!-- dsh-migrate … -->` markers (idempotent re-runs).
- **Append-only honesty.** Writes use `wx` (no overwrite). A colliding id is retried with a fresh one; existing logs are never modified.

## How resume works

The trailing `session/end-seed` event makes the whole imported log *seed history*: when you continue an imported session, DSH replays the log as inherited context, then starts a clean live segment — the model sees the prior conversation exactly as DSH would have logged it. The agent preset and tools of the *current* runtime apply; tools the old agent had and DSH does not simply become history.

## Notes & limitations

- **Read-only on sources.** The importer never writes to the source agents' directories.
- **Images and attachments** are not imported (DSH attachments are content-addressed host objects); their surrounding text is.
- **Compaction history** in source transcripts is flattened to plain messages.
- **Source-specific gaps**, by design of the source format: Cursor transcripts don't record tool results (calls import without results); ChatGPT exports have no structured tool calls (tool messages become text); Kimi CLI sub-agent internals mirrored as `SubagentEvent` are skipped (import `subagents/<id>/wire.jsonl` directly if you want them).
- **SQLite sources are read immutably** (`mode=ro&immutable=1`), so a running Hermes/OpenClaw gateway is never disturbed. OpenClaw imports every `session_window`; resets/rollover windows appear as separate sessions (they were separate transcripts upstream too).
- **Aider scan roots** are `$DSH_MIGRATE_SCAN` (path-list), `~/projects`, `~/code`, `~/dev`, `~/work`, and a shallow `$HOME` sweep — its history files live inside projects, so a fixed home-relative path cannot find them.
- Format drift: these layouts are undocumented internals of the source agents and change over time. Adapters skip what they do not recognise; if your agent version is newer, please open an issue with a (redacted) sample row.

## Development

```sh
npm install
npm run build      # tsc → dist/
npm test           # fixture-driven end-to-end tests (real DSH codec replay)
```

The test suite replays produced logs through the actual `@deepseek-ai/dsh-session` codec (`decodeStorageRecord` + `foldSurface`) vendored from a live DSH profile, so format regressions fail loudly.

## Contributing a source adapter

One adapter = one file in `src/formats/` implementing:

```ts
interface SourceAdapter {
  key: string
  label: string
  detect(home: string): Promise<DiscoveredSource | undefined>
  readSessions(home: string, options?: { limit?: number }): Promise<IrSession[]>
  readMemories(home: string): Promise<IrMemory[]>
}
```

Register it in `src/formats/index.ts` and add a fixture test. See `src/formats/claude-code.ts` for the reference implementation.

## License

MIT
