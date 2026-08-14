/**
 * Aider adapter.
 *
 * Layout (project-local):
 *   <project>/.aider.chat.history.md        — markdown chat history
 *   <project>/.aider.input.history          — readline-style user inputs
 *   <project>/.aider/…                      — caches (not imported)
 *
 * History lives inside projects, so detection needs project roots. The CLI
 * accepts `--scan <dir>` for this; without one, the probe roots are
 * `$DSH_MIGRATE_SCAN` (colon/semicolon-separated), `$HOME/projects`,
 * `$HOME/code`, `$HOME/dev`, `$HOME/work`, and `$HOME` itself at depth 2.
 * Everything is bounded (maxDepth, maxFiles, `.git`/`node_modules` pruning)
 * so a cold scan stays fast on a real disk.
 */
import { basename, delimiter, dirname, join } from 'node:path'
import type { DiscoveredSource, IrMemory, IrSession, IrTurn, SourceAdapter } from '../ir.ts'
import { collectFiles, pathExists, readText } from '../util.ts'

const KEY = 'aider'
const LABEL = 'Aider'

/** Extra scan roots callers can inject (CLI `--scan`, env, or tests). */
export const extraScanRoots: string[] = []

/** Roots to probe for aider histories, in order; missing ones are skipped. */
export async function aiderScanRoots(home: string): Promise<string[]> {
  const roots: string[] = []
  const fromEnv = process.env.DSH_MIGRATE_SCAN
  if (fromEnv !== undefined && fromEnv.trim() !== '') {
    roots.push(...fromEnv.split(delimiter).map(p => p.trim()).filter(p => p !== ''))
  }
  roots.push(...extraScanRoots)
  for (const name of ['projects', 'code', 'dev', 'work']) roots.push(join(home, name))
  const existing: string[] = []
  for (const root of roots) {
    if (await pathExists(root)) existing.push(root)
  }
  // Shallow sweep of home itself covers a lone project at the top level.
  existing.push(home)
  return existing
}

/** Parse one `.aider.chat.history.md` into a session. */
export function parseAiderHistory(text: string, projectDir: string): IrSession | undefined {
  const turns: IrTurn[] = []
  let current: IrTurn | undefined
  let role: 'user' | 'assistant' | undefined
  let buffer: string[] = []
  let blockTime: number | undefined

  const pushMessage = () => {
    const body = buffer.join('\n').trim()
    buffer = []
    if (role === undefined || body === '') return
    if (role === 'user') {
      if (current !== undefined && current.messages.length > 0) turns.push(current)
      current = { messages: [{ role: 'user', text: [body], reasoning: [], toolCalls: [], time: blockTime }], time: blockTime }
    } else {
      if (current === undefined) current = { messages: [], time: blockTime }
      current.messages.push({ role: 'assistant', text: [body], reasoning: [], toolCalls: [], time: blockTime })
    }
  }

  for (const line of text.split('\n')) {
    const started = /^# aider chat started at (.+)$/.exec(line)
    if (started !== null) {
      pushMessage()
      if (current !== undefined && current.messages.length > 0) turns.push(current)
      current = undefined
      const ms = Date.parse(started[1] ?? '')
      blockTime = Number.isNaN(ms) ? undefined : ms
      role = undefined
      continue
    }
    const header = /^#### (USER|ASSISTANT)\b/.exec(line)
    if (header !== null) {
      pushMessage()
      role = header[1] === 'USER' ? 'user' : 'assistant'
      continue
    }
    if (role !== undefined) buffer.push(line)
  }
  pushMessage()
  if (current !== undefined && current.messages.length > 0) turns.push(current)

  if (turns.length === 0) return undefined
  return {
    source: KEY,
    cwd: projectDir,
    createdAt: turns[0]?.time,
    provider: undefined,
    model: undefined,
    turns,
  }
}

async function findHistoryFiles(home: string): Promise<string[]> {
  const out: string[] = []
  const roots = await aiderScanRoots(home)
  for (const root of roots) {
    // Home itself is probed shallowly; named project roots go deeper.
    const depth = root === home ? 2 : 5
    out.push(...await collectFiles(root, name => name === '.aider.chat.history.md', { maxDepth: depth, maxFiles: 500 }))
  }
  return [...new Set(out)]
}

export const aiderAdapter: SourceAdapter = {
  key: KEY,
  label: LABEL,

  async detect(home: string): Promise<DiscoveredSource | undefined> {
    const files = await findHistoryFiles(home)
    if (files.length === 0) return undefined
    return { source: KEY, label: LABEL, root: home, sessionCount: files.length, memoryCount: 0 }
  },

  async readSessions(home: string, options?: { limit?: number }): Promise<IrSession[]> {
    const files = await findHistoryFiles(home)
    const limited = options?.limit !== undefined ? files.slice(-options.limit) : files
    const sessions: IrSession[] = []
    for (const file of limited) {
      const text = await readText(file)
      if (text === undefined) continue
      const parsed = parseAiderHistory(text, dirname(file))
      if (parsed !== undefined) sessions.push(parsed)
    }
    return sessions
  },

  async readMemories(home: string): Promise<IrMemory[]> {
    // `.aider/…` has no durable memory store worth lifting; conventions live in
    // CONVENTIONS.md files the user keeps in their projects.
    const out: IrMemory[] = []
    const roots = await aiderScanRoots(home)
    const files: string[] = []
    for (const root of roots) {
      const depth = root === home ? 2 : 5
      files.push(...await collectFiles(root, name => name === 'CONVENTIONS.md', { maxDepth: depth, maxFiles: 200 }))
    }
    for (const file of [...new Set(files)]) {
      const body = await readText(file)
      if (body === undefined || body.trim() === '') continue
      out.push({ kind: 'instruction', title: `Aider ${basename(file)}`, body, project: dirname(file) })
    }
    return out
  },
}
