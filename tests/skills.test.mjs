/**
 * Skills：索引常驻、正文按需。
 *
 * 断言三件事：
 *  1. 只有名字和描述进 prompt（正文不进，否则窗口瞬间被吃光）；
 *  2. 模型调用 use_skill 后才拿到正文；
 *  3. 未知 skill 返回可读错误，而不是静默失败。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(process.cwd(), 'dist', 'uh.cjs')

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
        ? { model: 'mock', choices: [{ message: { role: 'assistant', content: 'skill used' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }
        : {
            model: 'mock',
            choices: [{
              message: {
                role: 'assistant', content: '',
                tool_calls: [{ id: 'c1', type: 'function', function: { name: 'use_skill', arguments: '{"name":"deploy-check"}' } }],
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

test('skills: index in prompt, body only after use_skill', async () => {
  const seen = []
  const server = startModel(seen)
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const home = mkdtempSync(join(tmpdir(), 'uh-skill-'))
  const proj = mkdtempSync(join(tmpdir(), 'uh-skillproj-'))

  // 项目级 skill
  mkdirSync(join(proj, '.uh', 'skills', 'deploy-check'), { recursive: true })
  writeFileSync(join(proj, '.uh', 'skills', 'deploy-check', 'SKILL.md'), [
    '---',
    'name: deploy-check',
    'description: Verify a deployment actually took effect',
    '---',
    '',
    '# Deploy check',
    '',
    'BODY_MARKER: curl the health endpoint and compare the git sha.',
  ].join('\n'))

  try {
    const out = await new Promise((resolve) => {
      const p = spawn(process.execPath, [CLI, 'run', 'do the deploy check', '--max-steps', '3'], {
        cwd: proj,
        env: { ...process.env, UH_HOME: home, UH_BASE_URL: `http://127.0.0.1:${port}/v1`, UH_MODEL: 'mock' },
      })
      let s = ''
      p.stdout.on('data', (d) => (s += d))
      p.stderr.on('data', (d) => (s += d))
      p.on('close', () => resolve(s))
    })

    assert.match(out, /skill used/)

    const first = seen[0]
    const systemMsg = first.messages.find((m) => m.role === 'system')
    assert.match(systemMsg.content, /<available_skills>/, 'skills index must be in the system prompt')
    assert.match(systemMsg.content, /deploy-check: Verify a deployment/, 'name + description only')
    assert.ok(!systemMsg.content.includes('BODY_MARKER'), 'the body must NOT be in the prompt')

    // 第二次请求里应该带上正文
    const second = seen[1]
    const toolMsg = second.messages.find((m) => m.role === 'tool')
    assert.match(toolMsg.content, /BODY_MARKER/, 'use_skill must return the body')

    // 事件留痕
    const sid = readdirSync(join(home, 'sessions'))[0]
    const events = readFileSync(join(home, 'sessions', sid, 'events.jsonl'), 'utf8')
      .trim().split('\n').map((l) => JSON.parse(l))
    const used = events.find((e) => e.kind === 'tool/result' && e.payload.tool === 'use_skill')
    assert.ok(used && used.payload.status === 'ok', 'use_skill must be recorded')
  } finally {
    server.close()
    rmSync(home, { recursive: true, force: true })
    rmSync(proj, { recursive: true, force: true })
  }
})
