/**
 * OpenClaw adapter.
 *
 * Layout (~/.openclaw):
 *   agents/<agentId>/agent/openclaw-agent.sqlite — per-agent store with
 *     `session_nodes` (sessionKey → current_session_id + entry_json),
 *     `session_windows` (one row per transcript window), and
 *     `transcript_events` (append-only rows: session_id + seq + event_json)
 *   <workspace>/MEMORY.md, <workspace>/memory/*.md — curated memory
 *     (workspace dir resolved from the session entry's cwd, defaulting to
 *     ~/.openclaw/workspace)
 *
 * The database is opened read-only/immutable; a running Gateway is never
 * disturbed. Event rows are the same JSONL entries the legacy file backend
 * used (message / custom_message / compaction / branch_summary / reset …),
 * so the reader is shared between both shapes.
 */
import { join } from 'node:path'
import type { DiscoveredSource, IrMemory, IrSession, IrToolCall, IrTurn, SourceAdapter } from '../ir.ts'
import { asObject, asString, asTime, collectFiles, listDir, pathExists, readText } from '../util.ts'
import { openReadOnly, sqliteAvailable } from '../sqlite.ts'

const KEY = 'openclaw'
const LABEL = 'OpenClaw'

// ---------------------------------------------------------------------------
// Transcript entry decoding (shared shape with the legacy JSONL backend)
// ---------------------------------------------------------------------------

function contentToText(content: unknown): { text: string[]; toolResults: string[] } {
  const text: string[] = []
  const toolResults: string[] = []
  if (typeof content === 'string') {
    if (content.trim() !== '') text.push(content)
    return { text, toolResults }
  }
  if (!Array.isArray(content)) return { text, toolResults }
  for (const rawBlock of content) {
    const block = asObject(rawBlock)
    if (block === undefined) continue
    const type = asString(block.type)
    if (type === 'text') {
      const t = asString(block.text)
      if (t !== undefined && t.trim() !== '') text.push(t)
    } else if (type === 'tool_result' || type === 'toolResult') {
      const inner = block.content
      if (typeof inner === 'string' && inner.trim() !== '') toolResults.push(inner)
      else {
        const t = asString(asObject(inner)?.text)
        if (t !== undefined && t.trim() !== '') toolResults.push(t)
      }
    }
  }
  return { text, toolResults }
}

function toolCallsOf(message: Record<string, unknown>): IrToolCall[] {
  const out: IrToolCall[] = []
  const content = message.content
  if (!Array.isArray(content)) return out
  for (const rawBlock of content) {
    const block = asObject(rawBlock)
    if (block === undefined) continue
    const type = asString(block.type)
    if (type !== 'toolCall' && type !== 'tool_use') continue
    const name = asString(block.name)
    if (name === undefined) continue
    const args = block.arguments !== undefined
      ? (typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments))
      : JSON.stringify(block.input ?? {})
    out.push({ id: asString(block.id), name, arguments: args })
  }
  return out
}

interface WindowRow {
  session_id: string
  session_key: string
  created_at: number
  started_at: number | null
}

