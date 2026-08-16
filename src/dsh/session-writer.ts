/**
 * Write imported sessions as DeepSeek Harness session logs.
 *
 * The writer targets the raw JSONL layout (`compression: 'none'`) of
 * `@deepseek-ai/dsh-session-persistence-jsonl`: one directory per project,
 * one directory per session, a `session.jsonl` whose first line is the
 * `SessionHeader` and whose remaining lines are `SessionEvent`s with
 * contiguous `seq`. The stock zstd reader loads these files unchanged —
 * reading is layout-blind and a root belongs to one encoding, so the
 * migration root is `sessions-imported` with `compression: 'none'` (the
 * shipped cordis.patch.yml points the persistence row at it).
 *
 * Event vocabulary follows `@deepseek-ai/dsh-session`'s SESSION_FORMAT_VERSION 0:
 *   header, turn/start, user/message, step/start, assistant/message,
 *   tool/call, tool/result, step/end, turn/end …
 * The final `session/end-seed` marks the whole log as imported seed history:
 * a resumed DSH loop treats everything before it as inherited context.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile, access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import type { IrMessage, IrSession, IrToolCall } from '../ir.ts'

/** DSH on-disk format version (SESSION_FORMAT_VERSION). */
export const SESSION_FORMAT_VERSION = 0

/** Provider name stamped on imported assistant provenance. */
export const IMPORT_PROVIDER = 'dsh-migrate'

// ---------------------------------------------------------------------------
// Path encoding — keep in sync with session-persistence-jsonl/src/format.ts.
// These are re-implemented (not imported) so the CLI works standalone, without
// a DSH installation on the module path.
// ---------------------------------------------------------------------------

/** Encode an arbitrary string as one safe path segment (format.ts `encodeSegment`). */
export function encodeSegment(raw: string): string {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      out += ch
    } else {
      out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
    }
  }
  return out
}

/** Readable project directory key for a cwd (format.ts `projectKey`). */
export function projectKey(cwd: string): string {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  const slug = readable.replace(/^-+/, '') || 'root'
  return `--${slug.slice(0, 251)}--`
}

export function projectDir(root: string, cwd: string | undefined): string {
  return cwd === undefined ? join(root, '_no-cwd') : join(root, projectKey(cwd))
}

export function sessionDir(root: string, cwd: string | undefined, id: string): string {
  return join(projectDir(root, cwd), encodeSegment(id))
}

export function logPath(root: string, cwd: string | undefined, id: string): string {
  return join(sessionDir(root, cwd, id), 'session.jsonl')
}

// ---------------------------------------------------------------------------
// Event model (structural; matches @deepseek-ai/dsh-session without importing it)
// ---------------------------------------------------------------------------

export interface DshEvent {
  type: string
  seq: number
  time: number
  data: unknown
  surfaceOp?: 'append' | { op: 'replace'; start: number; end: number }
  sourceEventSeqs?: number[]
  ignorable?: true
}

/**
 * Provenance tag for imported user-side messages.
 *
 * `kind: 'user'` is required for end-to-end visibility: the trajectory view
 * renders `user/message` events whose source is user-kind, and the loop
 * derives history from the surface verbatim regardless of source. The
 * importer is declared on the merge-extensible `via` channel
 * (`{ kind: 'user', via: 'dsh-migrate:<source>' }`) so UI and tooling can
 * still tell imported input apart from live typing. Unknown source fields
 * ride the log untouched, so a stock runtime simply ignores `via`.
 */
function importSource(session: IrSession): Record<string, unknown> {
  return { kind: 'user', via: `${IMPORT_PROVIDER}:${session.source}` }
}

function newId(): string {
  return randomUUID()
}

// ---------------------------------------------------------------------------
// Turn → events
// ---------------------------------------------------------------------------

interface EmitState {
  seq: number
  time: number
  lines: string[]
}

function push(state: EmitState, type: string, data: unknown, extra?: Partial<DshEvent>): void {
  const event: DshEvent = { type, seq: state.seq, time: state.time, data, ...extra }
  state.lines.push(JSON.stringify(event))
  state.seq += 1
}

function advanceTime(state: EmitState, next: number | undefined): void {
  if (next !== undefined && next >= state.time) state.time = next
}

