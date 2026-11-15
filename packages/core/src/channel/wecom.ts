/**
 * 企业微信：自建应用的回调。
 *
 * 现状有两个坑，都在这儿处理：
 *  1. 被动回复只给 5 秒。agent 跑一轮通常是十几秒到几分钟，等它跑完再被动回复，
 *     企微那边早就超时重投了。所以：先立刻回一句「收到了」，跑完用主动发消息接口推结果。
 *  2. 同一句话会被重投三次。按 MsgId 去重，否则同一个任务会被执行三遍。
 */
import {
  cdata, safeEqual, wecomDecrypt, wecomEncrypt, wecomSignature, xmlEscape, xmlValue,
} from './crypto.ts'
import type { ChannelAdapter, ChannelContext, IncomingMessage, OutgoingReply } from './types.ts'

export interface WecomConfig {
  corpId: string
  agentId: string
  secret: string
  token: string
  encodingAesKey: string
  /** 测试用：替换 fetch */
  fetchImpl?: typeof fetch
}

export interface WecomRequest {
  method: string
  query: Record<string, string>
  body: string
}

const API = 'https://qyapi.weixin.qq.com/cgi-bin'

/** access_token 每两小时过期，缓存 + 提前 5 分钟换 */
let tokenCache: { corpId: string; secret: string; token: string; exp: number } | null = null

async function accessToken(cfg: WecomConfig, f: typeof fetch): Promise<string> {
  const now = Date.now()
  if (tokenCache && tokenCache.corpId === cfg.corpId && tokenCache.secret === cfg.secret && tokenCache.exp > now) {
    return tokenCache.token
  }
  const r = await f(`${API}/gettoken?corpid=${encodeURIComponent(cfg.corpId)}&corpsecret=${encodeURIComponent(cfg.secret)}`)
  const j = (await r.json()) as { errcode?: number; errmsg?: string; access_token?: string; expires_in?: number }
  if (!j.access_token) throw new Error(`gettoken 失败：${j.errcode} ${j.errmsg ?? ''}`)
  tokenCache = { corpId: cfg.corpId, secret: cfg.secret, token: j.access_token, exp: now + (j.expires_in ?? 7200) * 1000 - 300_000 }
  return j.access_token
}

/** 主动发一条文本给某个人（touser 就是回调里的 FromUserName） */
export async function wecomSend(cfg: WecomConfig, touser: string, text: string): Promise<void> {
  const f = cfg.fetchImpl ?? fetch
  const token = await accessToken(cfg, f)
  const r = await f(`${API}/message/send?access_token=${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      touser,
      msgtype: 'text',
      agentid: Number(cfg.agentId),
      text: { content: text },
    }),
  })
  const j = (await r.json()) as { errcode?: number; errmsg?: string }
  if (j.errcode) throw new Error(`message/send 失败：${j.errcode} ${j.errmsg ?? ''}`)
}

/** 拆一条企微回调，拿到解密后的明文 XML */
export function wecomOpen(cfg: WecomConfig, req: WecomRequest): string {
  const sig = req.query.msg_signature ?? ''
  const ts = req.query.timestamp ?? ''
  const nonce = req.query.nonce ?? ''
  const encrypted = xmlValue(req.body, 'Encrypt')
  if (encrypted) {
    if (!safeEqual(wecomSignature(cfg.token, ts, nonce, encrypted), sig)) throw new Error('msg_signature 不匹配')
    return wecomDecrypt(encrypted, cfg.encodingAesKey, cfg.corpId)
  }
  // 明文模式：仍然要验签
  if (sig && !safeEqual(wecomSignature(cfg.token, ts, nonce, ''), sig)) throw new Error('msg_signature 不匹配')
  return req.body
}

export function makeWecom(cfg: WecomConfig): ChannelAdapter {
  return {
    id: 'wecom',
    label: '企业微信',
    async handle(req, ctx: ChannelContext): Promise<OutgoingReply | null> {
      // ① 配回调地址时的 GET 校验：解密 echostr 原样返回
      if (req.method === 'GET') {
        const echo = req.query.echostr ?? ''
        const sig = req.query.msg_signature ?? ''
        const ts = req.query.timestamp ?? ''
        const nonce = req.query.nonce ?? ''
        if (!safeEqual(wecomSignature(cfg.token, ts, nonce, echo), sig)) {
          ctx.log('warn', 'wecom: echostr 验签失败')
          return null
        }
        return { body: wecomDecrypt(echo, cfg.encodingAesKey, cfg.corpId) }
      }

      let xml: string
      try {
        xml = wecomOpen(cfg, req)
      } catch (err) {
        ctx.log('warn', `wecom: 报文打不开 —— ${err instanceof Error ? err.message : String(err)}`)
        return null
      }

      const msgType = xmlValue(xml, 'MsgType')
      if (msgType !== 'text') return { body: 'success' }
      const text = xmlValue(xml, 'Content').trim()
      if (!text) return { body: 'success' }

      const from = xmlValue(xml, 'FromUserName')
      const msg: IncomingMessage = {
        channel: 'wecom',
        // 群聊的 ChatId 是群；单聊没有，就用发信人
        chatId: xmlValue(xml, 'ChatId') || from,
        userId: from,
        text,
        messageId: xmlValue(xml, 'MsgId'),
        raw: xml,
      }

      // ② 立刻回 200，让企微别再重投；结果用主动发消息推回去
      void ctx.ask(msg).then(
        (answer) => {
          if (answer === null) return undefined   // 重复投递：什么都不回
          return wecomSend(cfg, from, answer)
        },
        (err) => {
          ctx.log('error', `wecom: 跑任务失败 ${err instanceof Error ? err.message : String(err)}`)
          return wecomSend(cfg, from, '这一轮没跑起来：' + (err instanceof Error ? err.message : String(err))).catch(() => {})
        },
      )
      return { body: 'success' }
    },
  }
}

/** 被动回复的 XML（企微要它时必须带 MsgType=text） */
export function wecomPassiveXml(to: string, from: string, text: string): string {
  return `<xml><ToUserName>${cdata(to)}</ToUserName><FromUserName>${cdata(from)}</FromUserName>`
    + `<CreateTime>${Math.floor(Date.now() / 1000)}</CreateTime><MsgType>${cdata('text')}</MsgType>`
    + `<Content>${cdata(text)}</Content></xml>`
}

/** 排障用：把一条明文按企微的格式加密回去，方便本地造报文 */
export function wecomSeal(cfg: WecomConfig, plainXml: string): string {
  return wecomEncrypt(plainXml, cfg.encodingAesKey, cfg.corpId)
}

export { xmlEscape }
