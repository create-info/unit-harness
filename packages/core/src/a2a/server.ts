/**
 * A2A v1.0 服务端（JSON-RPC 绑定 + REST 别名）。
 *
 * 我们是 server 而不是 client：别的 agent / 编排器通过 AgentCard 发现我们，
 * 然后用 SendMessage 派活，用 GetTask 查进度。
 *
 * 这里刻意不实现的东西，以及原因：
 *   - pushNotifications：要有公网可回调的地址和重试队列，做一半只会让对方
 *     等一个永远不来的回调。卡上明确声明 false。
 *   - AUTH_REQUIRED 流程：我们只有可选的 bearer 令牌，没有 OAuth 授权链，
 *     所以不会把任务置成这个状态。
 *
 * 实现要点：Task 不是内存里的对象，而是**从 events.jsonl 现场推导**。
 * 进程重启、别的进程在跑任务，GetTask 一样能答对——状态本来就在日志里。
 */
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import type { AgentCard, Message, SendMessageRequest, SendMessageResponse, Task } from './types.ts'
import { ERR } from './types.ts'
import { buildAgentCard } from './card.ts'
import { taskOf, stateOf, isTerminal, type SessionView, type SessionEvent } from './task.ts'

export interface A2AHooks {
  /** 起一个任务，返回会话 id。任务在后台跑，事件写进日志。 */
  start: (text: string, ctx: { taskId: string; contextId: string }) => Promise<{ sessionId: string }>
  /** 按 id 读会话视图；读不到返回 null */
  load: (id: string) => SessionView | null
  /** 列出会话（用于 ListTasks） */
  list: () => SessionView[]
  /** 请求中断。返回 false 表示这个任务已经结束，取消不了 */
  cancel: (id: string) => boolean
}

export interface A2AServerOptions {
  host: string
  port: number
  version: string
  hooks: A2AHooks
  /** 设置后要求 Authorization: Bearer <token> */
  authToken?: string
  /** 对外地址；默认按 host:port 拼 */
  publicUrl?: string
  log?: (msg: string) => void
}

const JSON_TYPE = 'application/json'
const A2A_TYPE = 'application/a2a+json'

function send(res: http.ServerResponse, status: number, body: unknown, type = JSON_TYPE) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': `${type}; charset=utf-8`,
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function rpcOk(id: unknown, result: unknown) {
  return { jsonrpc: '2.0', id: id ?? null, result }
}

function rpcErr(id: unknown, code: number, message: string, data?: unknown) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data ? { data } : {}) } }
}

