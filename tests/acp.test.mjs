/**
 * ACP 服务端测试。不起真编辑器、不连真模型：直接喂 JSON-RPC 行，抓 stdout。
 *
 * 钉住三件容易错的事：
 *   1) stdout 每一行都必须是合法 JSON-RPC —— 混进一个 console.log 客户端就断了；
 *   2) 取消必须回 stopReason: 'cancelled'，不能是错误（界面上会显示成报错）；
 *   3) prompt 期间的文本/工具/计划都要以 session/update 推出去，最后才回 stopReason。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { PassThrough } from 'node:stream'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const { createAcpServer } = await import(
  pathToFileURL(path.join(here, '..', 'packages', 'core', 'src', 'acp', 'server.ts')).href
)

/** 一个假 harness：跑 runTask 时按脚本吐文本，然后返回 */
function fakeHarness(script = {}) {
  const calls = []
  let aborted = false
  const h = {
    sessionId: 'sess_test',
    emitted: [],
    async start() { return [] },
    async runTask(o) {
      calls.push(o)
      if (script.behavior === 'hang') {
        // 模拟一个不自己结束的任务，等 abort
        await new Promise((resolve) => setTimeout(resolve, 5000))
        return { text: '', stoppedBy: 'interrupted' }
      }
      if (script.behavior === 'throw-abort') throw new Error('operation aborted')
      if (script.behavior === 'throw-real') throw new Error('model exploded')
      return { text: 'ok', stoppedBy: script.stoppedBy ?? undefined }
    },
    abort() { aborted = true },
    dispose() { },
    get aborted() { return aborted },
    get calls() { return calls },
  }
  return h
}

/** 搭一个 server，把 stdout 收到数组里 */
function makeRig(opts = {}) {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const lines = []
  stdout.on('data', (c) => {
    for (const l of c.toString().split('\n')) if (l.trim()) lines.push(l)
  })

  let lastHarness = null
  const hooks = {
    version: '9.9.9',
    create({ cwd }) {
      lastHarness = fakeHarness(opts.script ?? {})
      lastHarness.cwd = cwd
      return lastHarness
    },
    wire(h, emit) {
      h._emit = emit
      // 让假 harness 在 runTask 里能真的推流
      const orig = h.runTask.bind(h)
      h.runTask = async (o) => {
        emit.text('hel')
        emit.text('lo')
        emit.event('tool/call', { id: 'c1', tool: 'run_command', argv: ['ls'] })
        emit.event('tool/result', { id: 'c1', status: 'ok', exit_code: 0 })
        emit.event('plan/updated', { items: [{ step: 'do it', status: 'in_progress' }] })
        return orig(o)
      }
    },
  }

  const server = createAcpServer(hooks, { stdin, stdout })
  return { server, stdin, lines, get harness() { return lastHarness } }
}

const parse = (lines) => lines.map((l) => JSON.parse(l))

const send = async (rig, obj) => {
  const before = rig.lines.length
  await rig.server.feed(JSON.stringify(obj))
  // feed 是异步的（内部 await handle），给它一个 tick 把响应写出去
  await new Promise((r) => setTimeout(r, 30))
  return parse(rig.lines.slice(before))
}

const init = async (rig) => {
  const r = await send(rig, { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: 1 } })
  return r.find((m) => m.id === 0)
}

// ─────────────────────── 协议层 ───────────────────────

test('initialize negotiates version 1 and declares honest capabilities', async () => {
  const rig = makeRig()
  const res = await init(rig)
  assert.ok(res.result, JSON.stringify(res))
  assert.equal(res.result.protocolVersion, 1)
  assert.equal(res.result.agentInfo.name, 'unit-harness')
  assert.equal(res.result.agentInfo.version, '9.9.9')
  // 没实现 loadSession 就不能声明，客户端会试着调
  assert.equal(res.result.agentCapabilities.loadSession, false)
  assert.deepEqual(res.result.authMethods, [])
})

test('every line written to stdout is valid JSON-RPC', async () => {
  const rig = makeRig()
  await init(rig)
  await send(rig, { jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: '/tmp' } })
  for (const line of rig.lines) {
    const m = JSON.parse(line)   // 抛错就说明混进了非协议内容
    assert.equal(m.jsonrpc, '2.0')
  }
})

test('session/new returns a session id and does not require it to be a uuid', async () => {
  const rig = makeRig()
  await init(rig)
  const r = await send(rig, { jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: '/tmp/work' } })
  const res = r.find((m) => m.id === 1)
  assert.ok(res.result?.sessionId, JSON.stringify(res))
  assert.equal(rig.harness.cwd, '/tmp/work')
})

test('session/load is refused because the agent never advertised it', async () => {
  const rig = makeRig()
  await init(rig)
  const r = await send(rig, { jsonrpc: '2.0', id: 2, method: 'session/load', params: { sessionId: 'x', cwd: '/tmp' } })
  const res = r.find((m) => m.id === 2)
  assert.equal(res.error.code, -32601)
})

// ─────────────────────── prompt 回合 ───────────────────────

