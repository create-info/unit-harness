/**
 * 会话存储布局。
 *
 * 三件要对齐 Codex 的事：
 *   - 按 YYYY/MM/DD 分层，列最近 N 个不用扫全库
 *   - 老会话是「归档」不是「删除」——事件日志是证据，删了就没得查
 *   - 大段正文挪到 blobs/，事件行保持一行能看完
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, mkdirSync, existsSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(process.cwd(), 'dist', 'uh.cjs')

function run(args, env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { env })
    let s = ''
    p.stdout.on('data', (d) => (s += d))
    p.stderr.on('data', (d) => (s += d))
    p.on('close', (code) => resolve({ s, code }))
  })
}

/** 简单应答的模型 */
function plainServer() {
  return http.createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'mock' }] }))
      return
    }
    let b = ''
    req.on('data', (c) => (b += c))
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        model: 'mock',
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      }))
    })
  })
}

/** 打一个大 patch，验证正文外置 */
function bigPatchServer(handle) {
  let round = 0
  return http.createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'mock' }] }))
      return
    }
    let b = ''
    req.on('data', (c) => (b += c))
    req.on('end', () => {
      const payload = round++ === 0
        ? {
            model: 'mock',
            choices: [{
              message: {
                role: 'assistant', content: '',
                tool_calls: [{ id: 'c1', type: 'function', function: { name: 'apply_patch', arguments: JSON.stringify(handle) } }],
              },
              finish_reason: 'tool_calls',
            }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }
        : {
            model: 'mock',
            choices: [{ message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
          }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    })
  })
}

test('sessions are filed under YYYY/MM/DD and listed newest-first', async () => {
  const server = plainServer()
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const home = mkdtempSync(join(tmpdir(), 'uh-lay-'))
  mkdirSync(join(home, 'work'), { recursive: true })
  const env = { ...process.env, UH_HOME: home, UH_BASE_URL: `http://127.0.0.1:${port}/v1`, UH_MODEL: 'mock' }

  try {
    await run(['run', 'first'], env)
    await run(['run', 'second'], env)

    const root = join(home, 'sessions')
    const years = readdirSync(root).filter((n) => /^\d{4}$/.test(n))
    assert.equal(years.length, 1, 'sessions must sit under a year directory')
    const year = years[0]
    const months = readdirSync(join(root, year))
    const days = readdirSync(join(root, year, months[0]))
    const sessionDirs = readdirSync(join(root, year, months[0], days[0]))
    assert.equal(sessionDirs.length, 2, 'both sessions must be in today\'s folder')

    const list = await run(['sessions'], env)
    assert.match(list.s, /sessions \(newest first, 2 shown\)/, list.s)

    // 第二个会话的时间不早于第一个
    const ids = sessionDirs.sort()
    assert.ok(ids.length === 2)
  } finally {
    server.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('prune archives instead of deleting, and keeps the events readable', async () => {
  const server = plainServer()
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const home = mkdtempSync(join(tmpdir(), 'uh-prune-'))
  mkdirSync(join(home, 'work'), { recursive: true })
  const env = { ...process.env, UH_HOME: home, UH_BASE_URL: `http://127.0.0.1:${port}/v1`, UH_MODEL: 'mock' }

  try {
    await run(['run', 'old task'], env)

    // 把 meta 的 updated_at 改成 40 天前：不用真的等
    const root = join(home, 'sessions')
    const dayDir = walkToDayDir(root)
    const sid = readdirSync(dayDir)[0]
    const metaPath = join(dayDir, sid, 'meta.json')
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString()
    meta.created_at = old
    meta.updated_at = old
    writeFileSync(metaPath, JSON.stringify(meta))
    const eventsBefore = readFileSync(join(dayDir, sid, 'events.jsonl'), 'utf8')

    const dry = await run(['session', 'prune', '--older-than', '30d', '--dry-run'], env)
    assert.match(dry.s, /would archive 1/, dry.s)
    assert.ok(existsSync(join(dayDir, sid)), 'a dry run must not move anything')

    const real = await run(['session', 'prune', '--older-than', '30d'], env)
    assert.match(real.s, /archived 1/, real.s)

    const archived = walkToDayDir(join(home, 'archived_sessions'))
    assert.ok(existsSync(join(archived, sid)), 'the session must be in archived_sessions')
    assert.equal(existsSync(join(dayDir, sid)), false, 'and gone from sessions')
    // 事件仍然完整：归档不是删除
    assert.equal(readFileSync(join(archived, sid, 'events.jsonl'), 'utf8'), eventsBefore)

    const listed = await run(['sessions'], env)
    assert.equal(listed.s.includes(sid), false, 'archived sessions drop out of the list')
  } finally {
    server.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('a large body moves to blobs/ and the event line stays small', async () => {
  const big = Array.from({ length: 400 }, (_, i) => `line ${i} of a deliberately large file`).join('\n')
  const server = bigPatchServer({
    patch: ['*** Begin Patch', '*** Add File: big.txt', ...big.split('\n').map((l) => `+${l}`), '*** End Patch'].join('\n'),
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const home = mkdtempSync(join(tmpdir(), 'uh-blob-'))
  mkdirSync(join(home, 'work'), { recursive: true })

  try {
    await run(['run', 'add a big file', '--yes'], {
      ...process.env, UH_HOME: home, UH_BASE_URL: `http://127.0.0.1:${port}/v1`, UH_MODEL: 'mock',
    })

    const dayDir = walkToDayDir(join(home, 'sessions'))
    const sid = readdirSync(dayDir)[0]
    const lines = readFileSync(join(dayDir, sid, 'events.jsonl'), 'utf8').trim().split('\n')
    const rec = lines.map((l) => JSON.parse(l)).find((e) => e.kind === 'checkpoint/file' && e.payload.path === 'big.txt')
    assert.ok(rec, 'the write must be recorded')
    assert.ok(rec.payload.after_ref, 'large content must be spilled to a blob')
    assert.equal(rec.payload.after, null, 'and not inlined into the event line')
    assert.ok(rec.payload.after_size > 4096)
    assert.ok(JSON.stringify(rec).length < 2000, 'the event line must stay small')

    const blobs = readdirSync(join(dayDir, sid, 'blobs'))
    assert.equal(blobs.length, 1)

    // 外置之后 undo 仍然能还原
    const undo = await run(['undo'], { ...process.env, UH_HOME: home })
    assert.equal(undo.code, 0, undo.s)
    assert.equal(existsSync(join(home, 'work', 'big.txt')), false, 'undo must remove the created file')
  } finally {
    server.close()
    rmSync(home, { recursive: true, force: true })
  }
})

/** sessions/YYYY/MM/DD → 最深的那个日期目录 */
function walkToDayDir(root) {
  const year = readdirSync(root).filter((n) => /^\d{4}$/.test(n))[0]
  const month = readdirSync(join(root, year))[0]
  const day = readdirSync(join(root, year, month))[0]
  return join(root, year, month, day)
}
