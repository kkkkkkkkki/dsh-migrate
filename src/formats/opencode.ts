/**
 * OpenCode adapter.
 *
 * Layout (opencode.ai, v0.x storage layout):
 *   ~/.local/share/opencode/project/<project-slug>/storage/
 *     session/info/*.json     — session metadata
 *     message/info/*.json     — message envelopes
 *     part/<msg-id>/*.json    — content parts (text / tool / reasoning)
 *
 * The store is append-many small JSON files; we stream them grouped by
 * session id. Older versions kept `~/.local/share/opencode/storage` — the
 * walker simply searches the whole data root, so both resolve.
 */
import { join } from 'node:path'
import type { DiscoveredSource, IrMemory, IrSession, IrTurn, SourceAdapter } from '../ir.ts'
import { asObject, asString, asTime, collectFiles, pathExists, readText } from '../util.ts'

const KEY = 'opencode'
const LABEL = 'OpenCode'

function dataRoot(home: string): string {
  if (process.platform === 'win32') {
    return join(process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'opencode')
  }
  return join(home, '.local', 'share', 'opencode')
}

interface MsgRow {
  id: string
  sessionId?: string
  role?: string
  time?: number
  parts: { type?: string; text?: string; tool?: string; state?: unknown }[]
}

async function readRows(files: string[]): Promise<Map<string, MsgRow[]>> {
  const bySession = new Map<string, MsgRow[]>()
  for (const file of files) {
    const text = await readText(file)
    if (text === undefined) continue
    let doc: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(text)
      const obj = asObject(parsed)
      if (obj === undefined) continue
      doc = obj
    } catch {
      continue
    }
    const id = asString(doc.id)
    if (id === undefined) continue
    const sessionId = asString(doc.sessionID) ?? asString(doc.sessionId)
    const row: MsgRow = {
      id,
      sessionId,
      role: asString(doc.role),
      time: asTime(doc.time) ?? asTime(asObject(doc.time)?.created),
      parts: [],
    }
    const parts = doc.parts
    if (Array.isArray(parts)) {
      for (const rawPart of parts) {
        const part = asObject(rawPart)
        if (part === undefined) continue
        row.parts.push({
          type: asString(part.type),
          text: asString(part.text),
          tool: asString(part.tool),
          state: part.state,
        })
      }
    }
    const key = sessionId ?? '_unknown'
    const bucket = bySession.get(key) ?? []
    bucket.push(row)
    bySession.set(key, bucket)
  }
  return bySession
}

function toSession(sessionId: string, rows: MsgRow[]): IrSession | undefined {
  const ordered = [...rows].sort((a, b) => (a.time ?? 0) - (b.time ?? 0))
  const turns: IrTurn[] = []
  let current: IrTurn | undefined
  const flush = () => {
    if (current !== undefined && current.messages.length > 0) turns.push(current)
    current = undefined
  }
  for (const row of ordered) {
    const text = row.parts.filter(p => p.type === 'text' && p.text !== undefined && p.text.trim() !== '').map(p => p.text as string)
    const reasoning = row.parts.filter(p => (p.type === 'reasoning' || p.type === 'step-start') && p.text !== undefined && p.text.trim() !== '').map(p => p.text as string)
    const toolCalls = row.parts
      .filter(p => p.type === 'tool' && p.tool !== undefined)
      .map(p => {
        const state = asObject(p.state)
        const input = state?.input !== undefined ? JSON.stringify(state.input) : '{}'
        const output = asString(state?.output)
        const status = asString(state?.status)
        return {
          name: p.tool as string,
          arguments: input,
          result: output !== undefined ? { text: output, isError: status === 'error' ? true : undefined } : undefined,
        }
      })
    if (text.length === 0 && reasoning.length === 0 && toolCalls.length === 0) continue
    if (row.role === 'user') {
      flush()
      current = { messages: [{ role: 'user', text, reasoning: [], toolCalls: [], time: row.time }], time: row.time }
    } else {
      if (current === undefined) current = { messages: [], time: row.time }
      current.messages.push({ role: 'assistant', text, reasoning, toolCalls, time: row.time })
    }
  }
  flush()
  if (turns.length === 0) return undefined
  return {
    source: KEY,
    sourceId: sessionId === '_unknown' ? undefined : sessionId,
    provider: undefined,
    model: undefined,
    createdAt: turns[0]?.time,
    turns,
  }
}

export const openCodeAdapter: SourceAdapter = {
  key: KEY,
  label: LABEL,

  async detect(home: string): Promise<DiscoveredSource | undefined> {
    const root = dataRoot(home)
    if (!(await pathExists(root))) return undefined
    const files = await collectFiles(root, name => name.endsWith('.json'), { maxDepth: 8, maxFiles: 200_000 })
    if (files.length === 0) return undefined
    return { source: KEY, label: LABEL, root, sessionCount: files.length, memoryCount: 0 }
  },

  async readSessions(home: string, options?: { limit?: number }): Promise<IrSession[]> {
    const sep = join('message', 'info')
    const files = await collectFiles(dataRoot(home), (_name, full) => full.includes(sep), { maxDepth: 8, maxFiles: 200_000 })
    const limited = options?.limit !== undefined ? files.slice(-options.limit) : files
    const bySession = await readRows(limited)
    const sessions: IrSession[] = []
    for (const [sessionId, rows] of bySession) {
      const parsed = toSession(sessionId, rows)
      if (parsed !== undefined) sessions.push(parsed)
    }
    return sessions
  },

  async readMemories(): Promise<IrMemory[]> {
    return []
  },
}
