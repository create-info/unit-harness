/**
 * 两件从真实使用里冒出来的事：
 *
 * 1. **默认不该有步数上限。** 12 步是探索型任务的起步价，跑满就停、答案还是空的，
 *    屏幕上只剩「Hit the step limit · 12 steps」。Codex 没有这个上限，边界是
 *    上下文和用户的耐心；我们交给 token 预算、用户 Stop 和 --max-steps 去管。
 * 2. **被截停时也要说一句人话。** 不然上层（尤其是子 agent）拿到空字符串，
 *    父 agent 只能说「子代理没返回结果，我自己来查」，用户看到「— done —」后面空白。
 *
 * 顺带钉住排队插话的撤回语义：撤回之后那句绝不能再按原样生效。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(process.cwd(), 'dist', 'uh.cjs')

/**
 * 假模型：前 `toolSteps` 次都用工具，之后收尾。
 * 请求里没有 tools（收尾那一问）时直接给一句话——这正是「强制汇报」那条路径。
 */
function startMock({ toolSteps = 15, delayMs = 0, alwaysTools = false } = {}) {
  const seen = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : {}
      seen.push(parsed)
      const toolReplies = (parsed.messages ?? []).filter((m) => m.role === 'tool').length
      const noTools = !Array.isArray(parsed.tools) || parsed.tools.length === 0
      const payload = noTools
        ? {
            model: 'mock',
            choices: [{ message: { role: 'assistant', content: 'FINAL REPORT from the tools: nothing broke.' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
          }
        : !alwaysTools && toolReplies >= toolSteps
          ? {
              model: 'mock',
              choices: [{ message: { role: 'assistant', content: `finished after ${toolReplies} tool steps` }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
            }
          : {
              model: 'mock',
              choices: [{
                message: {
                  role: 'assistant',
                  content: '',
                  tool_calls: [{
                    id: `call_${toolReplies}`,
                    type: 'function',
                    function: { name: 'run_command', arguments: JSON.stringify({ argv: ['echo', 'step'] }) },
                  }],
                },
                finish_reason: 'tool_calls',
              }],
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            }
      const send = () => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(payload))
      }
      if (delayMs) setTimeout(send, delayMs)
      else send()
    })
  })
  return { server, seen }
}

function runCli(args, env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, ...env } })
    let out = ''
    let err = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (err += d))
    p.on('close', (code) => resolve({ code, out, err }))
  })
}

/** 会话目录是 home/sessions/YYYY/MM/DD/<id>，按日期分了层 */
function sessionDir(home, id) {
  const walk = (dir, depth) => {
    if (depth > 4) return null
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return null }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const p = join(dir, e.name)
      if (e.name === id) return p
      const found = walk(p, depth + 1)
      if (found) return found
    }
    return null
  }
  return walk(join(home, 'sessions'), 0)
}

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer()
  s.once('error', reject)
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) })
})

