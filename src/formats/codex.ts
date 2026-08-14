/**
 * Codex CLI adapter (OpenAI).
 *
 * Layout:
 *   ~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-<ts>-<uuid>.jsonl — transcripts
 *   ~/.codex/AGENTS.md (and ~/.codex/instructions.md on older versions)
 *
 * Transcript rows: `{ timestamp, type, payload }`. Relevant types:
 *   response_item with payload.type message / reasoning / function_call /
 *   function_call_output / local_shell_call; turn_context rows carry cwd.
 */
import { join } from 'node:path'
import type { DiscoveredSource, IrMemory, IrSession, IrTurn, SourceAdapter } from '../ir.ts'
import { asObject, asString, asTime, collectFiles, pathExists, readJsonl, readText } from '../util.ts'

const KEY = 'codex'
const LABEL = 'Codex CLI'

interface Accum {
  turns: IrTurn[]
  current: IrTurn | undefined
  cwd: string | undefined
  sessionId: string | undefined
  model: string | undefined
  createdAt: number | undefined
  pendingCalls: Map<string, { name: string; arguments: string }>
}

function flush(acc: Accum): void {
  if (acc.current !== undefined && acc.current.messages.length > 0) acc.turns.push(acc.current)
  acc.current = undefined
}

function readRollout(rows: unknown[]): IrSession | undefined {
  const acc: Accum = {
    turns: [],
    current: undefined,
    cwd: undefined,
    sessionId: undefined,
    model: undefined,
    createdAt: undefined,
    pendingCalls: new Map(),
  }
  for (const raw of rows) {
    const row = asObject(raw)
    if (row === undefined) continue
    const time = asTime(row.timestamp)
    acc.createdAt ??= time
    const type = asString(row.type)
    const payload = asObject(row.payload)

    if (type === 'session_meta' && payload !== undefined) {
      acc.sessionId ??= asString(payload.id)
      acc.cwd ??= asString(payload.cwd)
      continue
    }
    if (type === 'turn_context' && payload !== undefined) {
      acc.cwd ??= asString(payload.cwd)
      acc.model ??= asString(payload.model)
      continue
    }
    if (type !== 'response_item' || payload === undefined) continue
    const itemType = asString(payload.type)

    if (itemType === 'message') {
      const role = asString(payload.role)
      const parts: string[] = []
      const content = payload.content
      if (Array.isArray(content)) {
        for (const part of content) {
          const p = asObject(part)
          const t = p !== undefined ? asString(p.text) : undefined
          if (t !== undefined && t.trim() !== '') parts.push(t)
        }
      }
      if (parts.length === 0) continue
      if (role === 'user') {
        flush(acc)
        acc.current = {
          messages: [{ role: 'user', text: parts, reasoning: [], toolCalls: [], time }],
          time,
        }
      } else if (role === 'assistant') {
        if (acc.current === undefined) acc.current = { messages: [], time }
        acc.current.messages.push({ role: 'assistant', text: parts, reasoning: [], toolCalls: [], time })
      }
      continue
    }
    if (itemType === 'reasoning') {
      const summaries: string[] = []
      const summary = payload.summary
      if (Array.isArray(summary)) {
        for (const part of summary) {
          const p = asObject(part)
          const t = p !== undefined ? asString(p.text) : undefined
          if (t !== undefined && t.trim() !== '') summaries.push(t)
        }
      }
      if (summaries.length === 0) continue
      if (acc.current === undefined) acc.current = { messages: [], time }
      acc.current.messages.push({ role: 'assistant', text: [], reasoning: summaries, toolCalls: [], time })
      continue
    }
    if (itemType === 'function_call' || itemType === 'local_shell_call') {
      const name = asString(payload.name) ?? (itemType === 'local_shell_call' ? 'shell' : undefined)
      if (name === undefined) continue
      const callId = asString(payload.call_id) ?? asString(payload.callId) ?? asString(payload.id)
      const args = typeof payload.arguments === 'string'
        ? payload.arguments
        : JSON.stringify(payload.action ?? payload.arguments ?? {})
      if (callId !== undefined) acc.pendingCalls.set(callId, { name, arguments: args })
      if (acc.current === undefined) acc.current = { messages: [], time }
      acc.current.messages.push({
        role: 'assistant',
        text: [],
        reasoning: [],
        toolCalls: [{ id: callId, name, arguments: args }],
        time,
      })
      continue
    }
    if (itemType === 'function_call_output') {
      const callId = asString(payload.call_id) ?? asString(payload.callId)
      const output = asString(payload.output) ?? JSON.stringify(payload.output ?? '')
      if (callId === undefined || acc.current === undefined) continue
      const flat = acc.current.messages.flatMap(m => m.toolCalls)
      const target = flat.find(c => c.id === callId && c.result === undefined)
      if (target !== undefined) target.result = { text: output }
      continue
    }
  }
  flush(acc)
  if (acc.turns.length === 0) return undefined
  return {
    source: KEY,
    sourceId: acc.sessionId,
    cwd: acc.cwd,
    createdAt: acc.createdAt,
    provider: 'openai',
    model: acc.model,
    turns: acc.turns,
  }
}

export const codexAdapter: SourceAdapter = {
  key: KEY,
  label: LABEL,

  async detect(home: string): Promise<DiscoveredSource | undefined> {
    const root = join(home, '.codex')
    if (!(await pathExists(root))) return undefined
    const files = await collectFiles(join(root, 'sessions'), name => name.startsWith('rollout-') && name.endsWith('.jsonl'), { maxDepth: 8 })
    let memoryCount = 0
    for (const name of ['AGENTS.md', 'instructions.md']) {
      if (await pathExists(join(root, name))) memoryCount += 1
    }
    if (files.length === 0 && memoryCount === 0) return undefined
    return { source: KEY, label: LABEL, root, sessionCount: files.length, memoryCount }
  },

  async readSessions(home: string, options?: { limit?: number }): Promise<IrSession[]> {
    const files = await collectFiles(join(home, '.codex', 'sessions'), name => name.startsWith('rollout-') && name.endsWith('.jsonl'), { maxDepth: 8 })
    const limited = options?.limit !== undefined ? files.slice(-options.limit) : files
    const sessions: IrSession[] = []
    for (const file of limited) {
      const parsed = readRollout(await readJsonl(file))
      if (parsed !== undefined) sessions.push(parsed)
    }
    return sessions
  },

  async readMemories(home: string): Promise<IrMemory[]> {
    const out: IrMemory[] = []
    for (const name of ['AGENTS.md', 'instructions.md']) {
      const body = await readText(join(home, '.codex', name))
      if (body !== undefined && body.trim() !== '') {
        out.push({ kind: 'instruction', title: `Codex ${name}`, body })
      }
    }
    return out
  },
}
