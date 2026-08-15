/**
 * Shared read-only SQLite access for adapters whose sources store sessions in
 * SQLite (Hermes, OpenClaw). Uses Node's built-in `node:sqlite` (22.13+ /
 * 24+), opened with `mode: 'immutable'` so a live source's WAL/database is
 * never touched, locked, or checkpointed.
 */
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'

/** True when the runtime provides node:sqlite (guards older Nodes). */
export function sqliteAvailable(): boolean {
  try {
    return typeof DatabaseSync === 'function'
  } catch {
    return false
  }
}

/**
 * Open a SQLite database strictly read-only. `immutable` tells SQLite the
 * file cannot change (no locking, no WAL recovery attempt) — correct for
 * snapshots and safe against a concurrently-running source.
 */
export function openReadOnly(path: string): DatabaseSync {
  const url = pathToFileURL(path)
  url.searchParams.set('mode', 'ro')
  url.searchParams.set('immutable', '1')
  return new DatabaseSync(url, { open: true })
}
