/**
 * 系统提示词必须说真话。
 *
 * 这里钉住的是一条很具体的错误：environment 段曾经写死
 * "<home_readable>false</home_readable>" 并附一句「别去看 ~/.config，
 * 会失败、会浪费一步」，而沙箱其实**默认可读 $HOME**（不放开读的话
 * `git` 都跑不起来，`~/.gitconfig` 一缺就是 fatal）。
 *
 * 代价不是报错，是模型在错误的世界模型里做决定：`~/.cache/ms-playwright`
 * 里明明装着浏览器，它宁可去猜「这个相对路径是不是 harness 注入的」，
 * 也不肯 ls 一下。提示词谎报自己的能力，比少写一条能力更糟。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const here = fileURLToPath(new URL('..', import.meta.url))
const { buildSystemPrompt } = await import(
  pathToFileURL(join(here, 'packages', 'core', 'src', 'agent', 'prompt.ts')).href
)

function env(ctx) {
  const s = buildSystemPrompt({
    workspace: '/work',
    isolation: 'landlock-v7',
    networkBlocked: false,
    tools: [],
    ...ctx,
  })
  return { full: s, block: s.split('<environment_context>')[1].split('</environment_context>')[0] }
}

test('the environment block reports home as readable by default', () => {
  const { block } = env({ homeReadable: true })
  assert.match(block, /<home_readable>true<\/home_readable>/)
})

test('saying home is readable means the body must not tell the model to avoid it', () => {
  const { full } = env({ homeReadable: true })
  assert.doesNotMatch(
    full,
    /home directory is NOT readable|do not (try to )?inspect dotfiles/i,
    'a prompt that says readable and then forbids ~/.config is giving two answers',
  )
  // 反过来要把「能读、且值得读」说清楚，否则模型还是不会去查缓存目录
  assert.match(full, /\$HOME/)
  assert.match(full, /Reading \$HOME is allowed/i)
})

test('the unreadable branch still exists and still warns', () => {
  // --no-home 是真会打断 git/npm 的模式，那时候必须明确劝阻
  const { full, block } = env({ homeReadable: false })
  assert.match(block, /<home_readable>false<\/home_readable>/)
  assert.match(full, /NOT readable/i)
})

test('omitting the flag behaves like the default (readable), not like the strict branch', () => {
  // 调用方漏传时不能悄悄退化成最严格的描述，否则默认配置下又在撒谎
  const { block } = env({})
  assert.match(block, /<home_readable>true<\/home_readable>/)
})

test('the prompt names the workspace as the only writable place', () => {
  const full = env({ homeReadable: true }).full
  assert.match(full, /Everything you write must land inside <workspace>/)
  assert.match(full, /Only \*writing\* outside the workspace is blocked/)
})
