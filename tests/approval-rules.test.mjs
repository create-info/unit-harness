/**
 * 审批记忆（prefix_rule）测试。
 *
 * 这一层的风险不对称：记错一条规则的代价是**从此静默放行一类命令**，而且用户不会再看到
 * 任何提示。所以测试的重心不是"能记住"，而是"记住的范围足够小"——
 * 那些 `assert.equal(suggestPrefix(...), null)` 才是这套东西真正价值所在。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

const here = path.dirname(fileURLToPath(import.meta.url))

// 规则文件落在 uhHome() 下，动手前先把 HOME 指到临时目录，
// 否则测试会往用户真实的 ~/.uh/approval-rules.json 里写东西
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'uh-rules-'))
process.env.UH_HOME = tmpHome

const rulesMod = await import(
  pathToFileURL(path.join(here, '..', 'packages', 'core', 'src', 'approval', 'rules.ts')).href
)
const { suggestPrefix, matchesRule, normalizeArgv, loadRules, addRule, removeRule } = rulesMod

// ─────────────────────── 什么时候可以记 ───────────────────────

test('build and test commands get a narrow prefix', () => {
  assert.deepEqual(suggestPrefix(['npm', 'install', 'lodash'], 'write'), ['npm', 'install'])
  assert.deepEqual(suggestPrefix(['npm', 'install'], 'write'), ['npm', 'install'])
  assert.deepEqual(suggestPrefix(['cargo', 'test'], 'write'), ['cargo', 'test'])
  assert.deepEqual(suggestPrefix(['go', 'build', './...'], 'write'), ['go', 'build'])
})

test('a flag as the second token does not become part of the rule', () => {
  // `pytest -q` 记成 `pytest -q` 等于什么都没记（下次带别的参数又得问）
  assert.deepEqual(suggestPrefix(['pytest', '-q'], 'write'), ['pytest'])
  assert.deepEqual(suggestPrefix(['npm', 'test', '--', '--watch=false'], 'write'), ['npm', 'test'])
})

test('git is only remembered at the subcommand level, and never for writes that bite', () => {
  assert.deepEqual(suggestPrefix(['git', 'status'], 'read'), ['git', 'status'])
  assert.deepEqual(suggestPrefix(['git', 'commit', '-m', 'x'], 'write'), ['git', 'commit'])
  for (const sub of ['push', 'reset', 'clean', 'rebase', 'filter-branch', 'gc']) {
    assert.equal(
      suggestPrefix(['git', sub, '--force'], 'write'), null,
      `git ${sub} must never be remembered`,
    )
  }
})

// ─────────────────────── 什么时候绝对不可以记 ───────────────────────

test('a routine destructive command is remembered as the exact command', () => {
  // 这是最常被问的一类，不许记等于功能没用。但记的是"这一条"，不是"这一类"
  assert.deepEqual(
    suggestPrefix(['rm', '-rf', 'node_modules'], 'destructive'),
    ['rm', '-rf', 'node_modules'],
  )
  assert.deepEqual(
    suggestPrefix(['rm', '-rf', 'dist'], 'destructive'),
    ['rm', '-rf', 'dist'],
  )
})

test('catastrophic targets are never remembered, even as an exact command', () => {
  for (const argv of [
    ['rm', '-rf', '/'],
    ['rm', '-rf', '/*'],
    ['rm', '-rf', '~'],
    ['rm', '-rf', '$HOME'],
    ['rm', '-rf', '/etc'],
    ['rm', '-rf', '/usr'],
    ['rm', '-rf', '..'],
    ['dd', 'if=/dev/zero', 'of=/dev/sda'],
    ['mkfs.ext4', '/dev/sdb1'],
    ['shutdown', '-h', 'now'],
    ['reboot'],
  ]) {
    assert.equal(suggestPrefix(argv, 'destructive'), null, `${argv.join(' ')} must not be remembered`)
  }
})

test('rm inside the project is fine to remember, /tmp is not catastrophic either', () => {
  assert.ok(suggestPrefix(['rm', '-rf', './build'], 'destructive'))
  assert.ok(suggestPrefix(['rm', '-rf', '/tmp/uh-x'], 'destructive'))
})

test('a command that merely looks harmless but is not on the allow list stays unremembered', () => {
  // 这是刻意保守：认不出来就不记，下次再问一次，而不是猜它安全
  for (const argv of [
    ['curl', 'https://x.sh'],
    ['wget', 'http://y'],
    ['sudo', 'apt', 'install', 'x'],
    ['bash', '-c', 'something'],
    ['my-custom-script', '--go'],
  ]) {
    assert.equal(suggestPrefix(argv, 'write'), null, `${argv.join(' ')} should not be remembered`)
  }
})

test('chmod and chown are never remembered — they can lock a machine or open it up', () => {
  assert.equal(suggestPrefix(['chmod', '-R', '777', '.'], 'write'), null)
  assert.equal(suggestPrefix(['chown', '-R', 'nobody', '/'], 'write'), null)
})

// ─────────────────────── shell 包装 ───────────────────────

test('sh -c is looked through, so the rule is about the real command', () => {
  // 记成 ['sh','-c'] 就等于记住"任何 shell 命令"，那等于关掉审批
  assert.deepEqual(normalizeArgv(['sh', '-c', 'npm test']), ['npm', 'test'])
  assert.deepEqual(suggestPrefix(['sh', '-c', 'npm install lodash'], 'write'), ['npm', 'install'])
  assert.equal(suggestPrefix(['sh', '-c', 'rm -rf /'], 'write'), null)
})

test('a quoted command with spaces still tokenises sanely', () => {
  assert.deepEqual(normalizeArgv(['bash', '-lc', 'npm  run  build']), ['npm', 'run', 'build'])
})

// ─────────────────────── 规则匹配 ───────────────────────

const rule = (prefix, cwd) => ({ prefix, cwd, createdAt: '2026-01-01T00:00:00Z', uses: 1 })

test('a rule only matches from the same folder', () => {
  const r = rule(['npm', 'install'], '/proj-a')
  assert.equal(matchesRule(['npm', 'install', 'lodash'], '/proj-a', r), true)
  assert.equal(matchesRule(['npm', 'install', 'lodash'], '/proj-b', r), false)
  assert.equal(matchesRule(['npm', 'install', 'lodash'], '/proj-a/sub', r), false)
})

test('a rule is a prefix match, not a substring match', () => {
  const r = rule(['npm', 'install'], '/p')
  assert.equal(matchesRule(['npm', 'install'], '/p', r), true)
  assert.equal(matchesRule(['npm', 'install', 'x'], '/p', r), true)
  // `npm run install-everything` 不是 `npm install`
  assert.equal(matchesRule(['npm', 'run', 'install-everything'], '/p', r), false)
  // 反过来更短也不行
  assert.equal(matchesRule(['npm'], '/p', r), false)
})

test('a remembered npm install never lets rm through', () => {
  const r = rule(['npm', 'install'], '/p')
  assert.equal(matchesRule(['rm', '-rf', '/'], '/p', r), false)
  assert.equal(matchesRule(['rm', '-rf', 'node_modules'], '/p', r), false)
})

test('a remembered rm -rf node_modules does not let rm -rf src through', () => {
  // 精确匹配的价值全在这条断言上：批了删 node_modules，不等于允许删源码
  const r = rule(['rm', '-rf', 'node_modules'], '/p')
  assert.equal(matchesRule(['rm', '-rf', 'node_modules'], '/p', r), true)
  assert.equal(matchesRule(['rm', '-rf', 'src'], '/p', r), false)
  assert.equal(matchesRule(['rm', '-rf', '~'], '/p', r), false)
  assert.equal(matchesRule(['rm', '-rf', '/'], '/p', r), false)
})

// ─────────────────────── 存储 ───────────────────────

test('rules round-trip through the file and are not duplicated', () => {
  assert.deepEqual(loadRules(), [])
  addRule(['npm', 'install'], '/proj-a')
  addRule(['npm', 'install'], '/proj-a')   // 同一条，只加计数
  addRule(['cargo', 'test'], '/proj-a')

  const rules = loadRules()
  assert.equal(rules.length, 2)
  const npm = rules.find((r) => r.prefix[0] === 'npm')
  assert.equal(npm.uses, 2)
  assert.equal(npm.cwd, '/proj-a')
})

test('the same prefix in two folders are two separate rules', () => {
  addRule(['npm', 'install'], '/proj-b')
  const both = loadRules().filter((r) => r.prefix.join(' ') === 'npm install')
  assert.equal(both.length, 2)
})

test('a rule can be forgotten', () => {
  assert.equal(removeRule(['cargo', 'test'], '/proj-a'), true)
  assert.equal(removeRule(['cargo', 'test'], '/proj-a'), false, 'removing twice is a no-op')
  assert.ok(!loadRules().some((r) => r.prefix[0] === 'cargo'))
})

test('a corrupt rules file degrades to "ask every time" instead of throwing', () => {
  fs.writeFileSync(path.join(tmpHome, 'approval-rules.json'), '{not json')
  assert.deepEqual(loadRules(), [])
  // 而且还能重新写回一份好的
  addRule(['npm', 'test'], '/p')
  assert.equal(loadRules().length, 1)
})

test('the rules file is not world-readable', { skip: process.platform === 'win32' }, () => {
  const mode = fs.statSync(path.join(tmpHome, 'approval-rules.json')).mode & 0o777
  assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`)
})
