/**
 * `uh a2a` —— 把当前工作区暴露成一个 A2A agent。
 *
 * 为什么单独一个端口而不是挂在 Web UI 上：Web UI 是本机界面（默认只听 127.0.0.1，
 * 没有鉴权，靠"用户就坐在这台机器前"来保证安全）。A2A 端点是要给别的 agent 访问的，
 * 两者的信任模型完全不同，混在一个端口上迟早会把界面的口子开给外部。
 *
 * hooks 的实现方式值得说明：Task 不是内存对象，而是从 events.jsonl 现场推导。
 * 所以哪怕 A2A 服务重启、或者任务是由 `uh run` 在另一个进程里跑的，
 * GetTask 也一样答得对——状态本来就在日志里。
 */
import { EventStore, readSessionEvents, Harness, createA2AServer } from '@unit-harness/core'
import type { SessionView, SessionEvent } from '@unit-harness/core'

export interface A2ACommandOptions {
  host: string
  port: number
  version: string
  workspace: string
  authToken?: string
  publicUrl?: string
  /** 一个任务最多跑多久（毫秒），防止外部把机器占死 */
  maxSeconds?: number
}

/** 从会话目录读出 A2A 需要的那部分视图 */
function viewOf(store: EventStore, id: string): SessionView | null {
  const dir = store.sessionDir(id)
  if (!dir) return null
  const meta = store.list({ limit: 10000 }).find((m) => m.id === id)
  const events = readSessionEvents(dir) as unknown as SessionEvent[]
  return {
    id,
    contextId: String((meta as unknown as { contextId?: string })?.contextId ?? id),
    events,
    workspace: (meta as unknown as { workspace?: string })?.workspace,
    label: (meta as unknown as { label?: string })?.label,
  }
}

export async function startA2A(opts: A2ACommandOptions) {
  const store = new EventStore()
  const running = new Map<string, Harness>()

  const srv = createA2AServer({
    host: opts.host,
    port: opts.port,
    version: opts.version,
    publicUrl: opts.publicUrl,
    authToken: opts.authToken,
    log: (m) => console.log(m),
    hooks: {
      async start(text, ctx) {
        const h = new Harness({
          record: true,
          label: `a2a: ${text.slice(0, 50)}`,
          workspace: opts.workspace,
          // 外部来的任务不接审批门就等于自动批准一切越权操作。
          // 这里让审批请求落到日志里（变成 TASK_STATE_INPUT_REQUIRED），
          // 由调用方通过 GetTask 看到，而不是静默放行。
          gate: {
            request: async (req) => {
              console.log(`a2a: ${ctx.taskId} wants approval for ${req.summary || req.reason} — denying by default`)
              return 'deny'
            },
          },
        })
        await h.start()
        const sid = h.sessionId ?? ''
        if (!sid) throw new Error('harness started without a session id')
        running.set(sid, h)

        const capMs = (opts.maxSeconds ?? 1800) * 1000
        const timer = setTimeout(() => {
          console.log(`a2a: task ${ctx.taskId} exceeded its ${opts.maxSeconds ?? 1800}s budget — aborting`)
          h.abort()
        }, capMs)
        timer.unref?.()

        void (async () => {
          try {
            await h.runTask({ task: text })
          } catch (e) {
            console.log(`a2a: task ${ctx.taskId} failed: ${e instanceof Error ? e.message : String(e)}`)
          } finally {
            clearTimeout(timer)
            running.delete(sid)
            h.dispose()
          }
        })()

        return { sessionId: sid }
      },

      load(id) {
        return viewOf(store, id)
      },

      list() {
        // 只报这次 A2A 服务自己起的会话？
        // 不——A2A 的语义是"这个 agent 的公开任务"，把本机历史全抖出去是另一种泄露。
        // 只列那些标签以 a2a: 开头的。
        return store.list({ limit: 200 })
          .filter((m) => String((m as unknown as { label?: string }).label ?? '').startsWith('a2a:'))
          .map((m) => viewOf(store, m.id))
          .filter((v): v is SessionView => v !== null)
      },

      cancel(id) {
        const h = running.get(id)
        if (!h) return false
        h.abort()
        return true
      },
    },
  })

  await srv.listen()
  return { ...srv, stop: srv.close }
}
