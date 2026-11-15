/**
 * YAML 块标量要拼成一句完整的话。
 *
 * 很多真实技能的 frontmatter 是：
 *   description: >
 *     AI-driven presentation workflow for ...
 *     Use when the user asks to ...
 * 只按「键: 值」逐行解析的话，description 的值就是「>」——技能列表里整个简介
 * 变成一个箭头，模型拿到的技能索引也是「ppt-master: >」，等于没有描述。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('folded and literal block scalars become real text', async () => {
  const root = mkdtempSync(join(tmpdir(), 'uh-fm-'))
  const home = join(root, 'home')
  const ws = join(root, 'ws')
  mkdirSync(join(home, 'skills', 'folded'), { recursive: true })
  mkdirSync(join(home, 'skills', 'literal'), { recursive: true })
  mkdirSync(ws, { recursive: true })
  const prev = process.env.UH_HOME
  process.env.UH_HOME = home
  try {
    writeFileSync(join(home, 'skills', 'folded', 'SKILL.md'),
      '---\nname: folded\ndescription: >\n  first line here\n  second line here\n---\n\nbody\n')
    writeFileSync(join(home, 'skills', 'literal', 'SKILL.md'),
      '---\nname: literal\ndescription: |\n  保留换行\n---\n\nbody\n')

    const { discoverSkills } = await import('../packages/core/src/skill/registry.ts')
    const skills = discoverSkills(ws)
    const folded = skills.find((s) => s.name === 'folded')
    const literal = skills.find((s) => s.name === 'literal')
    assert.ok(folded && literal)
    assert.equal(folded.description, 'first line here second line here')
    assert.equal(literal.description, '保留换行')
    assert.notEqual(folded.description, '>')
  } finally {
    if (prev === undefined) delete process.env.UH_HOME
    else process.env.UH_HOME = prev
    rmSync(root, { recursive: true, force: true })
  }
})
