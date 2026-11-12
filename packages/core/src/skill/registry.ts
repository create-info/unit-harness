/**
 * Skills：按需加载的指令包。
 *
 * 结构借鉴 DeepSeek Harness 的 skill-filesystem provider：
 *   - 从多个 root 扫描，发现 `<name>/SKILL.md` 或扁平的 `<name>.md`
 *   - frontmatter 提供 name / description
 *   - 索引（名字 + 一句话）常驻上下文，正文只在 `use_skill` 时才加载
 *
 * 这个"索引常驻、正文按需"的分工是关键：把几十个 skill 的正文全塞进 prompt 会
 * 直接吃光窗口，而只放索引又能让模型知道"有这么个东西可以用"。
 */
import fs from 'node:fs'
import path from 'node:path'
import { uhHome } from '../paths.ts'

export interface Skill {
  name: string
  description: string
  /** 完整路径，用于审计与调试 */
  path: string
  /** 正文（不含 frontmatter） */
  body: string
  /** 来源 root，便于解释"为什么这个 skill 在这里" */
  root: string
}

export interface SkillRoot {
  dir: string
  rank: number
  label: string
}

/** 扫描顺序：项目内的优先于全局的（同名时后者被覆盖） */
export function skillRoots(cwd: string): SkillRoot[] {
  return [
    { dir: path.join(cwd, '.uh', 'skills'), rank: 100, label: 'project' },
    { dir: path.join(cwd, '.agents', 'skills'), rank: 200, label: 'project-agents' },
    { dir: path.join(uhHome(), 'skills'), rank: 300, label: 'user' },
  ]
}

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw)
  if (!m) return { meta: {}, body: raw.trim() }
  const meta: Record<string, string> = {}
  for (const line of (m[1] as string).split('\n')) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim())
    if (kv) meta[kv[1] as string] = (kv[2] as string).replace(/^["']|["']$/g, '').trim()
  }
  return { meta, body: raw.slice(m[0].length).trim() }
}

/** 从 SKILL.md 里取描述：frontmatter 优先，其次第一个非标题段落 */
function describe(meta: Record<string, string>, body: string): string {
  if (meta.description) return meta.description
  for (const line of body.split('\n')) {
    const t = line.trim()
    if (t && !t.startsWith('#') && !t.startsWith('---')) return t.slice(0, 200)
  }
  return ''
}

function readSkillFile(file: string, fallbackName: string, root: string): Skill | null {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    const { meta, body } = parseFrontmatter(raw)
    const name = meta.name || fallbackName
    return { name, description: describe(meta, body), path: file, body, root }
  } catch {
    return null
  }
}

/** 发现所有 skill；同名时 rank 高的（后扫描的）胜出 */
export function discoverSkills(cwd = process.cwd()): Skill[] {
  const byName = new Map<string, Skill>()

  for (const root of skillRoots(cwd).sort((a, b) => a.rank - b.rank)) {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(root.dir, { withFileTypes: true })
    } catch {
      continue
    }

    for (const e of entries) {
      const full = path.join(root.dir, String(e.name))
      let skill: Skill | null = null

      if (e.isDirectory()) {
        const md = path.join(full, 'SKILL.md')
        if (fs.existsSync(md)) skill = readSkillFile(md, String(e.name), root.label)
      } else if (e.isFile() && String(e.name).endsWith('.md')) {
        skill = readSkillFile(full, String(e.name).replace(/\.md$/, ''), root.label)
      }

      if (skill) byName.set(skill.name, skill)
    }
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** 注入 prompt 的索引段落：只有名字和一句话 */
export function renderSkillIndex(skills: Skill[]): string {
  if (skills.length === 0) return ''
  const lines = skills.map((s) => `- ${s.name}: ${s.description || '(no description)'}`)
  return [
    '<available_skills>',
    'Load one with the `use_skill` tool when the task matches — do not guess its contents.',
    ...lines,
    '</available_skills>',
  ].join('\n')
}
