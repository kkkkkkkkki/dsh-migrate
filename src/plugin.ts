/**
 * DeepSeek Harness plugin entry: mounts the `/migrate` command.
 *
 * The command runs the same migration engine as the `dsh-migrate` CLI, in
 * the running harness, against the configured session root — imported
 * sessions appear in the sidebar without a restart.
 *
 * Structural typing keeps this module dependency-free: `apply` accepts any
 * context with a `commands` registry, so the package needs no compile-time
 * link to the harness (the ambient declarations in plugin.d.ts cover the
 * types when the harness packages are not installed).
 *
 * @module @ersss/dsh-migrate/plugin
 */
import { homedir } from 'node:os'
import { defaultSessionsRoot, detect, migrate } from './dsh/migrate.ts'

/** The slice of the Cordis context this plugin consumes (structural). */
interface CommandsRegistry {
  register(definition: {
    name: string
    description: string
    input?: { hint: string }
    recordInput?: boolean
    handler: (invocation: { rawInput: string }) => unknown
  }): unknown
}

export interface MigratePluginContext {
  commands: CommandsRegistry
}

export const name = 'dsh-migrate'
export const inject = ['commands']

const USAGE = 'Usage: /migrate [list|run] [--source <key>] [--limit <n>] — import chat history & memory from other agents'

interface ParsedArgs {
  verb: 'list' | 'run'
  sources?: string[]
  limit?: number
  error?: string
}

function parseArgs(raw: string): ParsedArgs {
  const tokens = raw.trim().split(/\s+/).filter(t => t !== '')
  const out: ParsedArgs = { verb: 'run' }
  const sources: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as string
    if (token === 'list' || token === 'run') {
      out.verb = token
    } else if (token === '--source' || token === '-s') {
      const value = tokens[++i]
      if (value === undefined) return { ...out, error: USAGE }
      sources.push(value)
    } else if (token === '--limit' || token === '-n') {
      const value = Number(tokens[++i])
      if (!Number.isInteger(value) || value <= 0) return { ...out, error: USAGE }
      out.limit = value
    } else {
      return { ...out, error: `Unknown argument: ${token}\n${USAGE}` }
    }
  }
  if (sources.length > 0) out.sources = sources
  return out
}

type CommandResult =
  | { readonly kind: 'success'; readonly text?: string }
  | { readonly kind: 'error'; readonly text: string }

async function runList(home: string, sources: string[] | undefined): Promise<CommandResult> {
  const found = await detect(home, sources)
  if (found.length === 0) {
    return { kind: 'success', text: 'No importable agent data found under ' + home }
  }
  const lines = found.map(d => `- ${d.label} (${d.source}): ${d.sessionCount} session(s), ${d.memoryCount} memory item(s) — ${d.root}`)
  return { kind: 'success', text: ['Importable sources:', ...lines, '', 'Run /migrate run to import.'].join('\n') }
}

async function runMigrate(args: ParsedArgs): Promise<CommandResult> {
  const home = homedir()
  const report = await migrate({
    home,
    sources: args.sources,
    limit: args.limit,
    outRoot: defaultSessionsRoot(home),
  })
  if (report.sessions.length === 0 && report.memorySessions.length === 0) {
    const why = report.detected.length === 0
      ? 'No importable agent data found.'
      : 'Sources detected but nothing was written: ' + report.skipped.map(s => `${s.source}: ${s.reason}`).join('; ')
    return { kind: 'success', text: why }
  }
  const lines = [
    `Imported ${report.sessions.length} session(s) and ${report.memorySessions.length} memory session(s).`,
    ...report.sessions.slice(0, 20).map(s => `- [${s.source}] ${s.id} (${s.events} events)`),
    report.sessions.length > 20 ? `… and ${report.sessions.length - 20} more` : undefined,
    '',
    'Imported sessions appear in the session list under their original project.',
  ].filter((l): l is string => l !== undefined)
  return { kind: 'success', text: lines.join('\n') }
}

export function apply(ctx: MigratePluginContext): void {
  ctx.commands.register({
    name: 'migrate',
    description: 'import chat history and memory from other agents (Claude Code, Codex, Gemini CLI, Aider, Cline, OpenCode)',
    input: { hint: '[list|run] [--source <key>] [--limit <n>]' },
    handler: async invocation => {
      const args = parseArgs(invocation.rawInput)
      if (args.error !== undefined) return { kind: 'error', text: args.error }
      try {
        return args.verb === 'list'
          ? await runList(homedir(), args.sources)
          : await runMigrate(args)
      } catch (error) {
        return { kind: 'error', text: `migration failed: ${error instanceof Error ? error.message : String(error)}` }
      }
    },
  })
}

export default { name, inject, apply }