function entriesToIr(
  window: WindowRow,
  entries: Record<string, unknown>[],
  entryMeta: Record<string, unknown>,
): IrSession | undefined {
  // cwd / model from the session entry_json (best effort)
  const cwd = asString(entryMeta.cwd) ?? asString(entryMeta.workDir)
  const model = asString(entryMeta.model)
  const provider = asString(entryMeta.provider)

  const turns: IrTurn[] = []
  let current: IrTurn | undefined
  const flush = () => {
    if (current !== undefined && current.messages.length > 0) turns.push(current)
    current = undefined
  }
  // Pending tool calls for result pairing, by call id.
  const pending = new Map<string, IrToolCall[]>()

  for (const entry of entries) {
    const time = asTime(entry.timestamp)
    const type = asString(entry.type)

    if (type === 'message') {
      const message = asObject(entry.message)
      if (message === undefined) continue
      const role = asString(message.role)
      const { text, toolResults } = contentToText(message.content)
      const calls = toolCallsOf(message)
      const reasoning: string[] = []
      if (Array.isArray(message.content)) {
        for (const rawBlock of message.content) {
          const block = asObject(rawBlock)
          if (block === undefined) continue
          const t = asString(block.type)
          if (t === 'thinking' || t === 'reasoning') {
            const body = asString(block.thinking) ?? asString(block.text)
            if (body !== undefined && body.trim() !== '') reasoning.push(body)
          }
        }
      }

      if (role === 'user') {
        if (text.length === 0 && toolResults.length === 0) continue
        if (text.length === 0 && toolResults.length > 0 && current !== undefined) {
          // tool-result-only user row — attach to pending calls in order
          const flat = current.messages.flatMap(m => m.toolCalls)
          for (const resultText of toolResults) {
            const pendingCall = flat.find(c => c.result === undefined)
            if (pendingCall !== undefined) pendingCall.result = { text: resultText }
          }
          continue
        }
        flush()
        current = { messages: [{ role: 'user', text, reasoning: [], toolCalls: [], time }], time }
        continue
      }
      if (role === 'assistant') {
        if (text.length === 0 && reasoning.length === 0 && calls.length === 0) continue
        if (current === undefined) current = { messages: [], time }
        current.messages.push({ role: 'assistant', text, reasoning, toolCalls: calls, time })
        for (const call of calls) {
          if (call.id !== undefined) {
            const bucket = pending.get(call.id) ?? []
            bucket.push(call)
            pending.set(call.id, bucket)
          }
        }
        continue
      }
      if (role === 'toolResult' || role === 'tool') {
        const callId = asString(message.toolCallId) ?? asString(message.tool_call_id)
        const resultText = [...toolResults, ...text].join('\n')
        if (callId !== undefined && resultText !== '') {
          const bucket = pending.get(callId)
          const target = bucket?.find(c => c.result === undefined)
          if (target !== undefined) target.result = { text: resultText }
        }
        continue
      }
      // bashExecution / custom roles: text only, as assistant-visible context
      if (text.length > 0) {
        if (current === undefined) current = { messages: [], time }
        current.messages.push({ role: 'assistant', text, reasoning: [], toolCalls: [], time })
      }
      continue
    }

    if (type === 'custom_message') {
      // Extension-authored message that enters model context.
      const display = entry.display !== false
      if (!display) continue
      const { text } = contentToText(entry.content)
      if (text.length === 0) continue
      if (current === undefined) current = { messages: [], time }
      current.messages.push({ role: 'assistant', text, reasoning: [], toolCalls: [], time })
      continue
    }

    if (type === 'compaction' || type === 'branch_summary') {
      // Persisted summaries ARE part of the model-visible rolling history.
      const summary = asString(entry.summary)
      if (summary === undefined || summary.trim() === '') continue
      flush()
      current = {
        messages: [{ role: 'user', text: [`[${type} summary] ${summary}`], reasoning: [], toolCalls: [], time }],
        time,
      }
      flush()
      continue
    }
    // reset / label / model_change / session_info / custom / thinking_level_change:
    // metadata that does not produce messages.
  }
  flush()
  if (turns.length === 0) return undefined

  return {
    source: KEY,
    sourceId: window.session_id,
    cwd,
    createdAt: asTime(window.started_at ?? window.created_at),
    provider,
    model,
    turns,
  }
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

function agentsRoot(home: string): string {
  return join(home, '.openclaw', 'agents')
}

export const openClawAdapter: SourceAdapter = {
  key: KEY,
  label: LABEL,

  async detect(home: string): Promise<DiscoveredSource | undefined> {
    const root = join(home, '.openclaw')
    if (!(await pathExists(root))) return undefined
    const agents = await listDir(agentsRoot(home))
    let sessionCount = 0
    let foundDb = false
    if (sqliteAvailable()) {
      for (const agentId of agents) {
        const db = join(agentsRoot(home), agentId, 'agent', 'openclaw-agent.sqlite')
        if (!(await pathExists(db))) continue
        foundDb = true
        try {
          const handle = openReadOnly(db)
          try {
            const row = handle.prepare('SELECT COUNT(*) AS n FROM session_windows').get() as { n: number }
            sessionCount += row.n
          } finally {
            handle.close()
          }
        } catch {
          // unreadable or older schema — still report the agent
        }
      }
    }
    // Memory: MEMORY.md / memory/*.md under the default workspace
    let memoryCount = 0
    const workspace = join(root, 'workspace')
    if (await pathExists(join(workspace, 'MEMORY.md'))) memoryCount += 1
    memoryCount += (await collectFiles(join(workspace, 'memory'), name => name.endsWith('.md'), { maxDepth: 2, maxFiles: 500 })).length
    if (!foundDb && memoryCount === 0) return undefined
    return { source: KEY, label: LABEL, root, sessionCount, memoryCount }
  },

  async readSessions(home: string, options?: { limit?: number }): Promise<IrSession[]> {
    if (!sqliteAvailable()) return []
    const out: IrSession[] = []
    for (const agentId of await listDir(agentsRoot(home))) {
      const db = join(agentsRoot(home), agentId, 'agent', 'openclaw-agent.sqlite')
      if (!(await pathExists(db))) continue
      let handle
      try {
        handle = openReadOnly(db)
      } catch {
        continue
      }
      try {
        const windows = handle.prepare(
          'SELECT w.session_id, w.session_key, w.created_at, w.started_at, n.entry_json '
          + 'FROM session_windows w LEFT JOIN session_nodes n ON n.session_key = w.session_key '
          + 'ORDER BY w.created_at ASC',
        ).all() as unknown as (WindowRow & { entry_json: string | null })[]
        const limited = options?.limit !== undefined ? windows.slice(-options.limit) : windows
        const eventStmt = handle.prepare(
          'SELECT event_json FROM transcript_events WHERE session_id = ? ORDER BY seq ASC',
        )
        for (const window of limited) {
          let entryMeta: Record<string, unknown> = {}
          if (window.entry_json !== null) {
            try {
              entryMeta = asObject(JSON.parse(window.entry_json)) ?? {}
            } catch {
              // keep empty
            }
          }
          const rows = eventStmt.all(window.session_id) as unknown as { event_json: string }[]
          const entries: Record<string, unknown>[] = []
          for (const row of rows) {
            try {
              const parsed = asObject(JSON.parse(row.event_json))
              if (parsed !== undefined) entries.push(parsed)
            } catch {
              // skip malformed event row
            }
          }
          const parsed = entriesToIr(window, entries, entryMeta)
          if (parsed !== undefined) out.push(parsed)
        }
      } catch {
        // schema drift (older file-backed release) — nothing to read here
      } finally {
        handle.close()
      }
    }
    return out
  },

  async readMemories(home: string): Promise<IrMemory[]> {
    const workspace = join(home, '.openclaw', 'workspace')
    const out: IrMemory[] = []
    const memoryMd = await readText(join(workspace, 'MEMORY.md'))
    if (memoryMd !== undefined && memoryMd.trim() !== '') {
      out.push({ kind: 'notes', title: 'OpenClaw MEMORY.md', body: memoryMd })
    }
    const daily = await collectFiles(join(workspace, 'memory'), name => name.endsWith('.md'), { maxDepth: 2, maxFiles: 500 })
    for (const file of daily) {
      const body = await readText(file)
      if (body === undefined || body.trim() === '') continue
      out.push({ kind: 'notes', title: `OpenClaw memory/${file.split(/[\\/]/).pop()}`, body })
    }
    return out
  },
}
