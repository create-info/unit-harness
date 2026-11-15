/**
 * 多轮对话：第二句必须续在**同一条**会话里，并且真的带上文。
 *
 * 这是网页版最缺的一件事：以前每点一次 Run 就新开一条会话，左栏里一个对话
 * 变成一地碎片，模型也拿不到上一句。这里验证三件事：
 *   1. 续跑复用同一个 sessionId，不新开会话；
 *   2. 第二轮请求里带着第一轮的用户原话（上下文真的传过去了）；
 *   3. 事件里 turn_index 递增——不然回放分不出两轮。
 *
 * 顺带覆盖选项目用的目录浏览接口：只回目录、不越界、建文件夹要拦住路径分隔符。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import net from 'node:net'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(process.cwd(), 'dist', 'uh.cjs')

/**
 * 端口不能拍一个随机数。
 *
 * `npm test` 会把测试文件并行跑，各文件自己也在挑随机端口；挑到同一个就变成
 * `EADDRINUSE` 挂 15 秒——看起来像功能坏了，其实只是撞号。让内核分配一个空闲端口。
 */
let PORT = 0
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer()
  s.once('error', reject)
  s.listen(0, '127.0.0.1', () => {
    const p = s.address().port
    s.close(() => resolve(p))
  })
})

/** 记下每次请求的 messages，回一句话。 */
function modelServer(said) {
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
      const body = b ? JSON.parse(b) : {}
      seen.push(body.messages ?? [])
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        model: 'mock',
        choices: [{ message: { role: 'assistant', content: said[Math.min(seen.length - 1, said.length - 1)] }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
      }))
    })
  })
  return { server, seen }
}

async function startUh(env) {
  PORT = await freePort()
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [CLI, 'serve', '--port', String(PORT)], { env })
    let log = ''
    // 计时器一定要收：留着它，测试跑完进程还要多等 15 秒才退出
    const timer = setTimeout(() => reject(new Error('server did not start:\n' + log)), 15000)
    p.stdout.on('data', (d) => {
      log += d
      if (/http:\/\/127\.0\.0\.1:/.test(log)) { clearTimeout(timer); resolve(p) }
    })
    p.stderr.on('data', (d) => (log += d))
  })
}

const get = async (path) => (await fetch(`http://127.0.0.1:${PORT}${path}`)).json()
const post = async (path, body) =>
  (await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })).json()

/** 会话目录（home/sessions/YYYY/MM/DD/<id>） */
function sessionDir(home, id) {
  const walk = (dir, depth) => {
    if (depth > 4) return null
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return null }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const p = join(dir, e.name)
      if (e.name === id) return p
      const found = walk(p, depth + 1)
      if (found) return found
    }
    return null
  }
  return walk(join(home, 'sessions'), 0)
}

const events = (home, id) => {
  const dir = sessionDir(home, id)
  if (!dir) return []
  try {
    return readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  } catch { return [] }
}