async function readBody(req: http.IncomingMessage, limit = 4 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      // 不设上限的话，一个大的 body 就能把服务撑爆
      if (size > limit) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** 从 Message 里取文本。别的 agent 可能发多段（text + data），都要能读。 */
function textOf(m: Message): string {
  const parts = m?.parts ?? []
  const texts = parts.map((p) => {
    if (typeof p.text === 'string') return p.text
    if (p.data !== undefined) {
      // 空的 {} / [] 不是"内容"，当成没说话处理，否则一条空 data part 会被当成任务指令
      const s = JSON.stringify(p.data)
      return s === '{}' || s === '[]' || s === 'null' ? '' : s
    }
    return ''
  }).filter(Boolean)
  return texts.join('\n').trim()
}

export function createA2AServer(opts: A2AServerOptions) {
  const log = opts.log ?? (() => {})
  const url = opts.publicUrl ?? `http://${opts.host === '0.0.0.0' ? '127.0.0.1' : opts.host}:${opts.port}/`

  let card: AgentCard = buildAgentCard({
    url,
    version: opts.version,
    authToken: opts.authToken,
    streaming: false,
  })

  const authorized = (req: http.IncomingMessage): boolean => {
    if (!opts.authToken) return true
    const h = String(req.headers.authorization ?? '')
    return h === `Bearer ${opts.authToken}`
  }

  const taskById = (id: string, historyLength?: number): Task | null => {
    const view = opts.hooks.load(id)
    if (!view) return null
    return taskOf(view, { historyLength })
  }

  /** SendMessage / REST message:send 的共同实现 */
  const sendMessage = async (params: SendMessageRequest) => {
    const msg = params?.message
    if (!msg || typeof msg !== 'object') throw new RpcError(ERR.INVALID_PARAMS, 'message is required')
    if (msg.role !== 'ROLE_USER') throw new RpcError(ERR.INVALID_PARAMS, 'message.role must be ROLE_USER')
    if (!Array.isArray(msg.parts) || !msg.parts.length) throw new RpcError(ERR.INVALID_PARAMS, 'message.parts is required')

    const text = textOf(msg)
    if (!text) throw new RpcError(ERR.INVALID_PARAMS, 'message contains no text')

    // 带 taskId 的消息是在续跑：只回当前状态，不重新开一个任务。
    // 真正的多轮靠的是同一条会话不断追加消息，这里先如实返回现状。
    if (msg.taskId) {
      const existing = taskById(msg.taskId, params.configuration?.historyLength)
      if (!existing) throw new RpcError(ERR.TASK_NOT_FOUND, `no task ${msg.taskId}`)
      if (isTerminal(existing.status.state)) {
        throw new RpcError(ERR.UNSUPPORTED_OPERATION, `task ${msg.taskId} is already ${existing.status.state}`)
      }
      return { task: existing } satisfies SendMessageResponse
    }

    const taskId = `tsk_${randomUUID().replace(/-/g, '')}`
    const contextId = msg.contextId || `ctx_${randomUUID().replace(/-/g, '')}`
    const started = await opts.hooks.start(text, { taskId, contextId })
    if (!started?.sessionId) throw new RpcError(ERR.INTERNAL, 'task did not start')

    const view = opts.hooks.load(started.sessionId)
    if (view) {
      // 把 A2A 的 id 记在视图上，让 GetTask 能用同一个 id 查回来
      view.id = started.sessionId
      view.contextId = contextId
    }
    const task = taskById(started.sessionId, params.configuration?.historyLength)
    if (!task) throw new RpcError(ERR.INTERNAL, 'task started but cannot be read back')
    return { task } satisfies SendMessageResponse
  }

  const dispatch = async (method: string, params: Record<string, unknown>) => {
    switch (method) {
      case 'SendMessage':
        return sendMessage(params as unknown as SendMessageRequest)

      case 'GetTask': {
        const id = String(params?.id ?? '')
        if (!id) throw new RpcError(ERR.INVALID_PARAMS, 'id is required')
        const t = taskById(id, Number(params?.historyLength) || undefined)
        if (!t) throw new RpcError(ERR.TASK_NOT_FOUND, `no task ${id}`)
        return t
      }

      case 'ListTasks': {
        const views = opts.hooks.list()
        const limit = Number(params?.pageSize) || undefined
        const tasks = views.slice(0, limit ?? 100).map((v) => taskOf(v))
        return { tasks, totalSize: views.length }
      }

      case 'CancelTask': {
        const id = String(params?.id ?? '')
        if (!id) throw new RpcError(ERR.INVALID_PARAMS, 'id is required')
        const t = taskById(id)
        if (!t) throw new RpcError(ERR.TASK_NOT_FOUND, `no task ${id}`)
        if (isTerminal(t.status.state)) {
          throw new RpcError(ERR.TASK_NOT_CANCELABLE, `task is already ${t.status.state}`)
        }
        const ok = opts.hooks.cancel(id)
        if (!ok) throw new RpcError(ERR.TASK_NOT_CANCELABLE, 'task is not running in this process')
        return { ...t, status: { ...t.status, state: 'TASK_STATE_CANCELED' as const } }
      }

      case 'SendStreamingMessage':
        // 卡上声明 streaming:false。真收到也别装忙：明确拒绝比挂起好
        throw new RpcError(ERR.UNSUPPORTED_OPERATION, 'streaming is not supported; use SendMessage and poll GetTask')

      case 'GetExtendedAgentCard':
        return card

      default:
        throw new RpcError(ERR.METHOD_NOT_FOUND, `unknown method ${method}`)
    }
  }

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)

    try {
      // 发现端点不需要鉴权：客户端得先拿到卡才知道要怎么鉴权
      if (req.method === 'GET' && (u.pathname === '/.well-known/agent-card.json' || u.pathname === '/.well-known/agent.json')) {
        send(res, 200, card, A2A_TYPE)
        return
      }

      if (req.method === 'GET' && u.pathname === '/healthz') {
        send(res, 200, { ok: true })
        return
      }

      // REST 绑定的读端点
      const taskMatch = /^\/tasks\/([^/:]+)$/.exec(u.pathname)
      if (req.method === 'GET' && taskMatch) {
        if (!authorized(req)) { send(res, 401, { error: 'unauthorized' }); return }
        const t = taskById(decodeURIComponent(taskMatch[1] ?? ''))
        if (!t) { send(res, 404, { error: 'no such task' }, A2A_TYPE); return }
        send(res, 200, t, A2A_TYPE)
        return
      }
      if (req.method === 'GET' && u.pathname === '/tasks') {
        if (!authorized(req)) { send(res, 401, { error: 'unauthorized' }); return }
        const views = opts.hooks.list()
        send(res, 200, { tasks: views.map((v) => taskOf(v)), totalSize: views.length }, A2A_TYPE)
        return
      }

      if (req.method !== 'POST') {
        send(res, 405, { error: 'method not allowed' })
        return
      }

      if (!authorized(req)) {
        send(res, 401, rpcErr(null, -32000, 'unauthorized'))
        return
      }

      let raw: string
      try {
        raw = await readBody(req)
      } catch (e) {
        send(res, 413, rpcErr(null, ERR.INVALID_REQUEST, e instanceof Error ? e.message : 'body too large'))
        return
      }

      // REST 别名：POST /message:send —— 请求体直接是 SendMessageRequest
      if (u.pathname === '/message:send') {
        let body: SendMessageRequest
        try {
          body = JSON.parse(raw)
        } catch {
          send(res, 400, rpcErr(null, ERR.PARSE, 'invalid JSON'))
          return
        }
        try {
          const result = await sendMessage(body)
          send(res, 200, result, A2A_TYPE)
        } catch (e) {
          const err = e instanceof RpcError ? e : new RpcError(ERR.INTERNAL, String(e))
          send(res, 200, rpcErr(null, err.code, err.message), A2A_TYPE)
        }
        return
      }

      // JSON-RPC
      let rpc: { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> }
      try {
        rpc = JSON.parse(raw)
      } catch {
        send(res, 200, rpcErr(null, ERR.PARSE, 'invalid JSON'))
        return
      }

      if (rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string') {
        send(res, 200, rpcErr(rpc.id, ERR.INVALID_REQUEST, 'expected a JSON-RPC 2.0 request'))
        return
      }

      try {
        const result = await dispatch(rpc.method, rpc.params ?? {})
        send(res, 200, rpcOk(rpc.id, result))
      } catch (e) {
        const err = e instanceof RpcError ? e : new RpcError(ERR.INTERNAL, e instanceof Error ? e.message : String(e))
        send(res, 200, rpcErr(rpc.id, err.code, err.message))
      }
    } catch (e) {
      log(`a2a: unhandled ${e instanceof Error ? e.message : String(e)}`)
      if (!res.headersSent) send(res, 500, rpcErr(null, ERR.INTERNAL, 'internal error'))
    }
  })

  return {
    server,
    card: () => card,
    listen: () => new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(opts.port, opts.host, () => {
        server.removeListener('error', reject)
        resolve()
      })
    }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    address: () => server.address(),
  }
}

class RpcError extends Error {
  code: number
  constructor(code: number, message: string) {
    super(message)
    this.code = code
  }
}

export { RpcError, textOf, stateOf }
export type { SessionView, SessionEvent }
