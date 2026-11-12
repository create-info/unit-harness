/**
 * apply_patch 的端到端测试（不依赖真实模型）。
 *
 * 两条最关键的语义：
 *  1. 原子性 —— 补丁里任一 hunk 匹配失败，就一个字节都不能写盘；
 *  2. 结构化 —— Add / Update / Delete 走补丁，而不是让模型拼 shell 重定向。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(process.cwd(), 'dist', 'uh.cjs')

/** 一个只回一次 apply_patch、之后回文本的假模型 */
function startMock(seen, patch, { toolName = 'apply_patch' } = {}) {
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
        ? { model: 'mock', choices: [{ message: { role: 'assistant', content: 'patched' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }
        : {
            model: 'mock',
            choices: [{
              message: {
                role: 'assistant', content: '',
                tool_calls: [{ id: 'c1', type: 'function', function: { name: toolName, arguments: JSON.stringify({ patch }) } }],
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

async function run(task, patch, setup) {
  const seen = []
  const server = startMock(seen, patch)
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const home = mkdtempSync(join(tmpdir(), 'uh-patch-'))
  mkdirSync(join(home, 'work'), { recursive: true })
  setup?.(join(home, 'work'))

  const env = { ...process.env, UH_HOME: home, UH_BASE_URL: `http://127.0.0.1:${port}/v1`, UH_MODEL: 'mock' }
  const out = await new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, 'run', task, '--max-steps', '3'], { env })
    let s = ''
    p.stdout.on('data', (d) => (s += d))
    p.stderr.on('data', (d) => (s += d))
    p.on('close', () => resolve(s))
  })
  server.close()
  return { out, work: join(home, 'work'), home }
}

test('apply_patch updates a file and the change is verified', async () => {
  const patch = [
    '*** Begin Patch',
    '*** Update File: app.py',
    '@@ def greet():',
    ' def greet():',
    '-    print("hello")',
    '+    print("world")',
    '*** End Patch',
  ].join('\n')

  const { out, work } = await run('change the greeting', patch, (w) => {
    writeFileSync(join(w, 'app.py'), 'def greet():\n    print("hello")\n')
  })

  assert.match(readFileSync(join(work, 'app.py'), 'utf8'), /print\("world"\)/, 'file must contain the patched line')
  assert.match(out, /deliverables/, 'the patched file should be reported as a deliverable')
})

test('apply_patch is atomic: one bad hunk writes nothing', async () => {
  const patch = [
    '*** Begin Patch',
    '*** Update File: keep.txt',
    '@@',
    '-this line does not exist',
    '+replacement',
    '*** Add File: new.txt',
    '+should never be created',
    '*** End Patch',
  ].join('\n')

  const { out, work, home } = await run('break things', patch, (w) => {
    writeFileSync(join(w, 'keep.txt'), 'original content\n')
  })

  assert.equal(readFileSync(join(work, 'keep.txt'), 'utf8'), 'original content\n', 'failed hunk must leave the file untouched')
  assert.equal(existsSync(join(work, 'new.txt')), false, 'later hunk must not be applied either')
  // 失败必须留痕：事件里要有 tool/result{status:error}
  const sid = readdirSync(join(home, 'sessions'))[0]
  const events = readFileSync(join(home, 'sessions', sid, 'events.jsonl'), 'utf8')
    .trim().split('\n').map((l) => JSON.parse(l))
  const failed = events.filter((e) => e.kind === 'tool/result' && e.payload.status === 'error')
  assert.ok(failed.length > 0, 'a failed patch must be recorded as an error event')
  assert.match(JSON.stringify(failed[0].payload), /E_PATCH_NOMATCH/, 'the reason must be recorded')
  void out
})
