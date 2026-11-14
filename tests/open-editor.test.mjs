/**
 * POST /api/open 的边界必须被测住，不能靠手点。
 *
 * 这是个「替用户启动进程」的接口：路径校验一旦有缝，一个网页就能让它打开
 * 工作区外的任何东西。所以四条必须成立：
 *   1. 工作区内的文件 → 200，并且真的去 spawn 了编辑器
 *   2. 越界路径 → 403（不是 404，它不是「找不到」，是「不许」）
 *   3. 不存在的文件 → 404
 *   4. 没给路径 → 400
 *
 * 用一个假的 UH_EDITOR（写文件的 shell 脚本）确认 spawn 真的发生了，
 * 顺便验证「指定了不存在的编辑器就退回可用的那个」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(process.cwd(), 'dist', 'uh.cjs')

function freePort() {
  return new Promise((resolve) => {
    const s = http.createServer()
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port
      s.close(() => resolve(p))
    })
  })
}

async function waitUp(port, ms = 15000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/info`)
      if (r.ok) return true
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 150))
  }
  return false
}

async function post(port, path, body) {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: r.status, body: await r.json().catch(() => ({})) }
}

test('open-in-editor: stays inside the project, and says why when it refuses', async () => {
  const root = mkdtempSync(join(tmpdir(), 'uh-open-'))
  const work = join(root, 'work')
  mkdirSync(work, { recursive: true })
  writeFileSync(join(work, 'main.go'), 'package main\n')
  // 假的编辑器：只把收到的参数写下来，不真的开窗口
  const marker = join(root, 'opened.txt')
  const fakeEditor = join(root, 'fake-editor.sh')
  writeFileSync(fakeEditor, `#!/bin/sh\necho "$@" > ${JSON.stringify(marker)}\n`)
  chmodSync(fakeEditor, 0o755)

  const port = await freePort()
  const child = spawn(process.execPath, [CLI, 'serve', '--port', String(port)], {
    cwd: work,
    env: { ...process.env, UH_HOME: join(root, '.uh'), UH_EDITOR: fakeEditor },
  })
  try {
    assert.ok(await waitUp(port), 'server did not come up')

    // 1. 工作区内 → 200，并且编辑器真的被调起来了
    const ok = await post(port, '/api/open', { path: 'main.go' })
    assert.equal(ok.status, 200, JSON.stringify(ok.body))
    assert.equal(ok.body.editor, fakeEditor)
    const end = Date.now() + 5000
    while (Date.now() < end && !existsSync(marker)) await new Promise((r) => setTimeout(r, 100))
    assert.ok(existsSync(marker), 'the editor was never started')
    // 编辑器收到的是绝对路径，而且就在这个工作区里
    const opened = readFileSync(marker, 'utf8').trim();
    assert.ok(opened.endsWith('/work/main.go'), 'editor got: ' + opened);

    // 2. 越界 → 403（不是 404：路径没写错，是不许）
    const esc = await post(port, '/api/open', { path: '../../etc/passwd' })
    assert.equal(esc.status, 403)
    assert.match(String(esc.body.error), /outside this project/)

    // 2b. 绝对路径也不行
    const abs = await post(port, '/api/open', { path: '/etc/passwd' })
    assert.equal(abs.status, 403)

    // 3. 不存在 → 404
    const miss = await post(port, '/api/open', { path: 'nope.go' })
    assert.equal(miss.status, 404)

    // 4. 空路径 → 400
    const empty = await post(port, '/api/open', {})
    assert.equal(empty.status, 400)
  } finally {
    child.kill('SIGTERM')
    rmSync(root, { recursive: true, force: true })
  }
})
