/**
 * 密钥输入的清洗与校验。
 *
 * 放在 core 里而不是 CLI 里，是因为它需要被测试直接调用——测一份复刻的规则
 * 没有意义，规则改了测试也不会跟着改。
 *
 * 为什么需要这个：终端 raw mode 下按方向键会送来 `\x1b[A`，粘贴时会被
 * `\x1b[200~ … \x1b[201~` 包住。这些字节混进 API key 后不会在保存时报错，
 * 而是在很久之后、某次请求里以 "fetch failed" 的形式失败——因为 ESC 让
 * HTTP header 非法，而 undici 把这种情况也报成 fetch failed。
 */

/** CSI 序列：ESC [ 参数... 终止字节（0x40–0x7E，所以 ~ 也算） */
const CSI = /\x1b\[[0-9;?]*[\x40-\x7e]/g

/** OSC 序列：ESC ] … BEL 或 ESC \\ */
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g

export function sanitizeSecret(raw: string): string {
  const cleaned = raw
    .replace(/^\uFEFF/, '')
    .replace(CSI, '')
    .replace(OSC, '')
    .replace(/[\u200b-\u200d\uFEFF]/g, '')   // 零宽字符
    .replace(/[\r\n]/g, '')
    .trim()

  const bad = [...cleaned].filter((c) => {
    const code = c.charCodeAt(0)
    // 可打印 ASCII 之外的一律不接受：key 里不会有中文，空格也不行（header 值里非法）
    return code < 0x21 || code > 0x7e
  })
  if (bad.length > 0) {
    const codes = [...new Set(bad.map((c) => '0x' + c.charCodeAt(0).toString(16)))].join(' ')
    throw new Error(
      `refusing to store this value: it contains characters that cannot be in a key (${codes}). ` +
      `paste it again, or pipe it from a file.`,
    )
  }
  return cleaned
}
