/**
 * Gemini CLI adapter (Google).
 *
 * Layout:
 *   ~/.gemini/tmp/<project-slug>/chats/session-*.json — checkpointed chats
 *   ~/.gemini/GEMINI.md                                 — global context file
 *
 * Chat file: `{ sessionId, startTime, lastUpdated, messages: [...] }` where
 * each message has `{ id, timestamp, type: 'user' | 'gemini' | 'info' |
 * 'error', content?, thoughts?, toolCalls? }`.
 */
import { join } from 'node:path'
import type { DiscoveredSource, IrMemory, IrSession, IrTurn, SourceAdapter } from '../ir.ts'
import { asObject, asString, asTime, collectFiles, pathExists, readText } from '../util.ts'

const KEY = 'gemini-cli'
const LABEL = 'Gemini CLI'

function parseChat(text: string): IrSession | undefined {
  let doc: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(text)
    const obj = asObject(parsed)
    if (obj === undefined) return undefined
    doc = obj
  } catch {
    return undefined
  }
  const messages = doc.messages
  if (!Array.isArray(messages)) return undefined

  const turns: IrTurn[] = []
  let current: IrTurn | undefined
  const flush = () => {
    if (current !== undefined && current.messages.length > 0) turns.push(current)
    current = undefined
  }

  for (const rawMessage of messages) {
    const message = asObject(rawMessage)
    if (message === undefined) continue
    const type = asString(message.type)
    const time = asTime(message.timestamp)
    if (type === 'user') {
      const content = asString(message.content)
      const parts: string[] = []
      if (Array.isArray(message.content)) {
        for (const part of message.content) {
          const p = asObject(part)
          const t = p !== undefined ? asString(p.text) : undefined
          if (t !== undefined && t.trim() !== '') parts.push(t)
        }
      } else if (content !== undefined && content.trim() !== '') {
        parts.push(content)
      }
      if (parts.length === 0) continue
      flush()
      current = { messages: [{ role: 'user', text: parts, reasoning: [], toolCalls: [], time }], time }
      continue
    }
    if (type === 'gemini') {
      const content = asString(message.content) ?? ''
      const reasoning: string[] = []
      if (Array.isArray(message.thoughts)) {
        for (const thought of message.thoughts) {
          const t = asObject(thought)
          const subject = t !== undefined ? asString(t.subject) : undefined
          const description = t !== undefined ? asString(t.description) : undefined
          const line = [subject, description].filter(s => s !== undefined && s !== '').join(': ')
          if (line !== '') reasoning.push(line)
        }
      }
      const toolCalls: { id?: string; name: string; arguments: string; result?: { text: string; isError?: boolean } }[] = []
      if (Array.isArray(message.toolCalls)) {
        for (const rawCall of message.toolCalls) {
          const call = asObject(rawCall)
          if (call === undefined) continue
          const name = asString(call.name)
          if (name === undefined) continue
          const args = call.args !== undefined ? JSON.stringify(call.args) : '{}'
          const entry: { id?: string; name: string; arguments: string; result?: { text: string; isError?: boolean } } = {
            id: asString(call.id),
            name,
            arguments: args,
          }
          if (Array.isArray(call.result)) {
            const parts: string[] = []
            for (const rawResult of call.result) {
              const r = asObject(rawResult)
              const fr = r !== undefined ? asObject(r.functionResponse) : undefined
              const response = fr !== undefined ? asObject(fr.response) : undefined
              const output = response !== undefined ? asString(response.output) : undefined
              const error = response !== undefined ? asString(response.error) : undefined
              if (output !== undefined) parts.push(output)
              if (error !== undefined) parts.push(error)
            }
            if (parts.length > 0) entry.result = { text: parts.join('\n') }
          }
          toolCalls.push(entry)
        }
      }
      if (content.trim() === '' && reasoning.length === 0 && toolCalls.length === 0) continue
      if (current === undefined) current = { messages: [], time }
      current.messages.push({
        role: 'assistant',
        text: content.trim() === '' ? [] : [content],
        reasoning,
        toolCalls,
        time,
      })
      continue
    }
  }
  flush()
  if (turns.length === 0) return undefined
  return {
    source: KEY,
    sourceId: asString(doc.sessionId),
    createdAt: asTime(doc.startTime),
    provider: 'google',
    model: asString(doc.model),
    turns,
  }
}

export const geminiCliAdapter: SourceAdapter = {
  key: KEY,
  label: LABEL,

  async detect(home: string): Promise<DiscoveredSource | undefined> {
    const root = join(home, '.gemini')
    if (!(await pathExists(root))) return undefined
    const files = await collectFiles(join(root, 'tmp'), name => name.startsWith('session-') && name.endsWith('.json'), { maxDepth: 4 })
    const hasGeminiMd = await pathExists(join(root, 'GEMINI.md'))
    if (files.length === 0 && !hasGeminiMd) return undefined
    return { source: KEY, label: LABEL, root, sessionCount: files.length, memoryCount: hasGeminiMd ? 1 : 0 }
  },

  async readSessions(home: string, options?: { limit?: number }): Promise<IrSession[]> {
    const files = await collectFiles(join(home, '.gemini', 'tmp'), name => name.startsWith('session-') && name.endsWith('.json'), { maxDepth: 4 })
    const limited = options?.limit !== undefined ? files.slice(-options.limit) : files
    const sessions: IrSession[] = []
    for (const file of limited) {
      const text = await readText(file)
      if (text === undefined) continue
      const parsed = parseChat(text)
      if (parsed !== undefined) sessions.push(parsed)
    }
    return sessions
  },

  async readMemories(home: string): Promise<IrMemory[]> {
    const body = await readText(join(home, '.gemini', 'GEMINI.md'))
    if (body === undefined || body.trim() === '') return []
    return [{ kind: 'instruction', title: 'Gemini CLI GEMINI.md', body }]
  },
}
