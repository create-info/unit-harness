/**
 * 口令页：手机上打开 0.0.0.0 监听时，得有一个能输口令的地方。
 *
 * 用户的原话是「我这个现在怎么需要一个口令，你这什么东西」——他看到的是
 * 一句「口令在启动它的那台机器上：~/.uh/serve-token」。在手机上这句话等于
 * 死路：手机不是那台机器，也没法 cat 文件。所以那页必须能直接输、
 * 输对了就种 cookie 进去，输错要明确说错。
 *
 * 同时钉住一条安全底线：口令页不走 cookie 鉴权，但它自己必须验证口令，
 * 而且口令不能出现在返回的 HTML 里（页面会被投屏、被截图）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import net from 'node:net'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(process.cwd(), 'dist', 'uh.cjs')

/** 真找一个空端口：写死 8100+random 会撞上别的测试、别的进程（这台机器上
 *  8105 就长期被另一个服务占着），一撞就是 12 秒超时，看起来像代码坏了 */
async function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port
      s.close(() => resolve(port))
    })
  })
}

async function waitUp(port) {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/manifest.webmanifest`)
      if (r.ok) return
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error('server did not come up on ' + port)
}

test('the lock page takes a password in a form, and remembers it as a cookie', async () => {
  const home = mkdtempSync(join(tmpdir(), 'uh-unlock-'))
  const port = await freePort()
  const child = spawn(process.execPath, [CLI, 'serve', '--port', String(port), '--lan'], {
    env: { ...process.env, UH_HOME: home, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout.on('data', (d) => (out += String(d)))

  try {
    await waitUp(port)
    const token = readFileSync(join(home, 'serve-token'), 'utf8').trim()
    const base = `http://127.0.0.1:${port}`

    // 1. 无口令时拿到的是「能输口令」的页面，不是一句叫你去 cat 文件
    const lock = await fetch(base + '/')
    assert.equal(lock.status, 401)
    const html = await lock.text()
    assert.match(html, /<form[^>]+action="\/__unlock"/, 'the lock page must offer a form')
    assert.match(html, /name="t"/, 'there must be an input for the password')
    assert.ok(!html.includes(token), 'the token itself must never be printed on the page')

    // 2. 输错 → 401，而且还在这一页
    const bad = await fetch(base + '/__unlock', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ t: 'not-the-token' }).toString(),
      redirect: 'manual',
    })
    assert.equal(bad.status, 401)
    assert.match(await bad.text(), /口令不对/, 'a wrong password must say so')

    // 3. 输对 → 303 + cookie
    const good = await fetch(base + '/__unlock', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ t: token }).toString(),
      redirect: 'manual',
    })
    assert.equal(good.status, 303)
    const cookie = good.headers.get('set-cookie') ?? ''
    assert.match(cookie, /uh_t=/, 'it must set the cookie')
    assert.match(cookie, /HttpOnly/, 'the cookie must not be readable by scripts')

    // 4. 带着这个 cookie 就能进
    const withCookie = await fetch(base + '/api/plugins', { headers: { cookie: cookie.split(';')[0] } })
    assert.equal(withCookie.status, 200)

    // 5. 没有 cookie 还是进不去（表单口不能被当成后门）
    const again = await fetch(base + '/api/plugins')
    assert.equal(again.status, 401)
  } finally {
    child.kill('SIGKILL')
    rmSync(home, { recursive: true, force: true })
  }
})
