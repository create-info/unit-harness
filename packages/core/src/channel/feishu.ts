/**
 * 飞书：事件订阅（v2 schema）。
 *
 * 飞书和企微最大的不同：它的回调**必须**在 3 秒内返回 200，但回复可以异步发，
 * 所以这里同步只做「认领」，真正的回复走 open-apis/im/v1/messages。
 *
 * 三条必须做对的事：
 *  1. 配地址时的 url_verification 要原样回 challenge，且可能被加密；
 *  2. 开了 Encrypt Key 就必须验 X-Lark-Signature，不然谁都能往你这扔一句「删库」；
 *  3. 同一条消息飞书会重投，按 event_id 去重。
 */
import { feishuDecrypt, feishuSignature, safeEqual } from './crypto.ts'
import type { ChannelAdapter, ChannelContext, IncomingMessage } from './types.ts'

export interface FeishuConfig {
  appId: string
  appSecret: string
  /** 事件订阅里的 Verification Token */
  verificationToken?: string
  /** 加密用的 Encrypt Key（开了就必须填） */
  encryptKey?: string
  /** 测试用：替换 fetch */
  fetchImpl?: typeof fetch
  /** 测试/内网代理：默认 https://open.feishu.cn */
  baseUrl?: string
}

const DEFAULT_BASE = 'https://open.feishu.cn'

let tokenCache: { appId: string; secret: string; token: string; exp: number } | null = null

export async function feishuToken(cfg: FeishuConfig, f: typeof fetch): Promise<string> {
  const now = Date.now()
  if (tokenCache && tokenCache.appId === cfg.appId && tokenCache.secret === cfg.appSecret && tokenCache.exp > now) {
    return tokenCache.token
  }
  const r = await f(`${cfg.baseUrl ?? DEFAULT_BASE}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: cfg.appId, app_secret: cfg.appSecret }),
  })
  const j = (await r.json()) as { code?: number; msg?: string; tenant_access_token?: string; expire?: number }
  if (!j.tenant_access_token) throw new Error(`tenant_access_token 失败：${j.code} ${j.msg ?? ''}`)
  tokenCache = { appId: cfg.appId, secret: cfg.appSecret, token: j.tenant_access_token, exp: now + (j.expire ?? 7200) * 1000 - 300_000 }
  return j.tenant_access_token
}

export async function feishuSend(cfg: FeishuConfig, chatId: string, text: string): Promise<void> {
  const f = cfg.fetchImpl ?? fetch
  const token = await feishuToken(cfg, f)
  const r = await f(`${cfg.baseUrl ?? DEFAULT_BASE}/open-apis/im/v1/messages?receive_id_type=chat_id`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8', authorization: 'Bearer ' + token },
    body: JSON.stringify({ receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }) }),
  })
  const j = (await r.json()) as { code?: number; msg?: string }
  if (j.code) throw new Error(`im/v1/messages 失败：${j.code} ${j.msg ?? ''}`)
}

interface FeishuEventBody {
  encrypt?: string
  type?: string
  challenge?: string
  token?: string
  header?: { event_id?: string; event_type?: string; token?: string }
  event?: {
    sender?: { sender_id?: { open_id?: string } }
    message?: { message_id?: string; chat_id?: string; message_type?: string; content?: string; chat_type?: string }
  }
}

/** 拆一层加密，返回可以直接读的 JSON 文本 */
export function feishuOpen(cfg: FeishuConfig, body: string, headers: Record<string, string | undefined>): string {
  const parsed = JSON.parse(body) as FeishuEventBody
  if (!parsed.encrypt) {
    // 明文模式：开了 Encrypt Key 却收到明文，说明对方没配或我们配错了，直接拒
    if (cfg.encryptKey) throw new Error('这条报文没有加密，但本机配置了 Encrypt Key')
    return body
  }
  const sig = headers['x-lark-signature']
  const ts = headers['x-lark-request-timestamp'] ?? ''
  const nonce = headers['x-lark-request-nonce'] ?? ''
  if (cfg.encryptKey) {
    if (!sig) throw new Error('X-Lark-Signature 缺失')
    if (!safeEqual(feishuSignature(ts, nonce, cfg.encryptKey, body), sig)) throw new Error('X-Lark-Signature 不匹配')
  }
  return feishuDecrypt(parsed.encrypt, cfg.encryptKey ?? '')
}

export function makeFeishu(cfg: FeishuConfig): ChannelAdapter {
  return {
    id: 'feishu',
    label: '飞书',
    async handle(req, ctx: ChannelContext) {
      if (req.method !== 'POST') return null

      let text: string
      try {
        text = feishuOpen(cfg, req.body, req.headers)
      } catch (err) {
        ctx.log('warn', `feishu: 报文打不开 —— ${err instanceof Error ? err.message : String(err)}`)
        return { body: '{}', headers: { 'content-type': 'application/json' } }
      }

      const body = JSON.parse(text) as FeishuEventBody

      // ① 配地址时的握手
      if (body.type === 'url_verification') {
        if (cfg.verificationToken && body.token && body.token !== cfg.verificationToken) {
          ctx.log('warn', 'feishu: verification token 不匹配')
          return null
        }
        return {
          body: JSON.stringify({ challenge: body.challenge }),
          headers: { 'content-type': 'application/json' },
        }
      }

      // ② 正常事件
      if (cfg.verificationToken && body.header?.token && body.header.token !== cfg.verificationToken) {
        ctx.log('warn', 'feishu: 事件 token 不匹配')
        return { body: '{}', headers: { 'content-type': 'application/json' } }
      }
      const ev = body.event
      const m = ev?.message
      if (!m?.chat_id || m.message_type !== 'text') return { body: '{}', headers: { 'content-type': 'application/json' } }

      let said = ''
      try {
        said = String((JSON.parse(m.content ?? '{}') as { text?: string }).text ?? '')
      } catch { return { body: '{}', headers: { 'content-type': 'application/json' } } }
      // 群里 @ 机器人时正文前面会带 @_user_1 这种占位
      said = said.replace(/@_user_\d+/g, '').replace(/@\S+\s*/g, (s) => (s.includes('@_') ? '' : s)).trim()
      if (!said) return { body: '{}', headers: { 'content-type': 'application/json' } }

      const msg: IncomingMessage = {
        channel: 'feishu',
        chatId: m.chat_id,
        ...(ev?.sender?.sender_id?.open_id ? { userId: ev.sender.sender_id.open_id } : {}),
        text: said,
        ...(body.header?.event_id ? { messageId: body.header.event_id } : {}),
        raw: body,
      }

      // 飞书要求 3 秒内回包：先认领，再跑，再主动发
      void ctx.ask(msg).then(
        (answer) => {
          if (answer === null) return undefined   // 重复投递：什么都不回
          return feishuSend(cfg, m.chat_id as string, answer)
        },
        (err) => {
          ctx.log('error', `feishu: 跑任务失败 ${err instanceof Error ? err.message : String(err)}`)
          return feishuSend(cfg, m.chat_id as string, '这一轮没跑起来：' + (err instanceof Error ? err.message : String(err)))
            .catch(() => {})
        },
      )
      return { body: '{}', headers: { 'content-type': 'application/json' } }
    },
  }
}
