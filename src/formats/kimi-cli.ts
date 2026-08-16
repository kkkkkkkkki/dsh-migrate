/**
 * Kimi CLI adapter (Moonshot AI's kimi-cli).
 *
 * Storage (upstream layout):
 *   ~/.kimi/sessions/<workdir-md5>/<session-id>/wire.jsonl   — event stream
 *   ~/.kimi/sessions/<workdir-md5>/<session-id>/state.json   — custom_title, cwd
 *   ~/.kimi/kimi.json                                        — work_dirs[{path}]
 *
 * wire.jsonl's first line is {"type":"metadata",...}; each later line is
 * {"timestamp": <sec>, "message": {"type": "<PascalCase event>", "payload": {...}}}.
 * Event mapping:
 *   TurnBegin / SteerInput  → new user turn (payload.user_input: string or
 *                             ContentPart[] with {text})
 *   StepBegin               → new assistant step boundary (implicit steps are
 *                             opened for content arriving without one)
 *   TextPart / ThinkPart    → text / reasoning (streamed chunks are merged)
 *   ToolCall                → {id, function:{name, arguments(JSON string)}}
 *   ToolResult              → paired by tool_call_id; orphan results dropped
 *   SubagentEvent           → mirrored sub-agent internals — skipped (the
 *                             parent's Agent call/result already covers it);
 *                             subagents/<id>/wire.jsonl can be imported directly
 * All other events (StatusUpdate, ApprovalRequest, CompactionBegin, …) are
 * control plane and skipped.
 */
import { createHash } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import type { DiscoveredSource, IrMemory, IrSession, IrToolCall, IrTurn, SourceAdapter } from '../ir.ts'
import { asNumber, asObject, asString, asTime, collectFiles, pathExists, readJsonl, readText } from '../util.ts'

const KEY = 'kimi-cli'
const LABEL = 'Kimi CLI'

function userInputText(input: unknown): string {
  if (typeof input === 'string') return input
  if (Array.isArray(input)) {
    return input
      .map(p => {
        const obj = asObject(p)
        return obj !== undefined ? (asString(obj.text) ?? '') : ''
      })
      .join('')
  }
  return ''
}

function toolResultText(returnValue: unknown): { text: string; isError?: boolean } {
  const rv = asObject(returnValue)
  if (rv === undefined) return { text: '' }
  const output = rv.output
  let text = ''
  if (typeof output === 'string') text = output.trim()
  else if (Array.isArray(output)) {
    const parts: string[] = []
    for (const part of output) {
      const p = asObject(part)
      if (p === undefined) continue
      const t = asString(p.text)
      if (t !== undefined && t !== '') parts.push(t)
    }
    text = parts.join('\n')
  }
  if (text === '') {
    const message = asString(rv.message)
    if (message !== undefined) text = message.trim()
  }
  return { text, isError: rv.is_error === true ? true : undefined }
}

interface KimiSessionMeta {
  title?: string
  cwd?: string
}

export function parseKimiWire(recs: unknown[], meta: KimiSessionMeta = {}, sourceId?: string): IrSession | undefined {
  const turns: IrTurn[] = []
  let current: IrTurn | undefined
  let createdAt: number | undefined
  /** callId → the assistant message that declared it (for result pairing). */
  const callOwners = new Map<string, { toolCalls: IrToolCall[] }>()
  const resolved = new Set<string>()

  /** Last assistant message of the current turn, creating an implicit one. */
  const ensureAssistant = (): { toolCalls: IrToolCall[]; text: string[]; reasoning: string[] } => {
    if (current === undefined) return { toolCalls: [], text: [], reasoning: [] }
    let last = current.messages.at(-1)
    if (last === undefined || last.role !== 'assistant') {
      last = { role: 'assistant', text: [], reasoning: [], toolCalls: [] }
      current.messages.push(last)
    }
    return last
  }

  const appendChunk = (kind: 'text' | 'reasoning', chunk: string): void => {
    const msg = ensureAssistant()
    const parts = kind === 'text' ? msg.text : msg.reasoning
    // Merge consecutive streamed chunks of the same kind.
    if (parts.length > 0) parts[parts.length - 1] += chunk
    else parts.push(chunk)
  }

  for (const rawRec of recs) {
    const rec = asObject(rawRec)
    if (rec === undefined) continue
    if (asString(rec.type) === 'metadata') continue
    const msg = asObject(rec.message)
    if (msg === undefined) continue
    const type = asString(msg.type)
    if (type === undefined) continue
    const payload = asObject(msg.payload) ?? {}
    const time = asTime(asNumber(rec.timestamp))
    if (createdAt === undefined && time !== undefined) createdAt = time

    if (type === 'TurnBegin' || type === 'SteerInput') {
      const prompt = userInputText(payload.user_input).trim()
      if (prompt === '') continue
      current = { messages: [{ role: 'user', text: [prompt], reasoning: [], toolCalls: [], time }], time }
      turns.push(current)
    } else if (type === 'TextPart' || type === 'ThinkPart') {
      if (current === undefined) continue
      const chunk = type === 'TextPart' ? asString(payload.text) : asString(payload.think)
      if (chunk === undefined || chunk === '') continue
      appendChunk(type === 'TextPart' ? 'text' : 'reasoning', chunk)
    } else if (type === 'ToolCall') {
      if (current === undefined) continue
      const id = asString(payload.id)
      const fn = asObject(payload.function)
      const name = fn !== undefined ? asString(fn.name) : undefined
      if (id === undefined || name === undefined) continue
      const call: IrToolCall = {
        id,
        name,
        arguments: (fn !== undefined ? asString(fn.arguments) : undefined) ?? '{}',
      }
      const msg2 = ensureAssistant()
      msg2.toolCalls.push(call)
      callOwners.set(id, msg2)
    } else if (type === 'ToolResult') {
      const callId = asString(payload.tool_call_id)
      if (callId === undefined || !callOwners.has(callId) || resolved.has(callId)) continue
      resolved.add(callId)
      const owner = callOwners.get(callId)
      const call = owner?.toolCalls.find(c => c.id === callId)
      if (call !== undefined) call.result = toolResultText(payload.return_value)
    }
    // StepBegin/TurnEnd are step boundaries the IR doesn't need; SubagentEvent
    // and status/control events produce no conversation content.
  }

  if (turns.length === 0) return undefined
  return {
    source: KEY,
    sourceId,
    cwd: meta.cwd,
    provider: 'moonshot',
    model: 'kimi',
    createdAt,
    turns,
  }
}

