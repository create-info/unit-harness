/** Crockford Base32 的 ULID 生成（26 字符，时间有序）。 */
import { randomBytes } from 'node:crypto'

const CROCK = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

function encode(value: number, len: number): string {
  let out = ''
  for (let i = len - 1; i >= 0; i--) {
    out = CROCK[value % 32] + out
    value = Math.floor(value / 32)
  }
  return out
}

function randomChars(len: number): string {
  const bytes = randomBytes(len)
  let out = ''
  for (let i = 0; i < len; i++) out += CROCK[(bytes[i] as number) % 32]
  return out
}

/** 时间有序的唯一 ID（毫秒时间戳 + 80 bit 随机） */
export function ulid(): string {
  return encode(Date.now(), 10) + randomChars(16)
}

export const newEventId = (): string => `evt_${ulid()}`
export const newSessionId = (): string => `ses_${ulid()}`
