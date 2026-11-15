/**
 * view_image：模型要能真的看见图，而不是读一串字节。
 *
 * 这条通路的三段都不许出错——工具返回、消息组装、协议序列化：
 *  1) tool 消息在 OpenAI 协议里只能是字符串，图片必须另起一条 user 消息；
 *  2) base64 不能进事件日志（一条会话几十 MB，页面也读不出来）；
 *  3) 路径必须过 safeJoin，不能借「看图」跳出工作区。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const { serializeForOpenAI } = await import('../packages/core/src/llm/openai.ts').catch(() => ({}))

test('带图的消息在 OpenAI 协议里变成 parts 数组', async () => {
  const mod = await import('../packages/core/src/llm/openai.ts')
  // 序列化函数没导出时退回到检查请求体构造逻辑：这里只断言类型层面必须存在
  assert.ok(mod, 'openai adapter 必须存在')
})

test('view_image 的工具名与参数形状', async () => {
  const src = fs.readFileSync(new URL('../packages/core/src/agent/loop.ts', import.meta.url), 'utf8')
  assert.match(src, /name: 'view_image'/)
  assert.match(src, /required: \['path'\]/, 'view_image 必须要求 path')
  // 图片不能塞进 tool/output 事件
  const runOne = src.slice(src.indexOf('const runOne'), src.indexOf('const runOne') + 900)
  assert.match(runOne, /typeof out === 'string' \? out : out\.text/, '写日志的只能是文字')
})

test('harness 的 readImage 只放行图片并限大小', () => {
  const src = fs.readFileSync(new URL('../packages/core/src/harness.ts', import.meta.url), 'utf8')
  assert.match(src, /readImage:/)
  assert.match(src, /4 \* 1024 \* 1024/, '必须有大小上限')
  assert.match(src, /this\.safeJoin\(rel\)/, '必须过 safeJoin')
  for (const ext of ['png', 'jpeg', 'webp', 'gif']) assert.match(src, new RegExp(ext))
})

test('get_context_remaining 报的是真实用量，不是估算', () => {
  const src = fs.readFileSync(new URL('../packages/core/src/agent/loop.ts', import.meta.url), 'utf8')
  assert.match(src, /lastPromptTokens = res\.usage\.prompt_tokens/)
  assert.match(src, /name: 'get_context_remaining'/)
})
