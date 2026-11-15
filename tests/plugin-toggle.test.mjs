/**
 * 插件面板的开关必须真的能关掉。
 *
 * 用户的原话是「设置里面插件 MCP 不能关了吗，当前点不掉」。原因不是鼠标，
 * 是两套 id：列表里 id 给的是裸名字 `unitai`，而启用判断问的是 `mcp:unitai`。
 * 于是点一下→写入一条永远不会被读到的 `unitai`→重新拉列表时仍然是 on→
 * 界面弹回原位。开关变成装饰品，而「我明明关了它」是最难排查的一类问题。
 *
 * 这里钉三件事：
 *   1. 列表给的 id 就是关它时要写的那个 key（带前缀）；
 *   2. 关掉之后重新读，状态真的是 false（不是「写进配置但读不出来」）；
 *   3. 裸名字被拒（400），而不是静默写一条无效记录。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(process.cwd(), 'dist', 'uh.cjs')

async function waitUp(port) {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/plugins`)
      if (r.ok) return
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error('server did not come up on ' + port)
}

test('an MCP server can be switched off, and it stays off after re-reading', async () => {
  const home = mkdtempSync(join(tmpdir(), 'uh-toggle-'))
  const work = join(home, 'work')
  mkdirSync(work, { recursive: true })
  // 沿用 Claude Desktop 的 mcpServers 结构（key 就在这里，写错成 servers 会读到空表）
  writeFileSync(join(home, 'mcp.json'), JSON.stringify({
    mcpServers: { unitai: { url: 'https://unitai.site/mcp' } },
  }))

  const port = 8000 + Math.floor(Math.random() * 60)
  const child = spawn(process.execPath, [CLI, 'serve', '--port', String(port)], {
    cwd: work,
    env: { ...process.env, UH_HOME: home, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout.on('data', (d) => (out += String(d)))
  child.stderr.on('data', (d) => (out += String(d)))

  try {
    await waitUp(port)
    const base = `http://127.0.0.1:${port}`

    // 1. 列表里的 id 带前缀，而且初始是开着的
    let list = await (await fetch(base + '/api/plugins')).json()
    const m = list.mcp.find((x) => x.name === 'unitai')
    assert.ok(m, 'the configured MCP server must be listed:\n' + JSON.stringify(list.mcp))
    assert.equal(m.id, 'mcp:unitai', 'the id must be the key the toggle writes')
    assert.equal(m.enabled, true)

    // 2. 裸名字必须被拒——它写进去也不会生效
    const bad = await fetch(base + '/api/plugins/toggle', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'unitai', enabled: false }),
    })
    assert.equal(bad.status, 400, 'a bare name must not be accepted')

    // 3. 用列表给的 id 关掉 → 重新读仍然是关的
    const ok = await fetch(base + '/api/plugins/toggle', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: m.id, enabled: false }),
    })
    assert.equal(ok.status, 200)

    list = await (await fetch(base + '/api/plugins')).json()
    const after = list.mcp.find((x) => x.name === 'unitai')
    assert.equal(after.enabled, false, 'the switch must stay off, not bounce back')

    const cfg = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'))
    assert.deepEqual(cfg.disabledPlugins, ['mcp:unitai'], 'it must be persisted under the prefixed key')

    // 4. 再打开 → 状态回到 true，配置里不留垃圾
    await fetch(base + '/api/plugins/toggle', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: m.id, enabled: true }),
    })
    list = await (await fetch(base + '/api/plugins')).json()
    assert.equal(list.mcp.find((x) => x.name === 'unitai').enabled, true)
    const cfg2 = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'))
    assert.deepEqual(cfg2.disabledPlugins ?? [], [], 'turning it back on must clean up the record')
  } finally {
    child.kill('SIGKILL')
    rmSync(home, { recursive: true, force: true })
  }
})
