/**
 * 空转的模型（同一个失败动作一遍一遍再来）。
 *
 * 取消步数上限之后必须补上这块边界：模型如果卡在「同一条命令再试一次」，
 * 每一步都很小、token 也不涨，没有边界就是转到天荒地老——子 agent 尤其明显，
 * 深度被拒之后它会拿同一条 spawn_agent 一直试（这条用例最初就是这么发现的：
 * 整个测试套件挂住 19 分钟）。
 *
 * 判据不是「任务太长」（那是猜测），而是「什么都没变、还是同样的失败」。
 * 更要紧的是：停下之后也必须说人话，不能只留一个空字符串。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(process.cwd(), 'dist', 'uh.cjs')

/** 永远拿同一条会失败的命令去撞墙的模型；不给工具时才肯说话 */
function startStuckMock() {
  const seen = []
  const server = http.createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'mock' }] }))
      return
    }
    let b = ''
    req.on('data', (c) => (b += c))
    req.on('end', () => {
      const parsed = JSON.parse(b || '{}')
      seen.push(parsed)
      const noTools = !Array.isArray(parsed.tools) || parsed.tools.length === 0
      const payload = noTools
        ? {
            model: 'mock',
            choices: [{ message: { role: 'assistant', content: 'I kept running the same failing command; it is still broken.' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
          }
        : {
            model: 'mock',
            choices: [{
              message: {
                role: 'assistant', content: '',
                tool_calls: [{
                  id: 'same',
                  type: 'function',
                  // 每次都是同一条命令，且它一定会失败
                  function: { name: 'run_command', arguments: JSON.stringify({ argv: ['sh', '-c', 'exit 7'] }) },
                }],
              },
              finish_reason: 'tool_calls',
            }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    })
  })
  return { server, seen }
}

function runCli(args, env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, ...env } })
    let out = ''
    let err = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (err += d))
    p.on('close', (code) => resolve({ code, out, err }))
  })
}

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

test('a model that keeps repeating the same failing call is stopped, and still explains', async () => {
  const { server, seen } = startStuckMock()
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const home = mkdtempSync(join(tmpdir(), 'uh-stuck-'))
  try {
    const res = await runCli(
      ['run', 'fix the build', '--base-url', `http://127.0.0.1:${port}/v1`, '--model', 'mock'],
      { UH_HOME: home },
    )
    // 退出码 4 = 卡死，和「撞步数上限」(2)、「预算用光」(3) 分开
    assert.equal(res.code, 4, 'exit ' + res.code + '\n' + res.out.slice(-500))
    // 只撞了 5 次就被叫停，没有一路转到天荒地老
    assert.ok(seen.length <= 8, 'it must stop after a handful of identical failures, saw ' + seen.length)
    // 停下来时必须有话，不能只留一个空字符串
    assert.match(res.out, /same failing command/i, 'the wrap-up answer must reach the screen')

    const events = readFileSync(join(sessionDirOf(home), 'events.jsonl'), 'utf8')
      .trim().split('\n').map((l) => JSON.parse(l))
    const stuck = events.find((e) => e.kind === 'step/end' && e.payload.kind === 'stuck')
    assert.ok(stuck, 'the stop must be recorded as `stuck`, not silently')
    assert.ok(stuck.payload.repeats >= 5)
    assert.match(String(stuck.payload.action), /run_command/)
    const end = events.filter((e) => e.kind === 'turn/end').pop()
    assert.equal(end.payload.stop_reason, 'stuck')
  } finally {
    server.close()
    rmSync(home, { recursive: true, force: true })
  }
})
