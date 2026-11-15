/**
 * 上下文窗口必须按模型算。
 *
 * 写死 32000 不是"保守"，是错的：128k 的模型被按 32k 反复压缩，
 * 刚读到的文件被摘要掉，模型立刻回去重读——step 涨、token 涨、事还没做完。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const { resolveContextWindow, compactThreshold, windowFromModelEntry, DEFAULT_CONTEXT_WINDOW } =
  await import('../packages/core/src/llm/window.ts')

test('配置里写的窗口优先于一切', () => {
  const r = resolveContextWindow({ model: 'qwen3.8-27b', explicit: 131072, reported: { id: 'x', max: 262144 } })
  assert.equal(r.tokens, 131072)
  assert.equal(r.source, 'config')
})

test('服务端报的 loaded 优先于 max —— 开了 128k 就不能按 256k 算', () => {
  // LM Studio 的实测值：模型最大 262144，但当前只加载了 131072
  const r = resolveContextWindow({ model: 'qwen3.8-27b', reported: { id: 'qwen3.8-27b', max: 262144, loaded: 131072 } })
  assert.equal(r.tokens, 131072, '必须用 loaded，不能用 max')
  assert.equal(r.source, 'server-loaded')
})

test('只有 max 时用 max', () => {
  const r = resolveContextWindow({ model: 'm', reported: { id: 'm', max: 200000 } })
  assert.equal(r.tokens, 200000)
  assert.equal(r.source, 'server-max')
})

test('服务端没报就按模型名查内置表', () => {
  assert.equal(resolveContextWindow({ model: 'deepseek-v4-flash' }).tokens, 128000)
  assert.equal(resolveContextWindow({ model: 'claude-sonnet-4-5' }).tokens, 200000)
  // 长前缀优先：gpt-4.1 是 1M，不能被 gpt-4 的 128k 抢走
  assert.equal(resolveContextWindow({ model: 'gpt-4.1-mini' }).tokens, 1_000_000)
})

test('什么都不知道时回落默认值，并标明是猜的', () => {
  const r = resolveContextWindow({ model: 'some-unknown-model' })
  assert.equal(r.tokens, DEFAULT_CONTEXT_WINDOW)
  assert.equal(r.source, 'default', '必须能区分"查到的"和"猜的"')
})

test('压缩阈值是窗口的 70%', () => {
  assert.equal(compactThreshold(32000), 22400)
  assert.equal(compactThreshold(131072), 91750)
})

test('各家 /models 的窗口字段名都要认', () => {
  assert.deepEqual(windowFromModelEntry({ max_context_length: 262144, loaded_context_length: 131072 }),
    { max: 262144, loaded: 131072 }, 'LM Studio')
  assert.deepEqual(windowFromModelEntry({ context_length: 128000 }), { max: 128000 }, 'OpenRouter')
  assert.deepEqual(windowFromModelEntry({ max_model_len: 32768 }), { max: 32768 }, 'vLLM')
  assert.deepEqual(windowFromModelEntry({ id: 'x' }), {}, '认不出就不猜')
})

test('harness 不再写死 32000', () => {
  const src = fs.readFileSync(new URL('../packages/core/src/harness.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(src, /maxContextTokens: o\.maxContextTokens \?\? Number\(process\.env\.UH_MAX_CONTEXT \?\? 32000\)/,
    '旧的写死默认值必须消失')
  assert.match(src, /contextWindowFor\(provider\.def\.id, provider\.model\)/, '必须按实际 provider+model 解析')
})
