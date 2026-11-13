/**
 * 沙箱：不只「关得住」，还要「干得动」。
 *
 * 之前只测了「写工作区外被拒」，于是 git / npm 在沙箱里全挂这件事没被发现：
 * 关得住一个什么都干不了的环境，等于不可用。这里两头都要钉住。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import os, { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(process.cwd(), 'dist', 'uh.cjs')

/** Windows 上没有 landlock/seatbelt，也不是这套 shell 语义 */
const POSIX_ONLY = process.platform === 'win32' ? 'posix-only' : false

function run(home, args) {
  const r = spawnSync(process.execPath, [CLI, 'exec', ...args], {
    env: { ...process.env, UH_HOME: home },
    encoding: 'utf8',
    timeout: 30_000,
  })
  return { out: (r.stdout ?? '') + (r.stderr ?? ''), code: r.status }
}

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'uh-sbx-'))
  const work = join(home, 'work')
  mkdirSync(work, { recursive: true })
  return { home, work }
}

test('the sandbox can still read tool configs in $HOME', { skip: POSIX_ONLY }, () => {
  const { home, work } = setup()
  // $HOME 是真实用户目录，不是 UH_HOME——沙箱里运行的 git 读的也是真实那个。
  // 所以探针必须放在真实 home 下，跑完删掉。
  const probe = join(os.homedir(), `.uh-probe-${process.pid}`)
  try {
    writeFileSync(probe, 'PROBE_VALUE\n')
    const r = run(home, ['--', 'sh', '-c', `cd ${work} && cat "${probe}"`])
    assert.match(r.out, /PROBE_VALUE/,
      'if $HOME is unreadable, git says "fatal: 读取配置文件时遇到未知错误" and npm/pip behave similarly')
  } finally {
    rmSync(probe, { force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test('--no-home still tightens it, for people who want that', { skip: POSIX_ONLY }, () => {
  const { home, work } = setup()
  const probe = join(os.homedir(), `.uh-probe-${process.pid}-no`)
  try {
    writeFileSync(probe, 'PROBE_VALUE\n')
    const r = run(home, ['--no-home', '--', 'sh', '-c', `cd ${work} && cat "${probe}"`])
    assert.equal(r.out.includes('PROBE_VALUE'), false, 'the opt-out must actually take $HOME away')
  } finally {
    rmSync(probe, { force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test('writes outside the workspace are still refused', { skip: POSIX_ONLY }, () => {
  const { home, work } = setup()
  try {
    const r = run(home, ['--', 'sh', '-c', `cd ${work} && touch "$HOME/pwned.txt"`])
    assert.equal(existsSync(join(home, 'pwned.txt')), false, 'this is the whole point of the sandbox')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('caches are pointed inside the workspace so package managers work', { skip: POSIX_ONLY }, () => {
  const { home, work } = setup()
  try {
    // 不真的装包：只看环境变量指哪儿。npm 写 ~/.npm 被拦就是 EACCES，
    // 这是「沙箱里装不了依赖」的真正原因。
    const r = run(home, ['--', 'sh', '-c',
      `cd ${work} && echo "$NPM_CONFIG_CACHE|$TMPDIR|$XDG_CACHE_HOME"`])
    const line = r.out.trim().split('\n').pop()
    for (const p of line.split('|')) {
      assert.ok(p.startsWith(work), `expected a path inside the workspace, got ${p}`)
      assert.ok(existsSync(p), `${p} should have been created`)
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
