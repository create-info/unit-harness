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
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'

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
    const sid = basename(sessionDirOf(home))
    const events = readFileSync(join(sessionDirOf(home), 'events.jsonl'), 'utf8')
      .trim().split('\n').map((l) => JSON.parse(l))
    const used = events.find((e) => e.kind === 'tool/result' && e.payload.tool === 'use_skill')
    assert.ok(used && used.payload.status === 'ok', 'use_skill must be recorded')
  } finally {
    server.close()
    rmSync(home, { recursive: true, force: true })
    rmSync(proj, { recursive: true, force: true })
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

test('a skill can declare allowed-tools and ship scripts that actually run', async () => {
  // 两轮：先 use_skill，再 run_skill_script
  const seen = []
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
      const done = (parsed.messages ?? []).filter((m) => m.role === 'tool').length
      const calls = [
        { id: 'c1', type: 'function', function: { name: 'use_skill', arguments: '{"name":"deploy-check"}' } },
        { id: 'c2', type: 'function', function: { name: 'run_skill_script', arguments: '{"skill":"deploy-check","script":"scripts/check.sh","args":["prod"]}' } },
      ]
      const payload = done >= calls.length
        ? { model: 'mock', choices: [{ message: { role: 'assistant', content: 'all good' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }
        : { model: 'mock', choices: [{ message: { role: 'assistant', content: '', tool_calls: [calls[done]] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port

  const home = mkdtempSync(join(tmpdir(), 'uh-skill2-'))
  const proj = mkdtempSync(join(tmpdir(), 'uh-proj2-'))
  const skillDir = join(proj, '.uh', 'skills', 'deploy-check')
  mkdirSync(join(skillDir, 'scripts'), { recursive: true })
  writeFileSync(join(skillDir, 'SKILL.md'), [
    '---',
    'name: deploy-check',
    'description: Verify a deployment actually took effect',
    'allowed-tools: run_command, read_file',
    '---',
    '',
    '# Deploy check',
    '',
    'BODY_MARKER',
  ].join('\n'))
  const script = join(skillDir, 'scripts', 'check.sh')
  writeFileSync(script, '#!/bin/sh\necho "checked $1 from the skill script"\n')
  execFileSync('chmod', ['+x', script])

  try {
    const out = await new Promise((resolve) => {
      const p = spawn(process.execPath, [CLI, 'run', 'run the deploy check script', '--max-steps', '4'], {
        cwd: proj,
        env: { ...process.env, UH_HOME: home, UH_BASE_URL: `http://127.0.0.1:${port}/v1`, UH_MODEL: 'mock' },
      })
      let acc = ''
      p.stdout.on('data', (d) => (acc += d))
      p.stderr.on('data', (d) => (acc += d))
      p.on('close', () => resolve(acc))
    })
    assert.match(out, /all good/)

    // use_skill 的返回里要带上声明和脚本清单，但只给相对路径
    const skillResult = seen[1].messages.filter((m) => m.role === 'tool').map((m) => String(m.content)).join('\n')
    assert.match(skillResult, /Declared tools: run_command, read_file/)
    assert.match(skillResult, /scripts\/check\.sh/)
    assert.equal(skillResult.includes(home), false, 'no absolute home paths leak into the context')

    // 脚本真的跑了，参数也传进去了
    const scriptResult = seen.at(-1).messages.filter((m) => m.role === 'tool').map((m) => String(m.content)).join('\n')
    assert.match(scriptResult, /checked prod from the skill script/, 'the bundled script executed with its argument')
  } finally {
    server.close()
    rmSync(home, { recursive: true, force: true })
    rmSync(proj, { recursive: true, force: true })
  }
})

test('run_skill_script refuses a path the skill does not ship', async () => {
  const seen = []
  let asked = 0
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
      asked++
      const calls = [
        { id: 'c1', type: 'function', function: { name: 'use_skill', arguments: '{"name":"deploy-check"}' } },
        { id: 'c2', type: 'function', function: { name: 'run_skill_script', arguments: '{"skill":"deploy-check","script":"../../etc/passwd"}' } },
      ]
      const payload = asked > calls.length
        ? { model: 'mock', choices: [{ message: { role: 'assistant', content: 'gave up' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }
        : { model: 'mock', choices: [{ message: { role: 'assistant', content: '', tool_calls: [calls[asked - 1]] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const home = mkdtempSync(join(tmpdir(), 'uh-skill3-'))
  const proj = mkdtempSync(join(tmpdir(), 'uh-proj3-'))
  const skillDir = join(proj, '.uh', 'skills', 'deploy-check')
  mkdirSync(join(skillDir, 'scripts'), { recursive: true })
  writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: deploy-check\ndescription: d\n---\nbody\n')
  writeFileSync(join(skillDir, 'scripts', 'ok.sh'), '#!/bin/sh\necho ok\n')
  execFileSync('chmod', ['+x', join(skillDir, 'scripts', 'ok.sh')])
  try {
    await new Promise((resolve) => {
      const p = spawn(process.execPath, [CLI, 'run', 'try a bad script path', '--max-steps', '4'], {
        cwd: proj,
        env: { ...process.env, UH_HOME: home, UH_BASE_URL: `http://127.0.0.1:${port}/v1`, UH_MODEL: 'mock' },
      })
      p.on('close', resolve)
    })
    const fed = seen.at(-1).messages.filter((m) => m.role === 'tool').map((m) => String(m.content)).join('\n')
    assert.match(fed, /is not a script of skill/, 'a traversing path is refused, not resolved')
    assert.match(fed, /scripts\/ok\.sh/, 'and it says what is actually available')
  } finally {
    server.close()
    rmSync(home, { recursive: true, force: true })
    rmSync(proj, { recursive: true, force: true })
  }
})
