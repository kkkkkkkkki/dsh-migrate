/**
 * Cline / Roo Code adapter (VS Code extension agents).
 *
 * Task transcripts live under the extension's globalStorage:
 *   <vscode-data>/User/globalStorage/saoudrizwan.claude-dev/tasks/<id>/
 *     api_conversation_history.json  — [{ role, content }] (Anthropic shape)
 *     ui_messages.json               — UI-level ask/say stream
 *   <vscode-data>/User/globalStorage/rooveterinaryinc.roo-cline/tasks/…
 *
 * The VS Code data directory is platform-specific:
 *   Windows %APPDATA%/Code (and Cursor/Windsurf variants), macOS
 *   ~/Library/Application Support/…, Linux ~/.config/…
 * Detection probes every well-known host directory under the supplied home.
 */
import { join } from 'node:path'
import type { DiscoveredSource, IrMemory, IrSession, IrTurn, SourceAdapter } from '../ir.ts'
import { asObject, asString, asTime, collectFiles, pathExists, readText } from '../util.ts'

const KEY = 'cline'
const LABEL = 'Cline / Roo Code'

const EXTENSION_IDS = ['saoudrizwan.claude-dev', 'rooveterinaryinc.roo-cline']

/** Candidate VS Code-family data roots for this platform. */
function vscodeDataRoots(home: string): string[] {
  const roots: string[] = []
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? join(home, 'AppData', 'Roaming')
    for (const app of ['Code', 'Code - Insiders', 'Cursor', 'Windsurf', 'VSCodium']) {
      roots.push(join(appData, app, 'User', 'globalStorage'))
    }
  } else if (process.platform === 'darwin') {
    for (const app of ['Code', 'Code - Insiders', 'Cursor', 'Windsurf', 'VSCodium']) {
      roots.push(join(home, 'Library', 'Application Support', app, 'User', 'globalStorage'))
    }
  } else {
    for (const app of ['Code', 'Code - Insiders', 'Cursor', 'Windsurf', 'VSCodium']) {
      roots.push(join(home, '.config', app, 'User', 'globalStorage'))
    }
  }
  return roots
}

function contentToText(content: unknown): string[] {
  if (typeof content === 'string') return content.trim() === '' ? [] : [content]
  if (!Array.isArray(content)) return []
  const out: string[] = []
  for (const rawBlock of content) {
    const block = asObject(rawBlock)
    if (block === undefined) continue
    const type = asString(block.type)
    if (type === 'text') {
      const t = asString(block.text)
      if (t !== undefined && t.trim() !== '') out.push(t)
    } else if (type === 'tool_result') {
      const inner = block.content
      if (typeof inner === 'string' && inner.trim() !== '') out.push(`[tool result] ${inner}`)
    }
  }
  return out
}

export function parseClineConversation(doc: unknown): IrSession | undefined {
  const rows = Array.isArray(doc) ? doc : (asObject(doc)?.messages ?? [])
  if (!Array.isArray(rows)) return undefined
  const turns: IrTurn[] = []
  let current: IrTurn | undefined
  const flush = () => {
    if (current !== undefined && current.messages.length > 0) turns.push(current)
    current = undefined
  }
  for (const rawRow of rows) {
    const row = asObject(rawRow)
    if (row === undefined) continue
    const role = asString(row.role)
    const time = asTime(row.ts ?? row.timestamp)
    const text = contentToText(row.content)
    if (text.length === 0) continue
    if (role === 'user') {
      const toolOnly = text.every(t => t.startsWith('[tool result]'))
      if (toolOnly && current !== undefined) {
        current.messages.push({ role: 'assistant', text, reasoning: [], toolCalls: [], time })
        continue
      }
      flush()
      current = { messages: [{ role: 'user', text, reasoning: [], toolCalls: [], time }], time }
    } else if (role === 'assistant') {
      if (current === undefined) current = { messages: [], time }
      current.messages.push({ role: 'assistant', text, reasoning: [], toolCalls: [], time })
    }
  }
  flush()
  if (turns.length === 0) return undefined
  return { source: KEY, provider: undefined, model: undefined, turns, createdAt: turns[0]?.time }
}

async function taskFiles(home: string): Promise<string[]> {
  const out: string[] = []
  for (const storage of vscodeDataRoots(home)) {
    for (const ext of EXTENSION_IDS) {
      const tasksRoot = join(storage, ext, 'tasks')
      if (!(await pathExists(tasksRoot))) continue
      const files = await collectFiles(tasksRoot, name => name === 'api_conversation_history.json', { maxDepth: 3, maxFiles: 20_000 })
      out.push(...files)
    }
  }
  return out
}

export const clineAdapter: SourceAdapter = {
  key: KEY,
  label: LABEL,

  async detect(home: string): Promise<DiscoveredSource | undefined> {
    const files = await taskFiles(home)
    if (files.length === 0) return undefined
    return { source: KEY, label: LABEL, root: home, sessionCount: files.length, memoryCount: 0 }
  },

  async readSessions(home: string, options?: { limit?: number }): Promise<IrSession[]> {
    const files = await taskFiles(home)
    const limited = options?.limit !== undefined ? files.slice(-options.limit) : files
    const sessions: IrSession[] = []
    for (const file of limited) {
      const text = await readText(file)
      if (text === undefined) continue
      try {
        const parsed = parseClineConversation(JSON.parse(text))
        if (parsed !== undefined) sessions.push(parsed)
      } catch {
        // not JSON — skip
      }
    }
    return sessions
  },

  async readMemories(): Promise<IrMemory[]> {
    return []
  },
}
