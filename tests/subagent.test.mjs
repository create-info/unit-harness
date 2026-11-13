/**
 * 子 agent。
 *
 * 要证明的是「它真的独立干了一段活，结果回到父 agent 手里」，并且**不会无限递归**——
 * 一个能召唤自己的 agent，只要有一步判断失误就是无限套娃，而每一层都在花钱。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
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

function eventsOf(home) {
  const sid = readdirSync(join(home, 'sessions'))[0]
  return readFileSync(join(home, 'sessions', sid, 'events.jsonl'), 'utf8')
    .trim().split('\n').map((l) => JSON.parse(l))
}

test('a sub-agent runs its own conversation and reports back', async () => {
  let round = 0
  const server = http.createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'mock' }] }))
      return
    }
    let b = ''
    req.on('data', (c) => (b += c))
    req.on('end', () => {
      const parsed = JSON.parse(b || '{}')
      const isSub = !(parsed.messages ?? []).some((m) => m.role === 'system' && /You are UnitHarness/.test(String(m.content)))
      round++
      let payload
      if (round === 1) {
        // 父 agent：派活
        payload = {
          model: 'mock',
          choices: [{
            message: {
              role: 'assistant', content: '',
              tool_calls: [{ id: 'c1', type: 'function', function: { name: 'spawn_agent', arguments: JSON.stringify({ task: 'count the files' }) } }],
            },
            finish_reason: 'tool_calls',
          }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }
      } else if (round === 2) {
        // 子 agent：干完活，交报告
        payload = {
          model: 'mock',
          choices: [{ message: { role: 'assistant', content: 'there are 3 files' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 },
        }
      } else {
        payload = {
          model: 'mock',
          choices: [{ message: { role: 'assistant', content: 'summary: 3 files' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 30, completion_tokens: 3, total_tokens: 33 },
        }
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
      void isSub
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const home = mkdtempSync(join(tmpdir(), 'uh-sub-'))

  try {
    const { s, code } = await run(['run', 'find out how many files there are', '--max-steps', '4'], {
      ...process.env, UH_HOME: home, UH_BASE_URL: `http://127.0.0.1:${port}/v1`, UH_MODEL: 'mock',
    })
    assert.equal(code, 0, s)

    const events = eventsOf(home)
    const spawned = events.find((e) => e.kind === 'agent/spawned')
    const finished = events.find((e) => e.kind === 'agent/finished')
    assert.ok(spawned, 'spawning must be recorded')
    assert.equal(spawned.payload.task, 'count the files')
    assert.ok(finished, 'finishing must be recorded too')
    assert.equal(finished.payload.agent, spawned.payload.agent)
    assert.ok(finished.payload.steps >= 1)
    assert.equal(finished.parent_id, spawned.id, 'finish should hang off the spawn event')

    // 子 agent 走了自己的对话：三张请求，两次是独立的
    assert.equal(round, 3)
  } finally {
    server.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('a sub-agent cannot spawn forever', async () => {
  // 每一层都要求再派一个：第 3 层必须被拒
  let depth = 0
  const server = http.createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'mock' }] }))
      return
    }
    let b = ''
    req.on('data', (c) => (b += c))
    req.on('end', () => {
      depth++
      const payload = {
        model: 'mock',
        choices: [{
          message: {
            role: 'assistant', content: '',
            tool_calls: [{ id: `c${depth}`, type: 'function', function: { name: 'spawn_agent', arguments: JSON.stringify({ task: 'go deeper' }) } }],
          },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const home = mkdtempSync(join(tmpdir(), 'uh-sub2-'))

  try {
    const { s } = await run(['run', 'recurse', '--max-steps', '6'], {
      ...process.env, UH_HOME: home, UH_BASE_URL: `http://127.0.0.1:${port}/v1`, UH_MODEL: 'mock',
    })
    const events = eventsOf(home)
    const spawned = events.filter((e) => e.kind === 'agent/spawned')
    const levels = spawned.map((e) => Number(e.payload.level))
    assert.ok(spawned.length >= 1, 'the first sub-agent must run')
    assert.ok(Math.max(...levels) <= 2, `depth must be capped at 2, saw levels ${levels.join(',')}`)
    // 深度有界不等于成本有界：要有一个总数上限
    assert.ok(spawned.length <= 8, `sub-agent budget must hold, saw ${spawned.length}`)
    // 被拒的那次要以错误形式回到父 agent，而不是把整次 run 炸掉
    const errs = events.filter((e) => e.kind === 'tool/result' && e.payload.tool === 'spawn_agent' && e.payload.status === 'error')
    assert.ok(errs.length >= 1, 'the depth limit must surface as a tool error')
    assert.match(JSON.stringify(errs[0].payload), /E_AGENT_DEPTH/)
    void s
  } finally {
    server.close()
    rmSync(home, { recursive: true, force: true })
  }
})
