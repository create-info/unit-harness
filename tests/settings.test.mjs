/**
 * 桌面端的设置面：换 provider、换模型、换项目。
 *
 * 这几件事在 CLI 里都有（uh provider / uh config set），但桌面端之前只能看不能改——
 * 「支持 12 家 provider」在 UI 里等于不支持。这里测的是那层缺失的胶水。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, statSync, rmSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(process.cwd(), 'dist', 'uh.cjs')
const PORT = 7911 + Math.floor(Math.random() * 80)

function startServer(env) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [CLI, 'serve', '--port', String(PORT)], { env })
    let log = ''
    p.stdout.on('data', (d) => {
      log += d
      if (/http:\/\/127\.0\.0\.1:/.test(log)) resolve(p)
    })
    p.stderr.on('data', (d) => (log += d))
    p.on('close', (c) => reject(new Error('server exited: ' + c + '\n' + log)))
    setTimeout(() => reject(new Error('server did not start:\n' + log)), 15000)
  })
}

const get = async (p) => (await fetch('http://127.0.0.1:' + PORT + p)).json()
const post = async (p, body) =>
  (await fetch('http://127.0.0.1:' + PORT + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })).json()

test('settings expose every provider, save a key masked, and keep it off disk in the clear', async () => {
  const home = mkdtempSync(join(tmpdir(), 'uh-set-'))
  const env = { ...process.env, UH_HOME: home }
  const srv = await startServer(env)

  try {
    const s = await get('/api/settings')
    // 前端不该写死任何一家：注册表里有几家就返回几家
    assert.ok(s.providers.length >= 12, 'all providers must be offered, got ' + s.providers.length)
    assert.ok(s.providers.some((p) => p.id === 'anthropic' && p.protocol === 'anthropic'))
    assert.ok(s.providers.some((p) => p.local === true), 'local providers must be flagged')
    assert.equal(s.hasKey, false)
    assert.ok(s.workspace, 'the UI needs to know where it is running')

    const saved = await post('/api/settings', {
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      apiKey: 'sk-ant-secret-value-4321',
    })
    assert.equal(saved.ok, true)

    const after = await get('/api/settings')
    assert.equal(after.provider, 'anthropic')
    assert.equal(after.model, 'claude-sonnet-4-5')
    assert.equal(after.hasKey, true)
    // 读回来的 key 必须打码：这条 API 会被浏览器缓存、被截图
    assert.equal(after.keyMasked.includes('secret-value'), false, 'the masked form must not carry the key')
    assert.match(after.keyMasked, /…/)

    // 配置文件 0600
    const cfgPath = join(home, 'config.json')
    assert.equal(statSync(cfgPath).mode & 0o777, 0o600, 'config.json must be 0600')
    assert.ok(readFileSync(cfgPath, 'utf8').includes('sk-ant-secret-value-4321'), 'the key itself is stored')

    // 换 provider 之后再读，选中项要跟着变
    await post('/api/settings', { provider: 'openai', model: 'gpt-5' })
    const third = await get('/api/settings')
    assert.equal(third.provider, 'openai')
    assert.equal(third.model, 'gpt-5', 'a key set earlier must not be clobbered by a model-only save')
    assert.equal(third.keyMasked, '', 'openai has no key yet')

    const bad = await post('/api/settings', { provider: 'not-a-provider' })
    assert.ok(bad.error, 'an unknown provider must be refused')
  } finally {
    srv.kill()
    rmSync(home, { recursive: true, force: true })
  }
})

test('the workspace can be switched and becomes the sandbox root', async () => {
  const home = mkdtempSync(join(tmpdir(), 'uh-proj-'))
  const env = { ...process.env, UH_HOME: home }
  const srv = await startServer(env)

  try {
    const before = await get('/api/projects')
    assert.ok(before.current, 'there is always a current project')

    const target = join(home, 'code', 'demo')
    const moved = await post('/api/project', { path: target })
    assert.equal(moved.current, target)
    assert.ok(existsSync(target), 'switching to a new path must create it')

    const info = await get('/api/info')
    assert.equal(info.workspace, target, 'runs must use the chosen workspace')

    const rel = await post('/api/project', { path: 'relative/dir' })
    assert.ok(rel.error, 'a relative path is ambiguous — refuse it')

    // ~ 展开
    const tilde = await post('/api/project', { path: '~/unit-harness-tmp-proj' })
    assert.ok(tilde.current && tilde.current.startsWith('/'), '~ must expand to an absolute path')
    rmSync(tilde.current, { recursive: true, force: true })
  } finally {
    srv.kill()
    rmSync(home, { recursive: true, force: true })
  }
})

test('listing models degrades instead of throwing when the key is wrong', async () => {
  const home = mkdtempSync(join(tmpdir(), 'uh-models-'))
  const env = { ...process.env, UH_HOME: home }
  const srv = await startServer(env)

  try {
    await post('/api/settings', { provider: 'deepseek', apiKey: 'sk-invalid-000' })
    const r = await get('/api/models?provider=deepseek')
    // 401 是正常结果：用户还没填对 key。UI 要能显示「列不出来」而不是白屏
    assert.ok(Array.isArray(r.models))
    assert.equal(r.models.length, 0)
    assert.ok(r.error, 'the reason must be surfaced')

    const unknown = await get('/api/models?provider=nope')
    assert.ok(unknown.error)
  } finally {
    srv.kill()
    rmSync(home, { recursive: true, force: true })
  }
})

test('sessions are grouped under their project, which is what the sidebar draws', async () => {
  const home = mkdtempSync(join(tmpdir(), 'uh-grp-'))
  const env = { ...process.env, UH_HOME: home }
  const srv = await startServer(env)
  const a = join(home, 'proj-a')
  const b = join(home, 'proj-b')

  try {
    await post('/api/project', { path: a })
    const ra = await post('/api/run', { task: 'task in a' })
    await new Promise((r) => setTimeout(r, 400))
    await post('/api/project', { path: b })
    const rb = await post('/api/run', { task: 'task in b' })
    await new Promise((r) => setTimeout(r, 400))

    const projects = await get('/api/projects')
    assert.equal(projects.current, b)
    const pa = projects.projects.find((x) => x.path === a)
    const pb = projects.projects.find((x) => x.path === b)
    assert.ok(pa && pb, 'both projects must be listed')
    // 左栏是「项目 → 会话」两级：会话必须挂在它自己的项目下面
    assert.ok(Array.isArray(pa.items) && Array.isArray(pb.items))
    assert.equal(pa.items.some((i) => i.id === ra.sessionId), true, 'a\'s session belongs to a')
    assert.equal(pb.items.some((i) => i.id === rb.sessionId), true, 'b\'s session belongs to b')
    assert.equal(pa.items.some((i) => i.id === rb.sessionId), false, 'and not to the other project')

    const onlyA = await get('/api/sessions?workspace=' + encodeURIComponent(a))
    assert.ok(onlyA.every((s) => s.workspace === a), 'filtering by workspace must actually filter')
    assert.equal(onlyA.some((s) => s.id === rb.sessionId), false)
  } finally {
    srv.kill()
    rmSync(home, { recursive: true, force: true })
  }
})
