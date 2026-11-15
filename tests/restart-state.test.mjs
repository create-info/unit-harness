/**
 * 服务重启之后，旧会话不该还显示"正在跑"。
 *
 * 用户的原话是「服务一旦重启，这些就卡住了，然后刷新还是卡住，什么都没有」。
 * 根因有两层，这里各测一层：
 *
 *   1. meta.json 上的 status=active 是上次进程写的，被杀时没人改成 ended。
 *      旧会话于是永远 active，左栏挂一个转不完的圈。
 *   2. 前端更信自己的 RUNNING 变量。断流之后浏览器会重连，但没人去纠正
 *      那个状态，屏幕上就一直停在"运行中"。
 *
 * 第 2 层在 ui.html 里（RECONNECT_T 那段），第 1 层在这儿。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('a session left open by a dead process is closed on the next start', async () => {
  const home = mkdtempSync(join(tmpdir(), 'uh-restart-'))
  process.env.UH_HOME = home
  try {
    const { EventStore } = await import('../packages/core/src/evidence/store.ts')
    const store = new EventStore()

    // 模拟"上一个进程在这里跑到一半就被杀了"：建会话、留一条事件、不写 ended
    const a = store.create({ workspace: '/tmp', harness_version: 'x', label: 'was running' })
    store.append(a.id, 'turn/start', { task: 'hi' }, { source: 'user' })
    const b = store.create({ workspace: '/tmp', harness_version: 'x', label: 'finished cleanly' })
    store.end(b.id, 'done')

    assert.equal(store.get(a.id)?.status, 'active', 'precondition: a is stuck active')

    const closed = store.endInterrupted()
    assert.deepEqual(closed, [a.id], 'only the interrupted one is swept')

    // 新进程读出来的就是 ended；不会再被扫第二遍
    const fresh = new EventStore()
    assert.equal(fresh.get(a.id)?.status, 'ended')
    assert.equal(fresh.get(b.id)?.status, 'ended')
    assert.deepEqual(fresh.endInterrupted(), [], 'idempotent — a second start finds nothing')

    // 只改 meta，不编造 session/end 事件：那条事件的含义是"我们知道它怎么结束的"
    const events = readFileSync(
      join(home, 'sessions', ...a.created_at.slice(0, 10).split('-'), a.id, 'events.jsonl'),
      'utf8',
    )
    assert.ok(!events.includes('session/end'), 'no fake end event was written')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