test('a run is not capped at 12 steps by default', async () => {
  const { server, seen } = startMock({ toolSteps: 15 })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const home = mkdtempSync(join(tmpdir(), 'uh-limit-'))
  try {
    const res = await runCli(
      ['run', 'explore the codebase', '--base-url', `http://127.0.0.1:${port}/v1`, '--model', 'mock'],
      { UH_HOME: home },
    )
    assert.equal(res.code, 0, 'exit ' + res.code + '\n' + res.out.slice(-600) + res.err.slice(-600))
    // 15 次工具调用意味着它越过了原来那个 12 步的墙
    assert.ok(seen.length >= 16, 'expected at least 15 tool steps and one closing answer, saw ' + seen.length)
    assert.match(res.out, /finished after 15 tool steps/)
    assert.doesNotMatch(res.out, /step limit/i, 'nothing should be cut off at 12 any more')
  } finally {
    server.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('an explicit cap still ends with a real answer instead of nothing', async () => {
  const { server } = startMock({ alwaysTools: true })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const home = mkdtempSync(join(tmpdir(), 'uh-limit2-'))
  try {
    const res = await runCli(
      ['run', 'keep going', '--base-url', `http://127.0.0.1:${port}/v1`, '--model', 'mock', '--max-steps', '2'],
      { UH_HOME: home },
    )
    // 被上限截停时退出码是 2（脚本能据此区分「跑完了」和「被截断」）；
    // 但屏幕上必须还有一句人话——以前这里是空的
    assert.equal(res.code, 2, 'a capped run reports exit 2\n' + res.out.slice(-600))
    assert.match(res.out, /--- answer ---/)
    assert.match(res.out, /FINAL REPORT/, 'a capped run must still say what it found')
  } finally {
    server.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('a sub-agent comes back with its findings, not with "(no text)"', async () => {
  // 用户的原话：「子代理没返回结果」——子 agent 被 6 步砍断时，父 agent 拿到的
  // 是一句 (no text)，于是它只能说「我自己来查」。这条钉住子 agent 必须带话回来。
  const seen = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : {}
      seen.push(parsed)
      const msgs = parsed.messages ?? []
      const isChild = msgs.some((m) => m.role === 'user' && String(m.content).includes('look at the config'))
      const toolReplies = msgs.filter((m) => m.role === 'tool').length
      const subResult = msgs.filter((m) => m.role === 'tool' && String(m.content).startsWith('[worker')).pop()
      let payload
      if (isChild && toolReplies < 3) {
        payload = {
          model: 'mock',
          choices: [{
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [{ id: `c${toolReplies}`, type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ argv: ['echo', 'child'] }) } }],
            },
            finish_reason: 'tool_calls',
          }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }
      } else if (isChild) {
        payload = {
          model: 'mock',
          choices: [{ message: { role: 'assistant', content: 'child finding: the config lives in ~/.uh/config.json' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 6, total_tokens: 16 },
        }
      } else if (subResult) {
        payload = {
          model: 'mock',
          choices: [{ message: { role: 'assistant', content: 'parent answer from ' + String(subResult.content).replace(/\n/g, ' | ') }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 6, total_tokens: 16 },
        }
      } else {
        payload = {
          model: 'mock',
          choices: [{
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [{ id: 'spawn1', type: 'function', function: { name: 'spawn_agent', arguments: JSON.stringify({ task: 'look at the config' }) } }],
            },
            finish_reason: 'tool_calls',
          }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const home = mkdtempSync(join(tmpdir(), 'uh-sub-'))
  try {
    const res = await runCli(
      ['run', 'find where the config lives', '--base-url', `http://127.0.0.1:${port}/v1`, '--model', 'mock'],
      { UH_HOME: home },
    )
    assert.equal(res.code, 0, 'exit ' + res.code + '\n' + res.out.slice(-800))
    assert.match(res.out, /worker1 finished after/, 'the sub-agent must come back under its own name')
    assert.match(res.out, /child finding: the config lives/, 'the sub-agent must report its findings')
    assert.match(res.out, /parent answer from \[worker1/, 'the parent must be able to use that report')
    assert.doesNotMatch(res.out, /\(no text\)/, 'an empty sub-agent result is the bug being fixed')
  } finally {
    server.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('a queued note can be withdrawn before it lands', async () => {
  // 每步慢一点，才来得及在第一个 step 边界之前把它撤掉
  const { server } = startMock({ toolSteps: 3, delayMs: 400 })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const home = mkdtempSync(join(tmpdir(), 'uh-steer-'))
  const servePort = await freePort()
  const proc = spawn(process.execPath, [CLI, 'serve', '--port', String(servePort)], {
    env: {
      ...process.env,
      UH_HOME: home,
      UH_BASE_URL: `http://127.0.0.1:${port}/v1`,
      UH_MODEL: 'mock',
    },
  })
  const base = `http://127.0.0.1:${servePort}`
  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('serve did not start')), 15000)
      proc.stdout.on('data', (d) => { if (/UnitHarness UI/.test(String(d))) { clearTimeout(t); resolve() } })
    })

    // 设置页那一步跳过：直接告诉服务端用哪个 provider/model
    await fetch(`${base}/api/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'deepseek', model: 'mock', apiKey: 'k' }),
    })

    const runRes = await fetch(`${base}/api/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task: 'do something', workspace: home }),
    })
    const started = await runRes.json()
    const sid = started.sessionId
    assert.ok(sid, 'run should start a session: ' + JSON.stringify(started))

    const steerRes = await fetch(`${base}/api/steer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: sid, text: 'never mind, stop at the tests' }),
    })
    const steered = await steerRes.json()
    assert.ok(steered.id, 'the queue must hand back an id so it can be taken back')

    const win = await (await fetch(`${base}/api/steer/withdraw`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: sid, id: steered.id }),
    })).json()
    assert.equal(win.ok, true, 'withdrawing a queued note should succeed')

    // 再撤一次：它已经不在队列里了
    const again = await (await fetch(`${base}/api/steer/withdraw`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: sid, id: steered.id }),
    })).json()
    assert.equal(again.ok, false, 'a second withdraw must report that it is gone')

    // 等这一轮跑完，再看日志：撤掉的那句不能以 applied 的身份出现
    for (let i = 0; i < 60; i++) {
      const info = await (await fetch(`${base}/api/session/${sid}`)).json()
      if (info.answer) break
      await new Promise((r) => setTimeout(r, 250))
    }
    const log = join(sessionDir(home, sid) ?? join(home, 'missing'), 'events.jsonl')
    assert.ok(existsSync(log), 'the session log should exist')
    const events = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    const steering = events.filter((e) => e.kind === 'steering/message' || e.kind === 'steering/withdrawn')
    assert.ok(
      steering.some((e) => e.kind === 'steering/withdrawn' && e.payload.id === steered.id),
      'the withdrawal should be recorded; saw ' + JSON.stringify({ steered, steering }),
    )
    assert.ok(
      !steering.some((e) => e.payload.status === 'applied' && e.payload.text === 'never mind, stop at the tests'),
      'a withdrawn note must never be applied',
    )
  } finally {
    proc.kill('SIGKILL')
    server.close()
    rmSync(home, { recursive: true, force: true })
  }
})
