/**
 * 输入里那三种记号：`@文件`、`$技能`、`/mcp 名字`。
 *
 * 终端和网页走同一套展开逻辑——两边各写一份，迟早会一边支持一边忘。
 * 记号本身是给人写的，展开后的块是给模型看的：
 *
 *   @src/a.ts      → <file path="src/a.ts">内容</file>（大文件只给指针）
 *   $review        → <skill name="review">SKILL.md 正文</skill>
 *   /mcp fs 读文档 → <mcp_servers>- server "fs": …</mcp_servers> + 「读文档」
 *
 * `/mcp 名字` 这样的记号在展开后要从句子里删掉：模型不该看到一条它无法执行的
 * 「命令」，它只该看到「用 fs 这个 server 来做这件事」。
 */
import fs from 'node:fs'
import path from 'node:path'
import { discoverSkills } from '../skill/registry.ts'
import { loadMcpServers } from '../mcp/config.ts'

export interface ExpandResult {
  /** 展开后的任务文本（记号已替换/剥离） */
  text: string
  /** 被内联的文件（相对路径） */
  files: string[]
  /** 被点名的 MCP server */
  servers: string[]
  /** 被加载的技能 */
  skills: string[]
  /** 记号写错/文件不存在的提示，调用方可以原样展示 */
  warnings: string[]
}

const INLINE_MAX = 16 * 1024

export function expandMentions(task: string, cwd: string): ExpandResult {
  const blocks: string[] = []
  const files: string[] = []
  const servers: string[] = []
  const skills: string[] = []
  const warnings: string[] = []

  // ---- @文件 ----
  const wanted = new Set<string>()
  for (const m of task.matchAll(/(?:^|\s)@([\w./\-]+)/g)) if (m[1]) wanted.add(m[1])
  for (const rel of [...wanted].slice(0, 12)) {
    const abs = path.resolve(cwd, rel)
    // 只能带进工作区里的文件：这个记号不该变成「读 /etc/shadow」的捷径
    if (abs !== cwd && !abs.startsWith(cwd + path.sep)) {
      warnings.push(`${rel}: outside the workspace`)
      continue
    }
    let st: fs.Stats
    try {
      st = fs.statSync(abs)
    } catch {
      warnings.push(`${rel}: no such file`)
      continue
    }
    if (!st.isFile()) continue
    if (st.size > INLINE_MAX) {
      files.push(rel)
      blocks.push(`<file path="${rel}" bytes="${st.size}">(too large to inline — open it with read_file)</file>`)
      continue
    }
    try {
      files.push(rel)
      blocks.push(`<file path="${rel}">\n${fs.readFileSync(abs, 'utf8')}\n</file>`)
    } catch {
      warnings.push(`${rel}: cannot be read`)
    }
  }

  // ---- $技能 ----
  const known = discoverSkills(cwd)
  const askSkills = new Set<string>()
  for (const m of task.matchAll(/(?:^|\s)\$([\w\-]+)/g)) if (m[1]) askSkills.add(m[1])
  for (const name of askSkills) {
    const s = known.find((k) => k.name === name)
    if (!s) {
      warnings.push(`${name}: no such skill`)
      continue
    }
    skills.push(name)
    blocks.push(`<skill name="${name}">\n${s.body}\n</skill>`)
  }

  // ---- /mcp 名字 ----
  const mcp = loadMcpServers(cwd)
  const mcpLines: string[] = []
  let rest = task
  for (const m of task.matchAll(/(?:^|\s)\/mcp\s+([\w.\-]+)/g)) {
    const name = m[1]
    if (!name) continue
    if (!mcp.servers[name]) {
      warnings.push(`${name}: no such MCP server`)
      continue
    }
    if (!servers.includes(name)) {
      servers.push(name)
      mcpLines.push(`- server "${name}": its tools are named mcp__${name}__<tool>; use them (and only fall back to your own tools if they do not cover it)`)
    }
    rest = rest.replace(new RegExp('/mcp\\s+' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'g'), '')
  }
  rest = rest.replace(/^[\s,，。]+/, '').trim()

  if (!blocks.length && !mcpLines.length) {
    return { text: task, files, servers, skills, warnings }
  }

  const head = mcpLines.length ? `<mcp_servers>\n${mcpLines.join('\n')}\n</mcp_servers>\n\n` : ''
  const attached = blocks.length ? `<attached>\n${blocks.join('\n')}\n</attached>\n\n` : ''
  // 只剩记号、没有别的话时，退回原句：空任务模型不知道要干什么
  const body = rest || task.replace(/\/(mcp\s+[\w.\-]+)|\$[\w\-]+|@[\w./\-]+/g, '').trim() || task
  return { text: head + attached + body, files, servers, skills, warnings }
}
