/**
 * Hooks。
 *
 * 重点不是「能跑一条 shell」，而是**机制比提示词硬**：
 *   - pre_tool 挡下的命令，真的没执行
 *   - pre_finish 挡下的「我完成了」，模型不得不继续干活，而不是照样收工
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'

const CLI = join(process.cwd(), 'dist', 'uh.cjs')

function run(args, env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { env })
    let s = ''
    p.stdout.on('data', (d) => (s += d))
    p.stderr.on('data', (d) => (s += d))
    p.on('close', (code) => resolve({ s, code }))
  })
}

function eventsOf(home) {
  const sid = basename(sessionDirOf(home))
  return readFileSync(join(sessionDirOf(home), 'events.jsonl'), 'utf8')
    .trim().split('\n').map((l) => JSON.parse(l))
}

/** 按脚本返回：第一个响应执行一条命令，之后收尾 */
function scripted(command, finalText = 'done') {
  let round = 0
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
      const lastUser = [...(parsed.messages ?? [])].reverse().find((m) => m.role === 'user')
      const rejected = typeof lastUser?.content === 'string' && lastUser.content.includes('rejected by a hook')
      round++
      let payload
      if (round === 1 && command) {
        payload = {
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
      } else {
        payload = {
          model: 'mock',
          choices: [{ message: { role: 'assistant', content: rejected ? `${finalText} (after fixing)` : finalText }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
        }
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    })
  })
}

test('a pre_tool hook blocks the command before it runs', async () => {
  const server = scripted(['node', '-e', 'require("fs").writeFileSync("forbidden.txt","pwned")'])
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const home = mkdtempSync(join(tmpdir(), 'uh-hook-'))
  const work = join(home, 'work')
  mkdirSync(join(work, '.uh'), { recursive: true })
  writeFileSync(join(work, '.uh', 'hooks.json'), JSON.stringify({
    // 用 node 而不是 sh：hook 在 Windows 上走 cmd，POSIX 语法跑不了
    pre_tool: [{ tool: 'run_command', match: 'forbidden', run: 'node -e "console.error(\'no writes named forbidden\');process.exit(3)"' }],
  }))

  try {
    const { s } = await run(['run', 'write the file', '--yes', '--allow-unconfined'], {
      ...process.env, UH_HOME: home, UH_BASE_URL: `http://127.0.0.1:${port}/v1`, UH_MODEL: 'mock',
    })

    assert.equal(existsSync(join(work, 'forbidden.txt')), false, 'the command must not have run')

    const events = eventsOf(home)
    const hook = events.find((e) => e.kind === 'hook/execution')
    assert.ok(hook, 'the hook execution must be recorded')
    assert.equal(hook.payload.decision, 'block')
    assert.equal(hook.payload.event, 'pre_tool')
    assert.match(s, /done/)
  } finally {
    server.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('a pre_finish hook rejects "done" until the check passes', async () => {
  const server = scripted(null, 'all good')
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const home = mkdtempSync(join(tmpdir(), 'uh-hook2-'))
  const work = join(home, 'work')
  mkdirSync(join(work, '.uh'), { recursive: true })
  writeFileSync(join(work, 'check.marker'), 'present')
  writeFileSync(join(work, 'check.js'), [
    'const fs = require("fs")',
    'if (fs.existsSync("check.marker")) {',
    '  fs.unlinkSync("check.marker")',
    '  console.error("check.marker still there")',
    '  process.exit(1)',
    '}',
  ].join("\n"))
  // 第一次失败，把标记文件删掉让它第二次通过
  writeFileSync(join(work, '.uh', 'hooks.json'), JSON.stringify({
    // hook 写成文件由 node 执行，而不是内联一段带引号的脚本：
    // Windows 上是 `cmd /c`，它对嵌套引号的重解析会让内联脚本默默失败
    pre_finish: [{ run: 'node check.js' }],
  }))

  try {
    const { s } = await run(['run', 'do the thing', '--max-steps', '4', '--allow-unconfined'], {
      ...process.env, UH_HOME: home, UH_BASE_URL: `http://127.0.0.1:${port}/v1`, UH_MODEL: 'mock',
    })

    const events = eventsOf(home)
    const hooks = events.filter((e) => e.kind === 'hook/execution')
    assert.equal(hooks.length, 2, 'the finish hook must run twice: once rejected, once accepted')
    assert.equal(hooks[0].payload.decision, 'block')
    assert.equal(hooks[1].payload.decision, 'allow')

    // 被拒绝后模型拿到了新指令并继续，最终回复是「修好之后」的那句
    assert.match(s, /after fixing/, s)
  } finally {
    server.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('no hooks file means no hook overhead', async () => {
  const server = scripted(null, 'fine')
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const home = mkdtempSync(join(tmpdir(), 'uh-hook3-'))
  mkdirSync(join(home, 'work'), { recursive: true })
  try {
    await run(['run', 'nothing special', '--allow-unconfined'], {
      ...process.env, UH_HOME: home, UH_BASE_URL: `http://127.0.0.1:${port}/v1`, UH_MODEL: 'mock',
    })
    const events = eventsOf(home)
    assert.equal(events.filter((e) => e.kind === 'hook/execution').length, 0)
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
