/**
 * `uh acp` —— 用 stdio JSON-RPC 让编辑器驱动我们。
 *
 * 这里最重要的接线是**审批门反着走**：ACP 的对面是编辑器里的用户，
 * 他能真的点按钮，所以 gate 要发 `session/request_permission` 出去等回复，
 * 而不是像 A2A 那样一律拒绝。这条做对了，"破坏性动作要过人"在编辑器里才不是假话。
 *
 * stdout 是协议通道，所有日志走 stderr——这里一行 console.log 都不能有。
 */
import { Harness, createAcpServer } from '@unit-harness/core'
import type { RequestPermissionParams, RequestPermissionResult, AcpHooks } from '@unit-harness/core'

type Emit = {
  text: (d: string) => void
  reasoning: (d: string) => void
  event: (kind: string, payload: Record<string, unknown>) => void
}

export interface AcpCommandOptions {
  version: string
  /** 默认工作区；session/new 里的 cwd 会覆盖它 */
  cwd: string
}

export function startAcp(opts: AcpCommandOptions) {
  const log = (m: string) => process.stderr.write(`[uh acp] ${m}\n`)

  // 反向请求要拿到 server 实例，而 gate 在构造 harness 时就要传进去，所以先占位
  let serverRef: ReturnType<typeof createAcpServer> | null = null
  // 回调在 construct 时就要给，但真正发流要等 wire()——用可变引用接上，别去改 private opts
  let currentEmit: Emit | null = null

  const askPermission = async (req: RequestPermissionParams): Promise<RequestPermissionResult> => {
    if (!serverRef) return { outcome: { outcome: 'cancelled' } }
    try {
      const r = (await serverRef.request('session/request_permission', req)) as RequestPermissionResult
      return r && typeof r === 'object' && 'outcome' in r ? r : { outcome: { outcome: 'cancelled' } }
    } catch (e) {
      // 超时或客户端不回：按拒绝处理，绝不能默认放行
      log(`permission request failed: ${e instanceof Error ? e.message : String(e)} — treating as denied`)
      return { outcome: { outcome: 'cancelled' } }
    }
  }

  const server = createAcpServer(
    {
      version: opts.version,
      askPermission,

      create({ cwd }) {
        let sid = ''
        const h = new Harness({
          record: true,
          label: `acp: ${cwd.split('/').pop() || cwd}`,
          workspace: cwd,
          // stdout 是协议通道：任何一行日志都会把客户端搞崩
          logToStderr: true,
          onText: (d: string) => currentEmit?.text(d),
          onReasoning: (d: string) => currentEmit?.reasoning(d),
          onEvent: (kind: string, payload: Record<string, unknown>) => currentEmit?.event(kind, payload),
          // 编辑器里的用户可以点，所以这里真的问；客户端没回就按拒绝
          gate: {
            request: async (req) => {
              const decision = await askPermission({
                sessionId: sid,
                toolCall: {
                  toolCallId: `call_${Date.now()}`,
                  title: req.summary || req.kind,
                  kind: req.kind === 'patch' ? 'edit' : 'execute',
                  status: 'pending',
                  rawInput: { detail: req.detail },
                },
                options: [
                  { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
                  { optionId: 'deny', name: 'Reject', kind: 'reject_once' },
                ],
              })
              const sel = decision.outcome.outcome === 'selected' ? decision.outcome.optionId : ''
              return sel === 'allow' ? 'allow' : 'deny'
            },
          },
        })
        // session 在 start() 里才创建，所以这里补一步把 id 带进审批请求
        const origStart = h.start.bind(h)
        h.start = async () => {
          const r = await origStart()
          sid = h.sessionId ?? ''
          return r
        }
        return h
      },

      /** 把 harness 的三种回调接到 ACP 的 session/update 上 */
      wire(_h, emit) {
        currentEmit = emit
      },
    },
    { stdin: process.stdin, stdout: process.stdout },
  )

  serverRef = server
  log(`ready (cwd ${opts.cwd})`)

  return { stop: () => server.stop() }
}
