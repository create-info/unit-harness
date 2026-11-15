/**
 * 审批是三选一，不是 y/N。
 *
 * Codex 的问法是「现在做 / 以后都别问 / 别做，换个办法」。只有 y/N 的时候，
 * 用户没法表达「这条命令别再问我」，于是每条都要按一次 y——按到最后就是闭眼按，
 * 审批变成仪式。这个测试钉住：
 *
 *   1. 菜单里真的有两个「允许」选项，而且把会被记住的原文念出来；
 *   2. 选「本会话都允许」后命令真的跑了（junk 被删掉）；
 *   3. 落盘的事件里记的是 allow-always + remembered，不是含糊的 allow；
 *   4. 没人回答（stdin 关了）时是拒绝，不是默认放行。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(process.cwd(), 'dist', 'uh.cjs')
const POSIX_ONLY = process.platform === 'win32' ? 'posix-only' : false

/** 模型只说一句话：删掉 junk 目录（破坏性动作，任何策略下都要问人） */
function startMock() {
  return http.createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'mock' }] }))
      return
    }
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : {}
      const tools = (parsed.messages ?? []).filter((m) => m.role === 'tool').length
      const payload = tools >= 1
        ? { model: 'mock', choices: [{ message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }
        : {
            model: 'mock',
            choices: [{
              message: {
                role: 'assistant',
                content: '',
                // 工具名是 run_command，参数是 argv 数组（不是 exec / command 字符串）
                tool_calls: [{ id: 'c1', type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ argv: ['rm', '-rf', 'junk'] }) } }],
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

/** 跑一次 TUI：看到提示再回答，避免和任务行抢同一个 readline */
function runTui({ home, work, task, answer, answerOn }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, 'chat'], {
      cwd: work,
      env: { ...process.env, UH_HOME: home, NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let out = ''
    let answered = false
    let quit = false
    let killed = false
    const onData = (d) => {
      out += String(d)
      if (answer !== undefined && !answered && out.includes(answerOn)) {
        answered = true
        child.stdin.write(answer + '\n')
      }
      // 答完这一轮要自己退出：测试不是交互终端，没人再敲 /quit
      if (answered && !quit && out.includes('✓ done')) {
        quit = true
        child.stdin.write('/quit\n')
      }
      // `bye` 表示主循环收尾了。先正常关 stdin 让它把事件刷完（SIGKILL 会
      // 砍掉最后一次落盘，测试就会看到「一个会话都没有」），5 秒后还没退再硬杀
      if (out.includes('bye') && !killed) {
        killed = true
        child.stdin.end()
        setTimeout(() => child.kill('SIGKILL'), 5000)
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('timed out\n' + out.slice(-2000)))
    }, 90_000)
    child.on('exit', () => {
      clearTimeout(timer)
      resolve(out)
    })
    child.on('error', reject)
    child.stdin.write(task + '\n')
  })
}

function sessionsUnder(home) {
  const root = join(home, 'sessions')
  if (!existsSync(root)) return []
  const found = []
  // 结构是 sessions/YYYY/MM/DD/<sessionId>/events.jsonl —— 会话在第四层，不是第三层
  for (const y of readdirSync(root)) for (const m of readdirSync(join(root, y)))
    for (const d of readdirSync(join(root, y, m)))
      for (const sid of readdirSync(join(root, y, m, d))) {
        const dir = join(root, y, m, d, sid)
        if (existsSync(join(dir, 'events.jsonl'))) found.push(dir)
      }
  return found
}

test('approval offers "this once / this session / no", and remembers the prefix', { skip: POSIX_ONLY }, async () => {
  const server = startMock()
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const root = mkdtempSync(join(tmpdir(), 'uh-appr-'))
  const home = join(root, '.uh')
  const work = join(root, 'work')
  mkdirSync(home, { recursive: true })
  mkdirSync(join(work, 'junk'), { recursive: true })
  writeFileSync(join(work, 'junk', 'x.txt'), 'bye')
  writeFileSync(join(home, 'config.json'), JSON.stringify({
    defaultProvider: 'lmstudio',
    approval: 'ask',
    providers: { lmstudio: { baseUrl: `http://127.0.0.1:${port}/v1`, model: 'mock' } },
  }))

  try {
    const out = await runTui({
      home, work, task: 'clean up junk', answer: 'a', answerOn: '需要批准',
    })

    // 1. 两个「允许」都在，并且把会被记住的原文念出来
    assert.ok(out.includes('1) 允许这一次'), 'there must be an "once" option\n' + out.slice(-1500))
    assert.ok(out.includes('本会话都允许'), 'there must be an "always" option\n' + out.slice(-1500))
    assert.ok(out.includes('rm -rf junk'), 'the remembered command must be shown verbatim')
    assert.ok(out.includes('拒绝'), 'there must be a way to say no')

    // 2. 选了「本会话」就真的跑了
    assert.ok(!existsSync(join(work, 'junk')), 'the approved command must actually run')

    // 3. 事件里是 allow-always + remembered，不是含糊的 allow
    const sess = sessionsUnder(home)
    assert.equal(sess.length, 1)
    const ev = readFileSync(join(sess[0], 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    const resolved = ev.find((e) => e.kind === 'approval/resolved' && !e.payload.auto)
    assert.ok(resolved, 'approval must be recorded')
    assert.equal(resolved.payload.decision, 'allow')
    assert.equal(resolved.payload.remembered, true, 'allow-always must be recorded as remembered')
  } finally {
    server.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('a question nobody answers is a refusal, not a yes', { skip: POSIX_ONLY }, async () => {
  const server = startMock()
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const root = mkdtempSync(join(tmpdir(), 'uh-appr2-'))
  const home = join(root, '.uh')
  const work = join(root, 'work')
  mkdirSync(home, { recursive: true })
  mkdirSync(join(work, 'junk'), { recursive: true })
  writeFileSync(join(work, 'junk', 'x.txt'), 'keep me')
  writeFileSync(join(home, 'config.json'), JSON.stringify({
    defaultProvider: 'lmstudio',
    approval: 'ask',
    providers: { lmstudio: { baseUrl: `http://127.0.0.1:${port}/v1`, model: 'mock' } },
  }))

  try {
    // 只喂任务行，不给答案：stdin 关掉后必须按拒绝收尾（否则这里会挂到超时）
    const child = spawn(process.execPath, [CLI, 'chat'], {
      cwd: work,
      env: { ...process.env, UH_HOME: home, NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', (d) => (out += String(d)))
    child.stderr.on('data', (d) => (out += String(d)))
    child.stdin.end('clean up junk\n')
    const code = await new Promise((resolve) => child.on('exit', resolve))
    assert.equal(typeof code, 'number')
    // 注意这里是 existsSync（不是取反）：没人回答 = 拒绝 = junk 必须还在
    assert.ok(existsSync(join(work, 'junk')), 'an unanswered request must not delete anything')
    assert.ok(out.includes('需要批准'), 'it must have asked\n' + out.slice(-1200))
  } finally {
    server.close()
    rmSync(root, { recursive: true, force: true })
  }
})
