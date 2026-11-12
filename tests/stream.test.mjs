/**
 * 流式（SSE）解析。
 *
 * 流式最容易错的地方不是"能不能收到字"，而是 **tool_calls 是分片到达的**：
 * id/name 一次给全，arguments 一片片拼。漏一片就是非法 JSON，
 * 而且错误会推迟到工具执行时才炸，看起来像模型犯了错。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(process.cwd(), 'dist', 'uh.cjs')

function sse(res, frames) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  for (const f of frames) res.write(`data: ${JSON.stringify(f)}\n\n`)
  res.write('data: [DONE]\n\n')
  res.end()
}

test('streaming: split tool_call arguments are reassembled', async () => {
  const seen = []
  let round = 0

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

      if (round++ === 0) {
        // 第一次：正文分片 + 工具调用参数分片 + 末尾才给 usage
        sse(res, [
          { model: 'mock', choices: [{ delta: { content: 'I will ' } }] },
          { model: 'mock', choices: [{ delta: { content: 'run ls.' } }] },
          { model: 'mock', choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'run_command', arguments: '{"argv":' } }] } }] },
          { model: 'mock', choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '["ls","-a"]}' } }] } }] },
          { model: 'mock', choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
          { model: 'mock', choices: [], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } },
        ])
      } else {
        sse(res, [
          { model: 'mock', choices: [{ delta: { content: 'done' } }] },
          { model: 'mock', choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 2, total_tokens: 22 } },
        ])
      }
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const home = mkdtempSync(join(tmpdir(), 'uh-stream-'))

  try {
    const out = await new Promise((resolve) => {
      const p = spawn(process.execPath, [CLI, 'run', 'list files', '--max-steps', '3'], {
        env: { ...process.env, UH_HOME: home, UH_BASE_URL: `http://127.0.0.1:${port}/v1`, UH_MODEL: 'mock' },
      })
      let s = ''
      p.stdout.on('data', (d) => (s += d))
      p.stderr.on('data', (d) => (s += d))
      p.on('close', () => resolve(s))
    })

    // 1) 请求确实是流式的
    assert.equal(seen[0].stream, true, 'the client must ask for a stream')

    // 2) 分片的 arguments 拼回合法 JSON，并且工具真的执行了
    assert.match(out, /exit=0/, `the tool should have run; output was:\n${out}`)

    // 3) 末尾 chunk 里的 usage 被记录下来
    const sid = readdirSync(join(home, 'sessions'))[0]
    const events = readFileSync(join(home, 'sessions', sid, 'events.jsonl'), 'utf8')
      .trim().split('\n').map((l) => JSON.parse(l))
    const resp = events.find((e) => e.kind === 'llm/response')
    assert.ok(resp)
    assert.equal(resp.payload.usage.total_tokens, 18, 'usage from the final chunk must be recorded')
    assert.equal(resp.payload.tool_calls, 1)
  } finally {
    server.close()
    rmSync(home, { recursive: true, force: true })
  }
})
