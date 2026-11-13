/**
 * Agent 循环的回归测试：用一个假的 OpenAI 兼容服务驱动，
 * 断言事件序列完整（turn → step → llm → tool → step → turn）。
 *
 * 不需要真实模型、不需要 API key；CI 三个平台都跑。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function startMock(seen, command) {
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : {}
      seen.push(parsed)
      const hadTool = (parsed.messages ?? []).some((m) => m.role === 'tool')
      const payload = hadTool
        ? {
            model: 'mock',
            choices: [{ message: { role: 'assistant', content: 'finished' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
          }
        : {
            model: 'mock',
            choices: [{
              message: {
                role: 'assistant',
                content: '',
                tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ argv: command }) } }],
              },
              finish_reason: 'tool_calls',
            }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    })
  })
  return server
}

function runCli(args, env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [join(process.cwd(), 'dist', 'uh.cjs'), ...args], {
      env: { ...process.env, ...env },
    })
    let out = ''
    let err = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (err += d))
    p.on('close', (code) => resolve({ code, out, err }))
  })
}

test('agent loop emits the full turn/step/tool event chain', async () => {
  const seen = []
  const server = startMock(seen, ['echo', 'hello-from-mock'])
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const home = mkdtempSync(join(tmpdir(), 'uh-test-'))

  try {
    const res = await runCli(
      ['run', 'say hello', '--base-url', `http://127.0.0.1:${port}/v1`, '--model', 'mock', '--max-steps', '3'],
      { UH_HOME: home },
    )

    assert.match(res.out, /turn start/, 'turn start should be printed')
    assert.match(res.out, /tool call\(s\)/, 'tool call should be reported')
    assert.match(res.out, /turn end/, 'turn end should be printed')
    assert.match(res.out, /finished/, 'final assistant text should be shown')

    // 事件日志
    const raw = readFileSync(join(sessionDirOf(home), 'events.jsonl'), 'utf8')
    const kinds = raw.trim().split('\n').map((l) => JSON.parse(l).kind)

    for (const k of ['session/start', 'turn/start', 'step/start', 'llm/request', 'llm/response',
                     'tool/call', 'tool/result', 'step/end', 'turn/end', 'session/end']) {
      assert.ok(kinds.includes(k), `missing ${k} in ${kinds.join(',')}`)
    }

    // 第二次请求必须带 tool 消息，否则模型看不到工具结果
    const last = seen[seen.length - 1]
    assert.ok(last.messages.some((m) => m.role === 'tool'), 'tool result must be fed back')
  } finally {
    server.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('files created during a run are recorded and asserted', { skip: process.platform === 'win32' }, async () => {
  const seen = []
  const server = startMock(seen, ['sh', '-c', 'printf "#!/bin/sh\\necho deploying\\n" > deploy.sh'])
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const home = mkdtempSync(join(tmpdir(), 'uh-test-'))

  try {
    const res = await runCli(
      ['run', 'write a deploy script', '--base-url', `http://127.0.0.1:${port}/v1`, '--model', 'mock', '--max-steps', '3'],
      { UH_HOME: home },
    )

    assert.match(res.out, /deliverables/, 'deliverables section should be printed')
    assert.match(res.out, /deploy\.sh/, 'the created file should be listed')
    assert.match(res.out, /4\/4/, 'exists + nonempty + sha256 + sh -n should all pass')

    const kinds = readFileSync(join(sessionDirOf(home), 'events.jsonl'), 'utf8')
      .trim().split('\n').map((l) => JSON.parse(l).kind)

    assert.ok(kinds.includes('artifact/emitted'), 'artifact/emitted must be logged')
    assert.ok(kinds.includes('verification/asserted'), 'verification/asserted must be logged')
  } finally {
    server.close()
    rmSync(home, { recursive: true, force: true })
  }
})

/** 会话按 YYYY/MM/DD 分层了：走到第一个带 meta.json 的目录 */
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
