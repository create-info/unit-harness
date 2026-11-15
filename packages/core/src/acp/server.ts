/**
 * ACP v1 服务端：走 stdio 的 JSON-RPC，让编辑器（Zed / JetBrains 那一类）驱动我们。
 *
 * 和 A2A 的区别不是传输，而是**谁在问**：ACP 的对面是编辑器，它在等人打字，
 * 所以这里必须能回答审批（`session/request_permission` 反向请求客户端），
 * 而不是像 A2A 那样一律拒绝——编辑器那边的用户是真的可以点。
 *
 * 三条实现纪律：
 *
 * 1) **stdout 只能有协议帧。** 一行一条 JSON-RPC，任何 `console.log` 都会让客户端
 *    解析失败，表现为"连上了但没反应"。日志全部走 stderr。
 * 2) **取消不是错误。** 收到 `session/cancel` 后必须回 `stopReason: 'cancelled'`，
 *    而不是把 abort 抛出来的异常原样扔给客户端——那会在界面上显示成报错，
 *    而用户只是按了停止。
 * 3) **一次 prompt 就是一次 runTask。** 不另造会话概念：`sessionId` 直接就是
 *    我们的会话 id，所以 ACP 会话在 `uh session list` 里同样看得见。
 */
import { randomUUID } from 'node:crypto'
import type {
  InitializeParams, InitializeResult, PromptParams, PromptResult,
  SessionUpdateParams, SessionUpdate, StopReason, RequestPermissionParams,
  RequestPermissionResult, ContentBlock,
} from './types.ts'
import { ACP_ERR } from './types.ts'
import { describeTool } from '../agent/progress.ts'

export interface AcpHarnessLike {
  sessionId?: string | null
  start: () => Promise<unknown>
  runTask: (o: { task: string }) => Promise<{ text?: string; stoppedBy?: string }>
  abort: () => void
  dispose: () => void
}

export interface AcpHooks {
  /** 造一个 harness。cwd 来自 session/new，是这次会话的工作区。 */
  create: (opts: { cwd: string }) => AcpHarnessLike
  /** 给 runTask 挂回调；返回后 runTask 会边跑边推 session/update */
  wire: (
    h: AcpHarnessLike,
    emit: {
      text: (delta: string) => void
      reasoning: (delta: string) => void
      event: (kind: string, payload: Record<string, unknown>) => void
    },
  ) => void
  version: string
  /** 让审批门去问编辑器。不提供就一律拒绝。 */
  askPermission?: (req: RequestPermissionParams) => Promise<RequestPermissionResult>
}

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
}

