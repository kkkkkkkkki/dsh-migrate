/** Public library surface. */
export type {
  DiscoveredSource,
  IrMemory,
  IrMessage,
  IrSession,
  IrToolCall,
  IrToolResult,
  IrTurn,
  SourceAdapter,
} from './ir.ts'
export { adapters, adapterByKey } from './formats/index.ts'
export {
  IMPORT_PROVIDER,
  SESSION_FORMAT_VERSION,
  encodeSegment,
  logPath,
  projectDir,
  projectKey,
  renderSessionLog,
  sessionDir,
  writeSession,
} from './dsh/session-writer.ts'
export { memoriesToAgentsBlock, memoriesToSession } from './dsh/memory-writer.ts'
export { appendAgentsBlock, defaultSessionsRoot, detect, migrate } from './dsh/migrate.ts'
export type { MigrateOptions, MigrateReport } from './dsh/migrate.ts'
