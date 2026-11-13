/**
 * 上下文压缩。
 *
 * 关键不是"能摘要"，而是摘要之后历史仍然合法：
 *  1. 不能留下孤立的 tool 消息（有结果没调用）—— Anthropic 会直接 400；
 *  2. 压缩要留痕（session/compacted 事件）；
 *  3. 压缩后模型必须看到摘要，并且继续干活。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'

const CLI = join(process.cwd(), 'dist', 'uh.cjs')

function startMock(seen) {
  let call = 0
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

      // 摘要请求：system 是 SUMMARY_PROMPT
      const isSummary = (parsed.messages ?? [])[0]?.content?.includes?.('compacting the working memory')
      if (isSummary) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          model: 'mock',
          choices: [{ message: { role: 'assistant', content: '## Task\ncount files\n## Done so far\nls ran twice' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 300, completion_tokens: 30, total_tokens: 330 },
        }))
        return
      }

      call++
      const toolTurns = 7
      const isLast = call >= toolTurns
      const payload = isLast
        ? { model: 'mock', choices: [{ message: { role: 'assistant', content: 'done counting' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5000, completion_tokens: 4, total_tokens: 5004 } }
        : {
            model: 'mock',
            choices: [{
              message: {
                role: 'assistant', content: '',
                tool_calls: [{ id: `c${call}`, type: 'function', function: { name: 'run_command', arguments: '{"argv":["echo","x"]}' } }],
              },
              finish_reason: 'tool_calls',
            }],
            // 从第二轮开始把 prompt_tokens 报得很大，触发压缩
            usage: { prompt_tokens: call <= 1 ? 100 : 5000, completion_tokens: 5, total_tokens: 5005 },
          }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    })
  })
  return server
}

function assertToolsPaired(messages) {
  const openCalls = new Set()
  for (const m of messages) {
    if (m.role === 'assistant') {
      openCalls.clear()
      for (const tc of m.tool_calls ?? []) openCalls.add(tc.id)
    } else if (m.role === 'tool') {
      assert.ok(openCalls.has(m.tool_call_id), `orphan tool message ${m.tool_call_id} — would be rejected by Anthropic`)
    }
  }
}

test('compaction summarises early turns and keeps the transcript valid', async () => {
  const seen = []
  const server = startMock(seen)
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const home = mkdtempSync(join(tmpdir(), 'uh-compact-'))
  const env = { ...process.env, UH_HOME: home, UH_BASE_URL: `http://127.0.0.1:${port}/v1`, UH_MODEL: 'mock' }

  try {
    const out = await new Promise((resolve) => {
      const p = spawn(process.execPath, [CLI, 'run', 'count files', '--max-steps', '8', '--max-context', '1000'], { env })
      let s = ''
      p.stdout.on('data', (d) => (s += d))
      p.stderr.on('data', (d) => (s += d))
      p.on('close', () => resolve(s))
    })

    assert.match(out, /compacted/, 'compaction should be reported')
    assert.match(out, /done counting/, 'the run should still finish')

    // 事件留痕
    const sid = basename(sessionDirOf(home))
    const events = readFileSync(join(sessionDirOf(home), 'events.jsonl'), 'utf8')
      .trim().split('\n').map((l) => JSON.parse(l))
    const compactions = events.filter((e) => e.kind === 'session/compacted')
    assert.ok(compactions.length > 0, 'session/compacted must be logged')
    assert.ok(compactions[0].payload.dropped_messages > 0)

    // 压缩后的请求必须带上摘要，且结构合法
    const withSummary = seen.filter((s) => JSON.stringify(s.messages ?? []).includes('Compacted context'))
    assert.ok(withSummary.length > 0, 'later requests must include the summary')
    for (const req of withSummary) assertToolsPaired(req.messages)
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
