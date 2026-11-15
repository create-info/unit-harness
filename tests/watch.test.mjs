/**
 * 文件监听测试。
 *
 * 这一层的失败方式是「静默」：不报错、不崩，只是通知不来或来得太晚。
 * 所以每个测试都带超时——卡住本身就是要发现的问题。
 *
 * 三个关键行为：
 *   1. 固定窗口防抖：持续写入时仍然会发，不是被无限推迟
 *   2. 目标不存在时听祖先目录，且只报目标本身
 *   3. watchId 重复、unwatch、连接断开，三种生命周期的边界
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('..', import.meta.url))
const watchMod = await import(
  pathToFileURL(join(here, 'packages', 'core', 'src', 'watch', 'index.ts')).href
)
const { FileWatcher, DebouncedWatchReceiver, WatchManager } = watchMod

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 等到 fn() 为真，或超时后失败——失败信息要能看出是「什么都没来」 */
async function until(fn, ms = 3000, what = 'event') {
  const started = Date.now()
  while (Date.now() - started < ms) {
    if (fn()) return
    await sleep(25)
  }
  throw new Error(`timed out waiting for ${what} after ${ms}ms`)
}

// ─────────────────────── 防抖 ───────────────────────

test('a burst of changes arrives as one batch', async () => {
  const batches = []
  const d = new DebouncedWatchReceiver(120, (ev) => batches.push(ev))
  for (let i = 0; i < 10; i++) d.push([`/p/file${i}.txt`])
  await until(() => batches.length === 1, 2000, 'one batch')
  assert.equal(batches.length, 1, 'ten pushes inside the window must not become ten batches')
  assert.equal(batches[0].paths.length, 10)
  d.close()
})

test('the same path appearing twice is reported once', async () => {
  const batches = []
  const d = new DebouncedWatchReceiver(80, (ev) => batches.push(ev))
  d.push(['/p/a.txt'])
  d.push(['/p/a.txt', '/p/a.txt'])
  await until(() => batches.length === 1)
  assert.deepEqual(batches[0].paths, ['/p/a.txt'])
  d.close()
})

test('paths come out sorted, so two runs are comparable', async () => {
  const batches = []
  const d = new DebouncedWatchReceiver(80, (ev) => batches.push(ev))
  d.push(['/p/z.txt', '/p/a.txt', '/p/m.txt'])
  await until(() => batches.length === 1)
  assert.deepEqual(batches[0].paths, ['/p/a.txt', '/p/m.txt', '/p/z.txt'])
  d.close()
})

test('continuous writes still get flushed — a fixed window, not a trailing one', async () => {
  // 这条是防抖最容易写错的地方：每次事件都重置计时器，持续写入就永远不发。
  // 编译产物目录一刷几百次，界面就再也不更新了。
  const batches = []
  const d = new DebouncedWatchReceiver(100, (ev) => batches.push(ev))
  const stop = Date.now() + 500
  let n = 0
  while (Date.now() < stop) {
    d.push([`/p/f${n++}.txt`])
    await sleep(20)
  }
  assert.ok(batches.length >= 2, `continuous writes must flush repeatedly, got ${batches.length} batches`)
  d.close()
})

test('close() drops the pending batch instead of firing it late', async () => {
  let fired = 0
  const d = new DebouncedWatchReceiver(60, () => fired++)
  d.push(['/p/a.txt'])
  d.close()
  await sleep(150)
  assert.equal(fired, 0, 'a closed receiver must not notify after the fact')
})

// ─────────────────────── 真实文件系统 ───────────────────────

