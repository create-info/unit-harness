/**
 * 网页里的两件事：按停，和点「允许」。
 *
 * 审批在 CLI 里是 readline，在网页里必须等价——否则「沙箱兜不住的命令要过人」
 * 这条在 UI 上就是空的：默认 deny，用户连点的地方都没有。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(process.cwd(), 'dist', 'uh.cjs')
const PORT = 7961 + Math.floor(Math.random() * 60)

/** 第一次回一个 tool_call，之后回文本。argv 可指定。 */
function toolCallServer(argv) {
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
      const first = round++ === 0
      const body = first
        ? {
            model: 'mock',
            choices: [{
              message: {
                role: 'assistant', content: '',
                tool_calls: [{ id: 'c1', type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ argv }) } }],
              },
              finish_reason: 'tool_calls',
            }],
            usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 },
          }
        : {
            model: 'mock',
            choices: [{ message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
          }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    })
  })
}

function startServer(env) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [CLI, 'serve', '--port', String(PORT)], { env })
    let log = ''
    p.stdout.on('data', (d) => {
      log += d
      if (/http:\/\/127\.0\.0\.1:/.test(log)) resolve(p)
    })
    p.stderr.on('data', (d) => (log += d))
    setTimeout(() => reject(new Error('server did not start:\n' + log)), 15000)
  })
}

const post = async (p, body) =>
  (await fetch('http://127.0.0.1:' + PORT + p, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })).json()

/** 连上 SSE，读到某类事件就返回（审批请求只会从这里出来） */
async function waitForEvent(sid, kind, timeoutMs = 12000) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetch('http://127.0.0.1:' + PORT + '/api/stream?session=' + encodeURIComponent(sid), { signal: ctl.signal })
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return null
      buf += dec.decode(value, { stream: true })
      const frames = buf.split('\n\n')
      buf = frames.pop() ?? ''
      for (const f of frames) {
        const ev = /^event: (.+)$/m.exec(f)
        const data = /^data: (.+)$/m.exec(f)
        if (ev && data && ev[1] === kind) {
          reader.cancel().catch(() => {})
          return JSON.parse(data[1])
        }
      }
    }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

function sessionEvents(home) {
  let dir = join(home, 'sessions')
  for (let i = 0; i < 5; i++) {
    const sub = readdirSync(dir)
    if (sub.length === 0) return []
    const next = join(dir, sub[0])
    try { JSON.parse(readFileSync(join(next, 'meta.json'), 'utf8')); dir = next; break } catch { dir = next }
  }
  try {
    return readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  } catch { return [] }
}

test('approving in the browser lets a destructive command through; denying does not', async () => {
  for (const approve of [false, true]) {
    const srv = toolCallServer(['chmod', '-R', '777', '.'])
    await new Promise((r) => srv.listen(0, '127.0.0.1', r))
    const llmPort = srv.address().port
    const home = mkdtempSync(join(tmpdir(), 'uh-apv-'))
    mkdirSync(join(home, 'work'), { recursive: true })
    const env = { ...process.env, UH_HOME: home, UH_BASE_URL: `http://127.0.0.1:${llmPort}/v1`, UH_MODEL: 'mock' }
    const server = await startServer(env)

    try {
      await post('/api/settings', { provider: 'deepseek', model: 'mock', apiKey: 'sk-x' })
      const { sessionId } = await post('/api/run', { task: 'make everything world-writable' })

      const req = await waitForEvent(sessionId, 'approval/needs')
      assert.ok(req, 'the UI must be asked before a destructive command runs')
      assert.equal(req.risk, 'destructive')
      assert.match(req.detail, /chmod/)

      const decided = await post('/api/approve', { id: req.id, approved: approve })
      assert.equal(decided.decision, approve ? 'allow' : 'deny')
      await new Promise((r) => setTimeout(r, 1200))

      const evs = sessionEvents(home)
      const resolved = evs.find((e) => e.kind === 'approval/resolved')
      assert.ok(resolved, 'the decision must be recorded')
      assert.equal(resolved.payload.decision, approve ? 'allow' : 'deny')

      // 允许的那次命令真的跑了：工具结果不是 refused
      const result = evs.find((e) => e.kind === 'tool/result')
      if (approve) assert.notEqual(result?.payload.refused, true, 'an approved command must not be refused')
      else assert.equal(result?.payload.refused, true, 'a denied command must not run')

      const unknown = await post('/api/approve', { id: 'apr_nope', approved: true })
      assert.ok(unknown.error, 'unknown approval ids must be rejected')
    } finally {
      server.kill()
      srv.close()
      rmSync(home, { recursive: true, force: true })
    }
  }
})

test('stop interrupts a run that is stuck in a command', async () => {
  const srv = toolCallServer(['sleep', '45'])
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const llmPort = srv.address().port
  const home = mkdtempSync(join(tmpdir(), 'uh-stop-'))
  mkdirSync(join(home, 'work'), { recursive: true })
  const env = { ...process.env, UH_HOME: home, UH_BASE_URL: `http://127.0.0.1:${llmPort}/v1`, UH_MODEL: 'mock' }
  const server = await startServer(env)

  try {
    await post('/api/settings', { provider: 'deepseek', model: 'mock', apiKey: 'sk-x' })
    const { sessionId } = await post('/api/run', { task: 'sleep a long time' })
    await waitForEvent(sessionId, 'tool/call')

    const stopped = await post('/api/stop', { sessionId })
    assert.equal(stopped.ok, true)

    // 真的停了：40 秒内必须出现 turn/end(interrupted) 或 session/interrupted
    const deadline = Date.now() + 40_000
    let interrupted = false
    while (Date.now() < deadline && !interrupted) {
      const evs = sessionEvents(home)
      interrupted = evs.some((e) => e.kind === 'session/interrupted') ||
        evs.some((e) => e.kind === 'turn/end' && e.payload?.stop_reason === 'interrupted')
      if (!interrupted) await new Promise((r) => setTimeout(r, 500))
    }
    assert.equal(interrupted, true, 'the run must be marked interrupted')

    const gone = await post('/api/stop', { sessionId })
    assert.ok(gone.error, 'stopping something that already stopped must say so')
  } finally {
    server.kill()
    srv.close()
    rmSync(home, { recursive: true, force: true })
  }
})
