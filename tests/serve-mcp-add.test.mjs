/**
 * 插件页的添加入口要跟着分页走。
 *
 * 用户的原话：技能那页才该有「添加 Skill」，MCP 那页该出现「添加 MCP」。
 * 之前的实现是不管在哪一页都只有一个「添加 Skill」，等于在 MCP 页告诉人
 * 「MCP 加不了」——而 MCP 恰恰是最需要图形界面才能加的东西（要写一段 JSON）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import net from 'node:net'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
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

async function waitUp(port) {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/manifest.webmanifest`)).ok) return
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error('server did not come up')
}

test('mcp servers are added and removed from the settings page, and duplicates are refused', async () => {
  const home = mkdtempSync(join(tmpdir(), 'uh-mcpadd-'))
  const ws = join(home, 'work')
  mkdirSync(ws, { recursive: true })
  const port = await freePort()
  const child = spawn(process.execPath, [CLI, 'serve', '--port', String(port), '--workspace', ws], {
    env: { ...process.env, UH_HOME: home, NO_COLOR: '1', UH_BUILTIN_SKILLS: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const base = `http://127.0.0.1:${port}`
  const post = (p, body) => fetch(base + p, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })

  try {
    await waitUp(port)

    // 1. 贴一段 Claude Desktop 风格配置：整块接受
    const j = await post('/api/plugins/mcp', {
      json: JSON.stringify({ mcpServers: { alpha: { url: 'https://a.example/mcp' } } }),
    })
    assert.equal(j.status, 200, await j.clone().text())
    assert.deepEqual((await j.json()).added, ['alpha'])

    // 2. 落盘结构必须是 mcpServers（和 Claude Desktop 一致，才谈得上互相迁移）
    const saved = JSON.parse(readFileSync(join(home, 'mcp.json'), 'utf8'))
    assert.equal(saved.mcpServers.alpha.url, 'https://a.example/mcp')

    // 3. 出现插件列表里，带 mcp: 前缀的 id（裸 id 的 bug 曾经让开关点不动）
    const plug = await (await fetch(base + '/api/plugins')).json()
    assert.ok(plug.mcp.some((m) => m.id === 'mcp:alpha'))

    // 4. 同一个名字再来一次：409 而不是悄悄覆盖——那份可能正在用
    const dup = await post('/api/plugins/mcp', { json: JSON.stringify({ mcpServers: { alpha: { url: 'https://b.example/mcp' } } }) })
    assert.equal(dup.status, 409)

    // 5. 非法 JSON 要说清是 JSON 的问题
    const bad = await post('/api/plugins/mcp', { json: '{not json' })
    assert.equal(bad.status, 400)
    assert.match((await bad.json()).error, /JSON/)

    // 6. 删除
    const del = await post('/api/plugins/mcp/delete', { name: 'alpha' })
    assert.equal(del.status, 200)
    const after = JSON.parse(readFileSync(join(home, 'mcp.json'), 'utf8'))
    assert.equal(after.mcpServers.alpha, undefined)
  } finally {
    child.kill('SIGKILL')
    rmSync(home, { recursive: true, force: true })
  }
})
