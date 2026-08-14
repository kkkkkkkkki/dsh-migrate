/**
 * `dsh-migrate` command line: import chat history and memory from other AI
 * agents into DeepSeek Harness session storage.
 */
import { homedir } from 'node:os'
import { Command } from 'commander'
import { adapters } from './formats/index.js'
import { defaultSessionsRoot, detect, migrate } from './dsh/migrate.js'
import type { SourceAdapter } from './ir.js'

interface CliOptions {
  source?: string[]
  out?: string
  home?: string
  limit?: number
  writeInstructions?: string
  verbose?: boolean
}

const program = new Command()
  .name('dsh-migrate')
  .description('Import chat history and memory from other AI agents into DeepSeek Harness')
  .version('0.1.0')

program
  .command('list', { isDefault: true })
  .description('List detected importable sources')
  .option('-s, --source <key...>', 'restrict to these sources')
  .option('--home <dir>', 'scan this home directory instead of the real one')
  .action(async (options: CliOptions) => {
    const home = options.home ?? homedir()
    const found = await detect(home, options.source)
    if (found.length === 0) {
      console.log(`No importable agent data found under ${home}`)
      console.log(`Supported: ${adapters.map((a: SourceAdapter) => `${a.label} (${a.key})`).join(', ')}`)
      return
    }
    console.log('Importable sources:')
    for (const d of found) {
      console.log(`  ${d.label} (${d.source})`)
      console.log(`    ${d.sessionCount} session(s), ${d.memoryCount} memory item(s) at ${d.root}`)
    }
    console.log('\nRun `dsh-migrate run` to import.')
  })

program
  .command('run')
  .description('Import detected sessions and memory into DSH session storage')
  .option('-s, --source <key...>', 'restrict to these sources')
  .option('-o, --out <dir>', 'session root (default: $DSH_HOME/sessions-imported or ~/.dsh/sessions-imported)')
  .option('--home <dir>', 'scan this home directory instead of the real one')
  .option('-n, --limit <n>', 'max sessions per source (most recent win)', v => Number.parseInt(v, 10))
  .option('--write-instructions <project>', 'also append imported memory to this project\'s AGENTS.md')
  .option('-v, --verbose', 'print one line per imported session')
  .action(async (options: CliOptions) => {
    const home = options.home ?? homedir()
    const outRoot = options.out ?? defaultSessionsRoot(home)
    console.log(`Importing into ${outRoot} …`)
    const report = await migrate({
      home,
      sources: options.source,
      outRoot,
      limit: options.limit,
      instructionsProject: options.writeInstructions,
      verbose: options.verbose,
    })
    for (const skipped of report.skipped) {
      console.warn(`  ! ${skipped.source}: ${skipped.reason}`)
    }
    for (const written of report.sessions) {
      if (options.verbose) console.log(`  [${written.source}] ${written.id} — ${written.events} events`)
    }
    console.log(`\nImported ${report.sessions.length} session(s) and ${report.memorySessions.length} memory session(s).`)
    if (report.instructionsFile !== undefined) {
      console.log(`Appended imported memory to ${report.instructionsFile}`)
    }
    console.log('\nOpen them in DSH with the migration overlay (raw-JSONL store at')
    console.log('$DSH_HOME/sessions-imported + the /migrate command):')
    console.log('  dsh web --patch node_modules/@kodzhima/dsh-migrate/cordis.patch.yml')
    console.log('Imported sessions surface under the "imported" workspace, grouped')
    console.log('by their original project directory.')
  })

program.parseAsync(process.argv).catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
