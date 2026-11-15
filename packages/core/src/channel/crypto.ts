/**
 * 三个渠道的验签与加解密。
 *
 * 全部是纯函数，不碰网络——这样能用固定的报文把「别人家文档里那段 AES」验一遍：
 * 这类代码看着都差不多，错了却不会报错，只会让用户在群里发现机器人不回话。
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/* ---------------- 企业微信：AES + msg_signature ---------------- */

/** 企业微信要求 AESKey = base64(EncodingAESKey + '=') */
function wecomKey(encodingAesKey: string): Buffer {
  const key = Buffer.from(encodingAesKey + '=', 'base64')
  if (key.length !== 32) throw new Error(`EncodingAESKey 解出来是 ${key.length} 字节，应该是 32`)
  return key
}

/** sha1(sort([token, timestamp, nonce, encrypt]).join('')) */
export function wecomSignature(token: string, timestamp: string, nonce: string, encrypt: string): string {
  return createHash('sha1').update([token, timestamp, nonce, encrypt].sort().join('')).digest('hex')
}

/** PKCS7：企业微信用的是 32 字节块 */
function pkcs7(buf: Buffer, blockSize: number): Buffer {
  const pad = blockSize - (buf.length % blockSize || blockSize)
  const n = pad === blockSize ? blockSize : pad
  return Buffer.concat([buf, Buffer.alloc(n, n)])
}

function unpkcs7(buf: Buffer): Buffer {
  const pad = buf[buf.length - 1] as number
  if (pad < 1 || pad > 32) return buf
  return buf.subarray(0, buf.length - pad)
}

/**
 * 加密一条企业微信报文。
 * 明文结构：random(16) + msglen(4, 大端) + msg + receiveid
 */
export function wecomEncrypt(msg: string, encodingAesKey: string, receiveId: string): string {
  const key = wecomKey(encodingAesKey)
  const msgBuf = Buffer.from(msg, 'utf8')
  const len = Buffer.alloc(4)
  len.writeUInt32BE(msgBuf.length, 0)
  const plain = Buffer.concat([randomBytes(16), len, msgBuf, Buffer.from(receiveId, 'utf8')])
  const iv = key.subarray(0, 16)
  const c = createCipheriv('aes-256-cbc', key, iv)
  c.setAutoPadding(false)
  const out = Buffer.concat([c.update(pkcs7(plain, 32)), c.final()])
  return out.toString('base64')
}

/** 解密；receiveid 对不上就抛错（防止把别人的报文当自己的） */
export function wecomDecrypt(encrypted: string, encodingAesKey: string, receiveId: string): string {
  const key = wecomKey(encodingAesKey)
  const raw = Buffer.from(encrypted, 'base64')
  const d = createDecipheriv('aes-256-cbc', key, key.subarray(0, 16))
  d.setAutoPadding(false)
  const plain = unpkcs7(Buffer.concat([d.update(raw), d.final()]))
  const len = plain.readUInt32BE(16)
  const msg = plain.subarray(20, 20 + len).toString('utf8')
  const got = plain.subarray(20 + len).toString('utf8')
  if (got && got !== receiveId) throw new Error(`receiveid 不匹配：报文是给 ${got} 的`)
  return msg
}

/* ---------------- 飞书：encrypt + X-Lark-Signature ---------------- */

/**
 * 飞书事件加密：key = sha256(encrypt_key)，AES-256-CBC，iv 取 key 前 16 字节，
 * 密文外面套一层 base64(iv + ciphertext)。
 */
export function feishuDecrypt(encrypted: string, encryptKey: string): string {
  const key = createHash('sha256').update(encryptKey).digest()
  const buf = Buffer.from(encrypted, 'base64')
  const iv = buf.subarray(0, 16)
  const data = buf.subarray(16)
  const d = createDecipheriv('aes-256-cbc', key, iv)
  d.setAutoPadding(true)
  return Buffer.concat([d.update(data), d.final()]).toString('utf8')
}

export function feishuEncrypt(text: string, encryptKey: string): string {
  const key = createHash('sha256').update(encryptKey).digest()
  const iv = randomBytes(16)
  const c = createCipheriv('aes-256-cbc', key, iv)
  return Buffer.concat([iv, c.update(Buffer.from(text, 'utf8')), c.final()]).toString('base64')
}

/** X-Lark-Signature = sha256(timestamp + nonce + encrypt_key + rawBody) */
export function feishuSignature(timestamp: string, nonce: string, encryptKey: string, body: string): string {
  return createHash('sha256').update(timestamp + nonce + encryptKey + body).digest('hex')
}

/* ---------------- 微信订阅号：sha1 签名 ---------------- */

/** sha1(sort([token, timestamp, nonce]).join(''))，明文模式和验证 URL 都用它 */
export function weixinSignature(token: string, timestamp: string, nonce: string): string {
  return createHash('sha1').update([token, timestamp, nonce].sort().join('')).digest('hex')
}

/**
 * 定长比较。
 *
 * 签名是攻击者可以直接猜的东西，用 === 比会被计时差异一点点问出来（本站风险不高，
 * 但写对了不花成本，省得以后有人照抄这段到别的服务）。
 */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

/* ---------------- XML（企业微信和订阅号都用） ---------------- */

/** 取一个标签的文本；CDATA 和非 CDATA 都要认 */
export function xmlValue(xml: string, tag: string): string {
  const cdata = new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`).exec(xml)
  if (cdata) return cdata[1] as string
  const plain = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml)
  return plain ? (plain[1] as string) : ''
}

export function xmlEscape(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c] as string))
}

/** 包一层 CDATA；正文里出现 ]]> 会提前结束 CDATA，必须拆开 */
export function cdata(s: string): string {
  return '<![CDATA[' + s.replace(/]]>/g, ']]]]><![CDATA[>') + ']]>'
}
