/**
 * 对齐 Codex 的三件：审批三档、项目别名、账号登录。
 *
 * 账号这里不碰真的 unitai.site —— 拿 UH_UNITAI_BASE 指到本地桩，
 * 测的是「令牌怎么验证、怎么存、怎么登出」，不是对方服务。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(process.cwd(), 'dist', 'uh.cjs')
const PORT = 7941 + Math.floor(Math.random() * 40)

/** unitai.site 的桩：只认 good-token */
function accountStub() {
  return http.createServer((req, res) => {
    const auth = req.headers.authorization ?? ''
    if (req.url === '/api/auth/me') {
      if (auth !== 'Bearer good-token') {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        user: { id: 7, nickname: '老张', phone: '138****8000' },
        providers: ['sms'],
        membership: { active: true, expires_at: '2027-01-01' },
        email: '',
      }))
      return
    }
    res.writeHead(404)
    res.end('{}')
  })
}

function toolCallServer(argv) {
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
      const first = round++ === 0
      const body = first
        ? {
            model: 'mock',
            choices: [{
              message: {
                role: 'assistant', content: '',
                tool_calls: [{ id: 'c1', type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ argv }) } }],
              },
              finish_reason: 'tool_calls',
            }],
            usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 },
          }
        : {
            model: 'mock',
            choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
          }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    })
  })
}

function startServer(env) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [CLI, 'serve', '--port', String(PORT)], { env })
    let log = ''
    p.stdout.on('data', (d) => {
      log += d
      if (/http:\/\/127\.0\.0\.1:/.test(log)) resolve(p)
    })
    p.stderr.on('data', (d) => (log += d))
    setTimeout(() => reject(new Error('server did not start:\n' + log)), 15000)
  })
}

const get = async (p) => (await fetch('http://127.0.0.1:' + PORT + p)).json()
const post = async (p, body) =>
  (await fetch('http://127.0.0.1:' + PORT + p, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })).json()

/** 连 SSE 等某个事件，超时返回 null */
async function waitFor(sid, kind, timeoutMs = 9000) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetch('http://127.0.0.1:' + PORT + '/api/stream?session=' + encodeURIComponent(sid), { signal: ctl.signal })
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return null
      buf += dec.decode(value, { stream: true })
      const frames = buf.split('\n\n')
      buf = frames.pop() ?? ''
      for (const f of frames) {
        const ev = /^event: (.+)$/m.exec(f)
        const data = /^data: (.+)$/m.exec(f)
        if (ev && data && ev[1] === kind) { reader.cancel().catch(() => {}); return JSON.parse(data[1]) }
      }
    }
  } catch { return null } finally { clearTimeout(timer) }
}

test('approval has three modes and remembers the choice', async () => {
  const home = mkdtempSync(join(tmpdir(), 'uh-mode-'))
  const srv = await startServer({ ...process.env, UH_HOME: home })
  try {
    assert.equal((await get('/api/settings')).approval, 'ask', 'default must be ask')
    for (const mode of ['auto', 'allow', 'ask']) {
      const r = await post('/api/approval', { mode })
      assert.equal(r.ok, true)
      assert.equal((await get('/api/settings')).approval, mode, mode + ' must persist')
    }
    const bad = await post('/api/approval', { mode: 'yolo' })
    assert.ok(bad.error, 'an unknown mode must be refused')
  } finally {
    srv.kill()
    rmSync(home, { recursive: true, force: true })
  }
})

test('"approve for me" silently allows writes but still asks before destructive ones', async () => {
  // 写：沙箱兜得住 —— auto 档不该问
  for (const [argv, expectAsk] of [
    [['chmod', '700', 'x.txt'], false],
    [['chmod', '-R', '777', '.'], true],
  ]) {
    const llm = toolCallServer(argv)
    await new Promise((r) => llm.listen(0, '127.0.0.1', r))
    const llmPort = llm.address().port
    const home = mkdtempSync(join(tmpdir(), 'uh-auto-'))
    mkdirSync(join(home, 'work'), { recursive: true })
    const srv = await startServer({
      ...process.env, UH_HOME: home, UH_BASE_URL: `http://127.0.0.1:${llmPort}/v1`, UH_MODEL: 'mock',
    })
    try {
      await post('/api/settings', { provider: 'deepseek', model: 'mock', apiKey: 'sk-x' })
      await post('/api/approval', { mode: 'auto' })
      const { sessionId } = await post('/api/run', { task: 'go' })
      const asked = await waitFor(sessionId, 'approval/needs', 7000)
      assert.equal(Boolean(asked), expectAsk, argv.join(' ') + (expectAsk ? ' must ask' : ' must not ask'))
      if (asked) await post('/api/approve', { id: asked.id, approved: false })
    } finally {
      srv.kill()
      llm.close()
      rmSync(home, { recursive: true, force: true })
    }
  }
})

