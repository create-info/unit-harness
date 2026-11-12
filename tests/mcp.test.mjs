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
