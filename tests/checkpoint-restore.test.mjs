/**
 * 回退到任意检查点。
 *
 * 这是「不可逆操作」，逻辑错了就是把用户的文件写坏，所以这里按最狠的路径测：
 * 同一个文件在一轮里被改两次、还有新建文件，然后回退到那一轮之前——
 * 结果必须是「那一刻的样子」，而不是「每个文件回到各自第一次被改之前」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { listCheckpoints, editsAfterSeq, undoToCheckpoint, lastRestoreSeq } =
  await import('../packages/core/src/checkpoint/store.ts')

/** 造一条事件流：seq 是天然顺序，payload 与 harness 写出来的一致 */
function events() {
  return [
    { seq: 1, kind: 'turn/start', payload: {} },
    { seq: 2, kind: 'checkpoint/file', payload: { path: 'a.txt', before: null, after: 'v1\n', added: 1, removed: 0 } },
    { seq: 3, kind: 'checkpoint/created', payload: { label: 'turn 1', files: ['a.txt'], file_count: 1 } },
    { seq: 4, kind: 'turn/start', payload: {} },
    // 同一轮里 a.txt 被改了两次：v1 → v2 → v3
    { seq: 5, kind: 'checkpoint/file', payload: { path: 'a.txt', before: 'v1\n', after: 'v2\n' } },
    { seq: 6, kind: 'checkpoint/file', payload: { path: 'a.txt', before: 'v2\n', after: 'v3\n' } },
    { seq: 7, kind: 'checkpoint/file', payload: { path: 'b.txt', before: null, after: 'b1\n' } },
    { seq: 8, kind: 'checkpoint/created', payload: { label: 'turn 2', files: ['a.txt', 'b.txt'], file_count: 2 } },
  ]
}

test('restoring to a checkpoint puts every file back to that exact moment', () => {
  const ws = mkdtempSync(join(tmpdir(), 'uh-ck-'))
  try {
    writeFileSync(join(ws, 'a.txt'), 'v3\n')
    writeFileSync(join(ws, 'b.txt'), 'b1\n')

    const evs = events()
    const cps = listCheckpoints(evs)
    assert.equal(cps.length, 2)
    assert.deepEqual(cps.map((c) => c.seq), [3, 8], '检查点锚在 checkpoint/created 的 seq 上')
    assert.deepEqual(cps.map((c) => c.turn), [1, 2])

    // 回到第 1 轮结束：a.txt 是 v1，b.txt 那时还不存在
    const edits = editsAfterSeq(evs, 3)
    assert.equal(edits.length, 3, '第 1 轮之后的三条改写都要重放（包括同一文件的两次）')
    undoToCheckpoint(ws, edits)
    assert.equal(readFileSync(join(ws, 'a.txt'), 'utf8'), 'v1\n', '被改两次的文件也必须落回那一刻的值')
    assert.equal(existsSync(join(ws, 'b.txt')), false, '那一刻不存在的文件要被删掉')
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})

test('an empty diff after the checkpoint is not an error', () => {
  const evs = events()
  // 回到最后一个检查点：它之后什么都没有
  assert.equal(editsAfterSeq(evs, 8).length, 0)
})

test('a restore blocks checkpoints older than itself', () => {
  const evs = events()
  assert.equal(lastRestoreSeq(evs), 0, '没回退过时是 0')
  evs.push({ seq: 9, kind: 'checkpoint/restored', payload: { seq: 3 } })
  const last = lastRestoreSeq(evs)
  assert.equal(last, 9)
  // 只有比这次回退更晚的检查点还能用；更早的重放会撤掉已经撤掉的改动
  const usable = listCheckpoints(evs).filter((c) => c.seq > last)
  assert.deepEqual(usable.map((c) => c.seq), [])
})

test('paths outside the workspace are refused, not written', () => {
  const ws = mkdtempSync(join(tmpdir(), 'uh-ck-'))
  try {
    const outside = join(ws, '..', 'uh-escape-probe.txt')
    undoToCheckpoint(ws, [{ path: '../uh-escape-probe.txt', before: 'x', after: null, binary: false, tooLarge: false }])
    assert.equal(existsSync(outside), false, '越界路径必须被跳过')
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})

test('binary edits are skipped and reported', () => {
  const ws = mkdtempSync(join(tmpdir(), 'uh-ck-'))
  try {
    mkdirSync(ws, { recursive: true })
    writeFileSync(join(ws, 'img.png'), 'not really')
    const out = undoToCheckpoint(ws, [{ path: 'img.png', before: null, after: null, binary: true, tooLarge: false }])
    assert.equal(out.skipped.length, 1)
    assert.match(out.skipped[0].why, /binary/)
    assert.equal(existsSync(join(ws, 'img.png')), true, '跳过的文件不能被动')
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})
