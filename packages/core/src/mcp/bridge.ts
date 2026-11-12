/**
 * 把 MCP server 的工具桥接成 harness 工具。
 *
 * 命名：`mcp__<server>__<tool>`。前缀不是装饰——它让模型一眼看出这个工具
 * 受不受本地沙箱约束（答案是不受），也让用户在事件日志里能直接看出流量走向。
 */
import { McpClient } from './client.ts'
import type { McpServerConfig } from './client.ts'

export interface McpToolDef {
  /** 暴露给模型的名字：mcp__server__tool */
  name: string
  server: string
  tool: string
  description: string
  schema: Record<string, unknown>
}

export interface McpServerStatus {
  name: string
  transport: 'stdio' | 'http'
  tools: number
  error?: string
}

const NS = 'mcp__'

export function qualify(server: string, tool: string): string {
  return `${NS}${server}__${tool}`
}

export class McpRegistry {
  private clients = new Map<string, McpClient>()
  private byTool = new Map<string, { server: string; tool: string }>()
  private defs: McpToolDef[] = []
  readonly status: McpServerStatus[] = []

  get tools(): McpToolDef[] {
    return this.defs
  }

  get isEmpty(): boolean {
    return this.defs.length === 0
  }

  has(name: string): boolean {
    return this.byTool.has(name)
  }

  /** 连接所有配置的 server。单个失败不影响其它，也不能让整个 run 起不来。 */
  async start(servers: Record<string, McpServerConfig>): Promise<void> {
    const entries = Object.entries(servers)
    await Promise.all(entries.map(async ([name, cfg]) => {
      const client = new McpClient(name, cfg)
      const transport: 'stdio' | 'http' = cfg.url ? 'http' : 'stdio'
      try {
        await client.connect()
        const tools = await client.listTools()
        this.clients.set(name, client)
        for (const t of tools) {
          const qualified = qualify(name, t.name)
          this.byTool.set(qualified, { server: name, tool: t.name })
          this.defs.push({
            name: qualified,
            server: name,
            tool: t.name,
            description: `[MCP:${name}] ${t.description ?? ''}`.trim() + ' (runs outside the local sandbox)',
            schema: t.inputSchema ?? { type: 'object', properties: {} },
          })
        }
        this.status.push({ name, transport, tools: tools.length })
      } catch (err) {
        await client.close().catch(() => { /* ignore */ })
        this.status.push({
          name,
          transport,
          tools: 0,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }))
  }

  async call(name: string, args: Record<string, unknown>): Promise<{ content: string; isError: boolean }> {
    const target = this.byTool.get(name)
    if (!target) return { content: `ERROR: unknown MCP tool ${name}`, isError: true }
    const client = this.clients.get(target.server)
    if (!client) return { content: `ERROR: MCP server ${target.server} is not connected`, isError: true }
    const res = await client.callTool(target.tool, args)
    return { content: res.content, isError: res.isError }
  }

  async close(): Promise<void> {
    await Promise.all([...this.clients.values()].map((c) => c.close().catch(() => { /* ignore */ })))
    this.clients.clear()
  }
}
