/**
 * 微信订阅号（公众号）。
 *
 * 和企微/飞书不一样：公众号的被动回复必须**在 5 秒内**作为 HTTP 响应体返回，
 * 超过 5 秒微信会重试三次然后放弃。而 agent 跑一轮通常更久。
 * 所以这里走「先回 success（空），再用客服消息接口推结果」这条路——
 * 客服接口要求用户在 48 小时内发过消息，对「刚问了一句话」的场景正好成立。
 *
 * 另外公众号 API 常常要经代理（国内公网 IP 不在白名单时），所以 baseUrl 可配。
 */
import { createHash } from 'node:crypto'
import { cdata, safeEqual, weixinSignature, xmlValue } from './crypto.ts'
import type { ChannelAdapter, ChannelContext, IncomingMessage } from './types.ts'

export interface WeixinConfig {
  /** 后台「服务器配置」里填的 Token */
  token: string
  appId: string
  appSecret: string
  /** 代理前缀，例如 http://1.2.3.4/wxapi —— 空则直连 api.weixin.qq.com */
  baseUrl?: string
  /** 代理要求的自定义头 */
  proxyKey?: string
  fetchImpl?: typeof fetch
}

let tokenCache: { appId: string; secret: string; token: string; exp: number } | null = null

export async function weixinToken(cfg: WeixinConfig, f: typeof fetch): Promise<string> {
  const now = Date.now()
  if (tokenCache && tokenCache.appId === cfg.appId && tokenCache.secret === cfg.appSecret && tokenCache.exp > now) {
    return tokenCache.token
  }
  const base = cfg.baseUrl || 'https://api.weixin.qq.com'
  const r = await f(`${base}/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(cfg.appId)}&secret=${encodeURIComponent(cfg.appSecret)}`,
    cfg.proxyKey ? { headers: { 'X-Proxy-Key': cfg.proxyKey } } : undefined)
  const j = (await r.json()) as { access_token?: string; expires_in?: number; errcode?: number; errmsg?: string }
  if (!j.access_token) throw new Error(`access_token 失败：${j.errcode} ${j.errmsg ?? ''}`)
  tokenCache = { appId: cfg.appId, secret: cfg.appSecret, token: j.access_token, exp: now + (j.expires_in ?? 7200) * 1000 - 300_000 }
  return j.access_token
}

/** 客服消息（文本），用于被动回复赶不上的场合 */
export async function weixinSend(cfg: WeixinConfig, openid: string, text: string): Promise<void> {
  const f = cfg.fetchImpl ?? fetch
  const base = cfg.baseUrl || 'https://api.weixin.qq.com'
  const token = await weixinToken(cfg, f)
  const r = await f(`${base}/cgi-bin/message/custom/send?access_token=${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cfg.proxyKey ? { 'X-Proxy-Key': cfg.proxyKey } : {}) },
    body: JSON.stringify({ touser: openid, msgtype: 'text', text: { content: text } }),
  })
  const j = (await r.json()) as { errcode?: number; errmsg?: string }
  if (j.errcode) throw new Error(`custom/send 失败：${j.errcode} ${j.errmsg ?? ''}`)
}

/** 公众号的加密模式：AES-256-CBC，key = base64(appId + char(43))，与企微的报文结构一致 */
function weixinAesKey(appId: string): Buffer {
  return Buffer.from(createHash('sha1').update(appId).digest('hex').slice(0, 43) + '=', 'base64')
}

export function makeWeixin(cfg: WeixinConfig): ChannelAdapter {
  return {
    id: 'weixin',
    label: '微信（公众号）',
    async handle(req, ctx: ChannelContext) {
      const q = req.query
      const sig = q.signature ?? ''
      const ts = q.timestamp ?? ''
      const nonce = q.nonce ?? ''

      // ① 后台「服务器配置」的验证
      if (req.method === 'GET') {
        const expected = q.msg_signature
          // 安全模式：signature 是对 echostr 的签名
          ? createHash('sha1').update([cfg.token, ts, nonce, q.echostr ?? ''].sort().join('')).digest('hex')
          : weixinSignature(cfg.token, ts, nonce)
        const got = q.msg_signature ?? sig
        if (!safeEqual(expected, got)) {
          ctx.log('warn', 'weixin: 验证签名不匹配')
          return null
        }
        return { body: q.echostr ?? '' }
      }

      if (!safeEqual(weixinSignature(cfg.token, ts, nonce), sig) && !q.msg_signature) {
        ctx.log('warn', 'weixin: 消息签名不匹配')
        return null
      }

      // 安全模式下 body 是 <Encrypt>，这里只处理明文模式（订阅号默认明文即可）
      const msgType = xmlValue(req.body, 'MsgType')
      if (msgType !== 'text') return { body: 'success' }
      const text = xmlValue(req.body, 'Content').trim()
      const from = xmlValue(req.body, 'FromUserName')
      if (!text || !from) return { body: 'success' }

      const msg: IncomingMessage = {
        channel: 'weixin',
        chatId: from,
        userId: from,
        text,
        messageId: xmlValue(req.body, 'MsgId'),
        raw: req.body,
      }

      // 公众号只给 5 秒：先回 success，把结果用客服消息推回去
      void ctx.ask(msg).then(
        (answer) => {
          if (answer === null) return undefined   // 重复投递：什么都不回
          return weixinSend(cfg, from, answer)
        },
        (err) => {
          ctx.log('error', `weixin: 跑任务失败 ${err instanceof Error ? err.message : String(err)}`)
          return weixinSend(cfg, from, '这一轮没跑起来：' + (err instanceof Error ? err.message : String(err))).catch(() => {})
        },
      )
      return { body: 'success' }
    },
  }
}

/** 被动回复的 XML（服务号可用；订阅号在 5 秒内跑完时也能用） */
export function weixinPassiveXml(to: string, from: string, text: string): string {
  return `<xml><ToUserName>${cdata(to)}</ToUserName><FromUserName>${cdata(from)}</FromUserName>`
    + `<CreateTime>${Math.floor(Date.now() / 1000)}</CreateTime><MsgType>${cdata('text')}</MsgType>`
    + `<Content>${cdata(text)}</Content></xml>`
}

export { weixinAesKey }