async function waitDone(home, id, turns = 1, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const evs = events(home, id)
    const done = evs.filter((e) => e.kind === 'turn/end').length
    if (done >= turns) {
      // 等 state.json 也落盘（turn/end 之后还有交付物登记和状态写盘）
      const dir = sessionDir(home, id)
      if (dir && existsSync(join(dir, 'state.json'))) return evs
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error('the run never finished')
}

test('a follow-up message continues the same conversation with its context', async () => {
  const { server, seen } = modelServer(['first answer', 'second answer'])
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const llmPort = server.address().port
  const home = mkdtempSync(join(tmpdir(), 'uh-multi-'))
  mkdirSync(join(home, 'work'), { recursive: true })
  const uh = await startUh({ ...process.env, UH_HOME: home, UH_BASE_URL: `http://127.0.0.1:${llmPort}/v1`, UH_MODEL: 'mock' })

  try {
    await post('/api/settings', { provider: 'deepseek', model: 'mock', apiKey: 'sk-test' })

    const first = await post('/api/run', { task: 'remember the word pineapple' })
    assert.ok(first.sessionId, 'the first run must return a session id')
    const evs1 = await waitDone(home, first.sessionId)
    assert.equal(evs1.filter((e) => e.kind === 'turn/start').length, 1)

    const second = await post('/api/run', { task: 'what word did I say?', sessionId: first.sessionId })
    assert.equal(second.sessionId, first.sessionId, 'the follow-up must stay in the same session')
    assert.equal(second.continued, true, 'the server must say it continued')
    assert.equal(second.turn, 2, 'it is the second turn')

    const evs2 = await waitDone(home, first.sessionId, 2)
    const turns = evs2.filter((e) => e.kind === 'turn/start').map((e) => e.payload.turn_index)
    assert.deepEqual(turns, [1, 2], 'turn_index must increment inside one session')
    assert.equal(evs2.filter((e) => e.kind === 'session/start').length, 1, 'no second session may be opened')
    assert.ok(evs2.some((e) => e.kind === 'session/resumed'), 'the continuation must be recorded as a resume')

    // 上下文真的传过去了：第二轮请求里带着第一轮的用户原话
    const last = seen[seen.length - 1]
    const flat = JSON.stringify(last)
    assert.match(flat, /pineapple/, 'the second request must carry the first turn')
    assert.match(flat, /what word did I say/, 'and the new instruction')

    // 只有一条会话，且 state.json 里两问两答都在
    const projects = await get('/api/projects')
    const mine = projects.projects.find((p) => p.path === projects.current)
    assert.equal(mine.items.length, 1, 'one conversation, not two')

    const dir = sessionDir(home, first.sessionId)
    const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))
    const users = state.messages.filter((m) => m.role === 'user').map((m) => m.content)
    assert.ok(users.some((u) => /pineapple/.test(u)) && users.some((u) => /what word/.test(u)),
      'both questions must be in the saved state')
  } finally {
    uh.kill()
    server.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('a follow-up while the first turn is still running is refused, not queued twice', async () => {
  // 同一秒内会把 running 里的条目踩掉，所以这里只验证「忙的时候拒绝」这条线：
  // 用一个永远回 tool_call 的模型把第一轮挂住
  const server = http.createServer((req, res) => {
    if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[]}'); return }
    let b = ''
    req.on('data', (c) => (b += c))
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        model: 'mock',
        choices: [{
          message: { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'run_command', arguments: '{"argv":["node","-e","setTimeout(()=>{},20000)"]}' } }] },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      }))
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const home = mkdtempSync(join(tmpdir(), 'uh-busy-'))
  mkdirSync(join(home, 'work'), { recursive: true })
  const uh = await startUh({ ...process.env, UH_HOME: home, UH_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`, UH_MODEL: 'mock' })

  try {
    await post('/api/settings', { provider: 'deepseek', model: 'mock', apiKey: 'sk-test' })
    const first = await post('/api/run', { task: 'take your time' })
    const busy = await post('/api/run', { task: 'second thing', sessionId: first.sessionId })
    assert.ok(busy.error, 'a second turn on a running conversation must be refused')
    await post('/api/stop', { sessionId: first.sessionId })
  } finally {
    uh.kill()
    server.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('the folder picker lists directories, refuses escapes, and can create one', async () => {
  const home = mkdtempSync(join(tmpdir(), 'uh-fs-'))
  mkdirSync(join(home, 'projects', 'alpha'), { recursive: true })
  mkdirSync(join(home, 'projects', 'beta'), { recursive: true })
  const uh = await startUh({ ...process.env, UH_HOME: home })

  try {
    const top = await get('/api/fs?path=' + encodeURIComponent(home))
    assert.equal(top.path, home)
    assert.ok(Array.isArray(top.crumbs) && top.crumbs.length > 0, 'there must be a breadcrumb trail')
    assert.equal(top.crumbs[top.crumbs.length - 1].path, home)
    assert.ok(top.dirs.some((d) => d.name === 'projects'))

    const deep = await get('/api/fs?path=' + encodeURIComponent(join(home, 'projects')))
    assert.deepEqual(deep.dirs.map((d) => d.name).sort(), ['alpha', 'beta'])
    assert.equal(deep.parent, home, 'parent must be the folder above')

    // 不给路径 = 从家目录开始，且一定是绝对路径
    const noArg = await get('/api/fs')
    assert.ok(noArg.path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(noArg.path))

    const made = await post('/api/fs/mkdir', { path: join(home, 'projects'), name: 'gamma' })
    assert.equal(made.path, join(home, 'projects', 'gamma'))
    assert.ok(existsSync(made.path))

    const again = await post('/api/fs/mkdir', { path: join(home, 'projects'), name: 'gamma' })
    assert.ok(again.error, 'creating the same folder twice must be reported')

    // 名字里带分隔符 = 越界写文件，必须拒绝
    for (const name of ['../evil', 'a/b', '..', '']) {
      const bad = await post('/api/fs/mkdir', { path: join(home, 'projects'), name })
      assert.ok(bad.error, `"${name}" must be refused`)
    }
    assert.equal(existsSync(join(home, 'evil')), false)
  } finally {
    uh.kill()
    rmSync(home, { recursive: true, force: true })
  }
})
