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
