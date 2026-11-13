/**
 * 审批门。
 *
 * 定位里写了「花钱动作有审批」，这个文件是它的证据。三条边界：
 *   - 默认拒绝：没人回答 ≠ 获得许可（CI、脚本、API 都走这条路）
 *   - 沙箱兜得住的写操作不打扰人（否则每装一个包就要按一次 y）
 *   - 被拒绝也留痕：事后能查到「它想跑什么」
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'

const CLI = join(process.cwd(), 'dist', 'uh.cjs')

/** 让模型要求执行一条给定命令 */
function modelWants(command) {
  return http.createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'mock' }] }))
      return
    }
    let b = ''
    req.on('data', (c) => (b += c))
    req.on('end', () => {
      const parsed = JSON.parse(b || '{}')
      const hadTool = (parsed.messages ?? []).some((m) => m.role === 'tool')
      const payload = hadTool
        ? { model: 'mock', choices: [{ message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }
        : {
            model: 'mock',
            choices: [{
              message: {
                role: 'assistant', content: '',
                tool_calls: [{ id: 'c1', type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ argv: command }) } }],
              },
              finish_reason: 'tool_calls',
            }],
            usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
          }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    })
  })
}

function run(args, env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { env })
    let s = ''
    p.stdout.on('data', (d) => (s += d))
    p.stderr.on('data', (d) => (s += d))
    p.on('close', (code) => resolve({ s, code }))
  })
}

test('a destructive command is refused by default, and the attempt is recorded', async () => {
  const server = modelWants(['rm', '-rf', 'precious.txt'])
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const home = mkdtempSync(join(tmpdir(), 'uh-appr-'))

  try {
    const { s } = await run(['run', 'delete the thing', '--max-steps', '2'], {
      ...process.env, UH_HOME: home, UH_BASE_URL: `http://127.0.0.1:${port}/v1`, UH_MODEL: 'mock',
    })

    const sid = basename(sessionDirOf(home))
    const events = readFileSync(join(sessionDirOf(home), 'events.jsonl'), 'utf8')
      .trim().split('\n').map((l) => JSON.parse(l))

    const asked = events.find((e) => e.kind === 'approval/requested')
    assert.ok(asked, 'a destructive command must ask first')
    assert.equal(asked.payload.risk, 'destructive')
    assert.match(asked.payload.detail, /rm -rf precious\.txt/)

    const resolved = events.find((e) => e.kind === 'approval/resolved')
    assert.equal(resolved.payload.decision, 'deny', 'with no terminal attached, silence is not consent')

    const refused = events.find((e) => e.kind === 'tool/result' && e.payload.denied_by === 'approval')
    assert.ok(refused, 'the refusal itself must be recorded')
    assert.match(s, /done/) // 模型拿到错误后仍然正常收尾
  } finally {
    server.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('--yes runs it', async () => {
  const server = modelWants(['sh', '-c', 'echo hi > approved.txt'])
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const home = mkdtempSync(join(tmpdir(), 'uh-appr2-'))

  try {
    const { s } = await run(['run', 'write a file', '--yes', '--max-steps', '2'], {
      ...process.env, UH_HOME: home, UH_BASE_URL: `http://127.0.0.1:${port}/v1`, UH_MODEL: 'mock',
    })
    assert.equal(s.includes('E_APPROVAL_DENIED'), false, s)

    const sid = basename(sessionDirOf(home))
    const events = readFileSync(join(sessionDirOf(home), 'events.jsonl'), 'utf8')
      .trim().split('\n').map((l) => JSON.parse(l))
    assert.ok(!events.some((e) => e.kind === 'approval/requested'), '--yes should not prompt at all')
  } finally {
    server.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('read-only commands are never gated', async () => {
  const server = modelWants(['ls'])
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const home = mkdtempSync(join(tmpdir(), 'uh-appr3-'))

  try {
    await run(['run', 'list files', '--max-steps', '2'], {
      ...process.env, UH_HOME: home, UH_BASE_URL: `http://127.0.0.1:${port}/v1`, UH_MODEL: 'mock',
    })
    const sid = basename(sessionDirOf(home))
    const events = readFileSync(join(sessionDirOf(home), 'events.jsonl'), 'utf8')
      .trim().split('\n').map((l) => JSON.parse(l))
    assert.ok(!events.some((e) => e.kind === 'approval/requested'), 'ls must not ask permission')
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
