/**
 * 手机能打开网页版的前提：绑到非 loopback 时必须带口令。
 *
 * 这个端口后面是一个能跑 shell 的 agent。以前 `--host 0.0.0.0` 一开，同一个
 * Wi-Fi 里的任何人（包括隔壁工位那台连了公共网络的机器）都能直接
 * POST /api/run 让它在你的工作区里干活。所以：
 *
 *   - 没有口令 → 401，接口一个都不给；
 *   - 「装成 app」用得到的静态件（manifest / 图标 / sw）放行，否则手机上
 *     连安装提示都出不来；
 *   - 第一次带 ?t= 进来 → 种 cookie + 302 把口令从地址栏抹掉（它不该留在
 *     历史记录和截图里）；
 *   - 口令存在 $UH_HOME/serve-token，权限 0600。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import os from 'node:os'
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(process.cwd(), 'dist', 'uh.cjs')

/**
 * 「手机」怎么模拟：从本机连自己的局域网地址，对端就不是 127.0.0.1 了。
 * 鉴权现在按对端地址判断（本机免口令、外面必须带口令），所以测试不能再用
 * localhost 假装是手机——那一路现在是故意放行的。
 */
function phoneAddr() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const n of list ?? []) {
      if (n.family === 'IPv4' && !n.internal && !/^172\.(1[7-9]|2\d|3[01])\./.test(n.address)) return n.address
    }
  }
  return ''
}

async function waitUp(port, home) {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/manifest.webmanifest`)
      if (r.ok) return
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error('server did not come up on ' + port + ' (home=' + home + ')')
}

test('a non-loopback server demands a token, and remembers it as a cookie', async (t) => {
  const phone = phoneAddr()
  if (!phone) {
    t.skip('这台机器没有局域网地址，无法模拟手机连进来')
    return
  }
  const home = mkdtempSync(join(tmpdir(), 'uh-serve-'))
  const port = 7930 + Math.floor(Math.random() * 40)
  const child = spawn(process.execPath, [CLI, 'serve', '--port', String(port), '--lan'], {
    env: { ...process.env, UH_HOME: home, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout.on('data', (d) => (out += String(d)))
  child.stderr.on('data', (d) => (out += String(d)))

  try {
    await waitUp(port, home)

    // 1. 口令文件真的落盘了，而且只有本人能读
    const tokenFile = join(home, 'serve-token')
    assert.ok(existsSync(tokenFile), 'the token must be written to $UH_HOME/serve-token')
    const mode = statSync(tokenFile).mode & 0o777
    assert.equal(mode, 0o600, 'the token file must not be world-readable, got ' + mode.toString(8))
    const token = readFileSync(tokenFile, 'utf8').trim()
    assert.ok(token.length >= 20, 'token looks too short')

    // 2. 没有口令：接口 401，静态件放行（否则手机上装不出图标）
    const LAN = `http://${phone}:${port}`
    const api = await fetch(`${LAN}/api/info`)
    assert.equal(api.status, 401)
    const man = await fetch(`${LAN}/manifest.webmanifest`)
    assert.equal(man.status, 200)
    const manifest = await man.json()
    const sizes = (manifest.icons ?? []).map((i) => i.sizes)
    assert.ok(sizes.includes('192x192') && sizes.includes('512x512'), 'Chrome wants both sizes: ' + sizes)
    assert.equal(manifest.display, 'standalone')

    const icon = await fetch(`${LAN}/icon-192.png`)
    assert.equal(icon.status, 200)
    const png = Buffer.from(await icon.arrayBuffer())
    assert.equal(png.subarray(1, 4).toString(), 'PNG', 'the icon must be a real PNG')

    // 3. 带口令：种 cookie，并把口令从地址栏抹掉
    const first = await fetch(`${LAN}/?t=${token}`, { redirect: 'manual' })
    assert.equal(first.status, 302)
    const cookie = first.headers.get('set-cookie') ?? ''
    assert.ok(cookie.includes('uh_t='), 'a cookie must be set: ' + cookie)
    assert.ok(cookie.includes('HttpOnly'), 'the cookie must be HttpOnly')
    assert.equal(first.headers.get('location'), '/', 'the token must be stripped from the URL')

    // 4. 之后靠 cookie 就能用
    const withCookie = await fetch(`${LAN}/api/info`, {
      headers: { cookie: 'uh_t=' + token },
    })
    assert.equal(withCookie.status, 200)

    // 5. 启动横幅里要能直接抄走地址（手机第一步就是打开它）
    assert.match(out, /http:\/\/\d+\.\d+\.\d+\.\d+:\d+\/\?t=/, 'the banner must print a ready URL:\n' + out)
  } finally {
    child.kill('SIGKILL')
    rmSync(home, { recursive: true, force: true })
  }
})

test('a loopback server stays tokenless — localhost is you', async () => {
  const home = mkdtempSync(join(tmpdir(), 'uh-serve2-'))
  const port = 7990 + Math.floor(Math.random() * 40)
  const child = spawn(process.execPath, [CLI, 'serve', '--port', String(port)], {
    env: { ...process.env, UH_HOME: home, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  try {
    await waitUp(port, home)
    const r = await fetch(`http://127.0.0.1:${port}/api/info`)
    assert.equal(r.status, 200, 'localhost must not ask for a token')
    // 口令文件是启动时就准备好的：设置页里一开远程，下一次请求就要用它，
    // 不能等到那时候再临时生成。本机访问不校验它，但它必须在且只有本人能读。
    const tf = join(home, 'serve-token')
    assert.ok(existsSync(tf), 'the token is prepared even while listening on loopback')
    assert.equal(statSync(tf).mode & 0o777, 0o600)
  } finally {
    child.kill('SIGKILL')
    rmSync(home, { recursive: true, force: true })
  }
})
