/**
 * 设置 → 远程访问：不离开界面就能配对、查看、撤销。
 *
 * 为什么要有这一页：用户的原话是「这个功能不仅可以放在命令行，还可以放到
 * 设置里面，类似 Codex 的集成」。手机上配对完才发现要撤销，还得回电脑敲
 * `uh devices` / `uh unpair`——人不在电脑前面就办不到。
 *
 * 顺带钉住一条：口令只回给已经进门的人（/api/remote 走鉴权），
 * 而且绝不能出现在没有口令时返回的页面上。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import net from 'node:net'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os, { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(process.cwd(), 'dist', 'uh.cjs')

/** 从本机连自己的局域网地址 = 站在手机那一侧；127.0.0.1 是被故意放行的 */
function phoneAddr() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const n of list ?? []) {
      if (n.family === 'IPv4' && !n.internal && !/^172\.(1[7-9]|2\d|3[01])\./.test(n.address)) return n.address
    }
  }
  return ''
}

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
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error('server did not come up on ' + port)
}

test('the remote page lists, pairs and revokes devices without the CLI', async (t) => {
  const phone = phoneAddr()
  if (!phone) {
    t.skip('这台机器没有局域网地址，无法模拟手机连进来')
    return
  }
  const home = mkdtempSync(join(tmpdir(), 'uh-remote-'))
  const port = await freePort()
  const child = spawn(process.execPath, [CLI, 'serve', '--port', String(port), '--lan'], {
    env: { ...process.env, UH_HOME: home, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  try {
    await waitUp(port)
    const token = readFileSync(join(home, 'serve-token'), 'utf8').trim()
    const base = `http://${phone}:${port}`
    const auth = { cookie: `uh_t=${token}`, 'content-type': 'application/json' }

    // 1. 没口令进不来——这一页会显示口令
    assert.equal((await fetch(base + '/api/remote')).status, 401)

    // 2. 读状态：--lan 时是「局域网内可连」，且给出手机能打开的完整地址
    const st = await (await fetch(base + '/api/remote', { headers: auth })).json()
    assert.equal(st.loopback, false, 'serve --lan is not loopback-only')
    assert.equal(st.port, port)
    assert.ok(Array.isArray(st.devices))
    assert.ok(typeof st.token === 'string' && st.token.length > 0, 'the page can show a copyable url')
    assert.ok(['absent', 'logged-out', 'up'].includes(st.tailscale.state), 'tailscale state is explicit')

    // 3. 配对：返回一次性地址（把它发到手机上打开即可）
    const made = await (await fetch(base + '/api/remote/device', {
      method: 'POST', headers: auth, body: JSON.stringify({ name: '我的 iPhone' }),
    })).json()
    assert.equal(made.name, '我的 iPhone')
    assert.match(made.url, /\?t=uhp_/)

    const after = await (await fetch(base + '/api/remote', { headers: auth })).json()
    assert.equal(after.devices.length, 1)
    assert.equal(after.devices[0].name, '我的 iPhone')

    // 4. 用这个设备令牌能进门（和口令是两条独立的路）
    const dev = await fetch(base + '/api/plugins', { headers: { cookie: `uh_t=${made.token}` } })
    assert.equal(dev.status, 200, 'a paired device token opens the door')

    // 5. 撤销后这个令牌立刻失效
    const rev = await (await fetch(base + '/api/remote/revoke', {
      method: 'POST', headers: auth, body: JSON.stringify({ id: made.id }),
    })).json()
    assert.equal(rev.id, made.id)
    const gone = await fetch(base + '/api/plugins', { headers: { cookie: `uh_t=${made.token}` } })
    assert.equal(gone.status, 401, 'a revoked device cannot get back in')

    // 6. 配对二维码：服务端出 PNG（页面不引 QR 库），扫的就是上面那个地址
    const qr = await fetch(base + '/api/remote/qr?t=' + encodeURIComponent(made.url), { headers: auth })
    assert.equal(qr.status, 200)
    assert.equal(qr.headers.get('content-type'), 'image/png')
    const png = Buffer.from(await qr.arrayBuffer())
    assert.equal(png.subarray(1, 4).toString(), 'PNG', 'a real PNG, not an empty body')

    // 7. 撤一个不存在的要明确 404，不能假装成功
    const bad = await fetch(base + '/api/remote/revoke', {
      method: 'POST', headers: auth, body: JSON.stringify({ id: made.id }),
    })
    assert.equal(bad.status, 404)
  } finally {
    child.kill('SIGKILL')
    rmSync(home, { recursive: true, force: true })
  }
})
