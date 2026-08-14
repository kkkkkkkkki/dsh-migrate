/**
 * dsh-migrate end-to-end tests against the built CLI surface.
 * Fixtures are synthetic but byte-faithful to each source's on-disk shape.
 */
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  encodeSegment,
  migrate,
  projectKey,
  renderSessionLog,
} from '../dist/index.js'
import type { IrSession } from '../dist/index.js'

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-migrate-test-'))
  try {
    return await fn(home)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

/** Parse a produced session.jsonl back into header + events. */
function parseLog(text: string): { header: Record<string, unknown>; events: Record<string, unknown>[] } {
  const lines = text.trim().split('\n')
  assert.ok(lines.length >= 2, 'log must have a header and at least one event')
  const header = JSON.parse(lines[0] as string) as Record<string, unknown>
  const events = lines.slice(1).map(l => JSON.parse(l) as Record<string, unknown>)
  return { header, events }
}

interface ToolResultEventData {
  data: { message: { content: { content: { text: string }[] }[] } }
}

/** Extract the first text payload of the first tool/result event. */
function firstToolResultText(events: Record<string, unknown>[]): string | undefined {
  const result = events.find(e => e.type === 'tool/result') as unknown as ToolResultEventData | undefined
  return result?.data.message.content[0]?.content[0]?.text
}

function assertLogShape(text: string): void {
  const { header, events } = parseLog(text)
  assert.equal(header.type, 'session')
  assert.equal(header.version, 0)
  assert.equal(typeof header.id, 'string')
  assert.equal(header.delegationDepth, 0)
  assert.equal(typeof header.createdAt, 'number')
  // contiguous seq from 0
  events.forEach((event, i) => assert.equal(event.seq, i, `event ${i} seq`))
  assert.equal(typeof events[0]?.time, 'number')
  // balanced turns
  const starts = events.filter(e => e.type === 'turn/start').length
  const ends = events.filter(e => e.type === 'turn/end').length
  assert.equal(starts, ends)
  assert.equal(events.at(-1)?.type, 'session/end-seed')
}

test('path encoding matches the DSH format contract', () => {
  assert.equal(encodeSegment('plain-1.2_x'), 'plain-1.2_x')
  assert.equal(encodeSegment('.'), '~002E')
  assert.equal(encodeSegment('..'), '~002E~002E')
  assert.equal(encodeSegment('../escape'), '..~002Fescape')
  assert.equal(encodeSegment('~'), '~007E')
  assert.equal(projectKey('C:\\Users\\L\\proj'), '--C-Users-L-proj--')
  assert.equal(projectKey('/home/u/proj'), '--home-u-proj--')
  assert.equal(projectKey('C:\\proj~1'), '--C-proj~007E1--')
})

test('renderSessionLog emits a valid v0 log from an IR session', () => {
  const session: IrSession = {
    source: 'test-agent',
    cwd: '/tmp/proj',
    createdAt: 1_700_000_000_000,
    provider: 'anthropic',
    model: 'claude-x',
    turns: [{
      messages: [
        { role: 'user', text: ['hello'], reasoning: [], toolCalls: [], time: 1_700_000_000_100 },
        {
          role: 'assistant',
          text: ['hi — running a tool'],
          reasoning: ['thinking…'],
          toolCalls: [{ id: 'call-1', name: 'bash', arguments: '{"cmd":"ls"}', result: { text: 'ok' } }],
          time: 1_700_000_000_200,
        },
      ],
      time: 1_700_000_000_000,
    }],
  }
  const { text } = renderSessionLog(session, { id: 'fixed-id' })
  assertLogShape(text)
  const { header, events } = parseLog(text)
  assert.equal(header.id, 'fixed-id')
  assert.equal(header.cwd, '/tmp/proj')

  const user = events.find(e => e.type === 'user/message') as { data: { source: Record<string, unknown>; content: { text: string }[] } }
  assert.equal(user.data.source.kind, 'user')
  assert.equal(user.data.source.via, 'dsh-migrate:test-agent')
  assert.equal(user.data.content[0]?.text, 'hello')

  const assistant = events.find(e => e.type === 'assistant/message') as {
    data: { message: { source: { provider: string; model: string }; content: { type: string }[] } }
  }
  assert.equal(assistant.data.message.source.provider, 'dsh-migrate:anthropic')
  assert.equal(assistant.data.message.source.model, 'claude-x')
  assert.deepEqual(assistant.data.message.content.map(b => b.type), ['reasoning', 'text', 'tool-call'])

  const call = events.find(e => e.type === 'tool/call') as { data: { callId: string; name: string; arguments: string } }
  assert.equal(call.data.callId, 'call-1')
  assert.equal(call.data.name, 'bash')
  assert.equal(call.data.arguments, '{"cmd":"ls"}')

  const result = events.find(e => e.type === 'tool/result') as unknown as {
    data: { message: { source: { callId: string }; content: { toolCallId: string; content: { text: string }[] }[] } }
  }
  assert.equal(result.data.message.source.callId, 'call-1')
  assert.equal(result.data.message.content[0]?.toolCallId, 'call-1')
  assert.equal(result.data.message.content[0]?.content[0]?.text, 'ok')
})

test('migrate imports Claude Code sessions and memory', async () => {
  await withTempHome(async home => {
    const projectDir = join(home, '.claude', 'projects', '-tmp-proj')
    await mkdir(projectDir, { recursive: true })
    const rows = [
      { type: 'user', cwd: '/tmp/proj', sessionId: 'sess-1', timestamp: '2026-08-01T10:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'fix the bug' }] } },
      {
        type: 'assistant',
        cwd: '/tmp/proj',
        sessionId: 'sess-1',
        timestamp: '2026-08-01T10:00:05.000Z',
        message: {
          role: 'assistant',
          model: 'claude-fable-5',
          content: [
            { type: 'thinking', thinking: 'let me look' },
            { type: 'text', text: 'checking the file' },
            { type: 'tool_use', id: 'tu_1', name: 'Read', input: { file: 'a.ts' } },
          ],
        },
      },
      {
        type: 'user',
        cwd: '/tmp/proj',
        sessionId: 'sess-1',
        timestamp: '2026-08-01T10:00:06.000Z',
        message: { role: 'user', content: [{ type: 'tool_result', content: 'file body' }] },
        toolUseResult: { content: [{ type: 'text', text: 'file body' }] },
      },
      { type: 'assistant', cwd: '/tmp/proj', sessionId: 'sess-1', timestamp: '2026-08-01T10:00:09.000Z', message: { role: 'assistant', model: 'claude-fable-5', content: [{ type: 'text', text: 'done' }] } },
      { type: 'user', cwd: '/tmp/proj', sessionId: 'sess-1', timestamp: '2026-08-01T10:01:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'thanks' }] } },
    ]
    await writeFile(join(projectDir, 'sess-1.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n')
    await writeFile(join(home, '.claude', 'CLAUDE.md'), '# Global instructions\nBe terse.\n')
    const memoryDir = join(projectDir, 'memory')
    await mkdir(memoryDir, { recursive: true })
    await writeFile(join(memoryDir, 'prefs.md'), 'user prefers pnpm\n')

    const outRoot = join(home, 'out')
    const report = await migrate({ home, outRoot, sources: ['claude-code'] })

    assert.equal(report.sessions.length, 1)
    const written = report.sessions[0]!
    assert.equal(written.source, 'claude-code')
    assert.ok(written.path.includes('--tmp-proj--'))
    const text = await readFile(written.path, 'utf8')
    assertLogShape(text)
    const { events } = parseLog(text)
    // two turns: 'fix the bug' and 'thanks'
    assert.equal(events.filter(e => e.type === 'turn/start').length, 2)
    // tool result attached to the pending call
    assert.equal(firstToolResultText(events), 'file body')

    // memory: global CLAUDE.md + project memory → one memory session
    assert.equal(report.memorySessions.length, 1)
    const memoryText = await readFile(report.memorySessions[0]!.path, 'utf8')
    assert.ok(memoryText.includes('Be terse.'))
    assert.ok(memoryText.includes('user prefers pnpm'))
  })
})

test('migrate imports Codex rollouts', async () => {
  await withTempHome(async home => {
    const dir = join(home, '.codex', 'sessions', '2026', '08', '01')
    await mkdir(dir, { recursive: true })
    const rows = [
      { timestamp: '2026-08-01T09:00:00.000Z', type: 'session_meta', payload: { id: 'codex-1', cwd: '/work/app' } },
      { timestamp: '2026-08-01T09:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'add tests' }] } },
      { timestamp: '2026-08-01T09:00:02.000Z', type: 'response_item', payload: { type: 'function_call', name: 'shell', call_id: 'fc1', arguments: '{"cmd":"vitest"}' } },
      { timestamp: '2026-08-01T09:00:03.000Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'fc1', output: '3 passed' } },
      { timestamp: '2026-08-01T09:00:04.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'tests added' }] } },
    ]
    await writeFile(join(dir, 'rollout-2026-08-01T09-00-00-codex-1.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n')
    await writeFile(join(home, '.codex', 'AGENTS.md'), 'use strict typescript\n')

    const outRoot = join(home, 'out')
    const report = await migrate({ home, outRoot, sources: ['codex'] })
    assert.equal(report.sessions.length, 1)
    const text = await readFile(report.sessions[0]!.path, 'utf8')
    assertLogShape(text)
    const { header, events } = parseLog(text)
    assert.equal(header.cwd, '/work/app')
    assert.equal(firstToolResultText(events), '3 passed')
    assert.equal(report.memorySessions.length, 1)
  })
})

test('migrate imports Gemini CLI checkpoints', async () => {
  await withTempHome(async home => {
    const dir = join(home, '.gemini', 'tmp', 'my-proj', 'chats')
    await mkdir(dir, { recursive: true })
    const doc = {
      sessionId: 'gem-1',
      startTime: '2026-08-02T12:00:00.000Z',
      messages: [
        { id: 'u1', timestamp: '2026-08-02T12:00:01.000Z', type: 'user', content: 'explain this repo' },
        {
          id: 'g1',
          timestamp: '2026-08-02T12:00:05.000Z',
          type: 'gemini',
          content: 'it is a cli',
          thoughts: [{ subject: 'Repo', description: 'looks like a CLI' }],
          toolCalls: [{ id: 'tc1', name: 'run_shell_command', args: { command: 'ls' }, result: [{ functionResponse: { response: { output: 'a.txt' } } }] }],
        },
      ],
    }
    await writeFile(join(dir, 'session-2026-08-02T12-00-gem-1.json'), JSON.stringify(doc))
    await writeFile(join(home, '.gemini', 'GEMINI.md'), 'always cite files\n')

    const outRoot = join(home, 'out')
    const report = await migrate({ home, outRoot, sources: ['gemini-cli'] })
    assert.equal(report.sessions.length, 1)
    const text = await readFile(report.sessions[0]!.path, 'utf8')
    assertLogShape(text)
    const { events } = parseLog(text)
    const assistant = events.find(e => e.type === 'assistant/message') as { data: { message: { content: { type: string }[] } } }
    assert.deepEqual(assistant.data.message.content.map(b => b.type), ['reasoning', 'text', 'tool-call'])
    assert.equal(firstToolResultText(events), 'a.txt')
  })
})

test('migrate imports Aider markdown history', async () => {
  await withTempHome(async home => {
    const project = join(home, 'work', 'myproj')
    await mkdir(project, { recursive: true })
    const history = [
      '# aider chat started at 2026-08-03 08:30:00',
      '',
      '#### USER',
      'refactor the parser',
      '',
      '#### ASSISTANT',
      'I will split parser.ts into two modules.',
      '',
      '#### USER',
      'go ahead',
      '',
      '#### ASSISTANT',
      'Done.',
      '',
    ].join('\n')
    await writeFile(join(project, '.aider.chat.history.md'), history)

    const outRoot = join(home, 'out')
    const report = await migrate({ home, outRoot, sources: ['aider'] })
    assert.equal(report.sessions.length, 1)
    const text = await readFile(report.sessions[0]!.path, 'utf8')
    assertLogShape(text)
    const { events } = parseLog(text)
    assert.equal(events.filter(e => e.type === 'turn/start').length, 2)
    const users = events.filter(e => e.type === 'user/message') as { data: { content: { text: string }[] } }[]
    assert.equal(users[0]?.data.content[0]?.text, 'refactor the parser')
  })
})

test('Cline api_conversation_history parser maps Anthropic-shaped rows', async () => {
  const { parseClineConversation } = await import('../dist/formats/cline.js')
  const parsed = parseClineConversation([
    { role: 'user', content: [{ type: 'text', text: 'open the sidebar' }], ts: 1_700_000_000_000 },
    { role: 'assistant', content: [{ type: 'text', text: 'opening' }], ts: 1_700_000_001_000 },
    { role: 'user', content: [{ type: 'tool_result', content: 'sidebar opened' }], ts: 1_700_000_002_000 },
  ])
  assert.ok(parsed !== undefined)
  assert.equal(parsed.turns.length, 1)
  assert.equal(parsed.turns[0]?.messages[0]?.role, 'user')
  const assistantTexts = parsed.turns[0]?.messages.filter(m => m.role === 'assistant').flatMap(m => m.text) ?? []
  assert.ok(assistantTexts.some(t => t.includes('opening')))
  assert.ok(assistantTexts.some(t => t.includes('[tool result] sidebar opened')))
})

test('writeSession never overwrites an existing log', async () => {
  await withTempHome(async home => {
    const session: IrSession = {
      source: 'test',
      cwd: '/x',
      createdAt: 1,
      turns: [{ messages: [{ role: 'user', text: ['a'], reasoning: [], toolCalls: [], time: 1 }] }],
    }
    const { writeSession } = await import('../dist/index.js')
    const first = await writeSession(join(home, 'out'), session, { id: 'same-id' })
    const second = await writeSession(join(home, 'out'), session, { id: 'same-id' })
    assert.notEqual(first.id, second.id)
    assert.ok((await readdir(join(home, 'out', '--x--'))).length === 2)
  })
})
