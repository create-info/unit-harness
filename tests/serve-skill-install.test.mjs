/**
 * 在设置页里加装 skill：贴一段 / 给个链接 / 指个目录。
 *
 * 这三种来源最后都必须落到同一件事上——<skills 根>/<name>/SKILL.md 这一个目录。
 * 因为发现逻辑（discoverSkills）只认磁盘，没有第二份注册表可以忘掉同步；
 * 测试也就照着这个来验：装完能在 /api/plugins 里看到，删掉目录就自动消失。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import http from 'node:http'
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

/** 假的远端：只服务一个 SKILL.md，免得测试依赖外网 */
async function serveSkillMd(text) {
  const srv = http.createServer((req, res) => {
    if (req.url?.endsWith('.md')) {
      res.writeHead(200, { 'content-type': 'text/markdown' })
      res.end(text)
      return
    }
    res.writeHead(404)
    res.end('nope')
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${srv.address().port}/sample.md`, close: () => srv.close() }
}

const FM = (name, desc) => `---\nname: ${name}\ndescription: ${desc}\n---\n\n正文\n`

test('a skill can be installed by pasting, by url, or from a directory', async () => {
  const home = mkdtempSync(join(tmpdir(), 'uh-skills-'))
  const ws = join(home, 'work')
  mkdirSync(ws, { recursive: true })
  const port = await freePort()

  // 目录来源：带 scripts/ 的完整 skill
  const src = join(home, 'src-skill')
  mkdirSync(join(src, 'scripts'), { recursive: true })
  writeFileSync(join(src, 'SKILL.md'), FM('from-dir', '从目录装'))
  writeFileSync(join(src, 'scripts', 'run.sh'), '#!/bin/sh\necho hi\n')

  const remote = await serveSkillMd(FM('from-url', '从链接装'))
  const child = spawn(process.execPath, [CLI, 'serve', '--port', String(port), '--workspace', ws], {
    env: { ...process.env, UH_HOME: home, NO_COLOR: '1', UH_BUILTIN_SKILLS: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const post = (body) => fetch(`http://127.0.0.1:${port}/api/plugins/skill`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  const names = async () => (await (await fetch(`http://127.0.0.1:${port}/api/plugins`)).json())
    .skills.map((s) => s.name).sort()

  try {
    await waitUp(port)

    // 1. 粘贴：正文直接落盘
    const c = await post({ mode: 'content', name: 'pasted', content: FM('pasted', '贴进来的') })
    assert.equal(c.status, 200)
    const pastedDir = join(home, 'skills', 'pasted')
    assert.ok(existsSync(join(pastedDir, 'SKILL.md')))
    assert.match(readFileSync(join(pastedDir, 'SKILL.md'), 'utf8'), /description: 贴进来的/)

    // 2. 链接：SKILL.md 自己写的 name 优先，没有才退到文件名（sample.md -> sample）
    const u = await post({ mode: 'url', url: remote.url })
    assert.equal(u.status, 200)
    assert.equal((await u.json()).name, 'from-url', 'frontmatter 里的 name 是准的')

    // 3. 目录：整目录搬，scripts/ 也要跟着来（不然技能里引用的脚本是空的）
    const d = await post({ mode: 'path', path: src })
    assert.equal(d.status, 200)
    assert.ok(existsSync(join(home, 'skills', 'from-dir', 'scripts', 'run.sh')))

    assert.deepEqual(await names(), ['from-dir', 'from-url', 'pasted'])

    // 4. 重名不覆盖：那可能正是用户在用的那份
    assert.equal((await post({ mode: 'content', name: 'pasted', content: 'boom' })).status, 409)
    assert.match(readFileSync(join(pastedDir, 'SKILL.md'), 'utf8'), /贴进来的/)

    // 5. 名字会变成目录名：非法字符与穿越一律拒绝
    assert.equal((await post({ mode: 'content', name: '../evil', content: 'x' })).status, 400)
    assert.equal((await post({ mode: 'content', name: '', content: 'x' })).status, 400)
    assert.equal(existsSync(join(home, 'evil')), false)

    // 6. 装到项目里时落在工作区的 .uh/skills，而不是全局
    const p = await post({ mode: 'content', name: 'proj-only', content: FM('proj-only', '仅本项目'), scope: 'project' })
    assert.equal(p.status, 200)
    assert.ok(existsSync(join(ws, '.uh', 'skills', 'proj-only', 'SKILL.md')))
    assert.ok(!existsSync(join(home, 'skills', 'proj-only')))

    // 7. 删掉目录就等于卸载：发现逻辑只认磁盘，没有第二份注册表
    rmSync(pastedDir, { recursive: true, force: true })
    assert.ok(!(await names()).includes('pasted'))
  } finally {
    remote.close()
    child.kill('SIGKILL')
    rmSync(home, { recursive: true, force: true })
  }
})