test('a project keeps a display name separate from its folder', async () => {
  const home = mkdtempSync(join(tmpdir(), 'uh-name-'))
  const srv = await startServer({ ...process.env, UH_HOME: home })
  try {
    const dir = join(home, 'code', 'ugly-dir-name')
    const saved = await post('/api/project', { path: dir, name: 'Alpha Shop' })
    assert.equal(saved.name, 'Alpha Shop')

    const list = await get('/api/projects')
    const mine = list.projects.find((p) => p.path === dir)
    assert.equal(mine.name, 'Alpha Shop', 'the alias must come back on the list')
    assert.equal(mine.path, dir, 'and the folder must not move')

    // 清空名字 = 回到文件夹名
    await post('/api/project', { path: dir, name: '' })
    const again = await get('/api/projects')
    assert.equal(again.projects.find((p) => p.path === dir).name, '')
  } finally {
    srv.kill()
    rmSync(home, { recursive: true, force: true })
  }
})

test('signing in stores the token 0600, and a bad token is refused', async () => {
  const stub = accountStub()
  await new Promise((r) => stub.listen(0, '127.0.0.1', r))
  const stubPort = stub.address().port
  const home = mkdtempSync(join(tmpdir(), 'uh-acct-'))
  const srv = await startServer({
    ...process.env, UH_HOME: home, UH_UNITAI_BASE: `http://127.0.0.1:${stubPort}`,
  })
  try {
    assert.equal((await get('/api/account')).signedIn, false)

    const bad = await post('/api/account/token', { token: 'nope' })
    assert.ok(bad.error, 'a rejected token must not be stored')
    assert.equal(existsSync(join(home, 'account.json')), false)

    const ok = await post('/api/account/token', { token: 'good-token' })
    assert.equal(ok.ok, true)
    assert.equal(ok.user.nickname, '老张')
    assert.equal(ok.membership.active, true, 'membership comes back so the UI can show it')

    const file = join(home, 'account.json')
    if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600)

    const me = await get('/api/account')
    assert.equal(me.signedIn, true)
    assert.equal(me.user.nickname, '老张')

    await post('/api/account/logout', {})
    assert.equal((await get('/api/account')).signedIn, false)
    assert.equal(existsSync(file), false, 'logout must remove the token')
  } finally {
    srv.kill()
    stub.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('an unreachable unitai.site keeps you signed in instead of kicking you out', async () => {
  const home = mkdtempSync(join(tmpdir(), 'uh-off-'))
  // 指向一个必然连不上的地址：令牌还在，只是这次问不到
  const srv = await startServer({
    ...process.env, UH_HOME: home, UH_UNITAI_BASE: 'http://127.0.0.1:1',
  })
  try {
    // 先写一个令牌（用一个活的桩验一次，再改指到死地址）
    const stub = accountStub()
    await new Promise((r) => stub.listen(0, '127.0.0.1', r))
    const port = stub.address().port
    srv.kill()

    const srv2 = await startServer({
      ...process.env, UH_HOME: home, UH_UNITAI_BASE: `http://127.0.0.1:${port}`,
    })
    await post('/api/account/token', { token: 'good-token' })
    srv2.kill()
    stub.close()

    const srv3 = await startServer({ ...process.env, UH_HOME: home, UH_UNITAI_BASE: 'http://127.0.0.1:1' })
    const me = await get('/api/account')
    assert.equal(me.signedIn, true, 'a network blip must not sign you out')
    assert.equal(me.offline, true)
    srv3.kill()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('running without a usable model says so instead of pretending to start', async () => {
  const home = mkdtempSync(join(tmpdir(), 'uh-nomodel-'))
  const srv = await startServer({ ...process.env, UH_HOME: home })
  try {
    // 1) 全新：连 provider 都没选过
    const r1 = await post('/api/run', { task: 'hello' })
    assert.ok(r1.error, 'a run with no model must be refused')
    assert.equal(r1.needsSetup, true, 'and must tell the UI to open settings')
    assert.equal(r1.sessionId, undefined, 'nothing may be started')

    // 2) 选了 provider 和模型，但没 key
    await post('/api/settings', { provider: 'deepseek', model: 'deepseek-v4-flash' })
    const r2 = await post('/api/run', { task: 'hello' })
    assert.ok(r2.error)
    assert.match(r2.error, /API key/, 'the message must name the actual missing piece')

    // 3) 本地服务不需要 key —— 不能因为没 key 就把 ollama 拦掉
    await post('/api/settings', { provider: 'ollama', model: 'qwen3:8b' })
    const r3 = await post('/api/run', { task: 'hello' })
    assert.equal(r3.needsSetup, undefined, 'a local provider with no key must be allowed to start')
    assert.ok(r3.sessionId, 'the run must be accepted')
    await post('/api/stop', { sessionId: r3.sessionId })
  } finally {
    srv.kill()
    rmSync(home, { recursive: true, force: true })
  }
})
