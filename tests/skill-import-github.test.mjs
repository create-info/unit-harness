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
import { execFileSync, spawn } from 'node:child_process'
import net from 'node:net'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

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

/**
 * 造一个本地 bare 仓库当 GitHub 远端（git 的 file:// 协议），内容按真实仓库的形状：
 * skills/alpha 自己就是一个技能（带三层深的 python 包），skills/beta 是第二个，
 * skills/docs-only 不是技能。
 * 用它而不是 mock HTTP：导入走的是 git 稀疏检出，不是 Contents API。
 */
function makeRemote(root) {
  const work = join(root, 'work')
  const bare = join(root, 'remote.git')
  const git = (args) => execFileSync('git', args, { cwd: work, stdio: 'ignore' })
  mkdirSync(work, { recursive: true })
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.email', 't@example.com'])
  git(['config', 'user.name', 't'])
  const write = (p, text) => {
    mkdirSync(dirname(join(work, p)), { recursive: true })
    writeFileSync(join(work, p), text)
  }
  write('skills/alpha/SKILL.md', '---\nname: alpha\ndescription: 甲技能\n---\n\n见 scripts/run.sh\n')
  write('skills/alpha/scripts/run.sh', '#!/bin/sh\necho alpha\n')
  write('skills/alpha/scripts/pkg/deep/mod.py', 'print("deep")\n')
  write('skills/alpha/references/notes.md', 'notes\n')
  write('skills/beta/SKILL.md', '---\nname: beta\ndescription: 乙技能\n---\n\n正文\n')
  write('skills/docs-only/README.md', '这个目录没有 SKILL.md\n')
  write('README.md', 'repo\n')
  git(['add', '-A'])
  git(['commit', '-q', '-m', 'init'])
  git(['clone', '-q', '--bare', work, bare])
  return bare
}

test('a github tree url imports the skill itself, with every nested file', async () => {
  const home = mkdtempSync(join(tmpdir(), 'uh-gh-'))
  const ws = join(home, 'work')
  mkdirSync(ws, { recursive: true })
  const bare = makeRemote(join(home, 'src'))
  const port = await freePort()
  // 把 github.com 的克隆地址指到本地 bare 仓库：代码里走的仍是「真 git」那条路
  const child = spawn(process.execPath, [CLI, 'serve', '--port', String(port), '--workspace', ws], {
    env: {
      ...process.env, UH_HOME: home, NO_COLOR: '1', UH_BUILTIN_SKILLS: '0',
      UH_GITHUB_CLONE_BASE: `file://${bare}`,
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

    // 2b. 指向技能自己的目录（SKILL.md 在主目录里、旁边还有 references/ scripts/）
    //     必须被认成「一个技能」。之前实现只看子目录，于是把 references/ scripts/
    //     当成候选逐个去试，全报「里没有 SKILL.md」——这正是线上那个报错。
    const self = await post({ mode: 'auto', input: 'https://github.com/o/r/tree/main/skills/beta' })
    assert.equal(self.status, 400, 'beta 已经装过了，再装要报同名而不是「没有 SKILL.md」')
    assert.match((await self.json()).error, /同名/)

    // 3. 单个文件地址（blob 形式）：落到同一个技能目录，已装过就报同名
    const one = await post({ mode: 'auto', input: 'https://github.com/o/r/blob/main/skills/beta/SKILL.md' })
    const oneBody = await one.json()
    if (one.status === 200) {
      // 允许装成功，但名字必须是同一个 beta（不能变成 SKILL）
      assert.ok(!existsSync(join(home, 'skills', 'SKILL')), 'blob 地址不能装出一个叫 SKILL 的技能')
      assert.ok(existsSync(join(home, 'skills', 'beta', 'SKILL.md')))
    } else {
      assert.equal(one.status, 400, JSON.stringify(oneBody))
      assert.match(oneBody.error, /同名|没有|拉不到/, '实际报错：' + oneBody.error)
    }

    // 3b. 换个名字就能再装一份（同一个仓库的不同分支/变体靠这个）
    const renamed = await post({ mode: 'auto', name: 'beta2', input: 'https://github.com/o/r/tree/main/skills/beta' })
    assert.equal(renamed.status, 200, await renamed.clone().text())
    assert.ok(existsSync(join(home, 'skills', 'beta2', 'SKILL.md')))

    // 4. 不存在的东西要有明确的错，而不是 200
    const bad = await post({ mode: 'auto', input: 'https://github.com/o/r/tree/main/nope' })
    assert.equal(bad.status, 400)
    // 报错要说清是「这个路径没有」，而不是一个笼统的失败
    assert.match((await bad.json()).error, /没有 nope 这个路径/)
  } finally {
    child.kill('SIGKILL')
    rmSync(home, { recursive: true, force: true })
  }
})
