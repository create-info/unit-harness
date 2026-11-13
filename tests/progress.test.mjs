/**
 * 进度文案测试。
 *
 * 这类测试的价值不在"函数返回了字符串"，而在一条硬约束：
 * **屏幕上不许出现我们自己的词汇**（`run_command`、`argv`、`mcp__`、`tool_call`）。
 * 一条断言遍历所有输入，检查输出里没有这些词——这比逐个用例人眼检查可靠。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const { describeTool, describeToolResult, describeCommand, describeFilesChanged } = await import(
  pathToFileURL(path.join(here, '..', 'packages', 'core', 'src', 'agent', 'progress.ts')).href
)

/** 内部术语黑名单：任何一条出现在 label 里都算 bug */
const LEAKS = ['run_command', 'argv', 'mcp__', 'tool_call', 'tool/result', 'apply_patch', 'read_file', 'list_dir', 'undefined', 'null', '[object']

function assertClean(line, what) {
  for (const bad of LEAKS) {
    assert.ok(
      !line.label.includes(bad),
      `${what}: label "${line.label}" leaks internal term "${bad}"`,
    )
  }
  assert.ok(line.label.length > 0, `${what}: empty label`)
  assert.ok(line.label.length <= 120, `${what}: label too long (${line.label.length})`)
  // 句子型文案动词开头；文件汇总是计数器，允许 "2 files · +4 −0" 这种形状
  assert.ok(/^[A-Za-z0-9]/.test(line.label), `${what}: label should start with a word, got "${line.label}"`)
  // detail 可以带命令原文，但也不能带工具名
  if (line.detail) {
    for (const bad of ['run_command', 'mcp__', 'undefined']) {
      assert.ok(!line.detail.includes(bad), `${what}: detail leaks "${bad}"`)
    }
  }
}

// ─────────────────────── 命令行 ───────────────────────

test('common commands are described by intent, not by argv', () => {
  const cases = [
    [['npm', 'test'], /test/i],
    [['npm', 'run', 'test'], /test/i],
    [['pytest', '-q'], /test/i],
    [['cargo', 'test'], /test/i],
    [['go', 'test', './...'], /test/i],
    [['node', '--test', 'tests/a.test.mjs'], /test/i],
    [['npm', 'install'], /install/i],
    [['pip', 'install', 'six'], /install/i],
    [['npm', 'run', 'build'], /build/i],
    [['git', 'status'], /repo/i],
    [['git', 'commit', '-m', 'x'], /commit/i],
    [['ls', '-la'], /listing/i],
    [['grep', '-rn', 'foo', 'src'], /searching/i],
    [['rm', '-rf', 'build'], /delet/i],
    [['curl', 'https://x'], /network/i],
    [['ssh', 'box', 'uptime'], /remote/i],
  ]
  for (const [argv, re] of cases) {
    const line = describeTool('run_command', { argv })
    assertClean(line, argv.join(' '))
    assert.match(line.label, re, `"${argv.join(' ')}" should read like ${re}, got "${line.label}"`)
  }
})

test('sh -c wrappers are looked through', () => {
  const line = describeTool('run_command', { argv: ['sh', '-c', 'npm test -- --watch=false'] })
  assertClean(line, 'sh -c')
  assert.match(line.label, /test/i)
})

test('an unrecognised command is still readable and keeps the command as detail', () => {
  const line = describeTool('run_command', { argv: ['frobnicate', '--x'] })
  assertClean(line, 'unknown')
  assert.match(line.label, /frobnicate/)
  assert.ok(line.detail)
})

test('a long command is truncated instead of pushing the layout', () => {
  const line = describeTool('run_command', { argv: ['frobnicate', 'x'.repeat(300)] })
  assertClean(line, 'long')
  assert.ok(line.label.length <= 120)
})

// ─────────────────────── 内建工具 ───────────────────────

test('file tools read like sentences', () => {
  const reading = describeTool('read_file', { path: '/home/u/proj/src/cli.ts' })
  assertClean(reading, 'read_file')
  assert.match(reading.label, /^Reading /)
  assert.match(reading.label, /cli\.ts/)

  const listing = describeTool('list_dir', { path: '/home/u/proj/src' })
  assertClean(listing, 'list_dir')
  assert.match(listing.label, /^Listing /)

  const searching = describeTool('grep', { pattern: 'function main' })
  assertClean(searching, 'grep')
  assert.match(searching.label, /^Searching for "function main"/)
})

test('a commit-shaped home path is shortened but the file name survives', () => {
  const line = describeTool('read_file', { path: '/home/someone/deep/nested/dir/file.ts' })
  assertClean(line, 'home path')
  assert.ok(!line.label.includes('/home/someone'), `should not print the full home path: ${line.label}`)
  assert.match(line.label, /file\.ts/)
})

test('editing many files is summarised, not listed', () => {
  const line = describeTool('apply_patch', { files: ['a.ts', 'b.ts', 'c.ts', 'd.ts'] })
  assertClean(line, 'patch many')
  assert.match(line.label, /^Editing 4 files$/)
})

test('a single edit names the file', () => {
  const line = describeTool('apply_patch', { files: ['src/a.ts'] })
  assertClean(line, 'patch one')
  assert.match(line.label, /^Editing /)
  assert.match(line.label, /a\.ts/)
})

test('plugin tools say which system they went to', () => {
  const mcp = describeTool('mcp__github__create_issue', {})
  assertClean(mcp, 'mcp')
  assert.match(mcp.label, /github/)
  assert.match(mcp.label, /create issue/)

  const browse = describeTool('browser_open', { url: 'https://example.com' })
  assertClean(browse, 'browser')
  assert.match(browse.label, /^Opening /)

  const tap = describeTool('phone_tap', {})
  assertClean(tap, 'phone')
  assert.match(tap.label, /phone/)
})

test('an unknown tool name is turned into a sentence, never printed raw', () => {
  const line = describeTool('some_new_tool_name', {})
  assertClean(line, 'unknown tool')
  assert.match(line.label, /^Some new tool name$/)
})

// ─────────────────────── 结果 ───────────────────────

test('results do not make the user read exit codes', () => {
  const ok = describeToolResult('run_command', { status: 'ok', exit_code: 0 })
  assertClean(ok, 'ok result')
  assert.equal(ok.label, 'Done')

  const bad = describeToolResult('run_command', { status: 'error', exit_code: 2 })
  assertClean(bad, 'bad result')
  assert.match(bad.label, /2/)

  const refused = describeToolResult('run_command', { status: 'error', refused: true, denied_by: 'approval' })
  assertClean(refused, 'refused')
  assert.match(refused.label, /^Blocked/)
  assert.match(refused.label, /approval/)
})

test('file count summary looks like the one people expect', () => {
  const one = describeFilesChanged(4, 0, 1)
  assertClean(one, 'files 1')
  assert.match(one.label, /1 file\b/)
  const many = describeFilesChanged(12, 3, 4)
  assertClean(many, 'files n')
  assert.match(many.label, /4 files/)
  assert.match(many.label, /\+12/)
})
