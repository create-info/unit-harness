/**
 * LLM 层报错时，这一轮必须留下 turn/end。
 *
 * 起因是一次冒烟：模型返回 401，事件日志里 `turn/start` 后面直接是
 * `session/end`——**那一轮悬空了**。
 *
 * 这跟 `tool/call` 没有 `tool/result` 是同一类毛病：审计链断在半空，
 * 事后分不清「模型报错了」还是「进程被杀了」。区别在于前者只是难查，
 * 后者会让回放和续跑都算错轮次。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('..', import.meta.url))
const CLI = join(here, 'dist', 'uh.cjs')

/**
 * 每个测试单独一套 home + work。
 *
 * 一开始这套目录是模块级的，第一个测试在 finally 里把它删了，
 * 第二个测试的 cwd 就指向了不存在的路径——spawn 卡在那里直到超时。
 */
function freshHome(tag) {
  const home = mkdtempSync(join(tmpdir(), `uh-turnend-${tag}-`))
  const work = join(home, 'work')
  mkdirSync(work, { recursive: true })
  return { home, work }
}

/** 模型端点：GET 是模型列表，POST 一律按给定的状态码失败 */
function failingModel(status, body) {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'mock' }] }))
      return
    }
    req.resume()
    req.on('end', () => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    })
  })
  let port = 0
  const started = new Promise((r) => server.listen(0, '127.0.0.1', () => {
    port = server.address().port
    r()
  }))
  return { server, started: async () => { await started; return port } }
}

function run(args, env, cwd) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { env, cwd })
    let out = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (out += d))
    p.on('close', (code) => resolve({ out, code }))
  })
}

/** 找到这次会话唯一的事件文件 */
function eventsOf(home) {
  const base = join(home, 'sessions')
  const stack = [base]
  while (stack.length) {
    const d = stack.pop()
    let entries
    try { entries = readdirSync(d, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      const p = join(d, e.name)
      if (e.isDirectory()) { stack.push(p); continue }
      if (e.name !== 'events.jsonl') continue
      const evs = readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
      if (evs.some((x) => x.kind === 'turn/start')) return evs
    }
  }
  return []
}

test('a failing model still closes the turn it opened', async () => {
  const m = failingModel(401, { error: { message: 'api key is invalid' } })
  const port = await m.started()
  const { home, work } = freshHome('a')
  try {
    const env = {
      ...process.env,
      UH_HOME: home,
      UH_PROVIDER: 'openai',
      UH_MODEL: 'mock',
      UH_BASE_URL: `http://127.0.0.1:${port}/v1`,
      UH_API_KEY: 'not-a-real-key',
      NO_COLOR: '1',
    }
    const r = await run(['run', 'do something'], env, work)
    assert.notEqual(r.code, 0, 'a failed run must not exit 0')

    const evs = eventsOf(home)
    const starts = evs.filter((e) => e.kind === 'turn/start')
    const ends = evs.filter((e) => e.kind === 'turn/end')
    assert.equal(starts.length, 1)
    assert.equal(ends.length, 1, 'the turn that started must end, even on an error')

    const end = ends[0]
    assert.equal(end.payload.stop_reason, 'error')
    // 错误原因要留下，否则回看日志只知道"报错了"、不知道错在哪
    assert.match(String(end.payload.error), /invalid|401/i)
    // 事件顺序：turn/start 在前
    assert.ok(evs.indexOf(starts[0]) < evs.indexOf(end))
  } finally {
    m.server.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('the step that failed is recorded too, before the turn closes', async () => {
  const m = failingModel(500, { error: { message: 'upstream exploded' } })
  const port = await m.started()
  try {
    const { home, work } = freshHome('b')
    const env = {
      ...process.env,
      UH_HOME: home,
      UH_PROVIDER: 'openai',
      UH_MODEL: 'mock',
      UH_BASE_URL: `http://127.0.0.1:${port}/v1`,
      UH_API_KEY: 'x',
      NO_COLOR: '1',
    }
    await run(['run', 'do something'], env, work)

    const evs = eventsOf(home)
    const kinds = evs.map((e) => e.kind)
    const stepEnd = kinds.lastIndexOf('step/end')
    const turnEnd = kinds.lastIndexOf('turn/end')
    assert.ok(stepEnd >= 0 && turnEnd >= 0)
    assert.ok(stepEnd < turnEnd, 'the step must close before the turn does')
    assert.equal(evs[stepEnd].payload.status, 'error')
    rmSync(home, { recursive: true, force: true })
  } finally {
    m.server.close()
  }
})
