/**
 * MCP 桥接。
 *
 * 要证明的三件事：
 *  1. stdio 协议能连通（initialize → tools/list → tools/call）；
 *  2. 工具名带命名空间，模型不会和内置工具混淆；
 *  3. **MCP 调用不在沙箱里** —— 事件必须记 isolation:'none'，
 *     不能继承 landlock/seatbelt，否则用户会以为外部进程也被隔离了。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(process.cwd(), 'dist', 'uh.cjs')
const MOCK = join(process.cwd(), 'tests', 'fixtures', 'mock-mcp-server.mjs')

function startModel(seen) {
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
      seen.push(parsed)
      const hadTool = (parsed.messages ?? []).some((m) => m.role === 'tool')
      const payload = hadTool
        ? { model: 'mock', choices: [{ message: { role: 'assistant', content: 'mcp said hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }
        : {
            model: 'mock',
            choices: [{
              message: {
                role: 'assistant', content: '',
                tool_calls: [{ id: 'c1', type: 'function', function: { name: 'mcp__mock__echo', arguments: '{"text":"hello"}' } }],
              },
              finish_reason: 'tool_calls',
            }],
            usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
          }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    })
  })
  return server
}

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'uh-mcp-'))
  writeFileSync(join(home, 'mcp.json'), JSON.stringify({
    mcpServers: { mock: { command: process.execPath, args: [MOCK] } },
  }))
  return home
}

test('uh mcp list shows namespaced tools from a stdio server', async () => {
  const home = setup()
  try {
    const out = execFileSync(process.execPath, [CLI, 'mcp', 'list'], {
      env: { ...process.env, UH_HOME: home }, encoding: 'utf8',
    })
    assert.match(out, /mock/)
    assert.match(out, /mcp__mock__echo/)
    assert.match(out, /mcp__mock__add/)
    assert.match(out, /outside the local sandbox/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('an MCP tool call is logged with isolation:none', async () => {
  const seen = []
  const server = startModel(seen)
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const home = setup()

  try {
    const out = await new Promise((resolve) => {
      const p = spawn(process.execPath, [CLI, 'run', 'use the mcp tool', '--max-steps', '3'], {
        env: {
          ...process.env, UH_HOME: home,
          UH_BASE_URL: `http://127.0.0.1:${port}/v1`, UH_MODEL: 'mock',
        },
      })
      let s = ''
      p.stdout.on('data', (d) => (s += d))
      p.stderr.on('data', (d) => (s += d))
      p.on('close', () => resolve(s))
    })

    assert.match(out, /mcp said hi/, 'the model should see the MCP result')

    // 工具确实被调用过
    const toolMsg = seen.at(-1).messages.find((m) => m.role === 'tool')
    assert.match(toolMsg.content, /echo: hello/, 'the MCP server response must be fed back')

    const sid = readdirSync(join(home, 'sessions'))[0]
    const events = readFileSync(join(home, 'sessions', sid, 'events.jsonl'), 'utf8')
      .trim().split('\n').map((l) => JSON.parse(l))

    const call = events.find((e) => e.kind === 'tool/call' && e.payload.tool === 'mcp__mock__echo')
    assert.ok(call, 'the MCP call must be recorded')
    assert.equal(call.payload.external, true)

    const result = events.find((e) => e.kind === 'tool/result' && e.payload.tool === 'mcp__mock__echo')
    assert.ok(result)
    assert.equal(result.payload.isolation, 'none', 'MCP calls are NOT sandboxed and must say so')
  } finally {
    server.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('http MCP: streamable transport carries the configured headers', async () => {
  // 之前只测了 stdio。HTTP 传输要证明两件事：
  //  1. 响应里 JSON 与 SSE 两种形态都能解；
  //  2. 配置里的 Authorization 真的发出去了（token 不生效是静默的）
  const seen = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const msg = JSON.parse(body || '{}')
      seen.push({ method: msg.method, auth: req.headers.authorization })
      const send = (payload, sse) => {
        if (sse) {
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          res.end(`event: message\ndata: ${JSON.stringify(payload)}\n\n`)
        } else {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify(payload))
        }
      }
      if (msg.method === 'initialize') {
        send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'mock-http', version: '1' } } }, false)
      } else if (msg.method === 'tools/list') {
        // 用 SSE 响应，覆盖另一种形态
        send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'ping', description: 'say pong', inputSchema: { type: 'object', properties: {} } }] } }, true)
      } else if (msg.method === 'tools/call') {
        send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'pong' }] } }, false)
      } else {
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'unknown' } }, false)
      }
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port

  const home = mkdtempSync(join(tmpdir(), 'uh-mcp-http-'))
  writeFileSync(join(home, 'mcp.json'), JSON.stringify({
    mcpServers: { remote: { url: `http://127.0.0.1:${port}/mcp`, headers: { authorization: 'Bearer test-token' } } },
  }))

  try {
    // 必须用 spawn（异步）：execFileSync 会阻塞本进程的事件循环，
    // 而 mock server 就跑在本进程里 —— 同步等待 = 自己把自己锁死到超时。
    const out = await new Promise((resolve) => {
      const p = spawn(process.execPath, [CLI, 'mcp', 'test', 'remote'], {
        env: { ...process.env, UH_HOME: home },
      })
      let acc = ''
      p.stdout.on('data', (d) => (acc += d))
      p.stderr.on('data', (d) => (acc += d))
      p.on('close', () => resolve(acc))
    })
    assert.match(out, /✓ remote/)
    assert.match(out, /mcp__remote__ping/)

    // token 必须真的发出去
    const inits = seen.filter((x) => x.method === 'initialize')
    assert.ok(inits.length > 0, 'initialize must be sent')
    assert.equal(inits[0].auth, 'Bearer test-token', 'the configured Authorization header must reach the server')
  } finally {
    server.close()
    rmSync(home, { recursive: true, force: true })
  }
})
