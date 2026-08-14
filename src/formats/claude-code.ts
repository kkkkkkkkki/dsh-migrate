/**
 * Claude Code adapter.
 *
 * Layout (https://code.claude.com/docs):
 *   ~/.claude/projects/<slugified-cwd>/<session-uuid>.jsonl  — transcripts
 *   ~/.claude/projects/<slugified-cwd>/memory/*.md           — file memory
 *   ~/.claude/CLAUDE.md, <project>/CLAUDE.md                 — instruction memory
 *
 * Transcript rows (one JSON object per line) carry `type`
 * (`user` / `assistant` / `system` / `summary` / `file-history-snapshot` …),
 * `message` (Anthropic API message), `timestamp`, `cwd`, `sessionId`.
 */
import { basename, join } from 'node:path'
import type { DiscoveredSource, IrMemory, IrMessage, IrSession, IrTurn, SourceAdapter } from '../ir.ts'
import { asObject, asString, asTime, collectFiles, listDir, pathExists, readJsonl, readText } from '../util.ts'

const KEY = 'claude-code'
const LABEL = 'Claude Code'

function textOfContent(content: unknown): { text: string[]; reasoning: string[]; toolCalls: { id?: string; name: string; arguments: string }[]; toolResultOnly: boolean } {
  const text: string[] = []
  const reasoning: string[] = []
  const toolCalls: { id?: string; name: string; arguments: string }[] = []
  let sawBlock = false
  let sawToolResult = false
  let sawMeaningfulOther = false
  if (typeof content === 'string') {
    if (content.trim() !== '') { sawBlock = true; sawMeaningfulOther = true; text.push(content) }
    return { text, reasoning, toolCalls, toolResultOnly: false }
  }
  if (!Array.isArray(content)) return { text, reasoning, toolCalls, toolResultOnly: false }
  for (const rawBlock of content) {
    const block = asObject(rawBlock)
    if (block === undefined) continue
    sawBlock = true
    switch (asString(block.type)) {
      case 'text': {
        const t = asString(block.text)
        if (t !== undefined && t.trim() !== '') { sawMeaningfulOther = true; text.push(t) }
        break
      }
      case 'thinking': {
        const t = asString(block.thinking)
        if (t !== undefined && t.trim() !== '') { sawMeaningfulOther = true; reasoning.push(t) }
        break
      }
      case 'tool_use': {
        sawMeaningfulOther = true
        const name = asString(block.name)
        if (name === undefined) break
        toolCalls.push({
          id: asString(block.id),
          name,
          arguments: JSON.stringify(block.input ?? {}),
        })
        break
      }
      case 'tool_result': {
        // Results arrive as a user-role message; surfaced via the parent's
        // toolUseResult when available, otherwise rendered as plain text.
        sawToolResult = true
        const inner = block.content
        if (typeof inner === 'string') {
          if (inner.trim() !== '') text.push(`[tool result] ${inner}`)
        }
        break
      }
      default:
        break
    }
  }
  return { text, reasoning, toolCalls, toolResultOnly: sawBlock && sawToolResult && !sawMeaningfulOther }
}

/** Tool results keyed by tool_use id, from the row's `toolUseResult` map. */
function resultMap(row: Record<string, unknown>): Map<string, { text: string; isError?: boolean }> {
  const out = new Map<string, { text: string; isError?: boolean }>()
  const tur = row.toolUseResult
  if (typeof tur === 'string') return out
  const obj = asObject(tur)
  if (obj === undefined) return out
  // Shapes seen in the wild: { content: [{type:'text',text}] , is_error },
  // { stdout, stderr, interrupted }, { oldString/newString … } for edits.
  const parts: string[] = []
  const content = obj.content
  if (typeof content === 'string') parts.push(content)
  else if (Array.isArray(content)) {
    for (const item of content) {
      const o = asObject(item)
      const t = o !== undefined ? asString(o.text) : undefined
      if (t !== undefined) parts.push(t)
    }
  }
  for (const key of ['stdout', 'stderr']) {
    const v = asString(obj[key])
    if (v !== undefined && v !== '') parts.push(v)
  }
  if (parts.length === 0) return out
  const isError = obj.is_error === true || obj.isError === true ? true : undefined
  // The id is not on the result map itself; callers match by position.
  out.set('*', { text: parts.join('\n'), isError })
  return out
}

