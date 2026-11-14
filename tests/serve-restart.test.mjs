/**
 * 端口被上一版自己占着时怎么办。
 *
 * 改了代码、重建了 dist，桌面端看到的还是旧界面——原因几乎总是 7878 上还跑着
 * 上一次的 `uh serve`，新进程 listen 失败、退出，窗口连的还是老进程。所以这里
 * 只做两件事：把话说清楚（谁占着、该怎么修），以及在明确要求时接管它。
 *
 * 同时钉住那条底线：**端口上如果不是 UnitHarness，--force 也不许杀**。
 * 误杀用户的其他服务，比多看一次报错贵得多。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(process.cwd(), 'dist', 'uh.cjs')

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer()
  s.once('error', reject)
  s.listen(0, '127.0.0.1', () => {
    const p = s.address().port
    s.close(() => resolve(p))
  })
})

/** 起一个 uh serve，等到它报出 URL 才算就绪 */
function serve(port, extra = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, 'serve', '--port', String(port), ...extra], {
      env: process.env,
    })
    let log = ''
    let stderr = ''
    const timer = setTimeout(() => reject(new Error('serve did not report a URL:\n' + log + stderr)), 15000)
    child.stdout.on('data', (d) => {
      log += d
      if (/UnitHarness UI\s+http/.test(log)) { clearTimeout(timer); resolve({ child, log, getStderr: () => stderr }) }
    })
    child.stderr.on('data', (d) => {
      log += d
      stderr += d
    })
  })
}

/** 跑一次会自己退出的 serve，拿到退出码与输出 */
function serveOnce(port, extra = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, 'serve', '--port', String(port), ...extra], { env: process.env })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve({ code: null, out }) }, 20000)
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, out }) })
  })
}

/** 端口刚换手时第一次连接可能拿到 ECONNRESET（旧 socket 正在收尾），多试几次 */
async function alive(port) {
  for (let i = 0; i < 5; i++) {
    const ok = await fetch(`http://127.0.0.1:${port}/api/info`).then((r) => r.ok).catch(() => false)
    if (ok) return true
    await new Promise((r) => setTimeout(r, 200))
  }
  return false
}

test('a second serve explains who owns the port, and --force takes it back', {
  // Windows 上的接管走 taskkill，本机没有真机验证过，不假装它被测过
  skip: process.platform === 'win32' ? 'takeover uses taskkill on windows — unverified there' : false,
}, async () => {
  const home = mkdtempSync(join(tmpdir(), 'uh-restart-'))
  const port = await freePort()
  const env = process.env.UH_HOME
  process.env.UH_HOME = home
  let first = null
  let second = null
  try {
    first = await serve(port)
    assert.equal(await alive(port), true)

    // 不带 --force：必须失败，并且说清是谁、怎么修
    const dup = await serveOnce(port)
    assert.equal(dup.code, 1, 'a second serve must fail, not hang or silently attach')
    assert.match(dup.out, /already served by UnitHarness \(pid \d+\)/)
    assert.match(dup.out, /--force/, 'the message must name the way out')
    assert.equal(await alive(port), true, 'the first instance must still be serving')

    // 带 --force：接管，旧进程退出
    second = await serve(port, ['--force'])
    assert.match(second.log, /stopped the previous UnitHarness on port \d+ \(pid \d+\)/)
    const gone = await new Promise((resolve) => {
      // 被信号杀掉时 exitCode 仍然是 null（只有 signalCode 有值），
      // 只看 exitCode 会把「已经退了」判成「还活着」
      if (first.child.exitCode !== null || first.child.signalCode !== null) return resolve(true)
      const t = setTimeout(() => resolve(false), 8000)
      first.child.once('exit', () => { clearTimeout(t); resolve(true) })
    })
    assert.equal(gone, true, 'the process that was taken over must actually exit')
    assert.equal(await alive(port), true, 'the new instance must be serving')
  } finally {
    for (const s of [second, first]) {
      if (!s) continue
      try { s.child.kill('SIGKILL') } catch { /* already gone */ }
    }
    if (env === undefined) delete process.env.UH_HOME
    else process.env.UH_HOME = env
    rmSync(home, { recursive: true, force: true })
  }
})

test('--force refuses to kill something that is not UnitHarness', {
  skip: process.platform === 'win32' ? 'who-owns-the-port probing differs on windows' : false,
}, async () => {
  const home = mkdtempSync(join(tmpdir(), 'uh-restart2-'))
  const port = await freePort()
  // 先占住端口：一个普通的 HTTP 服务，不是我们的
  // 没有 error 监听时，客户端一断就是未捕获的 ECONNRESET，整个测试文件挂掉
  const squatter = net.createServer((sock) => {
    sock.on('error', () => { /* client went away */ })
    sock.end('HTTP/1.0 200 OK\r\n\r\nhi')
  })
  await new Promise((r) => squatter.listen(port, '127.0.0.1', r))

  const env = process.env.UH_HOME
  process.env.UH_HOME = home
  try {
    const res = await serveOnce(port, ['--force'])
    assert.equal(res.code, 1, 'it must refuse rather than take over')
    assert.match(res.out, /is taken by something that is not UnitHarness/)
    assert.match(res.out, /refusing to kill it/)
    // 占位者还活着
    const sock = await new Promise((resolve) => {
      const c = net.connect(port, '127.0.0.1', () => resolve(c))
      c.on('error', () => resolve(null))
    })
    assert.ok(sock, 'the other service must still be running')
    sock.destroy()
  } finally {
    await new Promise((r) => squatter.close(r))
    if (env === undefined) delete process.env.UH_HOME
    else process.env.UH_HOME = env
    rmSync(home, { recursive: true, force: true })
  }
})
