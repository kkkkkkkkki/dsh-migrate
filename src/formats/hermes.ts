/**
 * Hermes Agent adapter (NousResearch/hermes-agent).
 *
 * Layout (~/.hermes, or $HERMES_HOME):
 *   state.db            — SQLite store: `sessions` + `messages` tables
 *   memories/MEMORY.md  — agent's personal notes (built-in file memory)
 *   memories/USER.md    — what the agent knows about the user
 *
 * state.db is read strictly read-only (immutable URI) so a running Hermes
 * gateway is never disturbed. Messages rows carry OpenAI-chat-shaped fields:
 * `role`, `content`, `tool_calls` (JSON array), `tool_call_id`, `tool_name`,
 * `reasoning`, `timestamp` (epoch seconds). Soft-deleted rows (active=0,
 * compacted=0) are skipped; compacted rows are kept (they are durable
 * display history).
 */
import { join } from 'node:path'
import type { DiscoveredSource, IrMemory, IrSession, IrTurn, SourceAdapter } from '../ir.ts'
import { asObject, asString, asTime, pathExists, readText } from '../util.ts'
import { openReadOnly, sqliteAvailable } from '../sqlite.ts'

const KEY = 'hermes'
const LABEL = 'Hermes Agent'

interface SessionRow {
  id: string
  source: string
  title: string | null
  model: string | null
  cwd: string | null
  started_at: number
}

interface MessageRow {
  role: string
  content: string | null
  tool_call_id: string | null
  tool_calls: string | null
  tool_name: string | null
  reasoning: string | null
  reasoning_content: string | null
  timestamp: number
}

function dbPath(home: string): string {
  return join(home, '.hermes', 'state.db')
}

function sessionToIr(header: SessionRow, rows: MessageRow[]): IrSession | undefined {
  const turns: IrTurn[] = []
  let current: IrTurn | undefined
  const flush = () => {
    if (current !== undefined && current.messages.length > 0) turns.push(current)
    current = undefined
  }

  // Pending assistant tool calls by call id, for result pairing.
  const pending = new Map<string, { name: string; arguments: string; message: { toolCalls: { id?: string; result?: { text: string; isError?: boolean } }[] } }>()

  for (const row of rows) {
    const time = asTime(row.timestamp)
    const role = row.role

    if (role === 'user') {
      const text = (row.content ?? '').trim()
      if (text === '') continue
      flush()
      current = { messages: [{ role: 'user', text: [text], reasoning: [], toolCalls: [], time }], time }
      continue
    }

    if (role === 'assistant') {
      const text = (row.content ?? '').trim()
      const reasoning = (row.reasoning_content ?? row.reasoning ?? '').trim()
      const toolCalls: { id?: string; name: string; arguments: string; result?: { text: string; isError?: boolean } }[] = []
      const rawCalls = row.tool_calls
      if (rawCalls !== null) {
        try {
          const parsed: unknown = JSON.parse(rawCalls)
          if (Array.isArray(parsed)) {
            for (const rawCall of parsed) {
              const call = asObject(rawCall)
              if (call === undefined) continue
              const fn = asObject(call.function)
              const name = asString(fn?.name) ?? asString(call.name)
              if (name === undefined) continue
              const args = typeof fn?.arguments === 'string' ? fn.arguments : JSON.stringify(fn?.arguments ?? call.arguments ?? {})
              const id = asString(call.id)
              toolCalls.push({ id, name, arguments: args })
            }
          }
        } catch {
          // malformed tool_calls JSON — keep the rest of the message
        }
      }
      if (text === '' && reasoning === '' && toolCalls.length === 0) continue
      if (current === undefined) current = { messages: [], time }
      const message = {
        role: 'assistant' as const,
        text: text === '' ? [] : [text],
        reasoning: reasoning === '' ? [] : [reasoning],
        toolCalls,
        time,
      }
      current.messages.push(message)
      for (const call of toolCalls) {
        if (call.id !== undefined) pending.set(call.id, { name: call.name, arguments: call.arguments, message })
      }
      continue
    }

    if (role === 'tool' || role === 'toolResult') {
      const callId = row.tool_call_id ?? undefined
      const text = row.content ?? ''
      if (callId !== undefined) {
        const hit = pending.get(callId)
        if (hit !== undefined) {
          const flat = hit.message.toolCalls.find(c => c.id === callId && c.result === undefined)
          if (flat !== undefined) flat.result = { text }
        }
      }
      continue
    }
    // system / developer / other roles: skip (system prompt is runtime state)
  }
  flush()
  if (turns.length === 0) return undefined

  return {
    source: KEY,
    sourceId: header.id,
    cwd: header.cwd ?? undefined,
    createdAt: asTime(header.started_at),
    provider: header.source || undefined,
    model: header.model ?? undefined,
    turns,
  }
}

export const hermesAdapter: SourceAdapter = {
  key: KEY,
  label: LABEL,

  async detect(home: string): Promise<DiscoveredSource | undefined> {
    const root = join(home, '.hermes')
    if (!(await pathExists(root))) return undefined
    const db = dbPath(home)
    const hasDb = await pathExists(db)
    const memoryMd = await pathExists(join(root, 'memories', 'MEMORY.md'))
    const userMd = await pathExists(join(root, 'memories', 'USER.md'))
    if (!hasDb && !memoryMd && !userMd) return undefined

    let sessionCount = 0
    if (hasDb && sqliteAvailable()) {
      try {
        const handle = openReadOnly(db)
        try {
          const row = handle.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }
          sessionCount = row.n
        } finally {
          handle.close()
        }
      } catch {
        // schema drift or locked db — report what we know
      }
    }
    return { source: KEY, label: LABEL, root, sessionCount, memoryCount: (memoryMd ? 1 : 0) + (userMd ? 1 : 0) }
  },

  async readSessions(home: string, options?: { limit?: number }): Promise<IrSession[]> {
    const db = dbPath(home)
    if (!(await pathExists(db)) || !sqliteAvailable()) return []
    const handle = openReadOnly(db)
    try {
      const sessions = handle.prepare(
        'SELECT id, source, title, model, cwd, started_at FROM sessions ORDER BY started_at ASC',
      ).all() as unknown as SessionRow[]
      const limited = options?.limit !== undefined ? sessions.slice(-options.limit) : sessions
      const out: IrSession[] = []
      const messageStmt = handle.prepare(
        'SELECT role, content, tool_call_id, tool_calls, tool_name, reasoning, reasoning_content, timestamp '
        + 'FROM messages WHERE session_id = ? AND (active = 1 OR compacted = 1) ORDER BY id ASC',
      )
      for (const header of limited) {
        const rows = messageStmt.all(header.id) as unknown as MessageRow[]
        const parsed = sessionToIr(header, rows)
        if (parsed !== undefined) out.push(parsed)
      }
      return out
    } finally {
      handle.close()
    }
  },

  async readMemories(home: string): Promise<IrMemory[]> {
    const root = join(home, '.hermes', 'memories')
    const out: IrMemory[] = []
    for (const [file, title] of [['MEMORY.md', 'Hermes MEMORY.md'], ['USER.md', 'Hermes USER.md']] as const) {
      const body = await readText(join(root, file))
      if (body !== undefined && body.trim() !== '') {
        out.push({ kind: 'notes', title, body })
      }
    }
    return out
  },
}
