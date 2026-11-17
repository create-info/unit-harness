/**
 * 产物归属：谁写的，谁认领。
 *
 * 原来的做法是"开跑前拍一张工作区快照、跑完再拍一张、相减"。它回答的是
 * "目录里现在多了什么"，不是"这次会话做了什么"。两条会话共用一个目录时，
 * 隔壁那条写的东西会被算到这次头上——线上确实发生过：一条 30 步、只写了
 * 一个 _fetch.py 的复现，报了 16 个交付物，其中 15 个是另一条会话做的课件，
 * 每个还挂着 ✓ 3/3。
 *
 * 现在改成记录行为：只有经过工具记账（checkpoint/file）的路径才算
 * source='tool'，其余一律 'snapshot'——照样列出来，但不算数、不验证。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(process.cwd(), 'dist', 'uh.cjs')

const { snapshotDir, diffSnapshots, collectArtifacts } =
  await import('../packages/core/src/artifact/snapshot.ts')

test('a file we did not write is not our deliverable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uh-attr-'))
  try {
    writeFileSync(join(dir, 'ours.txt'), 'mine\n')
    writeFileSync(join(dir, 'theirs.txt'), 'someone else\n')
    const after = snapshotDir(dir)
    const empty = {}
    const changes = diffSnapshots(empty, after)

    const arts = collectArtifacts(dir, changes, after, new Set(['ours.txt']))
    const byPath = Object.fromEntries(arts.map((a) => [a.path, a.source]))
    assert.equal(byPath['ours.txt'], 'tool', 'what we wrote is ours')
    assert.equal(byPath['theirs.txt'], 'snapshot', 'what merely appeared is not')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a `./` prefix does not cost us our own file', () => {
  // 快照 key 的写法跟着拍摄时的路径走，比对前要统一；纯格式差异造成漏认同
  // 样是 bug——只是方向相反（该认的不认）
  const dir = mkdtempSync(join(tmpdir(), 'uh-attr-'))
  try {
    writeFileSync(join(dir, 'a.txt'), 'x\n')
    const after = snapshotDir(dir)
    const arts = collectArtifacts(dir, diffSnapshots({}, after), after, new Set(['./a.txt']))
    assert.equal(arts[0].source, 'tool')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * 假模型：
 *   1) apply_patch 写 mine.txt        —— 工具写的
 *   2) run_command 写 built.sh        —— 这条命令写的
 *   3) 等测试代码往工作区里塞一个 theirs.txt（模拟隔壁会话），再收尾
 *
 * 第三步必须发生在**没有任何命令在跑的时候**——这正是并发会话的处境：
 * 它写文件的那一刻跟我们哪条命令都不重合。
 */
const PATCH_ADD_MINE = ['*** Begin Patch', '*** Add File: mine.txt', '+ours', '*** End Patch', ''].join('\n')

function startMock(gate) {
  let n = 0
  const server = http.createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'mock' }] }))
      return
    }
    let b = ''
    req.on('data', (c) => (b += c))
    req.on('end', async () => {
      const body = JSON.parse(b || '{}')
      const hasTools = Array.isArray(body.tools) && body.tools.length > 0
      n++
      const done = (content) => ({
        model: 'mock',
        choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
      })
      const call = (name, args) => ({
        model: 'mock',
        choices: [{
          message: { role: 'assistant', content: '', tool_calls: [{ id: 'c' + n, type: 'function', function: { name, arguments: JSON.stringify(args) } }] },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
      })
      let payload
      if (!hasTools || n > 2) {
        if (gate) await gate()
        payload = done('done')
      } else if (n === 1) payload = call('apply_patch', { patch: PATCH_ADD_MINE })
      else payload = call('run_command', { argv: ['sh', '-c', 'echo built > built.sh'] })
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

test('our own output is claimed, a neighbour\'s is not', async () => {
  const home = mkdtempSync(join(tmpdir(), 'uh-attr-home-'))
  // 工作区是 $UH_HOME/work，不是 --cwd 指的那个：`--cwd` 只影响命令的 cwd。
  // 要模拟"隔壁会话往同一个工作区里写文件"，就得往这里写。
  const ws = join(home, 'work')
  mkdirSync(ws, { recursive: true })
  // 等第二条命令（写 built.sh 的那条）跑完、并且不再有命令在跑的时候，
  // 从外面丢一个文件进去——这就是隔壁会话在干的事
  const gate = async () => {
    await new Promise((r) => setTimeout(r, 400))
    // 写失败也绝不能把假模型的响应挂住：那会让整条用例卡死而不是失败
    try { writeFileSync(join(ws, 'theirs.txt'), 'someone else\n') } catch { /* 由断言兜底 */ }
  }
  const server = startMock(gate)
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  try {
    const code = await new Promise((resolve) => {
      const p = spawn(process.execPath, [CLI, 'run', 'write two files', '--base-url', `http://127.0.0.1:${port}/v1`, '--model', 'mock', '--cwd', ws, '--allow-unconfined'], {
        env: { ...process.env, UH_HOME: home },
      })
      p.on('close', (c) => resolve(c))
    })
    assert.equal(code, 0)

    const events = readFileSync(join(sessionDirOf(home), 'events.jsonl'), 'utf8')
      .trim().split('\n').map((l) => JSON.parse(l))
    const emitted = events.filter((e) => e.kind === 'artifact/emitted')
    const byPath = Object.fromEntries(emitted.map((e) => [String(e.payload.path), e.payload.source]))

    assert.equal(byPath['mine.txt'], 'tool', 'a patch we applied is ours: ' + JSON.stringify(byPath))
    assert.equal(byPath['built.sh'], 'exec', 'a command we ran wrote it: ' + JSON.stringify(byPath))
    assert.equal(byPath['theirs.txt'], 'snapshot', 'a neighbour\'s file is not ours: ' + JSON.stringify(byPath))

    // 不认领的东西不许挂验证勾：给别人的文件盖 ✓ 就是在替不存在的归属背书
    const verified = events.filter((e) => e.kind === 'verification/asserted')
    assert.ok(!verified.some((e) => JSON.stringify(e.payload).includes('theirs.txt')),
      'snapshot artifacts must not be verified')
  } finally {
    server.close()
    rmSync(home, { recursive: true, force: true })
  }
})
