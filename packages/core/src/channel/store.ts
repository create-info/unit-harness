/**
 * 渠道配置，以及「这个人该接到哪条会话」。
 *
 * 为什么单独一个文件而不是塞进 config.json：
 *  - 渠道配置里有密钥（appSecret、EncodingAESKey），命不好就会被整份 config 打日志
 *    打出去；分开放，读它的人也少。
 *  - 会话映射会被高频改写（每来一句话都写一次），不能让聊天把主配置写坏。
 */
import fs from 'node:fs'
import path from 'node:path'
import { uhHome } from '../paths.ts'
import type { ChannelAdapter } from './types.ts'
import { makeFeishu, type FeishuConfig } from './feishu.ts'
import { makeWecom, type WecomConfig } from './wecom.ts'
import { makeWeixin, type WeixinConfig } from './weixin.ts'

export interface ChannelsConfig {
  wecom?: WecomConfig
  feishu?: FeishuConfig
  weixin?: WeixinConfig
}

export interface ChatBinding {
  /** 接到哪条 agent 会话上 */
  sessionId: string
  /** 这条会话已经跑过几轮（续跑时 turn_index 要递增） */
  turns: number
  updatedAt: string
}

export function channelsPath(): string {
  return path.join(uhHome(), 'channels.json')
}

function bindingsPath(): string {
  return path.join(uhHome(), 'channels', 'sessions.json')
}

export function readChannels(): ChannelsConfig {
  try {
    return JSON.parse(fs.readFileSync(channelsPath(), 'utf8')) as ChannelsConfig
  } catch {
    return {}
  }
}

export function writeChannels(cfg: ChannelsConfig): void {
  const p = channelsPath()
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
}

/** 只返回配置齐全、能真的起来的渠道；配了一半的不算 */
export function buildAdapters(cfg: ChannelsConfig): ChannelAdapter[] {
  const out: ChannelAdapter[] = []
  if (cfg.wecom?.corpId && cfg.wecom.token && cfg.wecom.encodingAesKey) out.push(makeWecom(cfg.wecom))
  if (cfg.feishu?.appId && cfg.feishu.appSecret) out.push(makeFeishu(cfg.feishu))
  if (cfg.weixin?.token && cfg.weixin.appId) out.push(makeWeixin(cfg.weixin))
  return out
}

/** 缺哪些字段就起不来 —— 设置页要能直接说清，而不是让人对着文档猜 */
export function missingFields(cfg: ChannelsConfig): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  const w = (cfg.wecom ?? {}) as Record<string, unknown>
  const wm = ['corpId', 'agentId', 'secret', 'token', 'encodingAesKey'].filter((k) => !w[k])
  if (wm.length) out.wecom = wm
  const f = (cfg.feishu ?? {}) as Record<string, unknown>
  const fm = ['appId', 'appSecret'].filter((k) => !f[k])
  if (fm.length) out.feishu = fm
  const x = (cfg.weixin ?? {}) as Record<string, unknown>
  const xm = ['token', 'appId', 'appSecret'].filter((k) => !x[k])
  if (xm.length) out.weixin = xm
  return out
}

/* ---------------- 会话映射 ---------------- */

type Bindings = Record<string, ChatBinding>

function readBindings(): Bindings {
  try {
    return JSON.parse(fs.readFileSync(bindingsPath(), 'utf8')) as Bindings
  } catch {
    return {}
  }
}

export function bindingKey(channel: string, chatId: string): string {
  return `${channel}:${chatId}`
}

export function getBinding(channel: string, chatId: string): ChatBinding | null {
  return readBindings()[bindingKey(channel, chatId)] ?? null
}

export function setBinding(channel: string, chatId: string, b: ChatBinding): void {
  const all = readBindings()
  all[bindingKey(channel, chatId)] = b
  const p = bindingsPath()
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(all, null, 2) + '\n', 'utf8')
}

export function dropBinding(channel: string, chatId: string): void {
  const all = readBindings()
  delete all[bindingKey(channel, chatId)]
  const p = bindingsPath()
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(all, null, 2) + '\n', 'utf8')
}

/* ---------------- 去重 ---------------- */

/**
 * 同一条消息被渠道重投时，只应该跑一次。
 *
 * 内存里做就够：重投都发生在秒级（对方没等到 200），不是隔天再来。
 * 但**必须**在「认领」时立刻记账——等跑完再记，重投那几条早就并发了。
 */
const SEEN = new Map<string, number>()
const SEEN_TTL_MS = 10 * 60 * 1000
const SEEN_MAX = 2000

export function claimMessage(channel: string, messageId: string | undefined): boolean {
  if (!messageId) return true
  const now = Date.now()
  for (const [k, t] of SEEN) if (now - t > SEEN_TTL_MS) SEEN.delete(k)
  const key = `${channel}:${messageId}`
  if (SEEN.has(key)) return false
  if (SEEN.size >= SEEN_MAX) {
    const oldest = SEEN.keys().next().value
    if (oldest) SEEN.delete(oldest)
  }
  SEEN.set(key, now)
  return true
}
