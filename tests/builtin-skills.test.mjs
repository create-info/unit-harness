/**
 * 内置技能：create-skill / code-review / debug-repro。
 *
 * 它们要真的落地成 ~/.uh/skills 下的目录，才能被 discoverSkills 看到、
 * 被设置页编辑、被 use_skill 加载。难点全在「谁说了算」：
 *   用户改过的 → 别覆盖；用户删掉的 → 别复活；原样没动的 → 随版本更新。
 * 这三条要是搞错，用户就不会再信任这个目录。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// UH_HOME 必须在 import core 之前定好：uhHome() 是每次调用读环境变量，但为了稳
// 还是先设再导入。
const home = mkdtempSync(join(tmpdir(), 'uh-builtin-'))
process.env.UH_HOME = home

const { BUILTIN_SKILLS, syncBuiltinSkills, isBuiltinSkill, discoverSkills } =
  await import('../packages/core/src/skill/builtin.ts').then(async (m) => ({
    ...m,
    discoverSkills: (await import('../packages/core/src/skill/registry.ts')).discoverSkills,
  }))

test('builtin skills land on disk, are discovered, and survive being edited or deleted', () => {
  try {
    // 1. 第一次：全部装上
    const first = syncBuiltinSkills()
    assert.deepEqual(first.installed.sort(), BUILTIN_SKILLS.map((s) => s.name).sort())

    const dir = join(home, 'skills')
    for (const s of BUILTIN_SKILLS) {
      assert.ok(existsSync(join(dir, s.name, 'SKILL.md')), s.name + ' 应该被写入磁盘')
    }

    // create-skill 必须真的教「怎么写技能」：目录结构、frontmatter、验证
    const create = readFileSync(join(dir, 'create-skill', 'SKILL.md'), 'utf8')
    assert.match(create, /name: create-skill/)
    assert.match(create, /SKILL\.md/)
    assert.match(create, /description/, '要讲清楚 description 是触发条件，不是自我介绍')
    assert.match(create, /uh skill list/, '要给出验证方式')

    // 2. 发现逻辑能看见它们（这才是「装上了」的实际含义）
    const names = discoverSkills(process.cwd()).map((s) => s.name)
    for (const s of BUILTIN_SKILLS) assert.ok(names.includes(s.name), s.name + ' 应被发现')

    // 3. 再跑一次：没有变化就不该重复写
    const again = syncBuiltinSkills()
    assert.deepEqual(again.installed, [])
    assert.deepEqual(again.updated, [])

    // 4. 用户改过的那份：一个字节都不许动
    const mine = join(dir, 'code-review', 'SKILL.md')
    writeFileSync(mine, '---\nname: code-review\ndescription: 我自己改的\n---\n\n我的版本\n')
    syncBuiltinSkills()
    assert.match(readFileSync(mine, 'utf8'), /我的版本/, '用户改过的内置技能不能被覆盖')

    // 5. 用户删掉的：不能复活
    const dbg = join(dir, 'debug-repro')
    rmSync(dbg, { recursive: true, force: true })
    syncBuiltinSkills()
    assert.ok(!existsSync(dbg), '删掉的内置技能不该在下次启动时又冒出来')

    // 6. 面板要能把它们标出来
    assert.equal(isBuiltinSkill('create-skill'), true)
    assert.equal(isBuiltinSkill('我自己的技能'), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
