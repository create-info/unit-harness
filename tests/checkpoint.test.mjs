/**
 * Checkpoint / undo。
 *
 * 要证明的不是「git 能提交」，而是三件事：
 *   - 一次 run 的改动可以被整体撤回（包括 shell 里改的文件，不只有 apply_patch）
 *   - 撤不存在的历史要拒绝，而不是把工作区弄成别的样子
 *   - 撤销之后，用户自己 git 仓库的状态没被动过
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(process.cwd(), 'dist', 'uh.cjs')

/** 模型先跑一条 shell 命令，然后收尾 */
function shellThenDone(command) {
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
      const payload = round++ === 0
        ? {
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
        : {
            model: 'mock',
            choices: [{ message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
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

test('undo restores files the agent touched, including via shell', async () => {
  const server = shellThenDone(['sh', '-c', 'echo "changed by the agent" > target.txt && mkdir -p out && echo new > out/new.txt'])
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const home = mkdtempSync(join(tmpdir(), 'uh-cp-'))
  const work = join(home, 'work')
  mkdirSync(work, { recursive: true })
  writeFileSync(join(work, 'target.txt'), 'original content\n')

  const env = { ...process.env, UH_HOME: home, UH_BASE_URL: `http://127.0.0.1:${port}/v1`, UH_MODEL: 'mock' }
  try {
    const r1 = await run(['run', 'change target.txt', '--yes'], env)
    assert.equal(r1.code, 0, r1.s)
    assert.match(readFileSync(join(work, 'target.txt'), 'utf8'), /changed by the agent/)
    assert.ok(existsSync(join(work, 'out', 'new.txt')), 'the shell created a new file')

    const list = await run(['checkpoints'], env)
    assert.match(list.s, /before: change target\.txt/, list.s)

    const undo = await run(['undo'], env)
    assert.equal(undo.code, 0, undo.s)

    // 改过的文件回到原内容
    assert.equal(readFileSync(join(work, 'target.txt'), 'utf8'), 'original content\n')
    // run 期间新建的目录/文件应当消失，否则不算还原
    assert.equal(existsSync(join(work, 'out')), false, 'files created during the run must be gone')
  } finally {
    server.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('undo refuses to rewind further than the history goes', async () => {
  const home = mkdtempSync(join(tmpdir(), 'uh-cp2-'))
  mkdirSync(join(home, 'work'), { recursive: true })
  try {
    const r = await run(['undo', '5'], { ...process.env, UH_HOME: home })
    assert.notEqual(r.code, 0, 'rewinding past the beginning must fail loudly')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('checkpoints live outside the workspace git repo', async () => {
  const server = shellThenDone(['sh', '-c', 'echo x > a.txt'])
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const home = mkdtempSync(join(tmpdir(), 'uh-cp3-'))
  const work = join(home, 'work')
  mkdirSync(work, { recursive: true })

  // 工作区本身是个 git 仓库，且有未提交改动
  execFileSync('git', ['init', '-q'], { cwd: work })
  execFileSync('git', ['config', 'user.email', 'u@example.com'], { cwd: work })
  execFileSync('git', ['config', 'user.name', 'u'], { cwd: work })
  writeFileSync(join(work, 'precious.txt'), 'uncommitted work\n')

  const env = { ...process.env, UH_HOME: home, UH_BASE_URL: `http://127.0.0.1:${port}/v1`, UH_MODEL: 'mock' }
  try {
    await run(['run', 'touch a file', '--yes'], env)

    // 用户自己的仓库：HEAD 还是没提交的状态，index 不该被塞满
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: work, encoding: 'utf8' })
    assert.match(status, /precious\.txt/, 'the user\'s uncommitted file must still be untracked')
    let log = ''
    try { log = execFileSync('git', ['log', '--oneline'], { cwd: work, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) } catch { log = '' }
    assert.equal(String(log).trim(), '', 'we must not commit into the user\'s repository')
  } finally {
    server.close()
    rmSync(home, { recursive: true, force: true })
  }
})
