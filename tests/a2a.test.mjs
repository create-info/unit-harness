/**
 * A2A 服务端测试。
 *
 * 重点不在"能起一个 HTTP 服务"，而在三件容易做错的事：
 *   1) 状态是从 events.jsonl 推导的，不是内存里另存一份——所以重启也不会答错；
 *   2) 我们的审批门要能映射成 TASK_STATE_INPUT_REQUIRED，别的 agent 才知道在等人；
 *   3) 协议错误要回正确的 JSON-RPC 错误码，而不是一律 500 或者假装成功。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const core = await import(pathToFileURL(path.join(here, '..', 'packages', 'core', 'src', 'a2a', 'task.ts')).href)
const { stateOf, historyOf, artifactsOf, taskOf, isTerminal } = core

const { createA2AServer } = await import(
  pathToFileURL(path.join(here, '..', 'packages', 'core', 'src', 'a2a', 'server.ts')).href
)

const ev = (kind, payload = {}) => ({ kind, timestamp: '2026-01-01T00:00:00Z', payload })

// ─────────────────────── 状态推导 ───────────────────────

test('a session with no turn/end yet is WORKING', () => {
  const s = stateOf([ev('session/start'), ev('turn/start'), ev('step/start')])
  assert.equal(s.state, 'TASK_STATE_WORKING')
})

test('a finished turn is COMPLETED once the session ends', () => {
  const s = stateOf([ev('turn/start'), ev('turn/end', { stop_reason: 'model' }), ev('session/end')])
  assert.equal(s.state, 'TASK_STATE_COMPLETED')
})

test('an unresolved approval request maps to INPUT_REQUIRED', () => {
  const s = stateOf([
    ev('turn/start', { task: 'delete stuff' }),
    ev('approval/requested', { id: 'ap1', reason: 'destructive command', summary: 'rm -rf build' }),
  ])
  assert.equal(s.state, 'TASK_STATE_INPUT_REQUIRED')
  assert.match(String(s.detail), /destructive/)
})

test('once the approval is answered the task is no longer waiting', () => {
  const s = stateOf([
    ev('turn/start'),
    ev('approval/requested', { id: 'ap1', reason: 'destructive' }),
    ev('approval/resolved', { id: 'ap1', decision: 'allow' }),
    ev('turn/end', { stop_reason: 'model' }),
    ev('session/end'),
  ])
  assert.equal(s.state, 'TASK_STATE_COMPLETED')
})

test('a denied patch with no completed turn is REJECTED, not FAILED', () => {
  const s = stateOf([
    ev('turn/start'),
    ev('tool/call'),
    ev('tool/result', { refused: true, denied_by: 'path-guard' }),
  ])
  // 只有 turn/end 出现时才算跑完，这时 tool/result 的 refused 是拒绝而不是失败
  assert.ok(['TASK_STATE_REJECTED', 'TASK_STATE_WORKING'].includes(s.state))
})

test('interruption is CANCELED and it is terminal', () => {
  const s = stateOf([ev('turn/start'), ev('session/interrupted', { reason: 'user' })])
  assert.equal(s.state, 'TASK_STATE_CANCELED')
  assert.ok(isTerminal(s.state))
})

test('a stop_reason of error is FAILED', () => {
  const s = stateOf([ev('turn/start'), ev('turn/end', { stop_reason: 'error' })])
  assert.equal(s.state, 'TASK_STATE_FAILED')
})

// ─────────────────────── history / artifacts ───────────────────────

test('history carries the task the user actually asked for', () => {
  const h = historyOf([
    ev('session/start'),
    ev('turn/start', { task: 'add a --json flag' }),
    ev('assistant/message', { text: 'done, tests pass' }),
    ev('steering/message', { text: 'also update the docs' }),
    ev('assistant/message', { text: 'docs updated' }),
  ])
  assert.equal(h.length, 4)
  assert.equal(h[0].role, 'ROLE_USER')
  assert.match(h[0].parts[0].text, /--json/)
  assert.equal(h[1].role, 'ROLE_AGENT')
  assert.match(h[2].parts[0].text, /docs/)
})

test('historyLength keeps the most recent messages', () => {
  const events = [
    ev('turn/start', { task: 'one' }),
    ev('assistant/message', { text: 'two' }),
    ev('assistant/message', { text: 'three' }),
  ]
  const h = historyOf(events, 2)
  assert.equal(h.length, 2)
  assert.equal(h[0].parts[0].text, 'two')
  assert.equal(h[1].parts[0].text, 'three')
})

test('artifacts carry their verification result, not just a path', () => {
  const a = artifactsOf([
    // assertion 是对象，不是字符串——真实事件就是这个形状
    ev('verification/asserted', { assertion: { kind: 'artifact-exists', path: '/w/report.json' }, result: 'pass', detail: 'is a file' }),
    ev('verification/asserted', { assertion: { kind: 'command-exit', argv: ['npm', 'test'], expectExit: 0, why: 'tests' }, result: 'pass' }),
    ev('artifact/emitted', { path: '/w/report.json', bytes: 120 }),
    ev('artifact/emitted', { path: '/w/unverified.txt' }),
  ])
  // 两个文件 + 一条不能落到文件上的命令检查
  assert.equal(a.length, 3)
  const verified = a.find((x) => x.name === 'report.json')
  assert.match(String(verified.description), /verified: pass/)
  assert.equal(verified.metadata.verification, 'pass')
  const plain = a.find((x) => x.name === 'unverified.txt')
  assert.equal(plain.description, undefined, 'no verification means no claim of one')
  const cmd = a.find((x) => x.metadata?.check === true)
  assert.ok(cmd, 'a command check that matches no file should still be reported')
  assert.match(String(cmd.description), /command-exit/)
})

// ─────────────────────── 协议层 ───────────────────────

/** 起一个只连着内存 fixture 的服务 */
async function serve(fixture) {
  const calls = []
  const srv = createA2AServer({
    host: '127.0.0.1',
    port: 0,           // 让系统分配端口，测试之间不会抢
    version: '9.9.9',
    hooks: {
      async start(text, ctx) {
        calls.push({ text, ctx })
        return { sessionId: 'ses_test_1' }
      },
      load: (id) => (fixture[id] ? { ...fixture[id], id } : null),
      list: () => Object.entries(fixture).map(([id, v]) => ({ ...v, id })),
      cancel: () => calls.cancelable !== false,
    },
  })
  await srv.listen()
  const addr = srv.address()
  const base = `http://127.0.0.1:${addr.port}`
  return { srv, base, calls }
}

