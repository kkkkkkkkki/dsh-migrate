import { readFile, readdir, stat, access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'

/** True when `path` exists and is readable. */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK)
    return true
  } catch {
    return false
  }
}

/** Read a UTF-8 file, returning `undefined` when unreadable. */
export async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

/** Iterate the parsed objects of a JSONL file; malformed lines are skipped. */
export async function readJsonl(path: string): Promise<unknown[]> {
  const text = await readText(path)
  if (text === undefined) return []
  const out: unknown[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      out.push(JSON.parse(trimmed))
    } catch {
      // skip malformed line
    }
  }
  return out
}

/** List directory entries, `[]` when missing. */
export async function listDir(path: string): Promise<string[]> {
  try {
    return await readdir(path)
  } catch {
    return []
  }
}

/** Stat a path, `undefined` when missing. */
export async function tryStat(path: string) {
  try {
    return await stat(path)
  } catch {
    return undefined
  }
}

/** Recursively collect files under `root` whose names match `match`, bounded. */
export async function collectFiles(
  root: string,
  match: (name: string, fullPath: string) => boolean,
  options: { maxDepth?: number; maxFiles?: number } = {},
): Promise<string[]> {
  const { maxDepth = 6, maxFiles = 100_000 } = options
  const out: string[] = []
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth || out.length >= maxFiles) return
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      return
    }
    for (const name of names) {
      if (out.length >= maxFiles) return
      if (name === 'node_modules' || name === '.git') continue
      const full = join(dir, name)
      const st = await tryStat(full)
      if (st === undefined) continue
      if (st.isDirectory()) {
        await walk(full, depth + 1)
      } else if (st.isFile() && match(name, full)) {
        out.push(full)
      }
    }
  }
  await walk(root, 0)
  return out
}

/** Narrow an unknown JSON value to a plain object. */
export function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** Narrow to a string, or `undefined`. */
export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** Narrow to a finite number, or `undefined`. */
export function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Parse a timestamp that may be epoch ms, epoch seconds, or an ISO string. */
export function asTime(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Heuristic: seconds-since-epoch values for any plausible date are < 1e11.
    return value > 1e11 ? Math.round(value) : Math.round(value * 1000)
  }
  if (typeof value === 'string') {
    const ms = Date.parse(value)
    return Number.isNaN(ms) ? undefined : ms
  }
  return undefined
}