interface KimiSessionDir {
  dir: string
  wirePath: string
  sessionId: string
  workdirMd5: string
}

async function sessionDirs(home: string): Promise<KimiSessionDir[]> {
  const sessionsRoot = join(home, '.kimi', 'sessions')
  if (!(await pathExists(sessionsRoot))) return []
  const wires = await collectFiles(sessionsRoot, name => name === 'wire.jsonl', { maxDepth: 3, maxFiles: 10_000 })
  return wires.map(wirePath => ({
    dir: dirname(wirePath),
    wirePath,
    sessionId: basename(dirname(wirePath)),
    workdirMd5: basename(dirname(dirname(wirePath))),
  }))
}

/** Read state.json next to a wire.jsonl for the custom title and cwd. */
async function readState(dir: string): Promise<KimiSessionMeta> {
  const text = await readText(join(dir, 'state.json'))
  if (text === undefined) return {}
  try {
    const doc = asObject(JSON.parse(text))
    if (doc === undefined) return {}
    return {
      title: asString(doc.custom_title),
      cwd: asString(doc.cwd) ?? asString(doc.workdir),
    }
  } catch {
    return {}
  }
}

/** kimi.json work_dirs: map md5(path) → original path for cwd recovery. */
async function workdirMap(home: string): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  const text = await readText(join(home, '.kimi', 'kimi.json'))
  if (text === undefined) return map
  try {
    const doc = asObject(JSON.parse(text))
    const dirs = Array.isArray(doc?.work_dirs) ? doc.work_dirs : []
    for (const raw of dirs) {
      const entry = asObject(raw)
      const p = entry !== undefined ? asString(entry.path) : undefined
      if (p === undefined) continue
      map.set(createHash('md5').update(p).digest('hex'), p)
    }
  } catch {
    // malformed kimi.json — ignore
  }
  return map
}

export const kimiCliAdapter: SourceAdapter = {
  key: KEY,
  label: LABEL,

  async detect(home: string): Promise<DiscoveredSource | undefined> {
    const dirs = await sessionDirs(home)
    if (dirs.length === 0) return undefined
    return { source: KEY, label: LABEL, root: join(home, '.kimi'), sessionCount: dirs.length, memoryCount: 0 }
  },

  async readSessions(home: string, options?: { limit?: number }): Promise<IrSession[]> {
    const dirs = await sessionDirs(home)
    const limited = options?.limit !== undefined ? dirs.slice(-options.limit) : dirs
    const workdirs = await workdirMap(home)
    const sessions: IrSession[] = []
    for (const s of limited) {
      const state = await readState(s.dir)
      const cwd = state.cwd ?? workdirs.get(s.workdirMd5)
      const recs = await readJsonl(s.wirePath)
      const parsed = parseKimiWire(recs, { ...state, cwd }, s.sessionId)
      if (parsed !== undefined) sessions.push(parsed)
    }
    return sessions
  },

  async readMemories(): Promise<IrMemory[]> {
    return []
  },
}
