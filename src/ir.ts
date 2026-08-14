/**
 * Provider-neutral intermediate representation (IR) every source adapter
 * produces and the DSH writer consumes.
 *
 * The IR deliberately mirrors DeepSeek Harness's session-log vocabulary one
 * level removed: an `IrMessage` becomes a `user/message` or
 * `assistant/message` event, an `IrToolPair` becomes `tool/call` +
 * `tool/result`, and a turn becomes `turn/start` … `turn/end`.
 */

/** A normalized chat message. */
export interface IrMessage {
  role: 'user' | 'assistant' | 'system'
  /** Visible text parts of the message, in order. */
  text: string[]
  /** Reasoning / thinking text parts, when the source recorded them. */
  reasoning: string[]
  /** Tool calls requested by this message (assistant role only). */
  toolCalls: IrToolCall[]
  /** Epoch milliseconds; `undefined` when the source has no timestamp. */
  time?: number
}

export interface IrToolCall {
  /** Provider-issued call id, when the source keeps one. */
  id?: string
  name: string
  /** Raw JSON arguments string exactly as the source recorded it. */
  arguments: string
  /** The paired result, when the source records tool output. */
  result?: IrToolResult
}

export interface IrToolResult {
  text: string
  isError?: boolean
}

/**
 * One unit of user-initiated work. Sources without a native turn concept
 * produce one turn per user message (with its following assistant messages).
 */
export interface IrTurn {
  messages: IrMessage[]
  time?: number
}

/** One imported conversation. */
export interface IrSession {
  /** Source agent key, e.g. `claude-code`. */
  source: string
  /** Source-native session identifier, when it has one. */
  sourceId?: string
  /** Project/working directory the session belonged to. */
  cwd?: string
  /** Session creation time in epoch ms. */
  createdAt?: number
  /** Provider/model the source used, when known (goes to provenance). */
  provider?: string
  model?: string
  turns: IrTurn[]
}

/** A durable memory record lifted from a source agent. */
export interface IrMemory {
  /** Memory kind: `instruction` files (CLAUDE.md/AGENTS.md) or note stores. */
  kind: 'instruction' | 'notes'
  /** Short label, e.g. the file it came from. */
  title: string
  /** Markdown body. */
  body: string
  /** Project path this memory is scoped to, if project-scoped. */
  project?: string
}

/** What a source adapter found on disk. */
export interface DiscoveredSource {
  /** Adapter key. */
  source: string
  /** Human label, e.g. "Claude Code". */
  label: string
  /** Root directory the discovery matched. */
  root: string
  /** Number of candidate session transcripts found. */
  sessionCount: number
  /** Number of memory stores/files found. */
  memoryCount: number
}

/** A source adapter: detect + read. */
export interface SourceAdapter {
  readonly key: string
  readonly label: string
  /** Look at `home` and report what this adapter could import. */
  detect(home: string): Promise<DiscoveredSource | undefined>
  /** Read all sessions from this source. */
  readSessions(home: string, options?: { limit?: number }): Promise<IrSession[]>
  /** Read all memory records from this source. */
  readMemories(home: string): Promise<IrMemory[]>
}