export function createAcpServer(hooks: AcpHooks, io: {
  stdin: NodeJS.ReadableStream
  stdout: NodeJS.WritableStream
}) {
  const sessions = new Map<string, { h: AcpHarnessLike; cwd: string; busy: boolean }>()
  const outbox: string[] = []
  const pending = new Map<number, Pending>()
  let nextId = 1
  let initialized = false
  let stopped = false

  const log = (m: string) => process.stderr.write(`[acp] ${m}\n`)

  /** 所有出站消息的唯一出口。写 stdout 前先确认是协议帧。 */
  const write = (msg: unknown) => {
    const line = JSON.stringify(msg) + '\n'
    outbox.push(line)
    io.stdout.write(line)
  }

  const notify = (method: string, params: unknown) => write({ jsonrpc: '2.0', method, params })

  /** 反向请求：我们问客户端（审批就是这条路） */
  const request = (method: string, params: unknown, timeoutMs = 300_000): Promise<unknown> => {
    const id = nextId++
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      write({ jsonrpc: '2.0', id, method, params })
      // 客户端不回答时不能永远挂着：超时按"没批准"处理
      const t = setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`${method} timed out`))
      }, timeoutMs)
      t.unref?.()
    })
  }

  const emitUpdate = (sessionId: string, update: SessionUpdate) => {
    notify('session/update', { sessionId, update } satisfies SessionUpdateParams)
  }

  /**
   * 事件 → ACP 更新。
   *
   * `tool/call` 和 `tool/result` 之间没有共同的 id（事件里只有工具名和 argv），
   * 所以按「第 N 个 call 配第 N 个 result」配对。不做这一步的话客户端会一直看到
   * 工具停在 in_progress，用户以为任务卡住了。
   */
  const onEvent = (sessionId: string) => {
    let chunkId = `msg_${randomUUID().slice(0, 8)}`
    const openCalls: string[] = []
    return (kind: string, p: Record<string, unknown>) => {
      if (kind === 'tool/call') {
        const id = `call_${openCalls.length}_${randomUUID().slice(0, 6)}`
        openCalls.push(id)
        // 编辑器里显示的是 title，用户会把它当成"它在干什么"。
        // 所以这里必须是"Reading src/a.ts"，不能是 run_command。
        const described = describeTool(String(p.tool ?? ''), p)
        emitUpdate(sessionId, {
          sessionUpdate: 'tool_call',
          toolCallId: id,
          title: described.label,
          kind: 'execute',
          status: 'in_progress',
          rawInput: p.argv ?? p.input ?? null,
        })
      } else if (kind === 'tool/result') {
        const id = openCalls.shift()
        if (!id) return
        emitUpdate(sessionId, {
          sessionUpdate: 'tool_call_update',
          toolCallId: id,
          status: p.status === 'error' || p.refused === true ? 'failed' : 'completed',
          rawOutput: {
            status: p.status ?? null,
            exit_code: p.exit_code ?? null,
            refused: p.refused ?? false,
          },
        })
      } else if (kind === 'plan/updated') {
        const items = Array.isArray(p.items) ? p.items : []
        const entries = items.map((it) => {
          const o = it as Record<string, unknown>
          return {
            content: String(o.step ?? o.text ?? ''),
            ...(o.status ? { status: String(o.status) as 'pending' | 'in_progress' | 'completed' } : {}),
          }
        })
        if (entries.length) emitUpdate(sessionId, { sessionUpdate: 'plan', entries })
      }
      // 新消息开始：分块归到新的 messageId
      if (kind === 'step/start') chunkId = `msg_${randomUUID().slice(0, 8)}`
    }
  }

  const textOfPrompt = (blocks: ContentBlock[]): string => {
    const out: string[] = []
    for (const b of blocks ?? []) {
      if (b.type === 'text') out.push(b.text)
      else if (b.type === 'resource') {
        const r = b.resource
        // 内联的文件内容直接给模型；只给 uri 它看不见文件里是什么
        out.push(`<file uri="${r.uri}">\n${r.text ?? ''}\n</file>`)
      } else if (b.type === 'resource_link') {
        out.push(`<file uri="${b.uri}" />`)
      }
    }
    return out.join('\n').trim()
  }

  const handle = async (method: string, params: Record<string, unknown>) => {
    switch (method) {
      case 'initialize': {
        const p = params as unknown as InitializeParams
        // 版本协商：支持就原样回，不支持回自己最新的（规范要求）
        const version = p?.protocolVersion === 1 ? 1 : 1
        initialized = true
        const result: InitializeResult = {
          protocolVersion: version,
          agentCapabilities: {
            loadSession: false,   // 没实现就别声明，客户端会试着调
            promptCapabilities: { image: false, audio: false, embeddedContext: true },
            mcpCapabilities: { http: false, sse: false },
          },
          agentInfo: { name: 'unit-harness', title: 'UnitHarness', version: hooks.version },
          authMethods: [],
        }
        return result
      }

      case 'session/new': {
        if (!initialized) throw new RpcError(ACP_ERR.INVALID_REQUEST, 'call initialize first')
        const cwd = String(params?.cwd ?? process.cwd())
        const h = hooks.create({ cwd })
        await h.start()
        const sid = h.sessionId ?? `sess_${randomUUID().replace(/-/g, '').slice(0, 12)}`
        sessions.set(sid, { h, cwd, busy: false })
        log(`session ${sid} created for ${cwd}`)
        return { sessionId: sid }
      }

      case 'session/prompt': {
        const p = params as unknown as PromptParams
        const entry = sessions.get(String(p?.sessionId ?? ''))
        if (!entry) throw new RpcError(ACP_ERR.SESSION_NOT_FOUND, `no session ${p?.sessionId}`)
        if (entry.busy) throw new RpcError(ACP_ERR.INVALID_REQUEST, 'this session is already running a prompt')

        const text = textOfPrompt(p.prompt)
        if (!text) throw new RpcError(ACP_ERR.INVALID_PARAMS, 'prompt contains no text')

        entry.busy = true
        const sid = String(p.sessionId)
        try {
          hooks.wire(entry.h, {
            text: (d) => emitUpdate(sid, {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: d },
            }),
            reasoning: (d) => emitUpdate(sid, {
              sessionUpdate: 'agent_thought_chunk',
              content: { type: 'text', text: d },
            }),
            event: onEvent(sid),
          })
          const out = await entry.h.runTask({ task: text })
          // 被打断时 runTask 正常返回（不抛错），stopReason 要如实反映
          const reason: StopReason = out?.stoppedBy === 'interrupted' ? 'cancelled' : 'end_turn'
          return { stopReason: reason } satisfies PromptResult
        } catch (e) {
          // abort 抛出来的异常不是"错误"，是取消。客户端会把它当报错弹给用户
          const msg = e instanceof Error ? e.message : String(e)
          if (/abort|interrupt|cancel/i.test(msg)) {
            return { stopReason: 'cancelled' } satisfies PromptResult
          }
          throw new RpcError(ACP_ERR.INTERNAL, msg)
        } finally {
          entry.busy = false
        }
      }

      case 'session/cancel': {
        // 规范里这是 notification（没有 id），但我们同时接受带 id 的调用，回个空结果
        const sid = String(params?.sessionId ?? '')
        const entry = sessions.get(sid)
        if (entry) {
          log(`cancel ${sid}`)
          entry.h.abort()
        }
        return {}
      }

      case 'session/load':
        throw new RpcError(ACP_ERR.METHOD_NOT_FOUND, 'loadSession is not supported (the card says false)')

      case 'authenticate':
        // 我们不做认证，这个方法存在与否都不影响连接
        return {}

      default:
        throw new RpcError(ACP_ERR.METHOD_NOT_FOUND, `unknown method ${method}`)
    }
  }

  const onLine = async (line: string) => {
    const s = line.trim()
    if (!s) return
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(s)
    } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: ACP_ERR.PARSE, message: 'invalid JSON' } })
      return
    }

    // 客户端对我们反向请求的响应
    if (typeof msg.id === 'number' && !msg.method) {
      const p = pending.get(msg.id)
      if (!p) return
      pending.delete(msg.id)
      if (msg.error) p.reject(new Error(String((msg.error as Record<string, unknown>).message ?? 'error')))
      else p.resolve(msg.result)
      return
    }

    const method = String(msg.method ?? '')
    const isNotification = msg.id === undefined || msg.id === null

    try {
      const result = await handle(method, (msg.params as Record<string, unknown>) ?? {})
      if (!isNotification) write({ jsonrpc: '2.0', id: msg.id, result })
    } catch (e) {
      const err = e instanceof RpcError ? e : new RpcError(ACP_ERR.INTERNAL, e instanceof Error ? e.message : String(e))
      if (!isNotification) {
        write({ jsonrpc: '2.0', id: msg.id, error: { code: err.code, message: err.message } })
      } else {
        log(`notification ${method} failed: ${err.message}`)
      }
    }
  }

  let buf = ''
  io.stdin.setEncoding?.('utf8')
  io.stdin.on('data', (chunk: string | Buffer) => {
    buf += chunk.toString()
    let i: number
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      void onLine(line)
    }
  })

  io.stdin.on('end', () => {
    stop()
  })

  const stop = () => {
    if (stopped) return
    stopped = true
    for (const [, s] of sessions) {
      try { s.h.abort() } catch { /* 已经结束 */ }
      try { s.h.dispose() } catch { /* 已经结束 */ }
    }
    sessions.clear()
  }

  return {
    /** 供测试：直接把一行喂进来，不必开真管道 */
    feed: (line: string) => onLine(line),
    stop,
    sessions,
    /** 反向请求句柄，审批用 */
    request,
    emitUpdate,
    pendingCount: () => pending.size,
  }
}

class RpcError extends Error {
  code: number
  constructor(code: number, message: string) {
    super(message)
    this.code = code
  }
}

export { RpcError }
