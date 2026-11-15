/**
 * 渠道（IM）接入的类型定义。
 *
 * 一个 harness 能不能当「工作搭子」用，取决于它能不能出现在人已经在的地方：
 * 微信、企业微信、飞书。这些渠道的差别全在传输层（怎么收、怎么回、怎么验签），
 * 而「收到一句话 → 跑一轮 → 回一句话」这件事是一样的。
 *
 * 所以这里只定义那件事，具体协议各自在 wecom / feishu / weixin 里实现：
 * 新增一个渠道不该碰 agent 的循环，也不该碰别人的验签代码。
 */

/** 归一化之后的一条来信 */
export interface IncomingMessage {
  /** 渠道 id：wecom / feishu / weixin … */
  channel: string
  /** 会话标识：群聊 id 或个人 id，同一渠道内唯一。用来把同一个人接到同一条 agent 会话上 */
  chatId: string
  /** 发信人。群聊里 chatId 是群，userId 是谁说的 */
  userId?: string
  /** 纯文本正文（已去掉 @机器人 之类的前缀） */
  text: string
  /** 渠道给的消息 id：同一条消息被重投时靠它去重 */
  messageId?: string
  /** 原始报文，排障时写进日志 */
  raw?: unknown
}

/** 一次要回的响应 */
export interface OutgoingReply {
  /** 直接作为 HTTP 响应体返回（微信/企业微信的被动回复走这条） */
  body?: string
  /** 响应头 */
  headers?: Record<string, string>
  /** 需要主动调用接口发出去（飞书走这条） */
  send?: { chatId: string; text: string }[]
}

export interface ChannelContext {
  /**
   * 把一句话交给 agent，返回它要说的话。
   * 由 dispatcher 提供，渠道只管搬运，不关心 agent 怎么跑。
   *
   * 返回 null = 这句话不该回（重投的重复消息）。渠道必须什么都不发——
   * 回一句「收到」比不回复更糟：用户在群里看到两条，以为是两次回答。
   */
  ask: (msg: IncomingMessage) => Promise<string | null>
  log: (level: 'info' | 'warn' | 'error', msg: string) => void
}

export interface ChannelAdapter {
  /** 配置里的键名，也是 URL 里的路径段：/webhook/<id> */
  id: string
  /** 界面上显示的名字 */
  label: string
  /**
   * 处理一次 HTTP 请求。
   *
   * 返回 null = 这条报文不该处理（验签不过、是别人的事件），调用方回 200 空体，
   * 免得对方因为错误码反复重投。
   */
  handle: (
    req: { method: string; query: Record<string, string>; body: string; headers: Record<string, string | undefined> },
    ctx: ChannelContext,
  ) => Promise<OutgoingReply | null>
}
