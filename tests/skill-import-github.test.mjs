/**
 * 从 GitHub 导入技能。
 *
 * 用户不会自己手写 skill，最常见的是「这个仓库里的技能我想要」。所以导入必须
 * 能吃下：仓库根、tree 子目录、单个文件，以及一个 skills/ 目录里的一批技能；
 * 并且要把 scripts/ 一起带走——只拿 SKILL.md 等于装了个只会说不能做的技能。
 *
 * 这里用本地 mock 代替 api.github.com（UH_GITHUB_API 可覆盖），否则测试依赖外网。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import http from 'node:http'
import net from 'node:net'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(process.cwd(), 'dist', 'uh.cjs')

/** 一个假仓库：skills/{alpha,beta,notes-only}，alpha 带 scripts/ */
const TREE = {
  'skills': [
    { name: 'alpha', type: 'dir' },
    { name: 'beta', type: 'dir' },
    { name: 'not-a-skill', type: 'dir' },
    { name: 'README.md', type: 'file' },
  ],
  'skills/alpha': [
    { name: 'SKILL.md', type: 'file' },
    { name: 'scripts', type: 'dir' },
  ],
  'skills/alpha/scripts': [{ name: 'run.sh', type: 'file' }],
  'skills/beta': [{ name: 'SKILL.md', type: 'file' }],
  'skills/not-a-skill': [{ name: 'README.md', type: 'file' }],
  'skills/README.md': [],
}
const FILES = {
  'skills/alpha/SKILL.md': '---\nname: alpha\ndescription: 甲技能\n---\n\n正文\n',
  'skills/alpha/scripts/run.sh': '#!/bin/sh\necho alpha\n',
  'skills/beta/SKILL.md': '---\nname: beta\ndescription: 乙技能\n---\n\n正文\n',
  'skills/not-a-skill/README.md': '这个目录没有 SKILL.md\n',
}

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

/** 模仿 GitHub Contents API 的最小实现 */
async function mockGitHub() {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x')
    const m = /^\/repos\/o\/r\/contents\/?(.*)$/.exec(u.pathname)
    const raw = /^\/raw\/(.*)$/.exec(u.pathname)
    if (raw) {
      const body = FILES[decodeURIComponent(raw[1])]
      if (body === undefined) { res.writeHead(404); res.end('no'); return }
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end(body)
      return
    }
    if (!m) { res.writeHead(404); res.end('no'); return }
    const path = decodeURIComponent(m[1] ?? '')
    const base = `http://127.0.0.1:${srv.address().port}`
    if (path in FILES) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        name: path.split('/').pop(), type: 'file', path,
        download_url: `${base}/raw/${encodeURIComponent(path)}`,
      }))
      return
    }
    const listing = TREE[path]
    if (!listing) { res.writeHead(404); res.end('no'); return }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(listing.map((e) => ({
      ...e,
      path: path ? `${path}/${e.name}` : e.name,
      ...(e.type === 'file' ? { download_url: `${base}/raw/${encodeURIComponent(path ? `${path}/${e.name}` : e.name)}` } : {}),
    }))))
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  return { base: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() }
}

test('a github url imports a whole skills directory, scripts included', async () => {
  const home = mkdtempSync(join(tmpdir(), 'uh-gh-'))
  const ws = join(home, 'work')
  mkdirSync(ws, { recursive: true })
  const gh = await mockGitHub()
  const port = await freePort()
  const child = spawn(process.execPath, [CLI, 'serve', '--port', String(port), '--workspace', ws], {
    env: {
      ...process.env, UH_HOME: home, NO_COLOR: '1',
      UH_BUILTIN_SKILLS: '0', UH_GITHUB_API: gh.base,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const base = `http://127.0.0.1:${port}`
  const post = (body) => fetch(base + '/api/plugins/skill', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })

  try {
    await waitUp(port)

    // 1. 指向 skills/ 目录：里面每个带 SKILL.md 的子目录都装进来
    const r = await post({ mode: 'auto', input: 'https://github.com/o/r/tree/main/skills' })
    assert.equal(r.status, 200, await r.clone().text())
    const j = await r.json()
    assert.deepEqual((j.names ?? []).sort(), ['alpha', 'beta'], '只导入真正有 SKILL.md 的目录')

    // 2. scripts/ 必须跟着来，否则这个技能的脚本调用全是空
    const alpha = join(home, 'skills', 'alpha')
    assert.match(readFileSync(join(alpha, 'SKILL.md'), 'utf8'), /name: alpha/)
    assert.match(readFileSync(join(alpha, 'scripts', 'run.sh'), 'utf8'), /echo alpha/)
    assert.ok(existsSync(join(home, 'skills', 'beta', 'SKILL.md')))

    // 3. 单个文件地址（blob 形式）也能装
    const one = await post({ mode: 'auto', input: 'https://github.com/o/r/blob/main/skills/beta/SKILL.md' })
    assert.equal(one.status, 400, '同名已存在要报错而不是覆盖')
    assert.match((await one.json()).error, /同名/)

    // 4. 不存在的东西要有明确的错，而不是 200
    const bad = await post({ mode: 'auto', input: 'https://github.com/o/r/tree/main/nope' })
    assert.equal(bad.status, 400)
    assert.match((await bad.json()).error, /不存在/)
  } finally {
    child.kill('SIGKILL')
    gh.close()
    rmSync(home, { recursive: true, force: true })
  }
})
