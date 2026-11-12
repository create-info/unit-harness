/**
 * MCP server 配置。
 *
 * 沿用 Claude Desktop 的 `mcpServers` 结构，降低迁移成本：
 *   { "mcpServers": { "name": { "command": "...", "args": [...] } } }
 *
 * 查找顺序（后面的覆盖前面的）：~/.uh/mcp.json → <cwd>/.uh/mcp.json
 */
import fs from 'node:fs'
import path from 'node:path'
import { uhHome } from '../paths.ts'
import type { McpServerConfig } from './client.ts'

interface McpConfigFile {
  mcpServers?: Record<string, McpServerConfig>
}

export function globalMcpConfigPath(): string {
  return path.join(uhHome(), 'mcp.json')
}

export function projectMcpConfigPath(cwd: string): string {
  return path.join(cwd, '.uh', 'mcp.json')
}

function readFile(p: string): Record<string, McpServerConfig> {
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as McpConfigFile
    return parsed.mcpServers ?? {}
  } catch {
    return {}
  }
}

export interface LoadedMcp {
  servers: Record<string, McpServerConfig>
  sources: string[]
}

export function loadMcpServers(cwd = process.cwd()): LoadedMcp {
  const sources: string[] = []
  const merged: Record<string, McpServerConfig> = {}

  for (const p of [globalMcpConfigPath(), projectMcpConfigPath(cwd)]) {
    if (!fs.existsSync(p)) continue
    const servers = readFile(p)
    if (Object.keys(servers).length === 0) continue
    Object.assign(merged, servers)
    sources.push(p)
  }

  return { servers: merged, sources }
}

export interface WriteResult {
  path: string
  name: string
}

/**
 * 写入/覆盖全局 MCP server 条目。
 *
 * 文件权限固定 0600：配置里可能有 Bearer token，不能让同机其他用户读到。
 * 已存在的内容原样保留，只增改这一条。
 */
export function upsertMcpServer(name: string, config: McpServerConfig): WriteResult {
  const target = globalMcpConfigPath()
  fs.mkdirSync(path.dirname(target), { recursive: true })

  let current: McpConfigFile = {}
  try {
    current = JSON.parse(fs.readFileSync(target, 'utf8')) as McpConfigFile
  } catch { /* 不存在或损坏 → 从空开始 */ }

  const servers = { ...(current.mcpServers ?? {}) }
  servers[name] = config

  fs.writeFileSync(target, JSON.stringify({ ...current, mcpServers: servers }, null, 2) + '\n', { mode: 0o600 })
  try { fs.chmodSync(target, 0o600) } catch { /* 平台不支持则忽略 */ }
  return { path: target, name }
}

/** 删除一条；返回是否真的删掉了 */
export function removeMcpServer(name: string): boolean {
  const target = globalMcpConfigPath()
  let current: McpConfigFile
  try {
    current = JSON.parse(fs.readFileSync(target, 'utf8')) as McpConfigFile
  } catch {
    return false
  }
  const servers = { ...(current.mcpServers ?? {}) }
  if (!(name in servers)) return false
  delete servers[name]
  fs.writeFileSync(target, JSON.stringify({ ...current, mcpServers: servers }, null, 2) + '\n', { mode: 0o600 })
  return true
}