test('a prompt streams text, tool calls and the plan, then returns stopReason', async () => {
  const rig = makeRig()
  await init(rig)
  const created = await send(rig, { jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: '/tmp' } })
  const sid = created.find((m) => m.id === 1).result.sessionId

  const msgs = await send(rig, {
    jsonrpc: '2.0', id: 2, method: 'session/prompt',
    params: { sessionId: sid, prompt: [{ type: 'text', text: 'hello' }] },
  })

  const updates = msgs.filter((m) => m.method === 'session/update').map((m) => m.params.update)
  const kinds = updates.map((u) => u.sessionUpdate)

  assert.ok(kinds.includes('agent_message_chunk'), kinds.join(','))
  assert.ok(kinds.includes('tool_call'))
  assert.ok(kinds.includes('tool_call_update'))
  assert.ok(kinds.includes('plan'), 'the plan must reach the client, not just the log')

  const text = updates.filter((u) => u.sessionUpdate === 'agent_message_chunk')
    .map((u) => u.content.text).join('')
  assert.equal(text, 'hello')

  const done = msgs.find((m) => m.id === 2)
  assert.equal(done.result.stopReason, 'end_turn')
  assert.equal(rig.harness.calls[0].task, 'hello')
})

test('an interrupted run reports cancelled, not an error', async () => {
  const rig = makeRig({ script: { stoppedBy: 'interrupted' } })
  await init(rig)
  const created = await send(rig, { jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: '/tmp' } })
  const sid = created.find((m) => m.id === 1).result.sessionId

  const msgs = await send(rig, {
    jsonrpc: '2.0', id: 2, method: 'session/prompt',
    params: { sessionId: sid, prompt: [{ type: 'text', text: 'go' }] },
  })
  const done = msgs.find((m) => m.id === 2)
  assert.equal(done.result.stopReason, 'cancelled')
})

test('an abort exception thrown by the run is also cancelled, not reported as a failure', async () => {
  const rig = makeRig({ script: { behavior: 'throw-abort' } })
  await init(rig)
  const created = await send(rig, { jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: '/tmp' } })
  const sid = created.find((m) => m.id === 1).result.sessionId

  const msgs = await send(rig, {
    jsonrpc: '2.0', id: 2, method: 'session/prompt',
    params: { sessionId: sid, prompt: [{ type: 'text', text: 'go' }] },
  })
  const done = msgs.find((m) => m.id === 2)
  assert.equal(done.result?.stopReason, 'cancelled', JSON.stringify(done))
})

test('a real failure still surfaces as an error', async () => {
  const rig = makeRig({ script: { behavior: 'throw-real' } })
  await init(rig)
  const created = await send(rig, { jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: '/tmp' } })
  const sid = created.find((m) => m.id === 1).result.sessionId

  const msgs = await send(rig, {
    jsonrpc: '2.0', id: 2, method: 'session/prompt',
    params: { sessionId: sid, prompt: [{ type: 'text', text: 'go' }] },
  })
  const done = msgs.find((m) => m.id === 2)
  assert.equal(done.error.code, -32603, JSON.stringify(done))
})

test('an unknown session is rejected instead of silently starting a new one', async () => {
  const rig = makeRig()
  await init(rig)
  const msgs = await send(rig, {
    jsonrpc: '2.0', id: 3, method: 'session/prompt',
    params: { sessionId: 'nope', prompt: [{ type: 'text', text: 'hi' }] },
  })
  assert.equal(msgs.find((m) => m.id === 3).error.code, -32001)
})

test('a prompt with no text is invalid params', async () => {
  const rig = makeRig()
  await init(rig)
  const created = await send(rig, { jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: '/tmp' } })
  const sid = created.find((m) => m.id === 1).result.sessionId
  const msgs = await send(rig, {
    jsonrpc: '2.0', id: 4, method: 'session/prompt',
    params: { sessionId: sid, prompt: [] },
  })
  assert.equal(msgs.find((m) => m.id === 4).error.code, -32602)
})

test('an embedded resource is inlined into the task text', async () => {
  const rig = makeRig()
  await init(rig)
  const created = await send(rig, { jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: '/tmp' } })
  const sid = created.find((m) => m.id === 1).result.sessionId

  await send(rig, {
    jsonrpc: '2.0', id: 2, method: 'session/prompt',
    params: {
      sessionId: sid,
      prompt: [
        { type: 'text', text: 'explain this' },
        { type: 'resource', resource: { uri: 'file:///tmp/a.py', text: 'print(1)' } },
      ],
    },
  })
  const task = rig.harness.calls[0].task
  assert.match(task, /explain this/)
  assert.match(task, /print\(1\)/, 'the file content must reach the model, not just its uri')
})

test('malformed JSON gets a parse error and does not kill the connection', async () => {
  const rig = makeRig()
  const before = rig.lines.length
  await rig.server.feed('{not json')
  await new Promise((r) => setTimeout(r, 20))
  const msgs = parse(rig.lines.slice(before))
  assert.equal(msgs[0].error.code, -32700)

  // 连接还活着：接着发一个合法请求应该有回应
  const res = await init(rig)
  assert.ok(res.result)
})

test('session/cancel calls abort on the running harness', async () => {
  const rig = makeRig({ script: { behavior: 'hang' } })
  await init(rig)
  const created = await send(rig, { jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: '/tmp' } })
  const sid = created.find((m) => m.id === 1).result.sessionId

  // 不 await：prompt 会挂着
  void rig.server.feed(JSON.stringify({
    jsonrpc: '2.0', id: 2, method: 'session/prompt',
    params: { sessionId: sid, prompt: [{ type: 'text', text: 'long' }] },
  }))
  await new Promise((r) => setTimeout(r, 50))

  await rig.server.feed(JSON.stringify({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: sid } }))
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(rig.harness.aborted, true, 'cancel must reach the harness')
})
