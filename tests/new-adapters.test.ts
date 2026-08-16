/**
 * Fixture tests for the v0.2 adapters (Cursor, ChatGPT export, Kimi CLI).
 * Fixtures are synthetic but byte-faithful to each source's on-disk shape.
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { migrate } from '../dist/index.js'

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-migrate-v02-test-'))
  try {
    return await fn(home)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

function parseLog(text: string): { header: Record<string, unknown>; events: Record<string, unknown>[] } {
  const lines = text.trim().split('\n')
  const header = JSON.parse(lines[0] as string) as Record<string, unknown>
  const events = lines.slice(1).map(l => JSON.parse(l) as Record<string, unknown>)
  return { header, events }
}

function assertLogShape(text: string): void {
  const { header, events } = parseLog(text)
  assert.equal(header.type, 'session')
  assert.equal(header.version, 0)
  assert.equal(header.delegationDepth, 0)
  events.forEach((event, i) => assert.equal(event.seq, i, `event ${i} seq`))
  const starts = events.filter(e => e.type === 'turn/start').length
  const ends = events.filter(e => e.type === 'turn/end').length
  assert.equal(starts, ends)
  assert.equal(events.at(-1)?.type, 'session/end-seed')
}

function firstUserText(events: Record<string, unknown>[]): string | undefined {
  const e = events.find(e => e.type === 'user/message') as
    | { data: { content: { text: string }[] } }
    | undefined
  return e?.data.content[0]?.text
}

function firstToolCall(events: Record<string, unknown>[]): { name?: string; arguments?: string } | undefined {
  // DSH carries calls both as tool-call content blocks on assistant/message and
  // (when paired with a result) as standalone tool/call events. Cursor imports
  // are resultless, so look at the content blocks.
  for (const e of events) {
    if (e.type !== 'assistant/message') continue
    const content = (e as { data: { message: { content: unknown[] } } }).data.message.content
    for (const rawBlock of content) {
      const block = rawBlock as { type?: string; name?: string; arguments?: string }
      if (block.type === 'tool-call') return block
    }
  }
  return undefined
}

test('migrate imports Cursor agent transcripts', async () => {
  await withTempHome(async home => {
    const composerId = 'a1b2c3d4-0000-4000-8000-abcdefabcdef'
    const dir = join(home, '.cursor', 'projects', '-work-app', 'agent-transcripts', composerId)
    await mkdir(dir, { recursive: true })
    const lines = [
      JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: '<user_query>fix the flaky test</user_query>' }] } }),
      JSON.stringify({ role: 'assistant', message: { content: [
        { type: 'text', text: 'Looking at the suite. [REDACTED]' },
        { type: 'tool_use', id: 'cu-1', name: 'read_file', input: { path: 'test/app.test.ts' } },
      ] } }),
      JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: 'The mock needs a reset between cases.' }] } }),
      'not json at all',
    ].join('\n')
    await writeFile(join(dir, `${composerId}.jsonl`), lines)

    const outRoot = join(home, 'out')
    const report = await migrate({ home, outRoot, sources: ['cursor'] })
    assert.equal(report.sessions.length, 1)
    const text = await readFile(report.sessions[0]!.path, 'utf8')
    assertLogShape(text)
    const { header, events } = parseLog(text)
    assert.equal(header['importedSource'], 'cursor')
    assert.equal(header['importedSourceId'], composerId)
    // <user_query> wrapper stripped, [REDACTED] sentinel stripped
    assert.equal(firstUserText(events), 'fix the flaky test')
    const call = firstToolCall(events)
    assert.equal(call?.name, 'read_file')
    assert.equal(call?.arguments, '{"path":"test/app.test.ts"}')
    // Cursor transcripts carry no tool results — calls import resultless
    assert.equal(events.filter(e => e.type === 'tool/result').length, 0)
  })
})

test('migrate imports ChatGPT web-export conversations.json', async () => {
  await withTempHome(async home => {
    const downloads = join(home, 'Downloads', 'chatgpt-export')
    await mkdir(downloads, { recursive: true })
    const conv = {
      id: 'conv-abc',
      title: 'Deploy questions',
      create_time: 1786700000,
      mapping: {
        root: { id: 'root', message: { author: { role: 'system' }, content: { parts: ['sys'] } }, children: ['u1'] },
        u1: { id: 'u1', parent: 'root', message: { author: { role: 'user' }, content: { parts: ['how do I deploy?'] }, create_time: 1786700001 }, children: ['a1'] },
        a1: { id: 'a1', parent: 'u1', message: { author: { role: 'assistant' }, content: { parts: ['Run the pipeline:', { text: 'make deploy' }] }, create_time: 1786700002 }, children: ['t1'] },
        t1: { id: 't1', parent: 'a1', message: { author: { role: 'tool' }, content: { parts: ['pipeline exit 0'] }, create_time: 1786700003 }, children: ['a2'] },
        a2: { id: 'a2', parent: 't1', message: { author: { role: 'assistant' }, content: { parts: ['Deployed successfully.'] }, create_time: 1786700004 }, children: [] },
        placeholder: { id: 'placeholder', parent: 'a2', message: null, children: [] },
      },
    }
    await writeFile(join(downloads, 'conversations.json'), JSON.stringify([conv]))

    const outRoot = join(home, 'out')
    const report = await migrate({ home, outRoot, sources: ['chatgpt'] })
    assert.equal(report.sessions.length, 1)
    const text = await readFile(report.sessions[0]!.path, 'utf8')
    assertLogShape(text)
    const { header, events } = parseLog(text)
    assert.equal(header['importedSource'], 'chatgpt')
    assert.equal(header['importedSourceId'], 'conv-abc')
    assert.equal(header.createdAt, 1786700000_000)
    assert.equal(firstUserText(events), 'how do I deploy?')
    // tool message folded into the assistant thread as text, never an orphan result
    assert.equal(events.filter(e => e.type === 'tool/result').length, 0)
    const assistantTexts = JSON.stringify(events.filter(e => e.type === 'assistant/message'))
    assert.ok(assistantTexts.includes('pipeline exit 0'))
  })
})

test('migrate imports Kimi CLI wire.jsonl sessions', async () => {
  await withTempHome(async home => {
    const { createHash } = await import('node:crypto')
    const workdir = 'C:\\work\\app'
    const md5 = createHash('md5').update(workdir).digest('hex')
    const sessionDir = join(home, '.kimi', 'sessions', md5, 'sess-001')
    await mkdir(sessionDir, { recursive: true })
    await writeFile(join(home, '.kimi', 'kimi.json'), JSON.stringify({ work_dirs: [{ path: workdir }] }))
    await writeFile(join(sessionDir, 'state.json'), JSON.stringify({ custom_title: 'release prep' }))
    const wire = [
      JSON.stringify({ type: 'metadata', protocol_version: '1.0' }),
      JSON.stringify({ timestamp: 1786700000, message: { type: 'TurnBegin', payload: { user_input: 'cut the release' } } }),
      JSON.stringify({ timestamp: 1786700001, message: { type: 'StepBegin', payload: { n: 1 } } }),
      JSON.stringify({ timestamp: 1786700001, message: { type: 'ThinkPart', payload: { think: 'checking ' } } }),
      JSON.stringify({ timestamp: 1786700002, message: { type: 'ThinkPart', payload: { think: 'the changelog' } } }),
      JSON.stringify({ timestamp: 1786700003, message: { type: 'TextPart', payload: { text: 'On it. ' } } }),
      JSON.stringify({ timestamp: 1786700003, message: { type: 'TextPart', payload: { text: 'Bumping versions.' } } }),
      JSON.stringify({ timestamp: 1786700004, message: { type: 'ToolCall', payload: { id: 'k1', function: { name: 'shell', arguments: '{"cmd":"npm version patch"}' } } } }),
      JSON.stringify({ timestamp: 1786700005, message: { type: 'ToolResult', payload: { tool_call_id: 'k1', return_value: { is_error: false, output: 'v1.2.4' } } } }),
      JSON.stringify({ timestamp: 1786700006, message: { type: 'SubagentEvent', payload: { inner: {} } } }),
      JSON.stringify({ timestamp: 1786700007, message: { type: 'TurnEnd', payload: {} } }),
    ].join('\n')
    await writeFile(join(sessionDir, 'wire.jsonl'), wire)

    const outRoot = join(home, 'out')
    const report = await migrate({ home, outRoot, sources: ['kimi-cli'] })
    assert.equal(report.sessions.length, 1)
    const text = await readFile(report.sessions[0]!.path, 'utf8')
    assertLogShape(text)
    const { header, events } = parseLog(text)
    assert.equal(header['importedSource'], 'kimi-cli')
    assert.equal(header['importedSourceId'], 'sess-001')
    // cwd recovered via kimi.json md5 map
    assert.equal(header.cwd, workdir)
    assert.equal(firstUserText(events), 'cut the release')
    // streamed chunks merged
    const reasoning = events.find(e => e.type === 'assistant/message' && JSON.stringify(e).includes('checking the changelog'))
    assert.ok(reasoning, 'merged reasoning chunk present')
    // tool call paired with its result (standalone tool/call + tool/result events)
    const callEvent = events.find(e => e.type === 'tool/call') as { data: { name: string } } | undefined
    assert.equal(callEvent?.data.name, 'shell')
    const result = events.find(e => e.type === 'tool/result')
    assert.ok(result, 'tool/result present')
  })
})
