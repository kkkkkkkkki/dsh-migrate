/**
 * Import memory records as one DSH "memory session" per source.
 *
 * DSH has no built-in memory store of its own — durable knowledge enters the
 * model through sessions and through instruction files. Imported memories
 * therefore become a searchable, resumable session titled by its source, and
 * (optionally, at the CLI's `--write-instructions` flag) an AGENTS.md block
 * in the target project so every later session sees them.
 */
import type { IrMemory, IrSession } from '../ir.ts'

/** Render one source's memories as a single-turn import session. */
export function memoriesToSession(source: string, label: string, memories: IrMemory[], now = Date.now()): IrSession | undefined {
  const usable = memories.filter(m => m.body.trim() !== '')
  if (usable.length === 0) return undefined
  const parts: string[] = [
    `# Imported memory: ${label}`,
    '',
    `${usable.length} memory record(s) imported from ${label} by dsh-migrate.`,
    'Ask questions about them, or ask the agent to fold relevant entries into this project\'s AGENTS.md.',
  ]
  for (const memory of usable) {
    parts.push('', '---', '', `## ${memory.title}`, '')
    if (memory.project !== undefined) parts.push(`_Scope: \`${memory.project}\`_`, '')
    parts.push(memory.body.trim())
  }
  return {
    source,
    createdAt: now,
    provider: 'dsh-migrate',
    model: 'memory',
    turns: [{
      time: now,
      messages: [{ role: 'user', text: [parts.join('\n')], reasoning: [], toolCalls: [], time: now }],
    }],
  }
}

/** Render memories as an AGENTS.md block for a target project. */
export function memoriesToAgentsBlock(label: string, memories: IrMemory[]): string {
  const usable = memories.filter(m => m.body.trim() !== '')
  const parts: string[] = [
    '<!-- dsh-migrate: imported agent memory -->',
    `# Imported memory (${label})`,
    '',
  ]
  for (const memory of usable) {
    parts.push(`## ${memory.title}`, '', memory.body.trim(), '')
  }
  parts.push('<!-- /dsh-migrate -->', '')
  return parts.join('\n')
}
