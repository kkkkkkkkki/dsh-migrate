/**
 * Fixture tests for the SQLite-backed adapters (Hermes Agent, OpenClaw).
 * Databases are built with each source's real upstream schema shape.
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'

import { migrate } from '../dist/index.js'

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-migrate-sqlite-test-'))
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

function firstToolResultText(events: Record<string, unknown>[]): string | undefined {
  const result = events.find(e => e.type === 'tool/result') as
    | { data: { message: { content: { content: { text: string }[] }[] } } }
    | undefined
  return result?.data.message.content[0]?.content[0]?.text
}

test('migrate imports Hermes Agent state.db sessions and memories', async () => {
  await withTempHome(async home => {
    const hermesDir = join(home, '.hermes')
    await mkdir(join(hermesDir, 'memories'), { recursive: true })
    const db = new DatabaseSync(join(hermesDir, 'state.db'))
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, source TEXT NOT NULL, title TEXT, model TEXT,
        cwd TEXT, started_at REAL NOT NULL
      );
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
        role TEXT NOT NULL, content TEXT, tool_call_id TEXT, tool_calls TEXT,
        tool_name TEXT, reasoning TEXT, reasoning_content TEXT,
        timestamp REAL NOT NULL, active INTEGER NOT NULL DEFAULT 1,
        compacted INTEGER NOT NULL DEFAULT 0
      );
    `)
    db.prepare('INSERT INTO sessions (id, source, title, model, cwd, started_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('hsess-1', 'cli', 'demo', 'kimi-for-coding', '/work/app', 1786700000)
    const insertMsg = db.prepare(
      'INSERT INTO messages (session_id, role, content, tool_call_id, tool_calls, timestamp) VALUES (?, ?, ?, ?, ?, ?)')
    insertMsg.run('hsess-1', 'user', 'deploy the app', null, null, 1786700001)
    insertMsg.run('hsess-1', 'assistant', 'on it', null,
      JSON.stringify([{ id: 'c1', type: 'function', function: { name: 'terminal', arguments: '{"cmd":"deploy.sh"}' } }]), 1786700002)
    insertMsg.run('hsess-1', 'tool', 'deployed ok', 'c1', null, 1786700003)
    insertMsg.run('hsess-1', 'assistant', 'deployed', null, null, 1786700004)
    insertMsg.run('hsess-1', 'user', 'thanks', null, null, 1786700005)
    db.close()
    await writeFile(join(hermesDir, 'memories', 'MEMORY.md'), 'deploy target is prod-2\n')
    await writeFile(join(hermesDir, 'memories', 'USER.md'), 'user is terse\n')

    const outRoot = join(home, 'out')
    const report = await migrate({ home, outRoot, sources: ['hermes'] })
    assert.equal(report.sessions.length, 1)
    const text = await readFile(report.sessions[0]!.path, 'utf8')
    assertLogShape(text)
    const { header, events } = parseLog(text)
    assert.equal(header.cwd, '/work/app')
    // two turns: 'deploy the app' + 'thanks'
    assert.equal(events.filter(e => e.type === 'turn/start').length, 2)
    const call = events.find(e => e.type === 'tool/call') as { data: { name: string } } | undefined
    assert.equal(call?.data.name, 'terminal')
    assert.equal(firstToolResultText(events), 'deployed ok')
    // provenance preserved
    const assistant = events.find(e => e.type === 'assistant/message') as
      | { data: { message: { source: { provider: string; model: string } } } }
      | undefined
    assert.equal(assistant?.data.message.source.provider, 'dsh-migrate:cli')
    assert.equal(assistant?.data.message.source.model, 'kimi-for-coding')
    // memories → one memory session
    assert.equal(report.memorySessions.length, 1)
    const memoryText = await readFile(report.memorySessions[0]!.path, 'utf8')
    assert.ok(memoryText.includes('deploy target is prod-2'))
    assert.ok(memoryText.includes('user is terse'))
  })
})

test('migrate imports OpenClaw transcript_events from agent sqlite', async () => {
  await withTempHome(async home => {
    const agentDir = join(home, '.openclaw', 'agents', 'main', 'agent')
    await mkdir(agentDir, { recursive: true })
    const db = new DatabaseSync(join(agentDir, 'openclaw-agent.sqlite'))
    db.exec(`
      CREATE TABLE session_nodes (
        session_key TEXT NOT NULL PRIMARY KEY, current_session_id TEXT NOT NULL,
        entry_json TEXT NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE session_windows (
        session_id TEXT NOT NULL PRIMARY KEY, session_key TEXT NOT NULL,
        created_at INTEGER NOT NULL, started_at INTEGER
      );
      CREATE TABLE transcript_events (
        session_id TEXT NOT NULL, seq INTEGER NOT NULL, event_json TEXT NOT NULL,
        created_at INTEGER NOT NULL, PRIMARY KEY (session_id, seq)
      );
    `)
    const t0 = 1786700100000
    db.prepare('INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, ?, ?)')
      .run('agent:main:main', 'oc-1', JSON.stringify({ cwd: '/srv/bot', model: 'gpt-x', provider: 'openai' }), t0)
    db.prepare('INSERT INTO session_windows (session_id, session_key, created_at, started_at) VALUES (?, ?, ?, ?)')
      .run('oc-1', 'agent:main:main', t0, t0)
    const events = [
      { type: 'session', id: 'oc-1', timestamp: new Date(t0).toISOString(), cwd: '/srv/bot' },
      { type: 'message', id: 'e1', parentId: null, timestamp: new Date(t0 + 1000).toISOString(), message: { role: 'user', content: [{ type: 'text', text: 'restart the worker' }] } },
      { type: 'message', id: 'e2', parentId: 'e1', timestamp: new Date(t0 + 2000).toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'restarting' }, { type: 'toolCall', id: 'tc1', name: 'bash', arguments: '{"cmd":"systemctl restart w"}' }] } },
      { type: 'message', id: 'e3', parentId: 'e2', timestamp: new Date(t0 + 3000).toISOString(), message: { role: 'toolResult', toolCallId: 'tc1', content: 'worker restarted' } },
      { type: 'compaction', id: 'e4', parentId: 'e3', timestamp: new Date(t0 + 4000).toISOString(), summary: 'user asked to restart the worker; done', firstKeptEntryId: 'e4', tokensBefore: 9000 },
    ]
    const insertEvent = db.prepare('INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES (?, ?, ?, ?)')
    events.forEach((event, i) => insertEvent.run('oc-1', i, JSON.stringify(event), t0 + i * 1000))
    db.close()
    const wsDir = join(home, '.openclaw', 'workspace', 'memory')
    await mkdir(wsDir, { recursive: true })
    await writeFile(join(home, '.openclaw', 'workspace', 'MEMORY.md'), 'worker runs on prod\n')
    await writeFile(join(wsDir, '2026-08-10.md'), 'discussed worker restart\n')

    const outRoot = join(home, 'out')
    const report = await migrate({ home, outRoot, sources: ['openclaw'] })
    assert.equal(report.sessions.length, 1)
    const text = await readFile(report.sessions[0]!.path, 'utf8')
    assertLogShape(text)
    const { header, events: out } = parseLog(text)
    assert.equal(header.cwd, '/srv/bot')
    // tool result paired by toolCallId
    assert.equal(firstToolResultText(out), 'worker restarted')
    // compaction summary present as its own imported segment
    const compactionUser = out.find(e => e.type === 'user/message' && JSON.stringify(e).includes('compaction'))
    assert.ok(compactionUser !== undefined)
    assert.equal(report.memorySessions.length, 1)
    const memoryText = await readFile(report.memorySessions[0]!.path, 'utf8')
    assert.ok(memoryText.includes('worker runs on prod'))
    assert.ok(memoryText.includes('discussed worker restart'))
  })
})