function readTranscript(rows: unknown[]): IrSession | undefined {
  let cwd: string | undefined
  let sessionId: string | undefined
  let model: string | undefined
  let createdAt: number | undefined
  const turns: IrTurn[] = []
  let current: IrTurn | undefined

  const flush = () => {
    if (current !== undefined && current.messages.length > 0) turns.push(current)
    current = undefined
  }

  for (const raw of rows) {
    const row = asObject(raw)
    if (row === undefined) continue
    const type = asString(row.type)
    if (type !== 'user' && type !== 'assistant') continue
    cwd ??= asString(row.cwd)
    sessionId ??= asString(row.sessionId)
    const time = asTime(row.timestamp)
    createdAt ??= time
    const message = asObject(row.message)
    if (message === undefined) continue

    if (type === 'user') {
      // A tool_result-only user row continues the current turn; a text user
      // row (real prompt or /command output) starts a new one.
      const { text, toolResultOnly } = textOfContent(message.content)
      const results = resultMap(row)
      if (toolResultOnly && current !== undefined) {
        // Attach the result to the last unmatched tool call, if any.
        const flat = current.messages.flatMap(m => m.toolCalls)
        const pending = flat.find(c => c.result === undefined)
        const hit = results.get('*')
        if (pending !== undefined && hit !== undefined) pending.result = hit
        continue
      }
      if (text.length === 0) continue
      flush()
      current = { messages: [{ role: 'user', text, reasoning: [], toolCalls: [], time }], time }
      continue
    }

    // assistant
    const { text, reasoning, toolCalls } = textOfContent(message.content)
    model ??= asString(message.model)
    if (text.length === 0 && reasoning.length === 0 && toolCalls.length === 0) continue
    const irMessage: IrMessage = { role: 'assistant', text, reasoning, toolCalls, time }
    if (current === undefined) current = { messages: [], time }
    current.messages.push(irMessage)
  }
  flush()

  if (turns.length === 0) return undefined
  return {
    source: KEY,
    sourceId: sessionId,
    cwd,
    createdAt,
    provider: 'anthropic',
    model,
    turns,
  }
}

export const claudeCodeAdapter: SourceAdapter = {
  key: KEY,
  label: LABEL,

  async detect(home: string): Promise<DiscoveredSource | undefined> {
    const root = join(home, '.claude')
    if (!(await pathExists(root))) return undefined
    const projectsRoot = join(root, 'projects')
    const files = await collectFiles(projectsRoot, name => name.endsWith('.jsonl'))
    const memoryDirs = await collectFiles(projectsRoot, name => name.endsWith('.md'), { maxDepth: 8 })
    const globalClaudeMd = await pathExists(join(root, 'CLAUDE.md'))
    const memoryCount = memoryDirs.length + (globalClaudeMd ? 1 : 0)
    if (files.length === 0 && memoryCount === 0) return undefined
    return { source: KEY, label: LABEL, root, sessionCount: files.length, memoryCount }
  },

  async readSessions(home: string, options?: { limit?: number }): Promise<IrSession[]> {
    const projectsRoot = join(home, '.claude', 'projects')
    const files = await collectFiles(projectsRoot, name => name.endsWith('.jsonl'))
    const limited = options?.limit !== undefined ? files.slice(-options.limit) : files
    const sessions: IrSession[] = []
    for (const file of limited) {
      const parsed = readTranscript(await readJsonl(file))
      if (parsed !== undefined) sessions.push(parsed)
    }
    return sessions
  },

  async readMemories(home: string): Promise<IrMemory[]> {
    const root = join(home, '.claude')
    const out: IrMemory[] = []
    const globalClaudeMd = join(root, 'CLAUDE.md')
    const globalBody = await readText(globalClaudeMd)
    if (globalBody !== undefined && globalBody.trim() !== '') {
      out.push({ kind: 'instruction', title: 'Claude Code global CLAUDE.md', body: globalBody })
    }
    const projectsRoot = join(root, 'projects')
    for (const project of await listDir(projectsRoot)) {
      const memoryDir = join(projectsRoot, project, 'memory')
      const files = await collectFiles(memoryDir, name => name.endsWith('.md'), { maxDepth: 2 })
      for (const file of files) {
        const body = await readText(file)
        if (body === undefined || body.trim() === '') continue
        out.push({
          kind: 'notes',
          title: `${project}/${basename(file)}`,
          body,
          project,
        })
      }
    }
    return out
  },
}
