import type { SourceAdapter } from '../ir.ts'
import { aiderAdapter } from './aider.ts'
import { claudeCodeAdapter } from './claude-code.ts'
import { clineAdapter } from './cline.ts'
import { codexAdapter } from './codex.ts'
import { geminiCliAdapter } from './gemini-cli.ts'
import { openCodeAdapter } from './opencode.ts'

/** All built-in source adapters, in display order. */
export const adapters: SourceAdapter[] = [
  claudeCodeAdapter,
  codexAdapter,
  geminiCliAdapter,
  clineAdapter,
  openCodeAdapter,
  aiderAdapter,
]

export function adapterByKey(key: string): SourceAdapter | undefined {
  return adapters.find(a => a.key === key)
}