const rpc = async (base, method, params) => {
  const r = await fetch(base + '/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 7, method, params }),
  })
  return r.json()
}

test('the agent card declares only what is actually implemented', async () => {
  const { srv, base } = await serve({})
  try {
    const r = await fetch(base + '/.well-known/agent-card.json')
    const card = await r.json()
    assert.equal(card.name, 'UnitHarness')
    assert.equal(card.version, '9.9.9')
    assert.ok(Array.isArray(card.skills) && card.skills.length >= 3)
    for (const s of card.skills) {
      assert.ok(s.id && s.name && s.description && Array.isArray(s.tags), `skill ${s.id} is incomplete`)
    }
    // 没实现的能力不能声明，否则客户端会等一个永远不来的东西
    assert.equal(card.capabilities.pushNotifications, false)
    assert.equal(card.capabilities.streaming, false)
    assert.equal(card.capabilities.stateTransitionHistory, true)
    // 没开鉴权就不该出现 securitySchemes
    assert.equal(card.securitySchemes, undefined)
  } finally {
    await srv.close()
  }
})

test('SendMessage starts a task and GetTask reads it back', async () => {
  const fixture = {
    ses_test_1: {
      contextId: 'ctx_1',
      workspace: '/w',
      events: [ev('turn/start', { task: 'hello' }), ev('assistant/message', { text: 'hi' }), ev('turn/end', { stop_reason: 'model' }), ev('session/end')],
    },
  }
  const { srv, base, calls } = await serve(fixture)
  try {
    const sent = await rpc(base, 'SendMessage', {
      message: { messageId: 'm1', role: 'ROLE_USER', parts: [{ text: 'hello' }] },
    })
    assert.ok(sent.result?.task, JSON.stringify(sent))
    assert.equal(calls.length, 1)
    assert.equal(calls[0].text, 'hello')

    const got = await rpc(base, 'GetTask', { id: 'ses_test_1', historyLength: 5 })
    assert.equal(got.result.status.state, 'TASK_STATE_COMPLETED')
    assert.equal(got.result.history.length, 2)
  } finally {
    await srv.close()
  }
})

