/**
 * 选择器在非终端下的退路。
 *
 * 交互列表靠 stdin 的 keypress 工作。没有终端就没有按键——这时候如果它还
 * 坚持等用户按方向键，脚本会静默挂死（比报错难查得多）。所以 pickList 必须
 * 自己认出「这里没有终端」并立刻返回 null，让调用方退回文字输入。
 *
 * 真终端里的行为（高亮、方向键、筛选、Enter）用 pty 手工验过：
 *   /model → ↓ → Enter → config.json 里 model 变了；
 *   /config approval → ↓ → Enter → approval 变成 auto；
 *   打字 nomic → Enter 选中带 nomic 的那项；Esc 什么都不改。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(process.cwd(), 'dist', 'uh.cjs')

/** 用 node 的 type-stripping 直接跑那个 .ts，拿到真实行为而不是复制一份逻辑 */
function callPick(code) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--experimental-strip-types', '-e', code], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15000,
    })
    let s = ''
    p.stdout.on('data', (d) => (s += String(d)))
    p.stderr.on('data', (d) => (s += String(d)))
    p.on('close', (c) => (c === 0 ? resolve(s) : reject(new Error('exit ' + c + '\n' + s))))
  })
}

test('pickList refuses to wait for keystrokes when stdin is not a terminal', async () => {
  const out = await callPick(`
    const m = await import('./packages/cli/src/picker.ts');
    const r = await m.pickList([{label:'alpha',value:'alpha'},{label:'beta',value:'beta'}], {current:'beta'});
    console.log('RESULT:', JSON.stringify(r));
  `)
  assert.match(out, /RESULT: null/, 'no tty means "no answer", not a hang:\n' + out)
})

test('pickList also bails on an empty list', async () => {
  const out = await callPick(`
    const m = await import('./packages/cli/src/picker.ts');
    const r = await m.pickList([]);
    console.log('RESULT:', JSON.stringify(r));
  `)
  assert.match(out, /RESULT: null/)
})

test('a paired device token is stored only as a digest', async () => {
  const home = mkdtempSync(join(tmpdir(), 'uh-pair-'))
  try {
    await new Promise((resolve) => {
      const p = spawn(process.execPath, [CLI, 'pair', '--name', 'iPhone'], {
        env: { ...process.env, UH_HOME: home, NO_COLOR: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      p.on('close', resolve)
    })
    const devices = JSON.parse(readFileSync(join(home, 'devices.json'), 'utf8'))
    assert.equal(devices.devices.length, 1)
    const d = devices.devices[0]
    assert.ok(!('token' in d), 'the token itself must never be on disk')
    assert.match(d.hash, /^[0-9a-f]{64}$/, 'only the sha256 digest is kept')
    assert.equal(d.name, 'iPhone')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