function emitToolCall(state: EmitState, turn: number, step: number, call: IrToolCall): void {
  const callId = call.id ?? newId()
  push(state, 'tool/call', {
    turn,
    step,
    callId,
    name: call.name,
    arguments: call.arguments,
  })
  const result = call.result
  push(state, 'tool/result', {
    turn,
    step,
    message: {
      id: newId(),
      role: 'user',
      source: { kind: 'tool', callId },
      content: [{
        type: 'tool-result',
        toolCallId: callId,
        content: [{ type: 'text', text: result?.text ?? '' }],
        ...(result?.isError ? { isError: true } : {}),
      }],
    },
  }, { surfaceOp: 'append' })
}

function emitMessage(
  state: EmitState,
  turn: number,
  step: number,
  message: IrMessage,
  session: IrSession,
): void {
  advanceTime(state, message.time)
  if (message.role === 'assistant') {
    const content: unknown[] = []
    for (const text of message.reasoning) {
      if (text !== '') content.push({ type: 'reasoning', text })
    }
    for (const text of message.text) {
      if (text !== '') content.push({ type: 'text', text })
    }
    for (const call of message.toolCalls) {
      content.push({
        type: 'tool-call',
        id: call.id ?? newId(),
        name: call.name,
        arguments: call.arguments,
      })
    }
    if (content.length === 0) return
    push(state, 'assistant/message', {
      turn,
      step,
      message: {
        id: newId(),
        role: 'assistant',
        source: {
          kind: 'model',
          provider: session.provider ? `${IMPORT_PROVIDER}:${session.provider}` : IMPORT_PROVIDER,
          model: session.model ?? 'imported',
        },
        content,
      },
    }, { surfaceOp: 'append', sourceEventSeqs: [] })
    for (const call of message.toolCalls) {
      if (call.result !== undefined) emitToolCall(state, turn, step, call)
    }
  } else {
    // user + system messages both land on the user-role surface; the `via`
    // provenance keeps them honest as imported rather than live user input.
    const text = [...message.text].filter(t => t !== '').join('\n\n')
    if (text === '') return
    push(state, 'user/message', {
      id: newId(),
      role: 'user',
      source: importSource(session),
      content: [{ type: 'text', text }],
    }, { surfaceOp: 'append' })
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface WriteSessionResult {
  id: string
  path: string
  events: number
}

/**
 * Render one imported session to its `session.jsonl` text. Exported for tests
 * and for the DSH-side command that prefers in-process writes.
 */
export function renderSessionLog(session: IrSession, options: { id?: string; now?: number } = {}): { id: string; text: string; events: number } {
  const id = options.id ?? newId()
  const createdAt = session.createdAt ?? options.now ?? Date.now()
  const header: Record<string, unknown> = {
    type: 'session',
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt,
    delegationDepth: 0,
  }
  if (session.cwd !== undefined) header.cwd = session.cwd
  // Import provenance on the header itself, so importers and UIs can filter or
  // badge migrated sessions without walking the event stream.
  header.importedSource = session.source
  if (session.sourceId !== undefined) header.importedSourceId = session.sourceId

  const state: EmitState = { seq: 0, time: createdAt, lines: [] }
  let turnNo = 0
  for (const turn of session.turns) {
    advanceTime(state, turn.time)
    turnNo += 1
    push(state, 'turn/start', { turn: turnNo })
    let stepNo = 0
    for (const message of turn.messages) {
      if (message.role === 'assistant') {
        stepNo += 1
        push(state, 'step/start', { turn: turnNo, step: stepNo })
        emitMessage(state, turnNo, stepNo, message, session)
        push(state, 'step/end', { turn: turnNo, step: stepNo })
      } else {
        emitMessage(state, turnNo, stepNo, message, session)
      }
    }
    push(state, 'turn/end', { turn: turnNo, reason: { kind: 'completed' } })
  }
  // Mark the entire imported log as seed history: a resumed session inherits
  // it wholesale instead of treating it as this lifecycle's live work.
  push(state, 'session/end-seed', {})

  const text = JSON.stringify(header) + '\n' + state.lines.join('\n') + '\n'
  return { id, text, events: state.seq }
}

/**
 * Write one imported session under `root` in the DSH JSONL layout.
 * Never overwrites: a colliding id is retried with a fresh one.
 */
export async function writeSession(
  root: string,
  session: IrSession,
  options: { id?: string } = {},
): Promise<WriteSessionResult> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const rendered = renderSessionLog(session, { id: attempt === 0 ? options.id : undefined })
    const path = logPath(root, session.cwd, rendered.id)
    try {
      await access(path, constants.F_OK)
      continue // id collision — retry with a fresh id
    } catch {
      // free
    }
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, rendered.text, { encoding: 'utf8', flag: 'wx' })
    return { id: rendered.id, path, events: rendered.events }
  }
  throw new Error('could not allocate a unique session id after 3 attempts')
}