test('watching an existing directory reports changes in it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'uh-watch-'))
  const seen = []
  const w = new FileWatcher()
  const sub = w.addSubscriber()
  const reg = sub.register([{ path: dir, recursive: false }], (paths) => seen.push(...paths))
  try {
    await sleep(120)
    writeFileSync(join(dir, 'a.txt'), 'hi')
    await until(() => seen.some((p) => p.endsWith('a.txt')), 3000, 'a change to a.txt')
  } finally {
    reg.close()
    w.closeAll()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('watching a file that does not exist yet still catches its creation', async () => {
  // agent 和编辑器都是「先 watch 再创建」，fs.watch 一个不存在的路径直接 ENOENT，
  // 所以必须先向上找存在的祖先目录。
  const dir = mkdtempSync(join(tmpdir(), 'uh-watch2-'))
  const target = join(dir, 'notyet.txt')
  const seen = []
  const w = new FileWatcher()
  const sub = w.addSubscriber()
  const reg = sub.register([{ path: target, recursive: false }], (paths) => seen.push(...paths))
  try {
    await sleep(120)
    writeFileSync(target, 'created')
    await until(() => seen.some((p) => p.endsWith('notyet.txt')), 3000, 'creation of notyet.txt')
  } finally {
    reg.close()
    w.closeAll()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('when falling back to an ancestor, sibling files are not reported', async () => {
  // fallback 的另一半：听着目录，但只关心目标。否则「只看这个文件」变成
  // 「整个目录一有动静就通知」。
  const dir = mkdtempSync(join(tmpdir(), 'uh-watch3-'))
  const target = join(dir, 'wanted.txt')
  const seen = []
  const w = new FileWatcher()
  const sub = w.addSubscriber()
  const reg = sub.register([{ path: target, recursive: false }], (paths) => seen.push(...paths))
  try {
    await sleep(120)
    writeFileSync(join(dir, 'other.txt'), 'noise')
    await sleep(400)
    assert.equal(seen.filter((p) => p.endsWith('other.txt')).length, 0,
      'a sibling write must not be reported as a change to the watched file')
    writeFileSync(target, 'real')
    await until(() => seen.some((p) => p.endsWith('wanted.txt')), 3000, 'the watched file')
  } finally {
    reg.close()
    w.closeAll()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a recursive watch sees nested changes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'uh-watch4-'))
  mkdirSync(join(dir, 'sub', 'deep'), { recursive: true })
  const seen = []
  const w = new FileWatcher()
  const sub = w.addSubscriber()
  const reg = sub.register([{ path: dir, recursive: true }], (paths) => seen.push(...paths))
  try {
    await sleep(150)
    writeFileSync(join(dir, 'sub', 'deep', 'x.txt'), 'nested')
    await until(() => seen.some((p) => p.includes('x.txt')), 4000, 'a nested change')
  } finally {
    reg.close()
    w.closeAll()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ─────────────────────── 生命周期 ───────────────────────

test('a duplicate watch id is refused rather than silently replacing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'uh-watch5-'))
  const batches = []
  const m = new WatchManager({ debounceMs: 80, onBatch: (_c, _w, ev) => batches.push(ev) })
  try {
    assert.equal(m.watch('client1', 'w1', { path: dir, recursive: false }), true)
    // 覆盖的话前一个 fs.watch 就漏了引用，进程里悄悄多一个句柄
    assert.equal(m.watch('client1', 'w1', { path: dir, recursive: false }), false)
    assert.equal(m.size(), 1)
    // 另一个客户端用同样的 id 是允许的：watchId 的作用域是客户端
    assert.equal(m.watch('client2', 'w1', { path: dir, recursive: false }), true)
    assert.equal(m.size(), 2)
  } finally {
    m.closeAll()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('after unwatch no further notifications arrive', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'uh-watch6-'))
  const batches = []
  const m = new WatchManager({ debounceMs: 60, onBatch: (_c, _w, ev) => batches.push(ev) })
  try {
    m.watch('c', 'w', { path: dir, recursive: false })
    await sleep(120)
    writeFileSync(join(dir, 'one.txt'), 'x')
    await until(() => batches.length >= 1, 3000, 'the first batch')

    assert.equal(m.unwatch('c', 'w'), true)
    const after = batches.length
    writeFileSync(join(dir, 'two.txt'), 'y')
    await sleep(400)
    assert.equal(batches.length, after, 'a change after unwatch must not be delivered')
  } finally {
    m.closeAll()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a client going away releases all of its watches', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'uh-watch7-'))
  const m = new WatchManager({ debounceMs: 60, onBatch: () => {} })
  try {
    m.watch('tabA', 'w1', { path: dir, recursive: false })
    m.watch('tabA', 'w2', { path: dir, recursive: false })
    m.watch('tabB', 'w1', { path: dir, recursive: false })
    assert.equal(m.size(), 3)

    // 一个标签页反复开关不清就是句柄泄漏
    assert.equal(m.clientClosed('tabA'), 2)
    assert.equal(m.size(), 1)
  } finally {
    m.closeAll()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('unwatching something never watched is a no-op, not an error', async () => {
  const m = new WatchManager({ debounceMs: 60, onBatch: () => {} })
  assert.equal(m.unwatch('nobody', 'nothing'), false)
  m.closeAll()
})
