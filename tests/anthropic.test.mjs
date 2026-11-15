/**
 * Anthropic 协议适配的回归测试。
 *
 * 重点验证三家差异都被吸收：
 *  1. system 走顶层参数，不在 messages 里；
 *  2. tools 用 input_schema（不是 parameters）；
 *  3. tool_use / tool_result 的 block 结构，且 tool 结果回到 user 消息。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'

const CLI = join(process.cwd(), 'dist', 'uh.cjs')

function startAnthropic(seen) {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'claude-mock', display_name: 'Claude Mock' }] }))
      return
    }
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : {}
      seen.push({ url: req.url, headers: req.headers, body: parsed })

      const hadToolResult = JSON.stringify(parsed.messages ?? []).includes('tool_result')
      const payload = hadToolResult
        ? { model: 'claude-mock', content: [{ type: 'text', text: 'all done' }], stop_reason: 'end_turn', usage: { input_tokens: 20, output_tokens: 5 } }
        : {
            model: 'claude-mock',
            content: [{ type: 'tool_use', id: 'toolu_1', name: 'run_command', input: { argv: ['echo', 'from-anthropic'] } }],
            stop_reason: 'tool_use',
            usage: { input_tokens: 30, output_tokens: 12 },
          }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    })
  })
  return server
}

test('anthropic protocol: system, input_schema, tool_use round-trip', async () => {
  const seen = []
  const server = startAnthropic(seen)
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const home = mkdtempSync(join(tmpdir(), 'uh-anth-'))
  const env = { ...process.env, UH_HOME: home, ANTHROPIC_API_KEY: 'sk-ant-mock-0001' }

  try {
    execFileSync(process.execPath, [CLI, 'config', 'set', 'anthropic.baseUrl', `http://127.0.0.1:${port}`], { env })

    const out = await new Promise((resolve) => {
      const p = spawn(process.execPath, [CLI, 'run', 'do the thing', '--provider', 'anthropic', '--max-steps', '3'], { env })
      let s = ''
      p.stdout.on('data', (d) => (s += d))
      p.stderr.on('data', (d) => (s += d))
      p.on('close', () => resolve(s))
    })

    assert.match(out, /all done/, 'final assistant text should be surfaced')

    const call = seen.find((s) => s.url === '/v1/messages')
    assert.ok(call, 'must POST to /v1/messages')
    assert.equal(call.headers['x-api-key'], 'sk-ant-mock-0001', 'anthropic uses x-api-key, not bearer')
    assert.ok(call.headers['anthropic-version'], 'anthropic-version header required')
    assert.equal(typeof call.body.system, 'string', 'system must be a top-level param')
    assert.ok(!call.body.messages.some((m) => m.role === 'system'), 'no system role inside messages')
    assert.ok(call.body.tools[0].input_schema, 'tools use input_schema')
    assert.equal(call.body.tools[0].parameters, undefined, 'no openai-style parameters')
    assert.ok(call.body.max_tokens > 0, 'max_tokens is required by anthropic')

    // 第二次请求里 tool_result 必须包在 user 消息里
    const second = seen.filter((s) => s.url === '/v1/messages')[1]
    const blocks = second.body.messages.at(-1).content
    assert.equal(second.body.messages.at(-1).role, 'user')
    assert.ok(Array.isArray(blocks) && blocks.some((b) => b.type === 'tool_result'), 'tool_result goes in a user message')

    // 事件里不得出现明文 key
    const sid = basename(sessionDirOf(home))
    const log = readFileSync(join(sessionDirOf(home), 'events.jsonl'), 'utf8')
    assert.ok(!log.includes('sk-ant-mock-0001'), 'API key must never reach the event log')
  } finally {
    server.close()
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
