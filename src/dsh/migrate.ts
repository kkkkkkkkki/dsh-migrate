/**
 * Migration engine: discover → read → write, shared by the CLI and the
 * in-harness `/migrate` command.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import type { DiscoveredSource, IrSession } from '../ir.ts'
import { adapters, adapterByKey } from '../formats/index.ts'
import { writeSession } from './session-writer.ts'
import { memoriesToAgentsBlock, memoriesToSession } from './memory-writer.ts'

export interface MigrateOptions {
  /** Only import these source keys (default: every detected source). */
  sources?: string[]
  /** Where sessions go; default `$DSH_HOME/sessions` or `~/.dsh/sessions`. */
  outRoot?: string
  /** Home directory to scan (default: the real home). */
  home?: string
  /** Also append imported memories to this project's AGENTS.md. */
  instructionsProject?: string
  /** Cap on sessions per source (most recent win). */
  limit?: number
  /** Report one line per imported session. */
  verbose?: boolean
}

export interface MigrateReport {
  detected: DiscoveredSource[]
  sessions: { source: string; id: string; path: string; events: number }[]
  memorySessions: { source: string; id: string; path: string; events: number }[]
  instructionsFile?: string
  skipped: { source: string; reason: string }[]
}

/** The default DSH session root for imported logs (raw JSONL encoding). */
export function defaultSessionsRoot(home: string): string {
  const dshHome = process.env.DSH_HOME ?? join(home, '.dsh')
  return join(dshHome, 'sessions-imported')
}

/** Run detection across all adapters. */
export async function detect(home: string, sources?: string[]): Promise<DiscoveredSource[]> {
  const wanted = sources !== undefined ? new Set(sources) : undefined
  const out: DiscoveredSource[] = []
  for (const adapter of adapters) {
    if (wanted !== undefined && !wanted.has(adapter.key)) continue
    try {
      const found = await adapter.detect(home)
      if (found !== undefined) out.push(found)
    } catch {
      // an adapter that cannot read its store reports nothing
    }
  }
  return out
}

/** Run the full migration. */
export async function migrate(options: MigrateOptions = {}): Promise<MigrateReport> {
  const home = options.home ?? homedir()
  const outRoot = options.outRoot ?? defaultSessionsRoot(home)
  const report: MigrateReport = { detected: [], sessions: [], memorySessions: [], skipped: [] }

  const wanted = options.sources !== undefined ? new Set(options.sources) : undefined
  for (const adapter of adapters) {
    if (wanted !== undefined && !wanted.has(adapter.key)) continue
    let found: DiscoveredSource | undefined
    try {
      found = await adapter.detect(home)
    } catch (error) {
      report.skipped.push({ source: adapter.key, reason: `detect failed: ${String(error)}` })
      continue
    }
    if (found === undefined) continue
    report.detected.push(found)

    let sessions: IrSession[] = []
    try {
      sessions = await adapter.readSessions(home, { limit: options.limit })
    } catch (error) {
      report.skipped.push({ source: adapter.key, reason: `read failed: ${String(error)}` })
      continue
    }
    for (const session of sessions) {
      try {
        const written = await writeSession(outRoot, session)
        report.sessions.push({ source: adapter.key, ...written })
      } catch (error) {
        report.skipped.push({ source: adapter.key, reason: `write failed: ${String(error)}` })
      }
    }

    try {
      const memories = await adapter.readMemories(home)
      const memorySession = memoriesToSession(adapter.key, adapter.label, memories)
      if (memorySession !== undefined) {
        const written = await writeSession(outRoot, memorySession)
        report.memorySessions.push({ source: adapter.key, ...written })
      }
      if (options.instructionsProject !== undefined && memories.length > 0) {
        report.instructionsFile = await appendAgentsBlock(options.instructionsProject, memoriesToAgentsBlock(adapter.label, memories))
      }
    } catch (error) {
      report.skipped.push({ source: adapter.key, reason: `memory failed: ${String(error)}` })
    }
  }
  return report
}

/** Append (or replace) the dsh-migrate block in a project's AGENTS.md. */
export async function appendAgentsBlock(projectDir: string, block: string): Promise<string> {
  const path = join(projectDir, 'AGENTS.md')
  let existing = ''
  try {
    existing = await readFile(path, 'utf8')
  } catch {
    // new file
  }
  const start = existing.indexOf('<!-- dsh-migrate: imported agent memory -->')
  const end = existing.indexOf('<!-- /dsh-migrate -->')
  let next: string
  if (start !== -1 && end !== -1 && end > start) {
    next = existing.slice(0, start) + block + existing.slice(end + '<!-- /dsh-migrate -->'.length + 1)
  } else {
    next = existing.trimEnd() + (existing.trim() === '' ? '' : '\n\n') + block
  }
  await mkdir(projectDir, { recursive: true })
  await writeFile(path, next, 'utf8')
  return path
}

export { adapterByKey }
