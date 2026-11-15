/**
 * Plan 模式：能查，不能改。
 *
 * 主流产品都有一档"先说方案别动手"——Cursor 的 Ask/Plan、Claude Code 的
 * Plan mode。它和审批档不是一回事：审批档问的是"要不要问你"，这一档问的是
 * "允不允许做"。所以它不能靠"问一遍"来满足（模型会把拒绝读成"再试一次"），
 * 必须当场拒，并且给出能读懂的理由。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(process.cwd(), 'dist', 'uh.cjs')

/** 假模型：先写一个文件，再跑一条会写盘的命令，然后收尾 */
function startMock() {
  let n = 0
  const server = http.createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'mock' }] }))
      return
    }
    let b = ''
    req.on('data', (c) => (b += c))
    req.on('end', () => {
      const body = JSON.parse(b || '{}')
      const hasTools = Array.isArray(body.tools) && body.tools.length > 0
      n++
      const payload = !hasTools || n > 2
        ? { model: 'mock', choices: [{ message: { role: 'assistant', content: 'planned' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } }
        : n === 1
          ? { model: 'mock', choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'apply_patch', arguments: JSON.stringify({ patch: '*** Begin Patch\\n*** Add File: planned.txt\\n+x\\n*** End Patch\\n' }) } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } }
          : { model: 'mock', choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'c2', type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ argv: ['sh', '-c', 'echo hi > made.txt'] }) } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    })
  })
  return server
}

function sessionDirOf(home) {
  let dir = join(home, 'sessions')
  for (let i = 0; i < 5; i++) {
    let subs = []
    try { subs = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) } catch { return dir }
    if (!subs.length) return dir
    const next = join(dir, subs[0])
    if (existsSync(join(next, 'meta.json'))) return next
    dir = next
  }
  return dir
}

test('plan mode refuses writes and mutating commands, and writes nothing', async () => {
  const server = startMock()
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const home = mkdtempSync(join(tmpdir(), 'uh-plan-'))
  try {
    const code = await new Promise((resolve) => {
      const p = spawn(process.execPath, [CLI, 'run', 'plan it', '--plan', '--base-url', `http://127.0.0.1:${port}/v1`, '--model', 'mock'], {
        env: { ...process.env, UH_HOME: home },
      })
      let out = ''
      p.stdout.on('data', (d) => (out += d))
      p.on('close', (c) => { globalThis.__out = out; resolve(c) })
    })
    assert.equal(code, 0)

    // 一个字节都没落盘
    assert.ok(!existsSync(join(home, 'work', 'planned.txt')), 'plan mode must not write files')
    assert.ok(!existsSync(join(home, 'work', 'made.txt')), 'plan mode must not run mutating commands')

    const events = readFileSync(join(sessionDirOf(home), 'events.jsonl'), 'utf8')
      .trim().split('\n').map((l) => JSON.parse(l))
    const refused = events.filter((e) => e.kind === 'tool/result' && e.payload.refused)
    assert.ok(refused.length >= 1, 'the refusal has to be visible in the log')

    // 拒绝的理由要让模型读得懂，否则它会换个写法再来一次
    const text = events
      .filter((e) => e.kind === 'tool/output' || e.kind === 'error')
      .map((e) => JSON.stringify(e.payload))
      .join(' ')
    assert.match(text, /E_READ_ONLY|plan mode/i, 'refusals must explain themselves: ' + text.slice(0, 300))
  } finally {
    server.close()
    rmSync(home, { recursive: true, force: true })
  }
})
