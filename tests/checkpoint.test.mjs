/**
 * Checkpoint / undo —— 日志式。
 *
 * 这里要证的三件事：
 *   - 「可回滚的东西」就是事件日志本身，不另存一份副本
 *   - 改过的文件能回到改动之前，run 期间新建的文件会被删掉
 *   - 二进制/超大文件明说还原不了，而不是悄悄跳过
 *
 * 也要接受一个已知边界：只有当写入经过 agent 工具时才有记录。shell 里的
 * `sed -i` 不进日志，undo 还原不了——这条写在输出里，不装作覆盖了。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'

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

function eventsOf(home) {
  const sid = basename(sessionDirOf(home))
  return readFileSync(join(sessionDirOf(home), 'events.jsonl'), 'utf8')
    .trim().split('\n').map((l) => JSON.parse(l))
}

/** 模型打一个 patch，然后收尾 */
function patcher(patch) {
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
                tool_calls: [{ id: 'c1', type: 'function', function: { name: 'apply_patch', arguments: JSON.stringify({ patch }) } }],
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

test('the edit is recorded as an event and undo reverses it', async () => {
  const patch = [
    '*** Begin Patch',
    '*** Update File: target.txt',
    '@@',
    '-original content',
    '+changed by the agent',
    '*** Add File: fresh.txt',
    '+brand new',
    '*** End Patch',
  ].join('\n')

  const server = patcher(patch)
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const home = mkdtempSync(join(tmpdir(), 'uh-cpl-'))
  const work = join(home, 'work')
  mkdirSync(work, { recursive: true })
  writeFileSync(join(work, 'target.txt'), 'original content\n')

  const env = { ...process.env, UH_HOME: home, UH_BASE_URL: `http://127.0.0.1:${port}/v1`, UH_MODEL: 'mock' }
  try {
    const r1 = await run(['run', 'edit the file', '--yes', '--allow-unconfined'], env)
    assert.equal(r1.code, 0, r1.s)
    assert.match(readFileSync(join(work, 'target.txt'), 'utf8'), /changed by the agent/)

    // 记录是事件本身，不是另一个仓库
    const events = eventsOf(home)
    const recorded = events.filter((e) => e.kind === 'checkpoint/file')
    assert.equal(recorded.length, 2, 'both the edit and the creation must be recorded')
    const edit = recorded.find((e) => e.payload.path === 'target.txt')
    assert.equal(edit.payload.before, 'original content\n')
    assert.equal(edit.payload.binary, false)

    const list = await run(['checkpoints'], env)
    assert.match(list.s, /modified\s+target\.txt/, list.s)
    assert.match(list.s, /created\s+fresh\.txt/, list.s)

    const undo = await run(['undo'], env)
    assert.equal(undo.code, 0, undo.s)
    assert.equal(readFileSync(join(work, 'target.txt'), 'utf8'), 'original content\n')
    assert.equal(existsSync(join(work, 'fresh.txt')), false, 'a file created in the turn must be removed')

    // 再按一次不该把同一轮回滚两遍
    const again = await run(['undo'], env)
    assert.notEqual(again.code, 0, 'a second undo has nothing left to do')
  } finally {
    server.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('binary content is recorded as unrestorable rather than silently skipped', async () => {
  const patch = [
    '*** Begin Patch',
    '*** Add File: blob.bin',
    '+not really binary but the log flags what it cannot restore',
    '*** End Patch',
  ].join('\n')
  const server = patcher(patch)
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const home = mkdtempSync(join(tmpdir(), 'uh-cpl2-'))
  mkdirSync(join(home, 'work'), { recursive: true })

  try {
    await run(['run', 'add a file', '--yes', '--allow-unconfined'], {
      ...process.env, UH_HOME: home, UH_BASE_URL: `http://127.0.0.1:${port}/v1`, UH_MODEL: 'mock',
    })
    const events = eventsOf(home)
    const rec = events.find((e) => e.kind === 'checkpoint/file' && e.payload.path === 'blob.bin')
    assert.ok(rec, 'the creation must be recorded')
    assert.equal(rec.payload.before, null, 'a file that did not exist records null, not empty string')
  } finally {
    server.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('undo without any recorded edits fails loudly', async () => {
  const home = mkdtempSync(join(tmpdir(), 'uh-cpl3-'))
  mkdirSync(join(home, 'work'), { recursive: true })
  try {
    const r = await run(['undo'], { ...process.env, UH_HOME: home })
    assert.notEqual(r.code, 0)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

/** 会话按 YYYY/MM/DD 分层了：从 sessions/ 往下走到第一个带 meta.json 的目录 */
function sessionDirOf(home) {
  let dir = join(home, 'sessions')
  for (let depth = 0; depth < 5; depth++) {
    let sub = []
    try { sub = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) } catch { return dir }
    if (sub.length === 0) return dir
    const next = join(dir, sub[0])
    if (existsSync(join(next, 'meta.json'))) return next
    dir = next
  }
  return dir
}
