/**
 * 电脑操控：这一层碰的是真实桌面，不在沙箱里。
 *
 * 两条规矩：① 能不能做先探测再说，没工具就如实报不可用——列一个"支持点击"
 * 然后点了没反应，比不支持更糟；② 开关必须落在执行路径上，关掉之后截图端点
 * 要真的拒绝，而不是界面上变灰、接口照给。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(process.cwd(), 'dist', 'uh.cjs')
const PORT = 7861 + Math.floor(Math.random() * 50)

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
    setTimeout(() => reject(new Error('server did not start:\n' + log)), 15_000)
  })
}

const get = async (p) => (await fetch('http://127.0.0.1:' + PORT + p)).json()
const post = async (p, body) =>
  (await fetch('http://127.0.0.1:' + PORT + p, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })).json()

test('it reports what this machine can actually do, and says how to fix what it cannot', async () => {
  const home = mkdtempSync(join(tmpdir(), 'uh-comp-'))
  const srv = await startServer({ ...process.env, UH_HOME: home })
  try {
    const c = await get('/api/computer')

    // 能力探测必须分开报：能看不能动，和完全不行，是两件事
    assert.equal(typeof c.screenshots.available, 'boolean')
    assert.equal(typeof c.control.available, 'boolean')
    assert.ok(['x11', 'wayland', 'none'].includes(c.session))

    // 做不到的时候要给名字，不是给一个灰按钮
    if (!c.screenshots.available) assert.equal(c.screenshots.tool, '')
    if (!c.control.available) assert.ok(c.control.need === 'xdotool' || c.control.need === 'ydotool')

    // 这一层不受沙箱约束，状态里不能声称它有隔离
    assert.equal(c.isolation, 'none')
    assert.equal(c.external, true)
  } finally {
    srv.kill()
    rmSync(home, { recursive: true, force: true })
  }
})

test('turning screen capture off actually stops it serving screenshots', async () => {
  const home = mkdtempSync(join(tmpdir(), 'uh-comp2-'))
  const srv = await startServer({ ...process.env, UH_HOME: home })
  try {
    await post('/api/computer/toggle', { field: 'screenshots', value: false })
    const after = await get('/api/computer')
    assert.equal(after.screenshotsEnabled, false, 'the state has to come back, or a reload shows it wrong')

    const r = await fetch('http://127.0.0.1:' + PORT + '/api/computer/shot.png')
    assert.equal(r.status, 403,
      'a switch that greys out the UI but still serves the data is worse than no switch')
  } finally {
    srv.kill()
    rmSync(home, { recursive: true, force: true })
  }
})

test('with no display at all it refuses instead of returning a blank image', async () => {
  const home = mkdtempSync(join(tmpdir(), 'uh-comp3-'))
  const env = { ...process.env, UH_HOME: home }
  // 模拟没有图形会话：不传 DISPLAY / WAYLAND_DISPLAY
  delete env.DISPLAY
  delete env.WAYLAND_DISPLAY
  const srv = await startServer(env)
  try {
    const c = await get('/api/computer')
    assert.equal(c.session, 'none')
    assert.equal(c.screenshots.available, false, 'no display means no capture, not "probably fine"')

    const r = await fetch('http://127.0.0.1:' + PORT + '/api/computer/shot.png')
    assert.equal(r.status, 403, 'a blank PNG would look like a black screen and send people hunting')
  } finally {
    srv.kill()
    rmSync(home, { recursive: true, force: true })
  }
})
