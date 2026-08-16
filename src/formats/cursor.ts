/**
 * Cursor adapter (agent transcripts).
 *
 * Storage: ~/.cursor/projects/<slug>/agent-transcripts/<composer-uuid>/<composer-uuid>.jsonl
 * Line shape: { role: 'user'|'assistant', message: { content: [...] } } with no
 * envelope. Content blocks are `text` / `tool_use` only (input is already a
 * parsed object). Known quirks, per the format itself:
 *   - the first user text is wrapped in <user_query>…</user_query> (stripped);
 *   - transcripts carry no tool_result blocks (results live in a separate
 *     bubble store) — calls are imported without results;
 *   - assistant text may contain "[REDACTED]" privacy sentinels (stripped);
 *   - no timestamps, model, or cwd fields — the composer uuid (file stem) is
 *     the source id.
 */
import { basename, dirname, join } from 'node:path'
import type { DiscoveredSource, IrMemory, IrSession, IrToolCall, IrTurn, SourceAdapter } from '../ir.ts'
import { asObject, asString, collectFiles, pathExists, readJsonl } from '../util.ts'

const KEY = 'cursor'
const LABEL = 'Cursor'

/** Strip Cursor's <user_query> wrapper and [REDACTED] sentinels. */
function cleanText(text: string): string {
  return text.replace(/<\/?user_query>/g, '').replace(/\[REDACTED\]/g, '').trim()
}

export function parseCursorTranscript(recs: unknown[], sourceId?: string): IrSession | undefined {
  const turns: IrTurn[] = []
  let current: IrTurn | undefined
  for (const rawRec of recs) {
    const rec = asObject(rawRec)
    if (rec === undefined) continue
    const role = asString(rec.role)
    if (role !== 'user' && role !== 'assistant') continue
    const message = asObject(rec.message)
    const content = Array.isArray(message?.content) ? message.content : []
    if (role === 'user') {
      const texts: string[] = []
      for (const rawBlock of content) {
        const block = asObject(rawBlock)
        if (block === undefined || asString(block.type) !== 'text') continue
        const t = cleanText(asString(block.text) ?? '')
        if (t !== '') texts.push(t)
      }
      if (texts.length === 0) continue
      current = { messages: [{ role: 'user', text: texts, reasoning: [], toolCalls: [] }] }
      turns.push(current)
    } else if (current !== undefined) {
      const texts: string[] = []
      const toolCalls: IrToolCall[] = []
      for (const rawBlock of content) {
        const block = asObject(rawBlock)
        if (block === undefined) continue
        const type = asString(block.type)
        if (type === 'text') {
          const t = cleanText(asString(block.text) ?? '')
          if (t !== '') texts.push(t)
        } else if (type === 'tool_use') {
          toolCalls.push({
            id: asString(block.id),
            name: asString(block.name) ?? 'unknown',
            arguments: JSON.stringify(block.input ?? {}),
          })
        }
      }
      if (texts.length === 0 && toolCalls.length === 0) continue
      current.messages.push({ role: 'assistant', text: texts, reasoning: [], toolCalls })
    }
  }
  if (turns.length === 0) return undefined
  return { source: KEY, sourceId, provider: 'cursor', model: 'cursor', turns }
}

async function transcriptFiles(home: string): Promise<string[]> {
  const projectsRoot = join(home, '.cursor', 'projects')
  if (!(await pathExists(projectsRoot))) return []
  return collectFiles(projectsRoot, (name, full) =>
    name.endsWith('.jsonl') && basename(dirname(full)) === basename(name, '.jsonl'),
  { maxDepth: 5, maxFiles: 50_000 })
}

export const cursorAdapter: SourceAdapter = {
  key: KEY,
  label: LABEL,

  async detect(home: string): Promise<DiscoveredSource | undefined> {
    const files = await transcriptFiles(home)
    if (files.length === 0) return undefined
    return { source: KEY, label: LABEL, root: join(home, '.cursor'), sessionCount: files.length, memoryCount: 0 }
  },

  async readSessions(home: string, options?: { limit?: number }): Promise<IrSession[]> {
    const files = await transcriptFiles(home)
    const limited = options?.limit !== undefined ? files.slice(-options.limit) : files
    const sessions: IrSession[] = []
    for (const file of limited) {
      const recs = await readJsonl(file)
      const parsed = parseCursorTranscript(recs, basename(file, '.jsonl'))
      if (parsed !== undefined) sessions.push(parsed)
    }
    return sessions
  },

  async readMemories(): Promise<IrMemory[]> {
    return []
  },
}
