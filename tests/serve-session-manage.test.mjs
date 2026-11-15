/**
 * 左栏会话的三件事：改名、置顶、删除。
 *
 * 为什么要钉住：
 *  - 改名只写 meta.json 的 label，不能碰 events.jsonl（seq 和审计链在这上面）；
 *  - 置顶落在 ~/.uh/config.json，不是「这次页面记着」，否则刷新就没了；
 *  - 删除是唯一不可逆的动作，参数来自 HTTP —— 必须证明它只能删自己那一个目录。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import net from 'node:net'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs'
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

/** 直接在磁盘上摆一条会话，省掉跑一次真 agent */
function seedSession(home, id, label, workspace) {
  const d = new Date()
  const dir = join(home, 'sessions',
    String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'), id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({
    id, created_at: d.toISOString(), updated_at: d.toISOString(),
    workspace, harness_version: 'test', status: 'ended', last_seq: 2, label,
  }))
  writeFileSync(join(dir, 'events.jsonl'), '')
  return dir
}

const post = async (port, path, body) => fetch(`http://127.0.0.1:${port}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})

test('sessions can be renamed, pinned and deleted — and only their own directory', async () => {
  const home = mkdtempSync(join(tmpdir(), 'uh-sess-'))
  const port = await freePort()
  const ws = join(home, 'work')
  mkdirSync(ws, { recursive: true })
  const a = seedSession(home, 'sess-aaa', '旧标题', ws)
  const b = seedSession(home, 'sess-bbb', '另一条', ws)

  const child = spawn(process.execPath, [CLI, 'serve', '--port', String(port), '--workspace', ws], {
    env: { ...process.env, UH_HOME: home, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  try {
    await waitUp(port)

    // 1. 改名：列表和 meta.json 都要变，事件日志不能被动
    const rn = await post(port, '/api/session/rename', { id: 'sess-aaa', label: '新标题' })
    assert.equal(rn.status, 200)
    assert.equal(JSON.parse(readFileSync(join(a, 'meta.json'), 'utf8')).label, '新标题')

    const list1 = await (await fetch(`http://127.0.0.1:${port}/api/projects`)).json()
    const flat = list1.projects.flatMap((p) => p.items)
    assert.equal(flat.find((s) => s.id === 'sess-aaa')?.label, '新标题')

    // 2. 置顶：落在配置里，并且排在前面（b 更新，但 a 钉住之后要在它上面）
    const pin = await post(port, '/api/session/pin', { id: 'sess-aaa', pinned: true })
    assert.equal(pin.status, 200)
    const cfg = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'))
    assert.deepEqual(cfg.pinnedSessions, ['sess-aaa'])

    const list2 = await (await fetch(`http://127.0.0.1:${port}/api/projects`)).json()
    const items2 = list2.projects.flatMap((p) => p.items).filter((s) => s.id.startsWith('sess-'))
    assert.equal(items2[0].id, 'sess-aaa', '置顶的排最前')
    assert.equal(items2[0].pinned, true)

    // 3. 参数是 HTTP 来的： traversal 一律拒绝，别碰工作区里的东西
    const bad = await post(port, '/api/session/delete', { id: '../../../work' })
    assert.equal(bad.status, 404)
    assert.ok(existsSync(ws), '工作区必须还在')

    // 4. 删除：目录真的没了，另一条不受影响
    const del = await post(port, '/api/session/delete', { id: 'sess-aaa' })
    assert.equal(del.status, 200)
    assert.ok(!existsSync(a), '会话目录应被删除')
    assert.ok(existsSync(b), '其它会话不受影响')

    // 5. 删过之后置顶记录也不该留着
    const cfg2 = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'))
    assert.deepEqual(cfg2.pinnedSessions, [])

    // 6. 再删同一条 = 404，不是 500
    assert.equal((await post(port, '/api/session/delete', { id: 'sess-aaa' })).status, 404)
  } finally {
    child.kill('SIGKILL')
    rmSync(home, { recursive: true, force: true })
  }
})
