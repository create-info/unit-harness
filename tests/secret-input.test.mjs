/**
 * 密钥输入必须过滤掉不属于 token 的字符。
 *
 * 起因是一次真实故障：用户配 LM Studio 时按了一下方向键，终端 raw mode 送来
 * 的 `\x1b[A` 被整段存进了 apiKey。之后每次请求都失败，界面上只有一句
 * `fetch failed`——查不出原因，因为 `\x1b` 让 HTTP header 非法，
 * 而 undici 把这种情况也报成 "fetch failed"。
 *
 * 这里锁住两件事：
 *   1. 控制字符永远进不了存储
 *   2. 真发不出去时，错误信息说得出是哪一种问题
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('..', import.meta.url))
const { sanitizeSecret } = await import(
  pathToFileURL(join(here, 'packages', 'core', 'src', 'llm', 'secret.ts')).href
)

test('an ANSI arrow-key sequence is stripped, not stored', () => {
  // 这一条就是事故本身：按一次「上」= \x1b[A
  assert.equal(sanitizeSecret('\x1b[A'), '')
  assert.equal(sanitizeSecret('sk-abc\x1b[A'), 'sk-abc')
})

test('a CSI sequence with parameters is stripped whole, and so is a bracketed-paste marker', () => {
  assert.equal(sanitizeSecret('\x1b[1;5Csk-1'), 'sk-1')
  // bracketed paste：粘贴密钥时终端会把内容包在 \x1b[200~ … \x1b[201~ 里
  assert.equal(sanitizeSecret('\x1b[200~sk-2\x1b[201~'), 'sk-2')
})

test('newlines and BOM do not survive a paste or a pipe', () => {
  assert.equal(sanitizeSecret('sk-abc\n'), 'sk-abc')
  assert.equal(sanitizeSecret('sk-abc\r\n'), 'sk-abc')
  assert.equal(sanitizeSecret('\uFEFFsk-abc'), 'sk-abc')
})

test('zero-width characters are removed', () => {
  assert.equal(sanitizeSecret('sk-\u200babc'), 'sk-abc')
})

test('a normal key passes through untouched', () => {
  assert.equal(sanitizeSecret('sk-proj-abc123_X-Y'), 'sk-proj-abc123_X-Y')
})

test('a value with non-printable content is refused instead of silently cleaned', () => {
  // NUL 不在白名单里，也没有"合理清洗"的办法——直接拒绝，让用户重贴
  assert.throws(() => sanitizeSecret('sk-ab\u0000c'), /cannot be in a key/)
})

test('a non-ASCII key is refused with the offending code point named', () => {
  assert.throws(
    () => sanitizeSecret('密钥abc'),
    (e) => /0x5bc6|0x[0-9a-f]+/.test(e.message),
    'the message must name what was wrong, not just say "invalid"',
  )
})

test('surrounding whitespace is trimmed, inner spaces are refused', () => {
  assert.equal(sanitizeSecret('  sk-abc  '), 'sk-abc')
  assert.throws(() => sanitizeSecret('sk-abc def'), /cannot be in a key/,
    'an inner space cannot be in a header value either')
})
