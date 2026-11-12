/**
 * MCP 客户端（JSON-RPC 2.0）。
 *
 * 支持两种传输：
 *  - stdio：spawn 一个子进程，逐行 JSON（绝大多数 server 都是这种）
 *  - streamable HTTP：POST JSON-RPC，响应可能是 JSON 也可能是 SSE
 *
 * 一条重要的诚实性规则：**MCP server 不在我们的沙箱里**。它们是自己起的进程，
 * 拥有用户本身的全部权限。所以每次调用都要标注 isolation: 'none'，
 * 而不是继承 harness 的 landlock/seatbelt 报告 —— 否则用户会以为那些调用被隔离了。
 */
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'

export interface McpServerConfig {
  /** stdio server：要执行的命令 */
  command?: string
  args?: string[]
  env?: Record<string, string>
  /** http server：endpoint */
  url?: string
  /** http server 的自定义头（比如 Authorization） */
  headers?: Record<string, string>
  /** 启动超时，默认 15s */
  timeoutMs?: number
}

export interface McpTool {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

export interface McpCallResult {
  content: string
  isError: boolean
  raw?: unknown
}

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: number | string | null
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

const PROTOCOL_VERSION = '2024-11-05'
const CLIENT_INFO = { name: 'unit-harness', version: '0.1.0' }

export class McpClient {
  private child: ChildProcess | null = null
  private nextId = 1
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()
  private buffer = ''
  private disposed = false

  constructor(
    readonly name: string,
    private readonly cfg: McpServerConfig,
  ) {}

  get isRemote(): boolean {
    return typeof this.cfg.url === 'string'
  }

  async connect(): Promise<void> {
    if (this.isRemote) return // HTTP 无连接状态

    const command = this.cfg.command
    if (!command) throw new Error(`E_MCP_CONFIG: server "${this.name}" has neither command nor url`)

    const isWin = process.platform === 'win32'
    this.child = spawn(command, this.cfg.args ?? [], {
      env: { ...process.env, ...(this.cfg.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: isWin, // npx / uvx 在 Windows 上是 .cmd 包装
    })

    this.child.on('exit', (code) => {
      if (this.disposed) return
      this.failAll(new Error(`E_MCP_EXIT: server "${this.name}" exited with code ${code ?? 'null'}`))
    })
    this.child.on('error', (err) => this.failAll(err))
    this.child.stdout?.setEncoding('utf8')
    this.child.stdout?.on('data', (chunk: string) => this.onData(chunk))
    // stderr 是 server 的日志，不能混进协议流
    this.child.stderr?.setEncoding('utf8')
    this.child.stderr?.on('data', () => { /* 丢弃：某些 server 会刷屏 */ })

    await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    })
    await this.notify('notifications/initialized')
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    let nl = this.buffer.indexOf('\n')
    while (nl >= 0) {
      const line = this.buffer.slice(0, nl).trim()
      this.buffer = this.buffer.slice(nl + 1)
      if (line) this.handleMessage(line)
      nl = this.buffer.indexOf('\n')
    }
  }

  private handleMessage(line: string): void {
    let msg: JsonRpcResponse
    try {
      msg = JSON.parse(line) as JsonRpcResponse
    } catch {
      return // 非 JSON 行（server 的杂项输出），忽略
    }
    if (msg.id === undefined || msg.id === null) return // 通知
    const waiting = this.pending.get(Number(msg.id))
    if (!waiting) return
    this.pending.delete(Number(msg.id))
    clearTimeout(waiting.timer)
    if (msg.error) waiting.reject(new Error(`E_MCP: ${msg.error.message}`))
    else waiting.resolve(msg.result)
  }

  private failAll(err: Error): void {
    for (const [, w] of this.pending) {
      clearTimeout(w.timer)
      w.reject(err)
    }
    this.pending.clear()
  }

  private send(payload: Record<string, unknown>): void {
    if (!this.child?.stdin?.writable) throw new Error(`E_MCP_CLOSED: server "${this.name}" is not running`)
    this.child.stdin.write(JSON.stringify(payload) + '\n')
  }

  async notify(method: string, params?: Record<string, unknown>): Promise<void> {
    if (this.isRemote) {
      await fetch(this.cfg.url as string, {
        method: 'POST',
        headers: this.httpHeaders(),
        body: JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }),
      })
      return
    }
    this.send({ jsonrpc: '2.0', method, ...(params ? { params } : {}) })
  }

  private httpHeaders(): Record<string, string> {
    return {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(this.cfg.headers ?? {}),
    }
  }

  async request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++
    const timeoutMs = this.cfg.timeoutMs ?? 30_000

    if (this.isRemote) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const res = await fetch(this.cfg.url as string, {
          method: 'POST',
          headers: this.httpHeaders(),
          body: JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }),
          signal: controller.signal,
        })
        const text = await res.text()
        if (!res.ok) throw new Error(`E_MCP_HTTP ${res.status}: ${text.slice(0, 300)}`)
        const parsed = this.parseHttpBody(res.headers.get('content-type') ?? '', text)
        if (parsed?.error) throw new Error(`E_MCP: ${parsed.error.message}`)
        return parsed?.result
      } finally {
        clearTimeout(timer)
      }
    }

    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`E_MCP_TIMEOUT: "${this.name}" did not answer ${method} within ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.send({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(err as Error)
      }
    })
  }

  /** HTTP 响应可能是纯 JSON，也可能是 SSE（data: 行） */
  private parseHttpBody(contentType: string, text: string): JsonRpcResponse | null {
    if (contentType.includes('text/event-stream')) {
      for (const line of text.split('\n')) {
        const t = line.trim()
        if (!t.startsWith('data:')) continue
        const payload = t.slice(5).trim()
        if (!payload || payload === '[DONE]') continue
        try {
          const msg = JSON.parse(payload) as JsonRpcResponse
          if (msg.id !== undefined && msg.id !== null) return msg
        } catch { /* keep scanning */ }
      }
      return null
    }
    try {
      return JSON.parse(text) as JsonRpcResponse
    } catch {
      return null
    }
  }

  async listTools(): Promise<McpTool[]> {
    const res = (await this.request('tools/list')) as { tools?: McpTool[] } | undefined
    return res?.tools ?? []
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const res = (await this.request('tools/call', { name, arguments: args })) as
      | { content?: Array<{ type: string; text?: string }>; isError?: boolean }
      | undefined

    const blocks = res?.content ?? []
    const text = blocks
      .map((b) => (b.type === 'text' ? b.text ?? '' : `[${b.type}]`))
      .join('\n')
      .trim()
    return { content: text || '(no content)', isError: res?.isError === true, raw: res }
  }

  async close(): Promise<void> {
    this.disposed = true
    this.failAll(new Error('E_MCP_CLOSED: client disposed'))
    if (this.child) {
      try { this.child.stdin?.end() } catch { /* ignore */ }
      try { this.child.kill() } catch { /* ignore */ }
      this.child = null
    }
  }
}
