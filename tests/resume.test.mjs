/**
 * 中断与续跑。
 *
 * 这两件事是一体的：Ctrl+C 之后如果状态没落盘，--continue 就是空话；
 * 而状态落盘了却不知道「是被谁停下的」，下次也不知道该接什么。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(process.cwd(), 'dist', 'uh.cjs')

function modelServer(onRequest) {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'mock' }] }))
      return
    }
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : {}
      const payload = onRequest(parsed)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    })
  })
  return server
}

const stop = (text) => ({
  model: 'mock',
  choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
})

test('SIGINT stops the run, records it, and saves resumable state', { skip: process.platform === 'win32' ? 'signals differ on windows' : false }, async () => {
  // 让模型一直要求跑一个长命令：中断必须能打断正在执行的工具，
  // 而不是等它自己跑完（否则用户按了 Ctrl+C 还得干等）
  const server = modelServer(() => ({
    model: 'mock',
    choices: [{
      message: {
        role: 'assistant', content: '',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'run_command', arguments: '{"argv":["sleep","30"]}' } }],
      },
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
  }))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const home = mkdtempSync(join(tmpdir(), 'uh-int-'))

  try {
    const child = spawn(process.execPath, [CLI, 'run', 'run something slow', '--max-steps', '5'], {
      env: { ...process.env, UH_HOME: home, UH_BASE_URL: `http://127.0.0.1:${port}/v1`, UH_MODEL: 'mock' },
    })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))

    // 等工具真的开始跑了再中断
    await new Promise((r) => setTimeout(r, 1500))
    const started = Date.now()
    child.kill('SIGINT')

    const code = await new Promise((r) => child.on('close', (c) => r(c)))
    const elapsed = Date.now() - started

    assert.equal(code, 130, `expected 130, got ${code}. output:\n${out}`)
    assert.ok(elapsed < 10000, `interrupt must not wait for the 30s command (took ${elapsed}ms)`)

    const sid = readdirSync(join(home, 'sessions'))[0]
    const events = readFileSync(join(home, 'sessions', sid, 'events.jsonl'), 'utf8')
      .trim().split('\n').map((l) => JSON.parse(l))
    assert.ok(events.some((e) => e.kind === 'session/interrupted'), 'the interrupt must be recorded')

    // 关键：状态必须落盘，否则 --continue 无据可依
    const statePath = join(home, 'sessions', sid, 'state.json')
    assert.ok(existsSync(statePath), 'state.json must exist for --continue')
    const state = JSON.parse(readFileSync(statePath, 'utf8'))
    assert.equal(state.stopped_by, 'interrupted')
    assert.ok(Array.isArray(state.messages) && state.messages.length >= 2)
  } finally {
    server.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('--continue sends the previous conversation to the model', async () => {
  const seen = []
  const server = modelServer((parsed) => {
    seen.push(parsed)
    return stop(`reply ${seen.length}`)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const home = mkdtempSync(join(tmpdir(), 'uh-cont-'))
  const env = { ...process.env, UH_HOME: home, UH_BASE_URL: `http://127.0.0.1:${port}/v1`, UH_MODEL: 'mock' }

  const runOnce = (args) => new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, 'run', ...args], { env })
    let s = ''
    p.stdout.on('data', (d) => (s += d))
    p.stderr.on('data', (d) => (s += d))
    p.on('close', (code) => resolve({ s, code }))
  })

  try {
    const first = await runOnce(['first task about widgets'])
    assert.equal(first.code, 0, first.s)

    const second = await runOnce(['--continue'])
    assert.equal(second.code, 0, second.s)
    assert.match(second.s, /resuming ses_/)

    // 第二次请求里必须带着第一轮的用户消息
    const msgs = seen.at(-1).messages
    assert.ok(msgs.some((m) => m.role === 'user' && /widgets/.test(String(m.content))),
      'the previous turn must be in the context')
    assert.ok(msgs.some((m) => m.role === 'assistant'), 'previous assistant turns must be there too')
  } finally {
    server.close()
    rmSync(home, { recursive: true, force: true })
  }
})
