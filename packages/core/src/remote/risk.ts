/**
 * 远端命令的风险分级。
 *
 * 远端执行等于在别人的生产机上跑模型给的字符串，所以**默认最小权限**：
 * 只读放行，写操作要显式授权，毁灭性的永远先拦。
 *
 * 这不是沙箱（沙箱管不到远端），这是**审批**。诚实地说：分级靠的是模式识别，
 * 一定有漏网之鱼 —— 所以它是"多一道拦截"，不是"保证安全"。真正要紧的是：
 * 每条命令都进事件日志，事后能查、能回放。
 */

export type RiskLevel = 'read' | 'write' | 'destructive'

/** 明确会毁数据/断服务的东西 */
const DESTRUCTIVE: RegExp[] = [
  // 递归/强制删除一律算毁灭性，不只是指向根的：
  // 以前只认 `rm -rf /`，于是 `rm -rf src` 被当成普通写入，在沙箱里畅通无阻——
  // 而沙箱变不出被删掉的文件
  /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+[^\s|;&]+/,
  /\bfind\b[^|;]*\s-delete\b/,
  /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f?\b.*(\/|\*)/,
  /\bdd\b.*\bof=\/dev\//,
  /\bmkfs(\.\w+)?\b/,
  /\bshutdown\b|\breboot\b|\bhalt\b|\bpoweroff\b/,
  /\bsystemctl\s+(stop|disable|mask)\b/,
  /\bkill\s+-9\s+1\b/,
  /\bchown\s+-R\b.*\s\/\s*$/,
  /\bchmod\s+-R\s+777\b/,
  /\bdrop\s+(database|table)\b/i,
  /\btruncate\s+-s\s*0\b/,
  /\bgit\s+push\s+.*--force\b/,
  /\bapt(-get)?\s+(remove|purge)\b.*\b(openssh|kernel|libc)\b/,
  /\bcurl\b.*\|\s*(ba)?sh\b/,
  /\bwget\b.*\|\s*(ba)?sh\b/,
]

/** 会改状态但不至于当场毁掉 */
const WRITE: RegExp[] = [
  /(^|[^>])>(?!>)\s*\S/, // 单个 > 重定向
  /\brm\b/,
  /\bmv\b|\bcp\b|\bmkdir\b|\btouch\b|\btee\b|\bln\b/,
  /\bchmod\b|\bchown\b/,
  /\bsystemctl\s+(start|restart|enable|reload|daemon-reload)\b/,
  /\b(docker|podman)\s+(run|rm|stop|kill|exec|compose)\b/,
  /\b(npm|pnpm|yarn)\s+(i|install|add|remove|ci)\b/,
  /\bpip3?\s+install\b/,
  /\bapt(-get)?\s+(install|update|upgrade)\b|\byum\b|\bdnf\b|\bapk\b/,
  /\bgit\s+(pull|checkout|reset|clean|clone|commit|push|merge|rebase)\b/,
  /\btar\b.*(-x|c\s*-)/,
  /\bunzip\b|\bgunzip\b/,
  /\bsed\s+-i\b|\bperl\s+-i\b/,
  /\btruncate\b/,
  /\bcrontab\b/,
]

/** 只读命令白名单：出现在首词才算（`cat x && rm y` 会因为 rm 落到 write） */
const READ_HEADS = new Set([
  'ls', 'cat', 'head', 'tail', 'less', 'wc', 'grep', 'egrep', 'rg', 'find', 'stat', 'file',
  'df', 'du', 'free', 'uptime', 'uname', 'whoami', 'id', 'pwd', 'hostname', 'date', 'env',
  'ps', 'top', 'ss', 'netstat', 'ip', 'ifconfig', 'ping', 'nslookup', 'dig', 'host',
  'systemctl', 'journalctl', 'docker', 'podman', 'kubectl', 'git', 'node', 'npm', 'python3',
  'curl', 'wget', 'echo', 'which', 'type', 'sort', 'uniq', 'awk', 'cut', 'tr', 'jq', 'sha256sum',
  'md5sum', 'lsblk', 'lsof', 'nproc', 'getconf', 'test',
])

/** 整条命令里只要出现这些就升级 —— 白名单首词也救不了 */
const HARD_WRITE = /(\brm\b|\bmv\b|\bcp\b|\btee\b|\bsed\s+-i\b|\bchmod\b|\bchown\b|\bdocker\s+rm\b|\bsystemctl\s+(start|restart|stop|enable|disable)\b|\bnpm\s+(i|install)\b|\bmkdir\b|\btouch\b)/

export function classify(command: string): RiskLevel {
  const cmd = command.trim()
  if (!cmd) return 'read'

  for (const re of DESTRUCTIVE) {
    if (re.test(cmd)) return 'destructive'
  }
  if (HARD_WRITE.test(cmd)) return 'write'
  for (const re of WRITE) {
    if (re.test(cmd)) return 'write'
  }

  // 管道/串行里的每一段都要是只读，整条才算只读
  const segments = cmd.split(/&&|\|\||\||;/).map((s) => s.trim()).filter(Boolean)
  for (const seg of segments) {
    const head = seg.split(/\s+/)[0] ?? ''
    const base = head.replace(/^.*\//, '')
    if (!READ_HEADS.has(base)) return 'write'
  }
  return 'read'
}

export function describeRisk(level: RiskLevel): string {
  switch (level) {
    case 'read': return 'read-only'
    case 'write': return 'modifies the remote host'
    case 'destructive': return 'destructive — refused unless explicitly allowed'
  }
}
