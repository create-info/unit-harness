/**
 * 远程访问只有一档端口（7878），开关在设置页里改，改完就地换绑。
 *
 * 为什么值得钉住：以前「给手机用」要另起一个 --lan 进程占另一个端口，
 * 于是会话和审批状态分家、用户要记两个地址。现在必须证明两件事：
 *   1. 换绑之后端口号不变，桌面端 127.0.0.1 仍然不用输口令；
 *   2. 关掉之后端口真的不再对外，不是只把界面上的字改了。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import net from 'node:net'
import os from 'node:os'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(process.cwd(), 'dist', 'uh.cjs')

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

/** 手机上真能连的那块网卡地址；容器里可能一个都没有 */
function lanAddr() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const n of list ?? []) {
      if (n.family === 'IPv4' && !n.internal && !/^172\.(1[7-9]|2\d|3[01])\./.test(n.address)) return n.address
    }
  }
  return ''
}

async function waitUp(port) {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/manifest.webmanifest`)).ok) return
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error('server did not come up on ' + port)
}

const code = async (url, init) => (await fetch(url, init)).status

test('one port: switching remote access rebinds in place, and off really closes it', async () => {
  const home = mkdtempSync(join(tmpdir(), 'uh-mode-'))
  const port = await freePort()
  const child = spawn(process.execPath, [CLI, 'serve', '--port', String(port)], {
    env: { ...process.env, UH_HOME: home, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  try {
    await waitUp(port)
    const base = `http://127.0.0.1:${port}`

    // 1. 默认状态：只听本机，桌面端不需要口令
    const st0 = await (await fetch(base + '/api/remote')).json()
    assert.equal(st0.mode, 'off')
    assert.equal(st0.loopback, true)
    // 「关闭」时列出来的只可能是域名转发那条（https）；不会给裸 IP 端口。
    // 这台机器上有没有真开 tailscale serve 都不影响这条断言。
    assert.ok(st0.urls.every((u) => u.startsWith('https://')), 'off: 不给裸 IP 地址，实际是 ' + JSON.stringify(st0.urls))

    const lan = lanAddr()

    // 2. 切到局域网：端口号不变，桌面端照样免口令
    const set = await fetch(base + '/api/remote/mode', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'lan' }),
    })
    assert.equal(set.status, 200)
    await new Promise((r) => setTimeout(r, 600)) // 服务端关掉再重听

    const st1 = await (await fetch(base + '/api/remote')).json()
    assert.equal(st1.mode, 'lan')
    assert.equal(st1.port, port, '换绑不改端口')
    assert.ok(st1.urls.length > 0, 'lan: 至少有一个手机能用的地址')
    assert.equal(await code(base + '/api/plugins'), 200, '本机访问仍然免口令')

    if (lan) {
      // 3. 局域网来的请求要口令——开远程不能等于开大门
      assert.equal(await code(`http://${lan}:${port}/api/plugins`), 401)
      // 4. 仅 Tailscale：同一块网卡的请求被挡在门外（这台测试机没有 tailnet 地址）
      await fetch(base + '/api/remote/mode', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'tailnet' }),
      })
      await new Promise((r) => setTimeout(r, 600))
      assert.equal(await code(`http://${lan}:${port}/api/plugins`), 403, 'tailnet 模式只认 100.64/10')
    }

    // 5. 关掉之后端口真的不再对外
    await fetch(base + '/api/remote/mode', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'off' }),
    })
    await new Promise((r) => setTimeout(r, 600))
    if (lan) {
      let refused = false
      try { await fetch(`http://${lan}:${port}/api/plugins`) } catch { refused = true }
      assert.ok(refused, 'off 之后从局域网连不上')
    }
    assert.equal(await code(base + '/api/plugins'), 200, '本机还能用')

    // 6. 走域名转发（tailscale serve）时，请求看起来来自 127.0.0.1，但不能当本机放行。
    //    否则 https://xxx.ts.net 就成了整个 tailnet 免口令的入口。
    await fetch(base + '/api/remote/mode', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'tailnet' }),
    })
    await new Promise((r) => setTimeout(r, 600))
    const proxied = (xff) => fetch(base + '/api/info', { headers: { 'x-forwarded-for': xff } })
    assert.equal((await proxied('100.127.187.70')).status, 401, '经转发的请求必须带口令')
    assert.equal((await proxied('192.168.1.50')).status, 403, '转发头说是局域网来的，tailnet 模式仍然拒绝')
    assert.equal(await code(base + '/api/info'), 200, '直连本机不受影响')

    // 7. 选择记在配置里，下次启动就按它来（当前停在 tailnet）
    const cfg = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'))
    assert.equal(cfg.remote, 'tailnet')
  } finally {
    child.kill('SIGKILL')
    rmSync(home, { recursive: true, force: true })
  }
})
