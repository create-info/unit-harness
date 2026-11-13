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
  /** resources / prompts 是可选的，服务器常常只实现 tools */
  resources?: number
  prompts?: number
  error?: string
}

const NS = 'mcp__'

export function qualify(server: string, tool: string): string {
  return `${NS}${server}__${tool}`
}

export class McpRegistry {
  private clients = new Map<string, McpClient>()
  private byTool = new Map<string, { server: string; tool: string; prompt?: boolean; resources?: 'list' | 'read' }>()
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
        // resources / prompts 是可选能力。服务器没实现时按协议要回 -32601，
        // 这里吞掉——「这个 server 只提供 tools」不是错误。
        const resources = await client.listResources().catch(() => [])
        const prompts = await client.listPrompts().catch(() => [])
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
        for (const p of prompts) {
          const qualified = qualify(name, `prompt_${p.name}`)
          this.byTool.set(qualified, { server: name, tool: p.name, prompt: true })
          const args = p.arguments ?? []
          this.defs.push({
            name: qualified,
            server: name,
            tool: p.name,
            description: `[MCP:${name}] prompt template: ${p.description ?? p.name}`
              + (args.length ? ` (takes: ${args.map((a) => a.name + (a.required ? '' : '?')).join(', ')})` : '')
              + ' (runs outside the local sandbox)',
            schema: {
              type: 'object',
              properties: Object.fromEntries(args.map((a) => [a.name, { type: 'string', description: a.description ?? '' }])),
              ...(args.some((a) => a.required) ? { required: args.filter((a) => a.required).map((a) => a.name) } : {}),
            },
          })
        }
        // 资源不逐个变成工具：一个 server 可能有几百个，展开就把工具表淹了。
        // 两个动词代替：列出来、按 uri 读。
        if (resources.length > 0) {
          const listName = qualify(name, 'list_resources')
          this.byTool.set(listName, { server: name, tool: '', resources: 'list' })
          this.defs.push({
            name: listName,
            server: name,
            tool: 'list_resources',
            description: `[MCP:${name}] list the ${resources.length} resources this server exposes (uri + name)`,
            schema: { type: 'object', properties: {} },
          })
          const readName = qualify(name, 'read_resource')
          this.byTool.set(readName, { server: name, tool: '', resources: 'read' })
          this.defs.push({
            name: readName,
            server: name,
            tool: 'read_resource',
            description: `[MCP:${name}] read one resource by uri (get uris from list_resources)`,
            schema: {
              type: 'object',
              properties: { uri: { type: 'string', description: 'the resource uri' } },
              required: ['uri'],
            },
          })
        }
        this.status.push({ name, transport, tools: tools.length, resources: resources.length, prompts: prompts.length })
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
    if (target.resources === 'list') {
      const list = await client.listResources()
      if (!list.length) return { content: '(no resources)', isError: false }
      return { content: list.map((r) => `${r.uri}\t${r.name ?? ''}${r.mimeType ? '\t' + r.mimeType : ''}`).join('\n'), isError: false }
    }
    if (target.resources === 'read') {
      const uri = String(args.uri ?? '')
      if (!uri) return { content: 'ERROR: read_resource needs a uri', isError: true }
      try {
        return { content: await client.readResource(uri), isError: false }
      } catch (err) {
        return { content: `ERROR: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    }
    if (target.prompt) {
      const strArgs: Record<string, string> = {}
      for (const [k, v] of Object.entries(args)) if (v !== undefined && v !== null) strArgs[k] = String(v)
      try {
        return { content: await client.getPrompt(target.tool, strArgs), isError: false }
      } catch (err) {
        return { content: `ERROR: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    }
    const res = await client.callTool(target.tool, args)
    return { content: res.content, isError: res.isError }
  }

  async close(): Promise<void> {
    await Promise.all([...this.clients.values()].map((c) => c.close().catch(() => { /* ignore */ })))
    this.clients.clear()
  }
}
