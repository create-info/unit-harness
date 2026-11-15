/**
 * 续跑必须记得住被打断的那一轮。
 *
 * 之前的 bug：一轮被 Stop / --force 打断，什么历史都没留下——state.json 只在
 * "整轮结束"时写。用户在网页上点"继续"，模型看到的是上一次的旧快照，于是说
 * "我不知道之前做到哪了"。它不是偷懒，它是真的没拿到。
 *
 * Codex 用 append-only 的 rollout 记这个过程：消息一发生就追加，续跑靠重放，
 * 压缩是往日志里追加一个 replacement，不是改写历史。这里测的就是这套语义。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const { appendRollout, replayRollout, rolloutPath } =
  await import('../packages/core/src/evidence/rollout.ts')

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'uh-rollout-'))
}

test('没有日志时返回 null，调用方才能退回 state.json', () => {
  assert.equal(replayRollout(tmp()), null)
})

test('消息按发生顺序重放', () => {
  const dir = tmp()
  appendRollout(dir, { type: 'message', message: { role: 'user', content: '做一个 PPT' } })
  appendRollout(dir, { type: 'message', message: { role: 'assistant', content: '先看看素材' } })
  appendRollout(dir, { type: 'message', message: { role: 'tool', tool_call_id: 't1', content: '狼牙山…' } })

  const out = replayRollout(dir)
  assert.deepEqual(out.map((m) => m.role), ['user', 'assistant', 'tool'])
  assert.equal(out[2].content, '狼牙山…', '工具输出要原样留着')
})

test('system 不重放：新一轮会重新生成，存下来只会留下过期的工作区路径', () => {
  const dir = tmp()
  appendRollout(dir, { type: 'message', message: { role: 'system', content: 'old system' } })
  appendRollout(dir, { type: 'message', message: { role: 'user', content: 'hi' } })
  assert.deepEqual(replayRollout(dir).map((m) => m.role), ['user'])
})

test('压缩点之前的消息被替换掉，而不是越堆越长', () => {
  const dir = tmp()
  appendRollout(dir, { type: 'message', message: { role: 'user', content: '旧任务' } })
  appendRollout(dir, { type: 'message', message: { role: 'assistant', content: '旧回复' } })
  // 压缩：用摘要 + 最近一条替换前面全部
  appendRollout(dir, {
    type: 'compacted',
    messages: [
      { role: 'user', content: '[摘要] 旧任务做过什么' },
      { role: 'assistant', content: '最近一条' },
    ],
  })
  appendRollout(dir, { type: 'message', message: { role: 'user', content: '继续' } })

  const out = replayRollout(dir)
  assert.deepEqual(out.map((m) => m.content), ['[摘要] 旧任务做过什么', '最近一条', '继续'])
})

test('崩溃留下的半行被跳过，前面的消息仍然可用', () => {
  const dir = tmp()
  appendRollout(dir, { type: 'message', message: { role: 'user', content: 'A' } })
  // 模拟写到一半被杀：没有换行、JSON 不完整
  fs.appendFileSync(rolloutPath(dir), '{"type":"message","message":{"role":"user","con')
  const out = replayRollout(dir)
  assert.equal(out.length, 1, '半行不该让整段历史读不出来')
  assert.equal(out[0].content, 'A')
})

test('被打断的一轮也留得下已经跑过的部分', () => {
  const dir = tmp()
  // 正常跑到一半，用户按了 Stop —— 没有"整轮结束"，所以没有 state.json
  appendRollout(dir, { type: 'message', message: { role: 'user', content: '给狼牙山五壮士做课件' } })
  appendRollout(dir, { type: 'message', message: { role: 'assistant', content: '', tool_calls: [{ id: 'a', type: 'function', function: { name: 'list_dir', arguments: '{}' } }] } })
  appendRollout(dir, { type: 'message', message: { role: 'tool', tool_call_id: 'a', content: 'w1.md w1_p2.md' } })

  const out = replayRollout(dir)
  assert.equal(out.length, 3)
  assert.equal(out[0].content, '给狼牙山五壮士做课件', '用户的原始要求必须还在')
})
