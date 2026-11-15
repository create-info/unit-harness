/**
 * 技能是个目录，项目是个列表项——两者都要能管。
 *
 * 钉住的点：
 *  - 技能详情要列出目录里所有文件（scripts/ 之类），不只是 SKILL.md；
 *  - 文件能读、能改、能新建（父目录自动建）、能删；
 *  - 路径来自 HTTP，`../` 一律拒绝，绝不能顺着它读写 skill 目录外面；
 *  - 项目只做改名和「从列表移除」：移除不动磁盘，而且移除的若是当前项目要换一个。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import net from 'node:net'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(process.cwd(), 'dist', 'uh.cjs')

async function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port
      s.close(() => resolve(port))
    })
  })
}

async function waitUp(port) {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/manifest.webmanifest`)).ok) return
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error('server did not come up')
}

function seedSession(home, id, workspace, label) {
  const d = new Date()
  const dir = join(home, 'sessions', String(d.getFullYear()),
    String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'), id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({
    id, created_at: d.toISOString(), updated_at: d.toISOString(),
    workspace, harness_version: 'test', status: 'ended', last_seq: 1, label,
  }))
  writeFileSync(join(dir, 'events.jsonl'), '')
}

test('a skill directory can be inspected and edited file by file', async () => {
  const home = mkdtempSync(join(tmpdir(), 'uh-skilldir-'))
  const ws = join(home, 'work')
  mkdirSync(ws, { recursive: true })

  // 一个「像个真技能」的目录：说明 + 脚本 + 资料
  const sk = join(home, 'skills', 'demo')
  mkdirSync(join(sk, 'scripts'), { recursive: true })
  writeFileSync(join(sk, 'SKILL.md'), '---\nname: demo\ndescription: 走查\n---\n\n正文\n')
  writeFileSync(join(sk, 'scripts', 'run.sh'), '#!/bin/sh\necho hi\n')

  const port = await freePort()
  const child = spawn(process.execPath, [CLI, 'serve', '--port', String(port), '--workspace', ws], {
    env: { ...process.env, UH_HOME: home, NO_COLOR: '1', UH_BUILTIN_SKILLS: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const base = `http://127.0.0.1:${port}`
  const post = (p, body) => fetch(base + p, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })

  try {
    await waitUp(port)

    // 1. 详情：目录里的子文件也要列出来（这才是「技能不只是 md」）
    const detail = await (await fetch(base + '/api/plugins/skill?name=demo')).json()
    assert.equal(detail.isDir, true)
    assert.deepEqual(detail.files.map((f) => f.path).sort(), ['SKILL.md', 'scripts/run.sh'])

    // 2. 读文件
    const f1 = await (await fetch(base + '/api/plugins/skill/file?name=demo&path=scripts/run.sh')).json()
    assert.match(f1.text, /echo hi/)

    // 3. 改文件（name 在 body 里，不在查询串里——这条曾经让保存永远失败）
    assert.equal((await post('/api/plugins/skill/file', { name: 'demo', path: 'SKILL.md', text: '改过了\n' })).status, 200)
    assert.equal(readFileSync(join(sk, 'SKILL.md'), 'utf8'), '改过了\n')

    // 4. 新建文件：父目录自动建
    assert.equal((await post('/api/plugins/skill/file', { name: 'demo', path: 'references/notes.md', text: '资料\n' })).status, 200)
    assert.ok(existsSync(join(sk, 'references', 'notes.md')))

    // 5. 路径越界：读和写都要拒绝
    assert.equal((await fetch(base + '/api/plugins/skill/file?name=demo&path=../../config.json')).status, 400)
    assert.equal((await post('/api/plugins/skill/file', { name: 'demo', path: '../../../evil.txt', text: 'x' })).status, 400)
    assert.ok(!existsSync(join(home, 'evil.txt')), '不能写到 skill 目录外面')

    // 6. 删单个文件，再删整个技能
    assert.equal((await post('/api/plugins/skill/file/delete', { name: 'demo', path: 'references/notes.md' })).status, 200)
    assert.ok(!existsSync(join(sk, 'references', 'notes.md')))
    assert.equal((await post('/api/plugins/skill/delete', { name: 'demo' })).status, 200)
    assert.ok(!existsSync(sk), '整个技能目录应被删除')
  } finally {
    child.kill('SIGKILL')
    rmSync(home, { recursive: true, force: true })
  }
})

test('projects can be renamed and hidden, and hiding never touches the disk', async () => {
  const home = mkdtempSync(join(tmpdir(), 'uh-proj-'))
  const a = join(home, 'proj-a')
  const b = join(home, 'proj-b')
  mkdirSync(a, { recursive: true })
  mkdirSync(b, { recursive: true })
  seedSession(home, 'sess-a', a, '在 a 里')
  seedSession(home, 'sess-b', b, '在 b 里')

  const port = await freePort()
  const child = spawn(process.execPath, [CLI, 'serve', '--port', String(port), '--workspace', a], {
    env: { ...process.env, UH_HOME: home, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const base = `http://127.0.0.1:${port}`
  const post = (p, body) => fetch(base + p, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  const list = async () => (await (await fetch(base + '/api/projects')).json()).projects

  try {
    await waitUp(port)
    assert.equal((await list()).length, 2)

    // 1. 改名：只是列表里的称呼
    assert.equal((await post('/api/project/rename', { path: a, name: '演示项目' })).status, 200)
    assert.equal((await list()).find((p) => p.path === a)?.name, '演示项目')

    // 2. 移除：从列表消失，目录还在
    const rm = await post('/api/project/remove', { path: a })
    assert.equal(rm.status, 200)
    assert.ok(!(await list()).some((p) => p.path === a), '被移除的项目不再出现')
    assert.ok(existsSync(a), '磁盘目录必须还在')

    // 3. 移除的是当前项目：要换到别的项目，不能停在一个看不见的项目里
    assert.notEqual((await rm.json()).current, a)
    assert.equal((await list()).some((p) => p.path === b), true)
  } finally {
    child.kill('SIGKILL')
    rmSync(home, { recursive: true, force: true })
  }
})