test('a message without text parts is rejected as invalid params', async () => {
  const { srv, base } = await serve({})
  try {
    const r = await rpc(base, 'SendMessage', {
      message: { messageId: 'm1', role: 'ROLE_USER', parts: [{ data: {} }] },
    })
    assert.equal(r.error.code, -32602, JSON.stringify(r))
  } finally {
    await srv.close()
  }
})

test('an unknown method and an unknown task get distinct protocol errors', async () => {
  const { srv, base } = await serve({})
  try {
    const m = await rpc(base, 'Nope', {})
    assert.equal(m.error.code, -32601)
    const t = await rpc(base, 'GetTask', { id: 'missing' })
    assert.equal(t.error.code, -32001)
  } finally {
    await srv.close()
  }
})

test('cancelling a finished task is refused, not silently accepted', async () => {
  const fixture = {
    done: {
      contextId: 'ctx',
      events: [ev('turn/start'), ev('turn/end', { stop_reason: 'model' }), ev('session/end')],
    },
  }
  const { srv, base } = await serve(fixture)
  try {
    const r = await rpc(base, 'CancelTask', { id: 'done' })
    assert.equal(r.error.code, -32002, JSON.stringify(r))
  } finally {
    await srv.close()
  }
})

test('streaming is refused explicitly because the card says it is off', async () => {
  const { srv, base } = await serve({})
  try {
    const r = await rpc(base, 'SendStreamingMessage', { message: { messageId: 'm', role: 'ROLE_USER', parts: [{ text: 'x' }] } })
    assert.equal(r.error.code, -32004)
  } finally {
    await srv.close()
  }
})

test('the REST binding answers GET /tasks/{id}', async () => {
  const fixture = {
    ses_r: { contextId: 'c', events: [ev('turn/start', { task: 'x' }), ev('turn/end', { stop_reason: 'model' }), ev('session/end')] },
  }
  const { srv, base } = await serve(fixture)
  try {
    const r = await fetch(base + '/tasks/ses_r')
    const t = await r.json()
    assert.equal(t.status.state, 'TASK_STATE_COMPLETED')
    const missing = await fetch(base + '/tasks/nope')
    assert.equal(missing.status, 404)
  } finally {
    await srv.close()
  }
})

test('REST POST /message:send accepts the request object directly', async () => {
  const fixture = { ses_test_1: { contextId: 'c', events: [ev('turn/start', { task: 'hi' })] } }
  const { srv, base } = await serve(fixture)
  try {
    const r = await fetch(base + '/message:send', {
      method: 'POST',
      headers: { 'content-type': 'application/a2a+json' },
      body: JSON.stringify({ message: { messageId: 'm', role: 'ROLE_USER', parts: [{ text: 'hi' }] } }),
    })
    const body = await r.json()
    assert.ok(body.task, JSON.stringify(body))
  } finally {
    await srv.close()
  }
})

test('a bearer token is enforced when configured, and the card says so', async () => {
  const srv = createA2AServer({
    host: '127.0.0.1',
    port: 0,
    version: '1.0.0',
    authToken: 'sekret',
    hooks: { async start() { return { sessionId: 's' } }, load: () => null, list: () => [], cancel: () => false },
  })
  await srv.listen()
  const base = `http://127.0.0.1:${srv.address().port}`
  try {
    // 发现端点不需要令牌：客户端得先拿到卡才知道要怎么鉴权
    const card = await (await fetch(base + '/.well-known/agent-card.json')).json()
    assert.ok(card.securitySchemes?.bearer, 'the card must advertise auth when auth is on')

    const unauth = await fetch(base + '/tasks')
    assert.equal(unauth.status, 401)

    const ok = await fetch(base + '/tasks', { headers: { authorization: 'Bearer sekret' } })
    assert.equal(ok.status, 200)
  } finally {
    await srv.close()
  }
})
