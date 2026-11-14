/**
 * 交互式终端（`uh chat`）必须真的能用，不能只是「看起来像 TUI」。
 *
 * 从外面喂输入，钉住三件事：
 *   1. /help 列出手上的命令（模型、配置、技能、@文件 都在）
 *   2. 一句话真的会跑：过程行流出来，回答落到屏幕上
 *   3. 连续两句话落在同一条会话里（不是各说各话）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(process.cwd(), 'dist', 'uh.cjs')

/** 假模型：第一次要工具，之后给结论（这样过程行和回答都能被看到） */
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
      n++
      let body = {}
      try { body = JSON.parse(b || '{}') } catch { /* ignore */ }
      const hasTools = Array.isArray(body.tools) && body.tools.length > 0
      const payload = !hasTools || n > 1
        ? {
            model: 'mock',
            choices: [{ message: { role: 'assistant', content: 'the answer is 42' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
          }
        : {
            model: 'mock',
            choices: [{
              message: {
                role: 'assistant', content: '',
                tool_calls: [{
                  id: 'c1', type: 'function',
                  function: { name: 'run_command', arguments: JSON.stringify({ argv: ['echo', 'hi'] }) },
                }],
              },
              finish_reason: 'tool_calls',
            }],
            usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
          }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    })
  })
  return server
}

function runTui(input, env, cwd) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, 'chat'], { env: { ...process.env, ...env }, cwd })
    let out = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (out += d))
    p.on('close', (code) => resolve({ code, out }))
    p.stdin.end(input)
  })
}

function sessionsUnder(home) {
  const found = []
  const walk = (dir, depth) => {
    if (depth > 4) return
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const full = join(dir, e.name)
      if (existsSync(join(full, 'meta.json'))) found.push(full)
      else walk(full, depth + 1)
    }
  }
  walk(join(home, 'sessions'), 0)
  return found
}

test('terminal chat: help, a real run, and one conversation across turns', async () => {
  const server = startMock()
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const root = mkdtempSync(join(tmpdir(), 'uh-tui-'))
  const uhHome = join(root, '.uh')
  mkdirSync(uhHome, { recursive: true })
  const work = join(root, 'work')
  mkdirSync(work, { recursive: true })
  writeFileSync(join(work, 'note.txt'), 'hello from a file\n')
  // 配置直接写进去：TUI 读的正是这个文件，走同一套解析
  writeFileSync(join(uhHome, 'config.json'), JSON.stringify({
    defaultProvider: 'lmstudio',
    approval: 'allow',
    providers: { lmstudio: { baseUrl: `http://127.0.0.1:${port}/v1`, model: 'mock' } },
  }))
  const env = { UH_HOME: uhHome }

  try {
    // 1. 帮助页
    const help = await runTui('/help\n/quit\n', env, work)
    assert.equal(help.code, 0)
    for (const want of ['/model', '/config', '/skills', '@路径', '$技能']) {
      assert.ok(help.out.includes(want), 'help must mention ' + want + '\n' + help.out.slice(0, 500))
    }

    // 2. 真跑一轮：@文件 带进上下文，过程行和回答都出来
    const one = await runTui('look at @note.txt and tell me\n/quit\n', env, work)
    assert.ok(/● /.test(one.out), 'tool progress must stream\n' + one.out)
    assert.ok(one.out.includes('the answer is 42'), 'the answer must reach the screen\n' + one.out)
    assert.ok(one.out.includes('✓ done'), 'the turn must report how it ended\n' + one.out)

    // 3. 连续两轮：同一条会话。换一个干净的 home——
    //    上面那轮是另一个进程（另一个 TUI 实例），本来就该是另一条会话。
    const uhHome2 = join(root, '.uh2')
    mkdirSync(uhHome2, { recursive: true })
    writeFileSync(join(uhHome2, 'config.json'), readFileSync(join(uhHome, 'config.json'), 'utf8'))
    const two = await runTui('first question\nsecond question\n/quit\n', { UH_HOME: uhHome2 }, work)
    const sess = sessionsUnder(uhHome2)
    assert.equal(sess.length, 1, 'both turns must land in one session, got ' + sess.length + '\n' + two.out)
    const events = readFileSync(join(sess[0], 'events.jsonl'), 'utf8')
    const turns = (events.match(/"kind":"turn\/start"/g) ?? []).length
    assert.ok(turns >= 2, 'the second turn must continue the same conversation (turns=' + turns + ')')
  } finally {
    server.close()
    rmSync(root, { recursive: true, force: true })
  }
})
