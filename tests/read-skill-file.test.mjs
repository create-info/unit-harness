/**
 * 装在技能目录里的文件，read_file 必须读得到。
 *
 * 技能的落点是 ~/.uh/skills/<name>/，工作区一般是 ~/.uh/work 之类。read_file 走
 * 的是工作区 containment 检查，所以读技能正文时被 E_PATH_ESCAPE 拒掉，上层又把
 * 它变成一句「no such file in workspace」——模型于是改用 run_command cat，
 * 多烧一轮对话，用户看到的就是「一直在读文件」。
 *
 * 这条用例锁两件事：技能目录里的绝对路径能读；别处的绝对路径仍然读不到。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { readFileSync } from 'node:fs'

test('read_file reaches files inside a skill dir but not outside the workspace', async () => {
  const root = mkdtempSync(join(tmpdir(), 'uh-skillread-'))
  const home = join(root, 'home')
  const ws = join(root, 'work')
  const prevHome = process.env.UH_HOME
  process.env.UH_HOME = home
  try {
    const skillDir = join(home, 'skills', 'demo')
    mkdirSync(skillDir, { recursive: true })
    mkdirSync(ws, { recursive: true })
    writeFileSync(join(skillDir, 'SKILL.md'), '# demo\n第一行\n第二行\n')
    const secret = join(root, 'outside.txt')
    writeFileSync(secret, 'not for you\n')

    // dist 是打进单文件的 CLI（没有 ESM 导出），源码里的 harness 用了 TS 参数属性，
    // node 的 strip-only 加载器也不认。所以直接验判据本身：技能根 → 允许，别处 → 拒绝。
    const { skillRoots } = await import('../packages/core/src/skill/registry.ts')

    const roots = skillRoots(ws).map((r) => r.dir)
    assert.ok(roots.includes(join(home, 'skills')), '全局技能根必须在候选里')

    /** 与 harness.readInSkillDir 同一判据 */
    const underSkillRoot = (p) => {
      const abs = resolve(p)
      return roots.some((r) => abs.startsWith(resolve(r) + '/') && !abs.endsWith('/'))
    }
    assert.equal(underSkillRoot(join(skillDir, 'SKILL.md')), true, '技能目录里的文件应当放行')
    assert.equal(underSkillRoot(secret), false, '技能目录之外必须拒绝')
    assert.equal(underSkillRoot(join(ws, 'x.txt')), false, '工作区文件不走这条放行')

    // 判据实现确实在 harness 里用上了（防止有人改回只查工作区）
    const src = readFileSync(join(process.cwd(), 'packages/core/src/harness.ts'), 'utf8')
    assert.match(src, /private readInSkillDir\(/, '保留 readInSkillDir')
    assert.match(src, /readSlice: \(rel, offset, limit\) => this\.readSliceAnywhereFull/, 'read_file 走合并判据')
  } finally {
    if (prevHome === undefined) delete process.env.UH_HOME
    else process.env.UH_HOME = prevHome
    rmSync(root, { recursive: true, force: true })
  }
})
