/**
 * ChatGPT adapter (web export).
 *
 * ChatGPT's data export (Settings → Data controls → Export) contains a
 * `conversations.json` — a top-level JSON array holding many conversations in
 * one file. Each conversation has a `mapping` DAG: nodeId → { id, message,
 * parent, children }. The active branch is reconstructed by walking from the
 * root along each node's last child; `message: null` placeholders and
 * system-role nodes are skipped. Timestamps are Unix seconds.
 *
 * ChatGPT is a general chat surface, not a coding agent — there is no cwd, so
 * imported sessions land ungrouped. Tool messages have no structured tool-call
 * counterpart in the export, so their text is appended to the preceding
 * assistant message rather than emitted as orphan results.
 */
import { basename, join } from 'node:path'
import type { DiscoveredSource, IrMemory, IrSession, IrTurn, SourceAdapter } from '../ir.ts'
import { asObject, asString, asTime, collectFiles, readText } from '../util.ts'

const KEY = 'chatgpt'
const LABEL = 'ChatGPT (export)'

interface ChatGptNode {
  id: string
  parent?: string
  children?: string[]
  message?: Record<string, unknown>
}

function messageText(msg: Record<string, unknown>): string {
  const content = asObject(msg.content)
  const parts = Array.isArray(content?.parts) ? content.parts : []
  const texts: string[] = []
  for (const p of parts) {
    if (typeof p === 'string' && p.trim() !== '') texts.push(p)
    else {
      const obj = asObject(p)
      const t = obj !== undefined ? asString(obj.text) : undefined
      if (t !== undefined && t.trim() !== '') texts.push(t)
    }
  }
  return texts.join('\n').trim()
}

/** Convert one conversation object from the export array. */
export function parseChatGptConversation(conv: unknown): IrSession | undefined {
  const obj = asObject(conv)
  if (obj === undefined) return undefined
  const mapping = asObject(obj.mapping)
  if (mapping === undefined) return undefined

  const nodes = new Map<string, ChatGptNode>()
  for (const [id, raw] of Object.entries(mapping)) {
    const n = asObject(raw)
    if (n === undefined) continue
    nodes.set(id, {
      id,
      parent: asString(n.parent),
      children: Array.isArray(n.children) ? n.children.filter((c): c is string => typeof c === 'string') : [],
      message: asObject(n.message) ?? undefined,
    })
  }

  // Root: a node whose parent is missing from the mapping and which carries a message.
  let root: ChatGptNode | undefined
  for (const n of nodes.values()) {
    if (n.message !== undefined && (n.parent === undefined || !nodes.has(n.parent))) {
      root = n
      break
    }
  }
  if (root === undefined) return undefined

  // Walk the active branch: always follow the last child that has a message.
  const thread: ChatGptNode[] = []
  const seen = new Set<string>()
  let node: ChatGptNode | undefined = root
  while (node !== undefined && !seen.has(node.id)) {
    seen.add(node.id)
    thread.push(node)
    const kids: ChatGptNode[] = (node.children ?? [])
      .map(id => nodes.get(id))
      .filter((n): n is ChatGptNode => n !== undefined && n.message !== undefined)
    node = kids.length > 0 ? kids[kids.length - 1] : undefined
  }

  const turns: IrTurn[] = []
  let current: IrTurn | undefined
  for (const n of thread) {
    const msg = n.message
    if (msg === undefined) continue
    const author = asObject(msg.author)
    const role = asString(author?.role)
    const time = asTime(msg.create_time)
    const text = messageText(msg)
    if (role === 'user') {
      if (text === '') continue
      current = { messages: [{ role: 'user', text: [text], reasoning: [], toolCalls: [], time }], time }
      turns.push(current)
    } else if (role === 'assistant' && current !== undefined) {
      if (text === '') continue
      current.messages.push({ role: 'assistant', text: [text], reasoning: [], toolCalls: [], time })
    } else if (role === 'tool' && current !== undefined && text !== '') {
      // No structured tool call exists in the export — fold into the last
      // assistant message so no orphan results are emitted.
      const last = current.messages.filter(m => m.role === 'assistant').at(-1)
      if (last !== undefined) last.text.push(text)
    }
    // system and placeholder nodes are skipped
  }
  if (turns.length === 0) return undefined

  // IrSession has no title field; the session list falls back to the first
  // user message, which matches ChatGPT's own title heuristic closely enough.
  return {
    source: KEY,
    sourceId: asString(obj.id),
    provider: 'openai',
    model: 'chatgpt',
    createdAt: asTime(obj.create_time),
    turns,
  }
}

/** Parse a whole conversations.json into one IrSession per conversation. */
export function parseChatGptExport(doc: unknown): IrSession[] {
  if (!Array.isArray(doc)) return []
  const out: IrSession[] = []
  for (const conv of doc) {
    const parsed = parseChatGptConversation(conv)
    if (parsed !== undefined) out.push(parsed)
  }
  return out
}

async function exportFiles(home: string): Promise<string[]> {
  // ChatGPT exports live wherever the user unzipped them — the canonical file
  // name is conversations.json. Scan a few plausible roots shallowly rather
  // than the whole home (which would be unbounded and slow).
  const candidates: string[] = []
  const roots = [join(home, 'Downloads'), join(home, 'Desktop'), join(home, 'Documents')]
  for (const root of roots) {
    const found = await collectFiles(root, name => name === 'conversations.json', { maxDepth: 3, maxFiles: 200 })
    candidates.push(...found)
  }
  return candidates
}

export const chatGptAdapter: SourceAdapter = {
  key: KEY,
  label: LABEL,

  async detect(home: string): Promise<DiscoveredSource | undefined> {
    const files = await exportFiles(home)
    if (files.length === 0) return undefined
    return { source: KEY, label: LABEL, root: home, sessionCount: files.length, memoryCount: 0 }
  },

  async readSessions(home: string, options?: { limit?: number }): Promise<IrSession[]> {
    const files = await exportFiles(home)
    const sessions: IrSession[] = []
    for (const file of files) {
      const text = await readText(file)
      if (text === undefined) continue
      try {
        const parsed = parseChatGptExport(JSON.parse(text))
        sessions.push(...parsed.map(s => ({ ...s, sourceId: s.sourceId ?? `${basename(file)}` })))
      } catch {
        // not a valid export file — skip
      }
    }
    return options?.limit !== undefined ? sessions.slice(-options.limit) : sessions
  },

  async readMemories(): Promise<IrMemory[]> {
    return []
  },
}
