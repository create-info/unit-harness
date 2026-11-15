/**
 * 本地 Web UI（`uh serve`）。
 *
 * 形态参考 DeepSeek Harness 的 apps/web + host/webserver：一个本机 HTTP 服务，
 * 前端是纯静态页面，事件走 SSE 实时推送。这样"桌面端"不需要 Electron，
 * 一个二进制的体积和启动速度都和 CLI 一样。
 */
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import pathMod, { join as pjoin } from 'node:path'
import fsSync, { mkdirSync, writeFileSync, existsSync, readFileSync, cpSync, rmSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import fs6 from 'node:fs'
import * as nodeCrypto from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import {
  EventStore, Harness, PROVIDERS, findProvider, hydrateEdits, maskKey, readState,
  listCheckpoints, editsAfterSeq, undoToCheckpoint, lastRestoreSeq,
  buildAdapters, readChannels, writeChannels, missingFields,
  getBinding, setBinding, claimMessage, bindingKey,
  readConfig, resolveProvider, setProviderEntry, uhHome, workspaceDir, writeConfig } from '@unit-harness/core'
import { describeTool, describeToolResult, describeThinking, describeFilesChanged, normalizeBudget, WatchManager } from '@unit-harness/core'
import type { IncomingMessage } from '@unit-harness/core'
import {
  loadMcpServers, discoverSkills, skillRoots, globalMcpConfigPath, projectMcpConfigPath,
  isBuiltinSkill, syncBuiltinSkills,
  expandMentions,
} from '@unit-harness/core'
import { pluginDirs } from './plugin-dirs.ts'
import { deviceForToken, loadDevices, createDevice, revokeDevice, pairUrl } from './pairing.ts'
import type { ApprovalGate, ApprovalRequest, Message } from '@unit-harness/core'
import UI from './ui.html'
import { asrStatus, transcribe } from './asr.ts'

/** 和桌面端、站上同一个图标：32px PNG 直接内联，省一个静态文件路由 */
const FAVICON_PNG = Buffer.from(
  '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',
  'base64',
)

interface Subscriber {
  write: (chunk: string) => void
}


/**
 * 装到手机主屏幕用的图标。
 *
 * 192 和 512 两个尺寸是 Chrome 判定「可安装」的硬条件（少一个就不给安装提示），
 * 所以它们必须和网页一起打包，不能指望用户的手机去 fetch 一张外部图。
 * 图案是暗底 + 两道紫斜杠 + 一个绿点：一眼能认出来，不靠文字。
 */
const ICON_192 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAMAAAADACAYAAABS3GwHAAADfklEQVR42u3dMU4jWRSGUfxkkZQceAvsgBURIBGxB8QeiJAI' +
  'WBE7YAsEiIQEIgIQBuyiqt57/znZjLqHBu5X95qhxWoYNm9HEKr4ECAAEAAIAAQAAgABgABAACAAEAAIAAQAAgABQJvWrb8D' +
  'w2brs7iwl+enZv/sq9b+QoyBF0RcAIZeDJEBGHwhRAZg8IUQGYDBF0JkAAZfCEsphp/kz38x/CRHsMgJZPCp5SQqhp/kbVAM' +
  'P8kRFMNPcgTF8JMcgW+HJlrpoWJsgSoDMPzUPkfF8JMcgdcAeA3g6U/qFrABsAE8/UndAjYANoCnP6lbwAbABvD0J3UL2ADY' +
  'ACAA5w+BZ5ANgA0AAgABuP/Jeh1gA2ADgABAACAAEAAIAAQAAgABgABAACAAEAAIoBMXJw9dvi12Wxt6Q59s9M8JbvUvxPw0' +
  'jLePp82+rURjfrZw1AbwtCduAxw6iIc8med8W/zPBvAimGjdBzDn09WTXABeL3i9IABbAAGAAJxBziABOIMQgC1gCwgABOAM' +
  'QgDOIGeQAGwBBAACcAY5gwTgDEIAtoAtIAAQgDMIATiDEIAtgABAAM4gBOAMQgC2AAIAATiDEIAzCAHYAggABOAMQgDOIARg' +
  'CyAAEIAzCAE4gxCALYAAQADOIAHgDBIAtoAAQAA4gwSAM0gA2AICAAHgDBKAM8gZ1KG1D8G0T+a5Bvq7t/V6f/7pn4/P7nxS' +
  'BNC/r4P/9d8LwQnU7Rm0a/j3/TUCwIthAdDSFri5uvnXTSEAEABOEwHQ2IthBBC3BS6vL//8a30pVABwtBqGzduY/8Cw2Xqi' +
  'T3zG7Pu2fvsKT29P/5fnp4N/r/8T3OHrhI8B960QNsCsW2DKwZ/zbdkANPO0xwbABjj49/oqENEEgABAACAAEAAIAAQAAgAB' +
  'gABAACAAEAAIAKIDGPO92LD0/NkA2AAgABCA1wHk3P82ADaADwECcAYReP7YANgANVYJc82ZDYANYAuQ+PS3AbABWqgUppor' +
  'GwAbwBYg8ek/+QYQAbXPUWn5D4/h9xoAag/AFqDWuSk9vTMY/qpPIBFQ25yUnt85DP9vRv+Y1DH8iFWWfjCWxHcaw19FACJg' +
  '6c//oieQk8jgL62qAIRg8AUgBIMvACEYfAGIwdALQBAGXgAwEd8OjQBAACAAEAAIAAQAAgABgABAACAAEAAIAFr2DlvsbaG2' +
  'IblQAAAAAElFTkSuQmCC',
  'base64',
)
const ICON_512 = Buffer.from(
  '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' +
  'DEYAAAAASUVORK5CYII=',
  'base64',
)

/**
 * 可安装的网页应用描述。
 *
 * `display: standalone` 让它在手机上不是「浏览器里开个网页」，而是没有地址栏的
 * 一切正常 app 的样子；`start_url: '/?src=homescreen'` 留个记号，事后能分清
 * 哪些请求是从主屏幕点进来的。
 */
const MANIFEST = JSON.stringify({
  name: 'UnitHarness',
  short_name: 'UnitHarness',
  description: 'A local coding agent that logs every step it takes.',
  start_url: '/?src=homescreen',
  scope: '/',
  display: 'standalone',
  orientation: 'any',
  background_color: '#0b0b0d',
  theme_color: '#0b0b0d',
  icons: [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
  ],
}, null, 2)

/**
 * Service worker：只做一件事——把请求放过去。
 *
 * Chrome 的安装判定曾经要求「有 fetch 处理器」，现在放宽了，但留着它不亏：
 * 离线时至少不会白屏报错，而缓存策略写多了反而会把新的 UI 锁在手机里。
 */
const SERVICE_WORKER = `self.addEventListener('install', (e) => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))
self.addEventListener('fetch', () => {})
`

export interface ServeOptions {
  port?: number
  host?: string
  /** 非本机监听时要求的口令；不给就自己生成一个并写进 $UH_HOME/serve-token */
  token?: string
  /** 需要 MCP / skills 时置 false */
  quietStartup?: boolean
  /** 没有正在跑的会话时，/api/open 以谁为根目录（默认进程 cwd） */
  workspace?: string
}

const subs = new Map<string, Set<Subscriber>>()

/**
 * 当前工作区。桌面端要能切项目，所以它不能是启动时定死的常量——
 * 每次 run 都把它传给 Harness。刷新页面不丢（服务端内存），重启回到默认。
 */
// 优先级：显式参数 > 环境变量 > 默认工作区。
// `--workspace` 以前会被静默忽略（只有环境变量说了算），于是「指定了工作区却没生效」
// 这种问题只能在别处绕一大圈才发现。
let currentWorkspace = ''
/** 用量要读全部会话日志，别让设置页每开一次就重扫一遍 */
let usageCache: { at: number; data: Record<string, unknown> } | null = null

/**
 * 审批档位，抄 Codex 的三档（AskForApproval）：
 *
 *   ask    每个需要批准的动作都问（默认）
 *   auto   「帮我批准」：只有 destructive 才问，沙箱兜不住的写自动过
 *   allow  「完全访问」：不问。只该在你知道自己在干什么时打开
 *
 * 默认 ask 而不是 allow：装插件、跑陌生仓库时，静默执行破坏性命令是最贵的错。
 */
export type ApprovalMode = 'ask' | 'auto' | 'allow'

/**
 * 项目显示名：路径 → 名字。
 *
 * 路径是真相，名字只是左栏上的标签。分开存是因为「重命名项目」不该动文件系统——
 * 在 Codex 里也是这个意思：项目名是人给的别名，源文件夹才是它跑的地方。
 */
function projectNamesFile(): string {
  return pathMod.join(uhHome(), 'projects.json')
}

function readProjectNames(): Record<string, string> {
  try { return JSON.parse(fs6.readFileSync(projectNamesFile(), 'utf8')) as Record<string, string> } catch { return {} }
}

/** 记一笔「这个工作区打开过」：空项目也要留在左栏，否则它看起来像没打开成功 */
function rememberProject(path: string): void {
  const cfg = readConfig()
  const list = cfg.projects ?? []
  if (list.includes(path)) return
  list.push(path)
  // 只留最近 50 个：这里记的是「打开过的」，不是永久历史
  writeConfig({ ...cfg, projects: list.slice(-50) })
}

function writeProjectName(path: string, name: string): void {
  const names = readProjectNames()
  if (name.trim()) names[path] = name.trim()
  else delete names[path]
  fs6.mkdirSync(pathMod.dirname(projectNamesFile()), { recursive: true })
  fs6.writeFileSync(projectNamesFile(), JSON.stringify(names, null, 2) + '\n', { mode: 0o600 })
}

/** 沙箱偏好，默认什么都不开 */
function sandboxPrefs(): { allowHome: boolean; denyNetwork: boolean; unconfined: boolean } {
  const sp = readConfig().sandbox ?? {}
  // allowHome 默认开：见 main.ts 里的说明
  return { allowHome: sp.allowHome !== false, denyNetwork: sp.denyNetwork === true, unconfined: sp.unconfined === true }
}

function approvalMode(): ApprovalMode {
  const m = readConfig().approval
  return m === 'auto' || m === 'allow' ? m : 'ask'
}

/**
 * UnitAI 账号。
 *
 * 登录走的是「浏览器里已经登录 → 复制令牌 → 粘进来」这条路，而不是在自己的壳里
 * 复刻一遍手机验证码 + 图形滑块：滑块是 go-captcha 的 2D 拼图，x/y 都要对（容差 6px），
 * 我们这边没有配套的 React 组件，硬凑一套只会让登录比不改还难用。
 *
 * 令牌就是网页的 aw_auth_token（unitai.site/mcp 页面上直接能复制），有效期 30 天、
 * 不续期——所以要把它读出来显示，别让人某天突然被踢下线还找不到原因。
 * 存在 ~/.uh/account.json，0600，不进事件日志。
 */
const UNITAI_BASE = process.env.UH_UNITAI_BASE || 'https://unitai.site'

function accountFile(): string {
  return pathMod.join(uhHome(), 'account.json')
}

function readAccountToken(): string {
  try {
    const raw = JSON.parse(fs6.readFileSync(accountFile(), 'utf8')) as { token?: string }
    return raw.token ?? ''
  } catch { return '' }
}

function writeAccountToken(token: string): void {
  fs6.mkdirSync(pathMod.dirname(accountFile()), { recursive: true })
  fs6.writeFileSync(accountFile(), JSON.stringify({ token }, null, 2) + '\n', { mode: 0o600 })
  try { fs6.chmodSync(accountFile(), 0o600) } catch { /* windows */ }
}

async function unitai(path: string, token: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: unknown }> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 12000)
  try {
    const r = await fetch(UNITAI_BASE + path, {
      ...init,
      headers: {
        ...(init?.headers ?? {}),
        ...(token ? { authorization: 'Bearer ' + token } : {}),
      },
      signal: ctl.signal,
    })
    const text = await r.text()
    let body: unknown = text
    try { body = JSON.parse(text) } catch { /* keep text */ }
    return { ok: r.ok, status: r.status, body }
  } finally {
    clearTimeout(timer)
  }
}

/** 正在跑的 harness，`POST /api/stop` 要能找到它 */
const running = new Map<string, Harness>()

/**
 * 渠道来信 → 一条 agent 会话里的一轮。
 *
 * 三条不能省的规矩：
 *  1. **同一个人接到同一条会话**（binding）：上下文连着，检查点也才连得起来；
 *  2. **同一个聊天排队**：连发两句时两轮会同时改同一个仓库，谁最后写谁算，
 *     那正是「我明明让它先删再建」却只剩一半的原因；
 *  3. **重投去重**：渠道没等到 200 会重投，不去重就执行两三遍。
 */
const chatQueue = new Map<string, Promise<unknown>>()

async function askViaChannel(msg: IncomingMessage): Promise<string | null> {
  // 渠道重投：这句话已经跑过了，不要跑第二次，也不要回第二句
  if (!claimMessage(msg.channel, msg.messageId)) return null
  const key = bindingKey(msg.channel, msg.chatId)
  const prev = chatQueue.get(key) ?? Promise.resolve()
  const job = prev.catch(() => {}).then(() => runChannelTurn(msg))
  chatQueue.set(key, job.catch(() => {}))
  return (await job) as string
}

async function runChannelTurn(msg: IncomingMessage): Promise<string> {
  const b = getBinding(msg.channel, msg.chatId)
  const st = b ? readState(b.sessionId) : null
  const turns = (b?.turns ?? 0) + 1
  const h = new Harness({
    pluginDirs: [],
    logLevel: 'error',
    label: `[${msg.channel}] ${msg.text.slice(0, 50)}`,
    ...(b ? { resumeSessionId: b.sessionId } : {}),
  })
  await h.start()
  const sid = h.sessionId ?? ''
  if (sid) running.set(sid, h)
  try {
    const out = await h.runTask({
      task: msg.text,
      displayTask: msg.text,
      ...(st?.messages.length ? { resumeFrom: st.messages } : {}),
      ...(turns > 1 ? { turnIndex: turns } : {}),
    })
    if (sid) setBinding(msg.channel, msg.chatId, { sessionId: sid, turns, updatedAt: new Date().toISOString() })
    const text = (out.text ?? '').trim()
    return text || '（这一轮没有输出）'
  } finally {
    if (sid) running.delete(sid)
  }
}

/**
 * 等人在网页上点「允许/拒绝」的审批。
 *
 * CLI 里是 readline，网页里必须是同一件事：把请求推给前端、挂一个 promise、
 * 等人点。五分钟没人理就当拒绝——把「没人回答」当成允许是最坏的那种默认。
 */
/**
 * 工作区文件监听。一个进程一个，所有 SSE 连接共享底层 watcher。
 *
 * 200ms 与 Codex 一致：编辑器保存一次文件通常会触发好几个事件，
 * 窗口太短前端会被刷爆，太长会显得迟钝。
 */
const watchManager = new WatchManager({
  debounceMs: 200,
  onBatch: (clientId: string, _watchId: string, ev: { paths: string[] }) => {
    const sub = fileSubs.get(clientId)
    if (!sub) return
    try {
      sub.write(`event: fs/changed\ndata: ${JSON.stringify({ paths: ev.paths })}\n\n`)
    } catch { /* 连接已断 */ }
  },
})
/**
 * Tailscale 能不能用来远程（不在同一个 Wi-Fi 也连得上）。
 *
 * 三条状态分开报：没装 / 装了没登录 / 在线。只说「不可用」会让人以为是
 * 网络问题，实际是差了 `tailscale up` 那一步。
 */
function tailscaleState(): {
  state: 'absent' | 'logged-out' | 'up'
  ip?: string
  host?: string
  serving?: boolean
  peers?: Array<{ name: string; ip: string; os: string; online: boolean }>
} {
  let ip = ''
  try {
    ip = (execFileSync('tailscale', ['ip', '-4'], { timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim().split('\n')[0]) ?? ''
  } catch { /* 落到下面继续判断 */ }
  if (!ip) {
    try {
      execFileSync('tailscale', ['version'], { timeout: 3000, stdio: 'ignore' })
      return { state: 'logged-out' }
    } catch {
      return { state: 'absent' }
    }
  }
  // MagicDNS 名字：`tailscale serve` 之后手机打开的是 https://<名字>.<tailnet>.ts.net
  let host = ''
  let serving = false
  try {
    const j = JSON.parse(execFileSync('tailscale', ['status', '--json'], { timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] }).toString())
    host = String(j?.Self?.DNSName ?? '').replace(/\.$/, '')
  } catch { /* 名字拿不到就只报 IP */ }
  try {
    // `tailscale serve status` 在有转发时输出非空；空输出=没在转发
    const out = execFileSync('tailscale', ['serve', 'status'], { timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim()
    serving = out.length > 0 && !/no serve config/i.test(out)
  } catch { /* 老版本没有这个子命令 */ }
  // tailnet 里还有谁：引导页要能直接说「你的手机在不在这个网络里」，
  // 让人去控制台翻列表是最没必要的一步
  const peers: Array<{ name: string; ip: string; os: string; online: boolean }> = []
  try {
    const j = JSON.parse(execFileSync('tailscale', ['status', '--json'], { timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] }).toString())
    for (const p of Object.values(j?.Peer ?? {}) as Array<Record<string, unknown>>) {
      const ips = (p.TailscaleIPs as string[] | undefined) ?? []
      peers.push({
        name: String(p.HostName ?? ''),
        ip: ips.find((a) => !a.includes(':')) ?? ips[0] ?? '',
        os: String(p.OS ?? ''),
        online: Boolean(p.Online),
      })
    }
  } catch { /* 拿不到就报空 */ }
  return { state: 'up', ip, host, serving, peers }
}

/** 读文件失败返回空串：路径来自请求，不该把整个接口带崩 */
const readFileSyncSafe = (p: string): string => {
  try { return readFileSync(p, 'utf8') } catch { return '' }
}
const statSyncSafe = (p: string): ReturnType<typeof statSync> | null => {
  try { return statSync(p) } catch { return null }
}

/** `::ffff:192.168.1.5` / `::1` 这类写法先归一，不然前缀判断全会错 */
function normalizeAddr(a: string | undefined): string {
  const s = String(a ?? '')
  return s.startsWith('::ffff:') ? s.slice(7) : s
}

/** Tailscale 的地址段固定是 100.64.0.0/10 —— 只有 tailnet 里的设备在里头 */
function isTailnetAddr(a: string): boolean {
  const m = /^100\.(\d+)\./.exec(a)
  return Boolean(m) && Number(m![1]) >= 64 && Number(m![1]) <= 127
}

/** 手机真正连得上的地址：跳过 docker/bridge 那几个（列出来只会让人多试几次） */
function lanAddresses(): string[] {
  const out: string[] = []
  for (const list of Object.values(os.networkInterfaces())) {
    for (const n of list ?? []) {
      if (n.family === 'IPv4' && !n.internal && !/^172\.(1[7-9]|2\d|3[01])\./.test(n.address)) {
        out.push(n.address)
      }
    }
  }
  return out
}

/** clientId → 这条 SSE 连接的写入口 */
const fileSubs = new Map<string, Subscriber>()
let nextWatchClient = 1

const pendingApprovals = new Map<string, (d: 'allow' | 'allow-always' | 'deny') => void>()

/**
 * 待决审批的完整内容，按 session 留一份。
 *
 * 光广播不够：请求可能在页面连上 SSE 之前就发出了（刷新页面、网络抖动、刚打开窗口），
 * 那一刻没人听，任务就只剩「等五分钟超时然后拒绝」。新连接进来时重放一遍，才真正等价于
 * CLI 里那句一直等在终端上的提示。
 */
const pendingInfo = new Map<string, { sid: string; payload: Record<string, unknown> }>()

/**
 * 每个会话最近的广播，等前端接上来时补发。
 *
 * `POST /api/run` 是先开始跑、再返回 sessionId 的，而前端拿到 id 才连 SSE——
 * 这中间的几百毫秒正好是模型的第一轮思考。不缓冲的话，用户永远看不到
 * 「它一开始在想什么」，只看得见后半截，看起来就像模型没思考。
 */
const evBuf = new Map<string, Array<{ kind: string; payload: Record<string, unknown> }>>()
const EV_BUF_MAX = 800

function bufferEvent(sid: string, kind: string, payload: Record<string, unknown>): void {
  const arr = evBuf.get(sid) ?? []
  arr.push({ kind, payload })
  if (arr.length > EV_BUF_MAX) arr.splice(0, arr.length - EV_BUF_MAX)
  evBuf.set(sid, arr)
}

/**
 * 这台机器上，电脑操控到底能做到哪一步。
 *
 * 分两类报：截屏（看）和输入模拟（动）。两者的依赖完全不同——截屏有 ffmpeg
 * 就够，输入要 xdotool（X11）或 ydotool（Wayland）。分开报是因为
 * 「我能看见但动不了」和「完全不行」是两件事，混在一个布尔里没法做决定。
 */
function haveCmd(name: string): boolean {
  try {
    execFileSync('sh', ['-c', `command -v ${name}`], { stdio: 'ignore', timeout: 2000 })
    return true
  } catch {
    return false
  }
}

function sessionType(): 'x11' | 'wayland' | 'none' {
  if (process.env.WAYLAND_DISPLAY) return 'wayland'
  if (process.env.DISPLAY) return 'x11'
  return 'none'
}

function computerStatus() {
  const cfg = readConfig().computer ?? {}
  const session = sessionType()
  const grabber = session === 'x11'
    ? (haveCmd('ffmpeg') ? 'ffmpeg x11grab' : haveCmd('scrot') ? 'scrot' : haveCmd('import') ? 'import' : '')
    : session === 'wayland'
      ? (haveCmd('grim') ? 'grim' : '')
      : '';
  const input = session === 'x11'
    ? (haveCmd('xdotool') ? 'xdotool' : '')
    : session === 'wayland'
      ? (haveCmd('ydotool') ? 'ydotool' : '')
      : '';
  return {
    // 总开关默认开：截屏本身不改变任何东西，先让人看见它行不行
    enabled: cfg.enabled !== false,
    // 分项开关也要回给界面，否则关掉之后刷新一看还是"开"的
    screenshotsEnabled: cfg.screenshots !== false,
    controlEnabled: cfg.control === true,
    screenshots: {
      available: Boolean(grabber),
      tool: grabber,
    },
    control: {
      available: Boolean(input),
      tool: input,
      // 没有工具时说清要装什么，而不是让用户对着一个灰按钮猜
      need: input ? '' : session === 'wayland' ? 'ydotool' : 'xdotool',
    },
    session,
    display: process.env.DISPLAY || process.env.WAYLAND_DISPLAY || '',
    allowedApps: cfg.allowedApps ?? [],
    // 这一层碰的是真实的桌面，沙箱管不到。状态里必须这么写。
    isolation: 'none' as const,
    external: true as const,
  }
}

function captureScreen(out: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const session = sessionType()
    const args = session === 'x11'
      ? (haveCmd('ffmpeg')
          // 缩到 1600 宽：4K 原图在设置页里只是个小预览，580KB 传过来纯属浪费，
          // 而且整页会卡住浏览器
          ? ['ffmpeg', '-loglevel', 'error', '-f', 'x11grab', '-i', process.env.DISPLAY || ':0',
             '-vf', 'scale=1600:-1', '-frames:v', '1', '-y', out]
          : haveCmd('scrot') ? ['scrot', '-o', out]
          : haveCmd('import') ? ['import', '-window', 'root', out]
          : null)
      : (haveCmd('grim') ? ['grim', out] : null)
    if (!args) { reject(new Error('no screenshot tool')); return }
    const child = spawn(args[0] as string, args.slice(1), { stdio: 'ignore' })
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('timed out')) }, 20_000)
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`${args[0]} exited ${code}`))
    })
    child.on('error', (e) => { clearTimeout(timer); reject(e) })
  })
}

/** 口令文件：只有本机用户读得到（0600）。没有就生成一个。 */
function serveToken(): string {
  const file = pjoin(uhHome(), 'serve-token')
  try {
    const t = fs6.readFileSync(file, 'utf8').trim()
    if (t) return t
  } catch { /* 头一次启动，还没有 */ }
  const t = nodeCrypto.randomBytes(18).toString('base64url')
  fs6.mkdirSync(uhHome(), { recursive: true })
  fs6.writeFileSync(file, t + '\n', { mode: 0o600 })
  return t
}

/** 定长比较，别让口令能被逐字符猜出来 */
function safeEqual(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false
  return nodeCrypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))
}

function makeWebGate(sidRef: { id: string }): ApprovalGate {
  return {
    async request(req: ApprovalRequest) {
      const mode = approvalMode()
      // 完全访问：不问。事件里仍然记一条 auto，否则事后没法解释「为什么它自己跑了」
      if (mode === 'allow') return 'allow'
      // 帮我批准：只拦真正不可逆的。沙箱兜不住的写入让它写——每装一个包点一次 y
      // 只会训练人闭眼按同意，那是把审批做成仪式
      if (mode === 'auto' && req.risk !== 'destructive') return 'allow'

      const id = 'apr_' + Math.random().toString(36).slice(2, 10)
      const payload = {
        id,
        kind: req.kind,
        risk: req.risk,
        summary: req.summary,
        detail: req.detail,
        reason: req.reason,
        // null 表示这条命令不允许被记住，界面就不显示那个复选框
        persistPrefix: req.persistPrefix ?? null,
        persistExact: req.persistExact === true,
      }
      pendingInfo.set(id, { sid: sidRef.id, payload })
      broadcast(sidRef.id, 'approval/needs', payload)
      const decision = await new Promise<'allow' | 'allow-always' | 'deny'>((resolve) => {
        pendingApprovals.set(id, resolve)
        const timer = setTimeout(() => {
          if (pendingApprovals.delete(id)) resolve('deny')
        }, 300_000)
        // 有人回答时把定时器摘掉，别让进程被它吊住
        const orig = resolve
        pendingApprovals.set(id, (d) => { clearTimeout(timer); orig(d) })
      })
      return decision
    },
  }
}

/**
 * 给事件补一句人话。
 *
 * 屏幕上是给用户看的，不是协议转储：`run_command`、`argv`、`tool_call(s)`
 * 这些词只该出现在日志里。翻译放在服务端，因为 Web UI 拿到的是静态页，
 * 而 ACP / CLI 也要用同一套说法——三处各写一套就是同一个动作三个名字。
 */
function progressOf(kind: string, payload: Record<string, unknown>): Record<string, unknown> {
  try {
    if (kind === 'tool/call') {
      const { label, detail } = describeTool(String(payload.tool ?? ''), payload)
      return { label, ...(detail ? { detail } : {}) }
    }
    if (kind === 'tool/result') {
      const { label } = describeToolResult(String(payload.tool ?? ''), payload)
      return { label }
    }
    if (kind === 'llm/request') return { label: describeThinking().label }
    if (kind === 'checkpoint/file') {
      const added = Number(payload.added ?? 0)
      const removed = Number(payload.removed ?? 0)
      return { label: describeFilesChanged(added, removed, 1).label }
    }
  } catch {
    // 翻译失败绝不能挡住事件本身：宁可显示原文，也不能让界面少一条
  }
  return {}
}

function broadcast(sessionId: string, kind: string, payload: Record<string, unknown>): void {
  // 盖上发送时刻：前端算「+2.3s」要用事件自己的时间，不然补发的那一批全显示成 +0.0s
  const stamped = { ...payload, ...progressOf(kind, payload), _ts: Date.now() }
  // 先记账，再看有没有人订阅。没有人听的时候正是最需要缓冲的时候——
  // 早退之前就 return，等于「没人在场就不留证据」，前端后来接上只能看到后半截
  bufferEvent(sessionId, kind, stamped)
  const set = subs.get(sessionId)
  if (!set) return
  const frame = `event: ${kind}\ndata: ${JSON.stringify(stamped)}\n\n`
  for (const s of set) {
    try { s.write(frame) } catch { /* client gone */ }
  }
}

function json(res: http.ServerResponse, code: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(Buffer.from(c))
  return Buffer.concat(chunks).toString('utf8')
}

/** 路径必须落在工作区内。refs 是前端传来的字符串，不能直接 join */
function underWorkspace(rel: string): string | null {
  const base = pathMod.resolve(currentWorkspace)
  const abs = pathMod.resolve(base, rel)
  if (abs !== base && !abs.startsWith(base + pathMod.sep)) return null
  return abs
}

const REF_SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.uh', '.cache', '__pycache__', '.venv', 'target'])

/**
 * 工作区里有哪些文件可以被 @ 到。
 *
 * 不用 `git ls-files`：换项目时目录未必是 git 仓库，而且用户常常就想引用
 * 一个还没提交的新文件。直接走目录，跳过那些一旦展开就没法收尾的目录。
 */
function listWorkspaceFiles(limit = 3000): string[] {
  const out: string[] = []
  const walk = (dir: string, depth: number) => {
    if (out.length >= limit || depth > 8) return
    let entries: import('node:fs').Dirent[]
    try { entries = fsSync.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (out.length >= limit) return
      if (e.name.startsWith('.') && e.name !== '.env.example') continue
      if (e.isDirectory()) {
        if (REF_SKIP.has(e.name)) continue
        walk(pathMod.join(dir, e.name), depth + 1)
      } else if (e.isFile()) {
        const abs = pathMod.join(dir, e.name)
        out.push(pathMod.relative(currentWorkspace, abs))
      }
    }
  }
  walk(currentWorkspace, 0)
  return out
}

/**
 * ISO 时间戳 → 本地时区的 `YYYY-MM-DD HH:MM:SS`。
 *
 * 事件里存的是 UTC（这是对的，换台机器也读得懂），但显示必须转成本地时区。
 * 原来直接 `replace('T',' ').slice(0,19)`，把 UTC 的时分当成本地时间显示，
 * 东八区的人看到的时间会比手表早 8 小时——而且不会觉得是 bug，
 * 只会觉得这个软件的时间是错的。
 */
function localStamp(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso.replace('T', ' ').slice(0, 19)
  const p2 = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ` +
         `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`
}

function collectSessions(workspace?: string): Array<{ id: string; label: string; created: string; events: number; status: string; workspace: string }> {
  const store = new EventStore()
  try {
    return store
      .list({ limit: workspace ? 300 : 50 })
      .filter((s) => !workspace || (s as { workspace?: string }).workspace === workspace)
      .slice(0, 50)
      .map((s) => ({
        id: s.id,
        label: s.label ?? '(untitled)',
        created: localStamp(s.created_at),
        events: s.last_seq,
        status: s.status,
        workspace: (s as { workspace?: string }).workspace ?? '',
      }))
  } catch {
    return []
  }
}

/**
 * 口令页。
 *
 * 之前这里只有一句「口令在启动它的那台机器上：~/.uh/serve-token」——
 * 在电脑上开到 0.0.0.0 之后用 127.0.0.1 打开，会看到这句话；手机上也一样。
 * 但手机用户既拿不到那台机器的终端，也不该为了看一眼界面去敲一条 URL。
 * 所以给一个能输入口令的表单：POST /__unlock 种 cookie 然后回到原来那页。
 */
function unlockPage(host: string, mode: 'off' | 'tailnet' | 'lan' = 'off', port = 7878): string {
  return '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'
    + '<title>UnitHarness · 口令</title>'
    + '<body style="background:#0b0b0d;color:#e6e6e6;font:15px system-ui;padding:32px;line-height:1.7;max-width:560px;margin:0 auto">'
    + '<h2 style="font-weight:600">需要口令</h2>'
    + '<p style="color:#9a9aa5">' + (mode === 'off'
      ? '这个 uh 只听本机 ' + host + '，你是从别的设备转发进来的，所以要先证明是你。'
      : '这个 uh 开了远程访问（端口 ' + port + '），同一个网络里的设备都能连到它，所以要先证明是你。')
    + '</p>'
    + '<p style="color:#9a9aa5">口令在跑它的那台电脑上：<code>~/.uh/serve-token</code>。'
    + '手机上不方便看文件？在「设置 → 远程访问」里点地址旁的「二维码」，扫一下就进去了。</p>'
    + '<form method="POST" action="/__unlock" style="margin-top:24px">'
    + '<input name="t" autocomplete="off" spellcheck="false" placeholder="粘贴口令" '
    + 'style="width:100%;box-sizing:border-box;padding:12px 14px;border-radius:10px;border:1px solid #2a2a32;'
    + 'background:#15151a;color:#e6e6e6;font:15px ui-monospace,monospace">'
    + '<button type="submit" style="margin-top:12px;width:100%;padding:12px;border-radius:10px;border:0;'
    + 'background:#7c5cff;color:#fff;font:15px system-ui;font-weight:600">进入</button>'
    + '</form>'
    + '<p style="color:#6a6a75;font-size:13px;margin-top:20px">输入一次，浏览器会记住一年。'
    + '口令只存在你这台设备的 cookie 里。</p></body>'
}

export async function startServer(opts: ServeOptions = {}): Promise<{
  url: string
  close: () => void
  /** 换远程访问档位（设置页/测试用），端口号不变 */
  setRemoteMode: (m: 'off' | 'tailnet' | 'lan') => Promise<void>
}> {
  const port = opts.port ?? 7878
  const host = opts.host ?? '127.0.0.1'
  // 内置技能先落地，再开始接请求：否则第一次打开插件页会是空列表，
  // 而「create-skill」这种东西本来就是为了让人一上手就能用上
  try { syncBuiltinSkills() } catch { /* 装不进就不装，不能因此起不来 */ }
  currentWorkspace = opts.workspace || process.env.UH_WORKSPACE || workspaceDir()
  // 只听 loopback 时不设防（本机就是你的）。一旦绑到别的地址，这个端口
  // 就能让局域网里任何人驱动一个有 shell 的 agent——必须带口令。
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1'
  // 口令一直准备好：默认只听本机时用不到，但设置页一开远程就要马上生效
  const token = opts.token || process.env.UH_SERVE_TOKEN || serveToken()

  // ---- 远程访问：一个端口，设置页里开关 ------------------------------------
  //
  // 以前是「想给手机用就再起一个 --lan 的进程」，于是 7878 和 7911 各跑一份，
  // 会话、插件、审批状态都不在一处，用户还要记两个端口。现在只有 7878：
  // 绑定地址由这里的三档决定，改完了就地换绑，不重启进程。
  type RemoteMode = 'off' | 'tailnet' | 'lan'
  const savedRemote = readConfig().remote
  let remoteMode: RemoteMode = loopback
    ? (savedRemote === 'tailnet' || savedRemote === 'lan' ? savedRemote : 'off')
    : 'lan'
  let bindAddr = remoteMode === 'off' ? '127.0.0.1' : '0.0.0.0'

  const handleRequest = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', `http://${host}:${port}`)

    // 口令页的表单提交口，必须在鉴权之前处理——否则「进来要口令、交口令
    // 也要口令」，自己把自己锁在门外。
    if (req.method === 'POST' && url.pathname === '/__unlock') {
      const form = new URLSearchParams(await readBody(req))
      const tried = (form.get('t') ?? '').trim()
      const good = (Boolean(token) && safeEqual(tried, token)) || Boolean(deviceForToken(tried))
      if (!good) {
        res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' })
        res.end(unlockPage(host, remoteMode, port).replace('placeholder="粘贴口令"', 'placeholder="口令不对，再试一次"'))
        return
      }
      res.writeHead(303, {
        location: '/',
        'set-cookie': `uh_t=${encodeURIComponent(tried)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`,
      })
      res.end()
      return
    }

    // 「能不能不输口令」取决于对端是谁，不是端口绑在哪：
    // 开了远程访问之后端口绑到 0.0.0.0，桌面上用 127.0.0.1 打开不该突然要口令。
    const peer = normalizeAddr(req.socket.remoteAddress)
    // 转发进来的请求对端也写 127.0.0.1（tailscale serve / 反向代理都这样），
    // 但它来自 tailnet，不是坐在电脑前的人——只看地址就等于把门敞开。
    //
    // 只有「本机代理」写的 X-Forwarded-For 才当证据：局域网里的机器完全可以
    // 自己伪造一个 100.x 头来骗过 tailnet 判断，所以对端一旦不是回环就整条忽略。
    const fromProxy = (peer === '127.0.0.1' || peer === '::1')
      && Boolean(req.headers['x-forwarded-for'] || req.headers.forwarded)
    const origin = fromProxy
      ? normalizeAddr(String(req.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim() ?? '')
      : peer
    const peerLocal = (peer === '127.0.0.1' || peer === '::1') && !fromProxy

    // 「仅 Tailscale」：端口对局域网开着，但只认 100.64/10 来的包。
    // 光靠绑定地址做不到这一点——tailscale0 和 eth0 都在同一个 socket 上。
    if (remoteMode === 'tailnet' && !peerLocal && !isTailnetAddr(origin)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('这台机器只接受 Tailscale 网络内的连接')
      return
    }

    if (token && !peerLocal) {
      const given = url.searchParams.get('t')
        ?? String(req.headers['x-uh-token'] ?? '')
        ?? ''
      const cookie = /(?:^|; )uh_t=([^;]+)/.exec(String(req.headers.cookie ?? ''))?.[1] ?? ''
      // 两种凭据都认：这把服务口令（全机一把），或者某台已配对设备的令牌
      // （每台一把、可单台撤销）。`uh pair` 发的是后者。
      const ok = safeEqual(given, token) || safeEqual(cookie, token)
        || Boolean(deviceForToken(given)) || Boolean(deviceForToken(cookie))
      if (!ok) {
        // 只放行「装成 app」需要的静态件，接口一个都不给
        // /webhook/ 也要放行：渠道服务器不会带我们的口令，它们各自的验签在 adapter 里
        const open = url.pathname.startsWith('/webhook/')
          || ['/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/sw.js', '/favicon.ico', '/favicon.png'].includes(url.pathname)
        if (!open) {
          res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' })
          // 光说「去那台机器上看文件」在手机上没用：手机不是那台机器，
          // 人在手机上也没法 cat。所以这一页要能直接输口令，输一次就记住。
          // 口令仍然不打在页面上（页面可能被投屏、被截图），只给输入框。
          res.end(unlockPage(host, remoteMode, port))
          return
        }
      } else if (given && !cookie) {
        // 第一次带 ?t= 进来：种 cookie 并把口令从地址栏去掉，
        // 否则它会留在历史记录、截图和别人的录像里
        const rest = new URL(url.toString())
        rest.searchParams.delete('t')
        res.writeHead(302, {
          location: rest.pathname + (rest.search || ''),
          'set-cookie': `uh_t=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`,
        })
        res.end()
        return
      }
    }

    // 浏览器标签页的图标：不提供就会去要 /favicon.ico，然后拿到 404
    if (req.method === 'GET' && (url.pathname === '/favicon.ico' || url.pathname === '/favicon.png')) {
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' })
      res.end(FAVICON_PNG)
      return
    }

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      // 这一页会跟着每次 build 变。不设 no-store 的话，手机上「添加到主屏幕」
      // 之后拿到的是旧页面，改了界面也看不见，还得手动清缓存。
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(UI)
      return
    }

    // 「装到手机主屏幕」需要三样东西：manifest、图标、一个 fetch 处理器
    if (req.method === 'GET' && url.pathname === '/manifest.webmanifest') {
      res.writeHead(200, { 'content-type': 'application/manifest+json; charset=utf-8', 'cache-control': 'no-cache' })
      res.end(MANIFEST)
      return
    }
    if (req.method === 'GET' && (url.pathname === '/icon-192.png' || url.pathname === '/icon-512.png')) {
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' })
      res.end(url.pathname === '/icon-192.png' ? ICON_192 : ICON_512)
      return
    }
    // 配对二维码：让服务端用同一份 qrcode 库出 PNG，终端里 `uh pair` 打的那种码
    // 和页面上扫的是同一个东西。前端不引 QR 库——那要多 30KB 且各端渲染不一致。
    if (req.method === 'GET' && url.pathname === '/api/remote/qr') {
      const text = String(url.searchParams.get('t') ?? '')
      if (!text || text.length > 512) { json(res, 400, { error: 'bad text' }); return }
      try {
        const QR = (await import('qrcode')).default
        const png = await QR.toBuffer(text, { type: 'png', margin: 1, width: 320 })
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' })
        res.end(png)
      } catch (e) {
        json(res, 500, { error: String(e) })
      }
      return
    }

    if (req.method === 'GET' && url.pathname === '/sw.js') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' })
      res.end(SERVICE_WORKER)
      return
    }

    // ---- 渠道：微信 / 企业微信 / 飞书 ------------------------------------
    // 一个人在一个群里说的话，应该接到同一条 agent 会话上：上下文连续，检查点也连续。
    // 这些请求来自公网，不可能带本机口令——所以放行到 /webhook/，改由各渠道自己验签。
    // 验不过一律当「没收到」，回 200 空体：回错误码只会让对方重投，越投越多。
    if (url.pathname.startsWith('/webhook/')) {
      const id = url.pathname.slice('/webhook/'.length).split('/')[0] ?? ''
      const adapter = buildAdapters(readChannels()).find((a) => a.id === id)
      if (!adapter) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('no such channel'); return }
      const body = req.method === 'POST' ? await readBody(req) : ''
      const query: Record<string, string> = {}
      url.searchParams.forEach((v, k) => { query[k] = v })
      const headers: Record<string, string | undefined> = {}
      for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : v
      try {
        const out = await adapter.handle({ method: req.method ?? 'GET', query, body, headers }, {
          ask: (msg) => askViaChannel(msg),
          log: (lvl, m) => { if (lvl === 'error') console.error(m); else console.warn(m) },
        })
        if (!out) { res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }); res.end(''); return }
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', ...(out.headers ?? {}) })
        res.end(out.body ?? '')
      } catch (err) {
        console.error(`webhook ${id} failed:`, err)
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('')
      }
      return
    }

    // 渠道配置：设置页要能填、能看到还缺什么。密钥只回「有没有」，不回原文。
    if (url.pathname === '/api/channels') {
      if (req.method === 'GET') {
        const cfg = readChannels()
        const mask = (v?: string) => (v ? '••••' + v.slice(-4) : '')
        json(res, 200, {
          config: {
            wecom: { corpId: cfg.wecom?.corpId ?? '', agentId: cfg.wecom?.agentId ?? '', hasSecret: Boolean(cfg.wecom?.secret), hasToken: Boolean(cfg.wecom?.token), hasAes: Boolean(cfg.wecom?.encodingAesKey) },
            feishu: { appId: cfg.feishu?.appId ?? '', hasSecret: Boolean(cfg.feishu?.appSecret), hasVerificationToken: Boolean(cfg.feishu?.verificationToken), hasEncryptKey: Boolean(cfg.feishu?.encryptKey) },
            weixin: { appId: cfg.weixin?.appId ?? '', baseUrl: cfg.weixin?.baseUrl ?? '', hasSecret: Boolean(cfg.weixin?.appSecret), hasToken: Boolean(cfg.weixin?.token), secretHint: mask(cfg.weixin?.appSecret) },
          },
          missing: missingFields(cfg),
          active: buildAdapters(cfg).map((a) => a.id),
          webhookBase: 'https://<你的公网地址>/webhook/',
        })
        return
      }
      if (req.method === 'POST') {
        const body = JSON.parse(await readBody(req).catch(() => '{}')) as Record<string, Record<string, string> | undefined>
        const cur = readChannels()
        const next = { ...cur }
        // 只覆盖传上来的字段；空串表示「保持原值」（界面上不回显密钥，凑不全会误清）
        for (const ch of ['wecom', 'feishu', 'weixin'] as const) {
          const inc = body[ch]
          if (!inc) continue
          const merged: Record<string, string> = { ...(cur[ch] as Record<string, string> | undefined) }
          for (const [k, v] of Object.entries(inc)) if (v !== '') merged[k] = v
          next[ch] = merged as never
        }
        writeChannels(next)
        json(res, 200, { ok: true, missing: missingFields(next), active: buildAdapters(next).map((a) => a.id) })
        return
      }
    }

    // ---- 远程访问（配对设备）----
    // 手机上要能看到「这台电脑现在能被谁连、连的是哪个地址」，还要能在这里
    // 撤销。以前只能回电脑敲 uh devices / uh unpair——人不在电脑前面就办不到。
    if (req.method === 'GET' && url.pathname === '/api/remote') {
      const token = serveToken()
      const addrs = lanAddresses()
      const ts = tailscaleState()
      const loopback = remoteMode === 'off'
      // 手机真能打开的地址，完全由当前模式决定：
      //   off     一个都没有（端口根本没对外）
      //   tailnet 只有 100.x 那条（局域网机器连得上也进不来）
      //   lan     局域网各地址 + 100.x（去重：Tailscale IP 本身就是一块网卡）
      // 有域名转发在跑时，域名永远是「手机该用的那个地址」——哪怕这个页面是本机
      // 打开的（对端 127.0.0.1，看不到转发头），哪怕模式是 tailnet。
      // 之前这里只在「off」或「请求自己被转发过」时才给域名，于是从电脑上看设置页
      // 显示的还是 100.x:7878 裸地址，跟实际在用的方案对不上。
      const serveUp = ts.state === 'up' && Boolean(ts.serving) && Boolean(ts.host)
      const urls = serveUp
        ? [`https://${ts.host}`]
        : remoteMode === 'off'
          ? []
        : [...new Set([
          ...(remoteMode === 'lan' ? addrs.filter((a) => !isTailnetAddr(a)).map((a) => `http://${a}:${port}`) : []),
          ...(ts.state === 'up' && ts.ip ? [`http://${ts.ip}:${port}`] : []),
        ])]
      json(res, 200, {
        // 三档模式：off（只听本机）/ tailnet（只认 Tailscale）/ lan（局域网）
        mode: remoteMode,
        // 只听本机还是对整个局域网开着：这决定了手机现在连不连得上
        loopback,
        port,
        addresses: addrs,
        // 口令只回给已经进门的人（这个接口本身在鉴权之后），不会出现在页面上
        token,
        urls,
        devices: loadDevices().map((d) => ({ id: d.id, name: d.name, created: d.created, lastSeen: d.lastSeen })),
        // 能不开公网就不开：tailscale 装了但没登录时，这里明确告诉用户下一步
        tailscale: ts,
      })
      return
    }
    // 引导页的「测试一下」：一条命令把链路逐段点一遍，省得用户在两台设备之间猜。
    // 顺序就是出问题的顺序：模式 → 端口 → Tailscale → 手机。
    if (req.method === 'POST' && url.pathname === '/api/remote/check') {
      const ts = tailscaleState()
      const fail = (step: string, detail: string) => json(res, 200, { ok: false, step, detail })
      // 「关闭」不等于不可用：端口只对本机开着、但 tailscale serve 把域名转发进来，
      // 是一种更干净的配置（外面连端口的机会都没有）。这种情况不该让人去开端口。
      const viaServe = ts.state === 'up' && Boolean(ts.serving) && Boolean(ts.host)
      if (remoteMode === 'off' && !viaServe) {
        return fail('mode', '远程访问还没打开——上面切到「仅 Tailscale」或「局域网」，或者用 tailscale serve 转发域名')
      }
      if (ts.state === 'absent') return fail('tailscale', '这台电脑没装 Tailscale')
      if (ts.state === 'logged-out') return fail('tailscale', 'Tailscale 装了但没登录：在电脑上跑 tailscale up')
      if (!ts.ip) return fail('tailscale', '还没拿到 tailnet 地址')

      // 端口真在听吗：从自己的 tailnet 地址连一次（走的是同一块网卡，
      // 能连上说明监听没问题，剩下的问题一定在手机那侧）。
      // 走域名转发时端口本来就不对外，改成从域名这一侧探——这才是手机会走的路。
      const portOk = viaServe
        ? await fetch(`https://${ts.host}/manifest.webmanifest`, { signal: AbortSignal.timeout(4000) })
          .then((r) => r.ok).catch(() => false)
        : await new Promise<boolean>((resolve) => {
          const sock = net.connect({ host: ts.ip!, port, timeout: 1500 })
          sock.once('connect', () => { sock.destroy(); resolve(true) })
          sock.once('error', () => { sock.destroy(); resolve(false) })
          sock.once('timeout', () => { sock.destroy(); resolve(false) })
        })
      if (!portOk) return fail('port', viaServe ? `https://${ts.host} 打不开` : `端口 ${port} 在 ${ts.ip} 上连不上`)

      const peer = (ts.peers ?? []).find((p) => p.online) ?? (ts.peers ?? [])[0]
      if (!peer) return fail('phone', 'tailnet 里只有这台电脑——手机还没装 Tailscale，或者没登录同一个账号')

      // 真正去戳一下那台设备。ping 用的是 WireGuard 自己的探测包，
      // 手机不响应 ICMP 也能测出来；它不回就是隧道没通。
      try {
        const out = execFileSync('tailscale', ['ping', '-c', '1', '--timeout', '4s', peer.ip], {
          timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'],
        }).toString()
        const via = /via (\S+)/.exec(out)?.[1] ?? 'direct'
        json(res, 200, { ok: true, detail: `${peer.name}（${peer.ip}）有回应，走 ${via}`, peer: peer.ip })
      } catch {
        // 探测包不回 ≠ 连不上：iOS 在后台挂起 Network Extension 时既不回 disco 包，
        // 也不影响它的 Safari 正常访问。所以这条只报「没确认」，不判死刑——
        // 上次就是因为这个把人劝去重启 Tailscale，其实网页本来就是开的。
        json(res, 200, {
          ok: false,
          soft: true,
          step: 'phone',
          detail: `${peer.name}（${peer.ip}）没回探测包。手机锁屏/后台时 iOS 会挂起 Tailscale，这不代表连不上——直接用手机打开下面那个地址试试。`,
        })
      }
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/remote/mode') {
      const body = JSON.parse(await readBody(req).catch(() => '{}')) as { mode?: string }
      const mode = body.mode
      if (mode !== 'off' && mode !== 'tailnet' && mode !== 'lan') {
        json(res, 400, { error: '模式只能是 off / tailnet / lan' })
        return
      }
      const next = mode as RemoteMode
      // 先把回执写出去，再换监听：换监听要掐断所有连接（包括这条请求的），
      // 顺序反了就是「点一下没反应，刷新才发现已经改了」。
      json(res, 200, { mode: next })
      setTimeout(() => { void applyRemoteMode(next) }, 80)
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/remote/device') {
      const body = JSON.parse(await readBody(req).catch(() => '{}')) as { name?: string }
      const name = String(body.name ?? '').trim().slice(0, 40) || '我的手机'
      const made = createDevice(name)
      const lb = host === '127.0.0.1' || host === 'localhost' || host === '::1'
      const t = tailscaleState()
      // 配对地址要手机真能打开：本机监听 + tailscale serve 时用 https 域名，
      // 否则退回局域网 IP。都给不出来就回空串，界面提示用户先改监听方式。
      const base = !lb
        ? `http://${lanAddresses()[0] ?? '127.0.0.1'}:${port}`
        : (t.state === 'up' && t.serving && t.host ? `https://${t.host}` : '')
      json(res, 200, {
        id: made.device.id,
        name: made.device.name,
        token: made.token,
        url: base ? pairUrl(base, made.token) : '',
      })
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/remote/revoke') {
      const body = JSON.parse(await readBody(req).catch(() => '{}')) as { id?: string }
      const gone = revokeDevice(String(body.id ?? ''))
      if (!gone) { json(res, 404, { error: '没有这台设备' }); return }
      json(res, 200, { id: gone.id, name: gone.name })
      return
    }

    if (req.method === 'GET' && url.pathname === '/api/info') {
      let isolation = 'unknown'
      let model = ''
      try {
        const { Harness } = await import('@unit-harness/core')
        const h = new Harness({ record: false })
        isolation = h.isolation.enforced
        h.dispose()
      } catch { /* keep unknown */ }
      try {
        const p = await resolveProvider()
        model = `${p.def.id}/${p.model}`
      } catch { /* no model configured */ }
      json(res, 200, {
        isolation,
        model,
        workspace: currentWorkspace,
        version: process.env.UH_VERSION || '0.1.0',
        home: pathMod.join(uhHome(), 'sessions'),
        // 真正的主目录：底栏把 /home/你/Applications/x 缩成 ~/Applications/x，
        // 和 Codex 的 cwd 一行放得下
        userHome: os.homedir(),
      })
      return
    }

    if (req.method === 'GET' && url.pathname === '/api/sessions') {
      const ws = url.searchParams.get('workspace') ?? undefined
      json(res, 200, collectSessions(ws))
      return
    }

    // 会话管理：改名 / 置顶 / 删除。三件事都作用在磁盘上，不是「这次打开时记着」，
    // 否则刷新一下列表就回到原样。
    if (req.method === 'POST' && url.pathname === '/api/session/rename') {
      const body = JSON.parse(await readBody(req).catch(() => '{}')) as { id?: string; label?: string }
      if (!body.id) { json(res, 400, { error: 'id required' }); return }
      const store = new EventStore()
      const meta = store.rename(body.id, body.label ?? '')
      if (!meta) { json(res, 404, { error: 'no such session' }); return }
      json(res, 200, { ok: true, id: meta.id, label: meta.label ?? '' })
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/session/pin') {
      const body = JSON.parse(await readBody(req).catch(() => '{}')) as { id?: string; pinned?: boolean }
      if (!body.id) { json(res, 400, { error: 'id required' }); return }
      const cfg = readConfig()
      const set = new Set(cfg.pinnedSessions ?? [])
      if (body.pinned === false) set.delete(body.id)
      else set.add(body.id)
      cfg.pinnedSessions = [...set]
      writeConfig(cfg)
      json(res, 200, { ok: true, pinned: cfg.pinnedSessions })
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/session/delete') {
      const body = JSON.parse(await readBody(req).catch(() => '{}')) as { id?: string }
      if (!body.id) { json(res, 400, { error: 'id required' }); return }
      // 正在跑的会话不能删：它还在往那个目录里追加事件，删完就是一堆 ENOENT
      if (running.has(body.id)) { json(res, 409, { error: '这条会话正在跑，先停掉再删' }); return }
      const store = new EventStore()
      const ok = store.remove(body.id)
      if (ok) {
        const cfg = readConfig()
        if ((cfg.pinnedSessions ?? []).includes(body.id)) {
          cfg.pinnedSessions = (cfg.pinnedSessions ?? []).filter((x) => x !== body.id)
          writeConfig(cfg)
        }
      }
      json(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'no such session' })
      return
    }

    // ---- 文件改动的前后对比 ------------------------------------------------
    // 事件里存的是引用（大正文外置到 blobs），所以 diff 在服务端算，前端只看结果
    if (req.method === 'GET' && url.pathname === '/api/diff') {
      const sessionId = url.searchParams.get('session') ?? ''
      const want = url.searchParams.get('path') ?? ''
      const seq = Number(url.searchParams.get('seq') ?? '0')
      if (!sessionId || !want) { json(res, 400, { error: 'session and path are required' }); return }
      try {
        const store = new EventStore()
        const dir = store.sessionDir(sessionId)
        if (!dir) { json(res, 404, { error: 'no such session' }); return }
        const events = store.read(sessionId)
        const hit = events.find((e) => e.kind === 'checkpoint/file'
          && (e.payload as { path?: string }).path === want
          && (!seq || e.seq === seq))
        if (!hit) { json(res, 404, { error: 'no checkpoint for that file in this session' }); return }
        const edits = hydrateEdits([hit.payload as never], dir)
        const ed = edits[0]
        if (!ed) { json(res, 404, { error: 'could not hydrate that edit' }); return }
        json(res, 200, {
          path: want,
          before: ed.before ?? '',
          after: ed.after ?? '',
          existed: (ed.before ?? '') !== '',
        })
      } catch (err) {
        json(res, 500, { error: err instanceof Error ? err.message : String(err) })
      }
      return
    }

    // ---- 检查点与回退 ------------------------------------------------------
    // 「回到某一轮之前」是本地 agent 最该有、最容易做错的一件事：
    // 回退要真把文件写回去，而不是只在界面上把那段对话藏起来。
    if (req.method === 'GET' && url.pathname === '/api/checkpoints') {
      const sessionId = url.searchParams.get('session') ?? ''
      if (!sessionId) { json(res, 400, { error: 'session required' }); return }
      const store = new EventStore()
      if (!store.sessionDir(sessionId)) { json(res, 404, { error: 'no such session' }); return }
      const events = store.read(sessionId)
      const last = lastRestoreSeq(events)
      const list = listCheckpoints(events).map((c) => ({
        ...c,
        // 跨过一次回退的检查点不再可用：重放会撤掉已经被撤过的改动
        restorable: last === 0 || c.seq > last,
      }))
      json(res, 200, { checkpoints: list, lastRestore: last, running: running.has(sessionId) })
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/session/restore') {
      const body = JSON.parse(await readBody(req).catch(() => '{}')) as { id?: string; seq?: number }
      if (!body.id || typeof body.seq !== 'number') { json(res, 400, { error: 'id and seq required' }); return }
      // 跑着的时候绝不能回退：它正在往这些文件里写，撤到一半就是两边打架
      if (running.has(body.id)) { json(res, 409, { error: '这条会话还在跑，先停掉再回退' }); return }
      const store = new EventStore()
      const dir = store.sessionDir(body.id)
      if (!dir) { json(res, 404, { error: 'no such session' }); return }
      const events = store.read(body.id)
      const anchor = listCheckpoints(events).find((c) => c.seq === body.seq)
      if (!anchor) { json(res, 404, { error: '没有这个检查点' }); return }
      const last = lastRestoreSeq(events)
      if (last && anchor.seq <= last) {
        json(res, 409, { error: '这条会话已经回退过，只能回到最近一次回退之后' })
        return
      }
      const raw = editsAfterSeq(events, anchor.seq)
      const edits = hydrateEdits(raw, dir)
      if (edits.length === 0) {
        json(res, 200, { ok: true, restored: [], removed: [], skipped: [], note: '这个检查点之后没有文件改动' })
        return
      }
      // 必须用**这条会话当初的工作区**，不能用服务当前的工作区：
      // 切了项目之后再回退旧会话，拿当前工作区写回去就是往别人的仓库里写。
      const ws = store.get(body.id)?.workspace
      if (!ws) { json(res, 409, { error: '这条会话没记下工作区，不能回退' }); return }
      const result = undoToCheckpoint(ws, edits)
      // 日志只增不改：回退本身记一条，读日志的人才知道工作区被谁动过
      try {
        store.reopen(body.id)
        store.append(body.id, 'checkpoint/restored', {
          seq: anchor.seq, turn: anchor.turn, files: edits.map((e) => e.path),
          restored: result.restored.length, removed: result.removed.length, skipped: result.skipped.length,
        }, { source: 'user' })
        store.end(body.id, 'restored')
      } catch { /* 记不上不影响已经落地的回退，但要能在响应里看出来 */ }
      json(res, 200, { ok: true, ...result })
      return
    }

    // ---- 维护 --------------------------------------------------------------
    // 用量：把每个会话的 llm/response 加起来。模型名和 token 数只存在于事件里，
    // 所以这里必须读日志，不能问 provider —— 问 provider 只会给「当前余额」，
    // 而用户想知道的是「我这些天在它身上花了多少、花在哪个模型上」。
    // @ 的文件补全
    if (req.method === 'GET' && url.pathname === '/api/files') {
      const q = (url.searchParams.get('q') ?? '').toLowerCase()
      const all = listWorkspaceFiles()
      const hits = (q ? all.filter((f) => f.toLowerCase().includes(q)) : all).slice(0, 40)
      json(res, 200, { files: hits, total: all.length })
      return
    }

    if (req.method === 'GET' && url.pathname === '/api/usage') {
      const now = Date.now()
      if (usageCache && now - usageCache.at < 30_000) { json(res, 200, usageCache.data); return }

      const byModel = new Map<string, { model: string; provider: string; calls: number; prompt: number; completion: number; total: number }>()
      const byDay = new Map<string, { day: string; calls: number; total: number }>()
      let calls = 0, prompt = 0, completion = 0, total = 0, sessions = 0

      const store = new EventStore()
      for (const meta of store.list({ limit: 500 })) {
        const dir = store.sessionDir(meta.id)
        if (!dir) continue
        let lines: string[] = []
        try { lines = readFileSync(pathMod.join(dir, 'events.jsonl'), 'utf8').split('\n') } catch { continue }
        sessions++
        for (const line of lines) {
          if (!line.includes('llm/response')) continue
          let ev: { kind?: string; timestamp?: string; payload?: Record<string, unknown> }
          try { ev = JSON.parse(line) } catch { continue }
          if (ev.kind !== 'llm/response') continue
          const u = (ev.payload?.usage ?? {}) as { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
          const t = u.total_tokens ?? 0
          if (t === 0) continue
          const model = String(ev.payload?.model ?? 'unknown')
          const provider = String(ev.payload?.provider ?? 'unknown')
          calls++
          prompt += u.prompt_tokens ?? 0
          completion += u.completion_tokens ?? 0
          total += t

          const mk = provider + '/' + model
          const m = byModel.get(mk) ?? { model, provider, calls: 0, prompt: 0, completion: 0, total: 0 }
          m.calls++; m.prompt += u.prompt_tokens ?? 0; m.completion += u.completion_tokens ?? 0; m.total += t
          byModel.set(mk, m)

          const day = String(ev.timestamp ?? '').slice(0, 10) || 'unknown'
          const d = byDay.get(day) ?? { day, calls: 0, total: 0 }
          d.calls++; d.total += t
          byDay.set(day, d)
        }
      }

      const data = {
        sessions,
        calls,
        prompt,
        completion,
        total,
        byModel: [...byModel.values()].sort((a, b) => b.total - a.total),
        byDay: [...byDay.values()].sort((a, b) => (a.day < b.day ? 1 : -1)).slice(0, 14),
      }
      usageCache = { at: now, data }
      json(res, 200, data)
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/prune') {
      let body: { olderThanDays?: number; dryRun?: boolean } = {}
      try { body = JSON.parse(await readBody(req)) as typeof body } catch { /* empty */ }
      const days = Number(body.olderThanDays ?? 30)
      if (!Number.isFinite(days) || days <= 0) { json(res, 400, { error: 'olderThanDays must be a positive number' }); return }
      try {
        const store = new EventStore()
        const pruned = store.prune({ olderThanDays: days, dryRun: body.dryRun === true })
        json(res, 200, { ok: true, moved: pruned.moved.length, kept: pruned.kept, dryRun: body.dryRun === true })
      } catch (err) {
        json(res, 500, { error: err instanceof Error ? err.message : String(err) })
      }
      return
    }

    // ---- 账号 --------------------------------------------------------------
    if (req.method === 'GET' && url.pathname === '/api/account') {
      const token = readAccountToken()
      if (!token) { json(res, 200, { signedIn: false, unitai: UNITAI_BASE }); return }
      try {
        const r = await unitai('/api/auth/me', token)
        if (!r.ok) {
          json(res, 200, { signedIn: false, unitai: UNITAI_BASE, expired: true })
          return
        }
        const b = r.body as { user?: Record<string, unknown>; membership?: unknown; email?: string }
        json(res, 200, {
          signedIn: true,
          unitai: UNITAI_BASE,
          user: b.user ?? {},
          membership: b.membership ?? null,
          email: b.email ?? '',
        })
      } catch (err) {
        // 断网时不要把人踢下线：令牌还在，只是这次问不到
        json(res, 200, { signedIn: true, unitai: UNITAI_BASE, offline: true, error: err instanceof Error ? err.message : 'unreachable' })
      }
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/account/token') {
      let body: { token?: string } = {}
      try { body = JSON.parse(await readBody(req)) as typeof body } catch { /* empty */ }
      const token = (body.token ?? '').trim()
      if (!token) { json(res, 400, { error: 'paste the token from ' + UNITAI_BASE + '/mcp' }); return }

      const r = await unitai('/api/auth/me', token)
      if (!r.ok) {
        json(res, 400, {
          error: r.status === 401
            ? 'that token was rejected — it may have expired (they last 30 days)'
            : 'unitai.site answered ' + r.status,
        })
        return
      }
      writeAccountToken(token)
      const b = r.body as { user?: Record<string, unknown>; membership?: unknown }
      json(res, 200, { ok: true, user: b.user ?? {}, membership: b.membership ?? null })
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/account/logout') {
      try { fs6.unlinkSync(accountFile()) } catch { /* already gone */ }
      json(res, 200, { ok: true })
      return
    }

    // ---- 设置：换模型就是换 provider + key + model 三件事 -------------------
    if (req.method === 'GET' && url.pathname === '/api/settings') {
      const cfg = readConfig()
      const active = cfg.defaultProvider ?? 'deepseek'
      const entry = cfg.providers[active] ?? {}
      const def = findProvider(active)
      json(res, 200, {
        provider: active,
        model: entry.model ?? '',
        baseUrl: entry.baseUrl ?? def?.baseUrl ?? '',
        hasKey: Boolean(entry.apiKey),
        keyMasked: entry.apiKey ? maskKey(entry.apiKey) : '',
        modelHint: def?.modelHint ?? '',
        protocol: def?.protocol ?? 'openai',
        ui: cfg.ui ?? {},
        approval: approvalMode(),
        // 三个沙箱开关必须落到 Harness 上，否则设置面板就是个备忘录
        allowHome: sandboxPrefs().allowHome,
        denyNetwork: sandboxPrefs().denyNetwork,
        unconfined: sandboxPrefs().unconfined,
        workspace: currentWorkspace,
        // 前端拿这个列表画下拉框：不写死任何一家，加 provider 只改注册表
        providers: PROVIDERS.map((p) => ({
          id: p.id,
          label: p.label,
          protocol: p.protocol,
          baseUrl: p.baseUrl,
          envKey: p.envKey ?? '',
          local: p.local === true,
          keysUrl: p.keysUrl ?? '',
          modelHint: p.modelHint ?? '',
          configured: Boolean(cfg.providers[p.id]?.apiKey || cfg.providers[p.id]?.model),
        })),
      })
      return
    }

    // 页面刷新 / 新标签页进来时，正在等的那条审批得能拿回来。
    // 之前只有 broadcast，人一刷新卡片就没了，而任务还在原地等——
    // 界面看起来像卡死，其实是有一个没人看得见的弹窗。
    if (req.method === 'GET' && url.pathname === '/api/pending') {
      json(res, 200, { pending: [...pendingInfo.values()] })
      return
    }

    // 成本预算：读写上限，同时报今天已经用了多少
    if (url.pathname === '/api/budget') {
      const cfg = readConfig()
      if (req.method === 'GET') {
        const b = normalizeBudget(cfg.budget)
        // 今日用量现算：内存计数器只代表"这个进程见过多少"
        const store = new EventStore()
        let today = 0
        const day = new Date().toISOString().slice(0, 10)
        for (const meta of store.list({ limit: 200 })) {
          const dir = store.sessionDir(meta.id)
          if (!dir) continue
          let text = ''
          try { text = readFileSync(pathMod.join(dir, 'events.jsonl'), 'utf8') } catch { continue }
          for (const line of text.split('\n')) {
            if (!line.includes('llm/response')) continue
            let ev: { kind?: string; timestamp?: string; payload?: { usage?: { total_tokens?: number } } }
            try { ev = JSON.parse(line) } catch { continue }
            if (ev.kind !== 'llm/response' || !String(ev.timestamp ?? '').startsWith(day)) continue
            today += ev.payload?.usage?.total_tokens ?? 0
          }
        }
        json(res, 200, { ...b, dayUsed: today })
        return
      }
      let body: { perRun?: unknown; perDay?: unknown } = {}
      try { body = JSON.parse(await readBody(req)) as typeof body } catch { /* empty */ }
      const next = normalizeBudget({ perRun: body.perRun, perDay: body.perDay })
      const cur = readConfig()
      cur.budget = next
      writeConfig(cur)
      json(res, 200, { ok: true, ...next })
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/approval') {
      let body: { mode?: string } = {}
      try { body = JSON.parse(await readBody(req)) as typeof body } catch { /* empty */ }
      const m = body.mode
      if (m !== 'ask' && m !== 'auto' && m !== 'allow') { json(res, 400, { error: 'mode must be ask, auto or allow' }); return }
      const cfg = readConfig()
      cfg.approval = m
      writeConfig(cfg)
      json(res, 200, { ok: true, approval: m })
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/sandbox') {
      let body: { allowHome?: unknown; denyNetwork?: unknown; unconfined?: unknown } = {}
      try { body = JSON.parse(await readBody(req)) as typeof body } catch { /* empty */ }
      const cfg = readConfig()
      const cur = cfg.sandbox ?? {}
      for (const k of ['allowHome', 'denyNetwork', 'unconfined'] as const) {
        if (typeof body[k] === 'boolean') cur[k] = body[k] as boolean
      }
      cfg.sandbox = cur
      writeConfig(cfg)
      json(res, 200, { ok: true, sandbox: sandboxPrefs() })
      return
    }

    // 电脑操控：这一层是真在操作这台机器，不是在沙箱里。
    // 能做什么必须先探测再显示——列出"支持点击"然后点了没反应，比不支持更糟。
    if (req.method === 'GET' && url.pathname === '/api/computer') {
      json(res, 200, computerStatus())
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/computer/toggle') {
      const body = JSON.parse(await readBody(req) || '{}') as { field?: string; value?: unknown }
      const cfg = readConfig()
      const cur = cfg.computer ?? {}
      if (body.field === 'enabled' || body.field === 'screenshots' || body.field === 'control') {
        cfg.computer = { ...cur, [body.field]: Boolean(body.value) }
      } else if (body.field === 'allowedApps') {
        cfg.computer = { ...cur, allowedApps: Array.isArray(body.value) ? body.value.map(String) : [] }
      } else {
        json(res, 400, { error: 'unknown field' })
        return
      }
      writeConfig(cfg)
      json(res, 200, { ok: true, ...computerStatus() })
      return
    }

    // 截屏：返回 PNG 本体，页面直接当图用
    if (req.method === 'GET' && url.pathname === '/api/computer/shot.png') {
      const st = computerStatus()
      // 三个条件缺一不可：总开关、分项开关、机器上真有工具。
      // 只查前两个里的一个，会出现「关掉了还在截」——开关于是变成一句谎话。
      if (!st.enabled || !st.screenshotsEnabled || !st.screenshots.available) {
        json(res, 403, {
          error: !st.enabled || !st.screenshotsEnabled ? 'screen capture is turned off' : 'no screenshot tool on this machine',
        })
        return
      }
      const out = pjoin(os.tmpdir(), 'uh-computer-' + Date.now() + '.png')
      try {
        await captureScreen(out)
        const buf = fs6.readFileSync(out)
        fs6.unlinkSync(out)
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' })
        res.end(buf)
      } catch (e) {
        // 拿不到就如实说拿不到：黑图会让人以为屏幕是黑的
        json(res, 500, { error: 'screenshot failed: ' + (e as Error).message })
      }
      return
    }

    // 插件页：把我们真实有的三类东西摊开——MCP server、技能、钩子。
    // 不假装有 Gmail/Calendar 那种应用，列表里有什么就是真能用的什么。
    if (req.method === 'GET' && url.pathname === '/api/plugins') {
      const cwd = currentWorkspace
      const mcp = loadMcpServers(cwd)
      const skills = discoverSkills(cwd)
      const disabled = new Set(readConfig().disabledPlugins ?? [])
      const hooks = readConfig().hooks ?? {}

      json(res, 200, {
        mcp: Object.entries(mcp.servers).map(([name, cfg]) => ({
          // id 必须是「关它的时候写进配置的那个 key」，带前缀。
          // 之前这里给的是裸名字，前端把裸名字发回 /toggle，写进去一条
          // `unitai`，而读取时问的是 `mcp:unitai` —— 于是开关怎么点都弹回原位。
          id: 'mcp:' + name,
          name,
          // stdio 说命令，http 说地址——"它到底是什么"要在列表里看得见
          command: cfg.command ? [cfg.command, ...(cfg.args ?? [])].join(' ') : '',
          url: cfg.url ?? '',
          transport: cfg.url ? 'http' : 'stdio',
          enabled: !disabled.has('mcp:' + name),
        })),
        skills: skills.map((s) => ({
          id: 'skill:' + s.name,
          name: s.name,
          // 随版本来的那几个标出来：用户知道哪些是「删了就没了」、哪些是自己加的
          builtin: isBuiltinSkill(s.name),
          description: s.description ?? '',
          allowedTools: s.allowedTools ?? [],
          scripts: (s.scripts ?? []).map((x) => x.rel),
          scope: s.root ?? '',
          enabled: !disabled.has('skill:' + s.name),
        })),
        hooks: Object.keys(hooks).map((k) => ({ id: 'hook:' + k, name: k, enabled: !disabled.has('hook:' + k) })),
        sources: mcp.sources,
        // 面板里要写清「该放哪」。这些路径由服务端算，前端不去猜——
        // 猜的结果就是告诉用户在 /…/sessions/skills 里建目录（根本不存在）
        paths: {
          skills: skillRoots(cwd).map((r) => ({ dir: r.dir, scope: r.label })),
          mcp: [globalMcpConfigPath(), projectMcpConfigPath(cwd)],
          hooks: pathMod.join(uhHome(), 'hooks'),
        },
        counts: { mcp: Object.keys(mcp.servers).length, skills: skills.length, hooks: Object.keys(hooks).length },
      })
      return
    }

    /** GitHub 仓库 / 子目录 → 一批 skill 文件。
     *
     * 网络现实：这台机器到 GitHub 只有十几 KB/s，一个带模板的仓库光 tarball 就
     * 几十 MB。所以这里不用 Contents API 逐目录列（匿名 60 次/小时，且每页一个
     * 请求），改用 git 的稀疏检出：只取这棵子树的对象，别的文件一个字节都不要。
     * 没装 git 或者仓库私有但没给 token 时，退回逐文件下载。
     */
    const importFromGitHub = async (
      url: URL, root: string, forcedName: string,
    ): Promise<Array<{ name: string; dir: string; files: number }>> => {
      const parts = url.pathname.split('/').filter(Boolean)      // owner/repo/tree/branch/path…
      const owner = parts[0]
      const repo = (parts[1] ?? '').replace(/\.git$/, '')
      if (!owner || !repo) throw new Error('这不是一个 GitHub 仓库地址')
      let branch = ''
      let sub = ''
      if (parts[2] === 'tree' || parts[2] === 'blob') {
        branch = parts[3] ?? ''
        sub = parts.slice(4).join('/')
      }
      // /owner/repo/blob/main/x/SKILL.md → 从它所在目录开始
      if (parts[2] === 'blob') sub = sub.split('/').slice(0, -1).join('/')

      const tmp = fs6.mkdtempSync(pathMod.join(os.tmpdir(), 'uh-gh-'))
      try {
        const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
        const git = (args: string[], cwd = tmp): string =>
          execFileSync('git', args, { cwd, env: gitEnv, stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000 })
            .toString()
        // tree 与 blob 两种地址要落到同名：名字只取决于地址里那个目录的最后一段，
        // 否则同一个技能从 /tree/.../beta 和 /blob/.../beta/SKILL.md 进来会变成两个。
        const nameHint = sub.split('/').filter(Boolean).pop() || repo
        let ok = false
        let why = ''
        try {
          const tok = process.env.UH_GITHUB_TOKEN ?? process.env.GITHUB_TOKEN
          // UH_GITHUB_CLONE_BASE 让测试把 github.com 指到本地 bare 仓库，
          // 否则这条逻辑只能靠联网才验得了
          const cloneBase = (process.env.UH_GITHUB_CLONE_BASE ?? `https://github.com/${owner}/${repo}.git`)
          const remote = !tok || cloneBase.startsWith('file://')
            ? cloneBase
            : cloneBase.replace('https://', `https://x-access-token:${tok}@`)
          // 只下元数据、不拉工作树：体积是仓库大小的零头
          git(['init', '-q'])
          // 地址直接写在命令行上，不写进 remote 配置：令牌有时效，也不该落盘。
          // 之前这里还套了一层 -c url.X.insteadOf=Y，X 和 Y 是同一个地址，
          // 纯属自己映射自己，网络一抖就报一句看不懂的 Command failed。
          const fetchArgs = ['fetch', '-q', '--depth=1', '--filter=blob:none', '--no-tags',
            remote, branch || 'HEAD']
          // GitHub 到这台机器经常抖：失败重试两次，别让一次超时变成「装不了」
          for (let i = 0; ; i++) {
            try { git(fetchArgs); break }
            catch (err) {
              if (i >= 2) throw err
              await new Promise((r) => setTimeout(r, 1500 * (i + 1)))
            }
          }
          git(['sparse-checkout', 'init', '--no-cone'])
          // 只保留这棵子树的 blob；子树的其余部分（内含 references/ scripts/）全都要
          git(['sparse-checkout', 'set', `/${sub ? sub + '/' : ''}`])
          git(['checkout', '-q', 'FETCH_HEAD'])
          ok = true
        } catch (err) {
          // execFileSync 的 message 只有一行命令；真正的原因在 stderr 末尾
          const e = err as { stderr?: Buffer; message?: string }
          const stderr = e.stderr ? e.stderr.toString().trim() : ''
          const lines = stderr.split('\n').filter(Boolean)
          why = lines.length ? lines.slice(-2).join(' ') : (e.message ?? String(err))
        }
        if (!ok) {
          throw new Error('拉不到这个仓库：' + why.slice(0, 200))
        }

        const repoRoot = tmp
        const wanted = pathMod.join(repoRoot, sub)
        if (!fs6.existsSync(wanted)) throw new Error(`仓库里没有 ${sub} 这个路径`)

        /** 把一个目录（递归）搬进 <skills 根>/<name> */
        const copyDir = (srcDir: string, dirName: string): { name: string; dir: string; files: number } => {
          const mdPath = pathMod.join(srcDir, 'SKILL.md')
          if (!fs6.existsSync(mdPath)) throw new Error(`${dirName} 里没有 SKILL.md`)
          const md = fs6.readFileSync(mdPath, 'utf8')
          const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md)?.[1] ?? ''
          // 名字优先级：用户指定 > 地址里的目录名 > frontmatter > 目录名。
          // 地址里那一段是人自己选的，和磁盘上看到的一致；只有仓库根才没有它。
          const fromFm = (/^name:\s*(.+)$/m.exec(fm)?.[1] ?? '').replace(/["']/g, '').trim()
          const name = (forcedName
            || (dirName !== repo && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(dirName) ? dirName : '')
            || fromFm
            || dirName).trim()
          if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) throw new Error(`技能名不合法：${name}`)
          if (discoverSkills(currentWorkspace).some((x) => x.name === name)) {
            throw new Error(`已经有同名 skill「${name}」了`)
          }
          const target = pathMod.join(root, name)
          const targetAbs = pathMod.resolve(target)
          let files = 0
          let bytes = 0
          const visit = (dir: string): void => {
            for (const e of fs6.readdirSync(dir, { withFileTypes: true })) {
              if (e.name === '.git' || e.name === 'node_modules' || e.name === '__pycache__') continue
              const from = pathMod.join(dir, e.name)
              if (e.isDirectory()) { visit(from); continue }
              if (!e.isFile()) continue                     // 符号链接一律不跟
              files++
              const sz = fs6.statSync(from).size
              bytes += sz
              // 上限是兜底，不是设计：真实的技能（ppt-master 那种）有 1000+ 个
              // 文件、30MB。之前卡在 600 个，装到一半就抛错，用户看到的是
              // 「导入失败」+ 一个只装了一半的目录——比不装更糟。
              if (files > 20000) throw new Error('文件超过 2 万个，这不像是一个 skill 目录')
              if (bytes > 300 * 1024 * 1024) throw new Error('这个技能太大了（>300MB）')
              const rel = pathMod.relative(srcDir, from)
              const dest = pathMod.join(target, rel)
              // 解出来的路径必须落在 target 里
              if (!pathMod.resolve(dest).startsWith(targetAbs + pathMod.sep)) {
                throw new Error(`拒绝越界路径：${rel}`)
              }
              fs6.mkdirSync(pathMod.dirname(dest), { recursive: true })
              fs6.copyFileSync(from, dest)
            }
          }
          fs6.mkdirSync(target, { recursive: true })
          visit(srcDir)
          return { name, dir: target, files }
        }

        // 装到一半失败比不装更糟：用户会得到一个「看着像装好了、实际缺文件」
        // 的技能，而且再装一次会撞「同名」。所以先写进临时目录，成了再改名。
        const safeCopy = (
          fn: (srcDir: string, dirName: string) => { name: string; dir: string; files: number },
          srcDir: string, dirName: string,
        ): { name: string; dir: string; files: number } => {
          try {
            return fn(srcDir, dirName)
          } catch (err) {
            // copyDir 里已经建好的目录：按它算出来的名字清掉
            const guess = (forcedName || dirName).trim()
            if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(guess)) {
              fs6.rmSync(pathMod.join(root, guess), { recursive: true, force: true })
            }
            throw err
          }
        }

        // ① 这个路径自己就是一个技能（目录里有 SKILL.md）——先认这一条。
        //    之前只看「里面有没有子目录」，于是 skills/ppt-master 这种
        //    「SKILL.md + references/ + scripts/」的标准结构被当成「装技能的根目录」，
        //    逐个去试子目录，全都报「里没有 SKILL.md」。
        if (fs6.existsSync(pathMod.join(wanted, 'SKILL.md'))) {
          return [safeCopy(copyDir, wanted, nameHint)]
        }
        // ② 不然它是个装着多个技能的根目录
        const kids = fs6.readdirSync(wanted, { withFileTypes: true })
          .filter((e) => e.isDirectory() && e.name !== '.git')
        const out: Array<{ name: string; dir: string; files: number }> = []
        const why2: string[] = []
        for (const k of kids.slice(0, 20)) {
          if (!fs6.existsSync(pathMod.join(wanted, k.name, 'SKILL.md'))) continue
          try {
            out.push(safeCopy(copyDir, pathMod.join(wanted, k.name), forcedName && kids.length === 1 ? forcedName : k.name))
          } catch (err) { why2.push(err instanceof Error ? err.message : String(err)) }
        }
        if (!out.length) {
          throw new Error('这个地址下没有找到 SKILL.md' + (why2.length ? '：' + why2[0] : '（子目录里也都没有）'))
        }
        return out
      } finally {
        fs6.rmSync(tmp, { recursive: true, force: true })
      }
    }

    // 加装 skill：贴一段、给个 URL、指个目录，三种都是同一个终点——
    // <skills 根>/<name>/SKILL.md。装完立刻出现在 / 补全和插件列表里，
    // 因为它就是磁盘上的一个目录，没有第二份注册表要同步。
    if (req.method === 'POST' && url.pathname === '/api/plugins/skill') {
      const body = JSON.parse(await readBody(req).catch(() => '{}')) as {
        mode?: 'auto' | 'github' | 'content' | 'url' | 'path'
        name?: string
        content?: string
        url?: string
        path?: string
        /** auto 模式下用户只粘一个东西进来，分类由服务端做 */
        input?: string
        scope?: 'user' | 'project'
      }
      // 用户不该先分「这是链接还是路径」。auto 让服务端看一眼就决定。
      const input = String(body.input ?? body.url ?? body.path ?? '').trim()
      let mode = body.mode ?? 'auto'
      if (mode === 'auto') mode = /^https?:\/\//i.test(input) ? 'url' : 'path'
      if (mode !== 'content' && mode !== 'url' && mode !== 'path' && mode !== 'github') {
        json(res, 400, { error: "mode 只能是 auto / github / content / url / path" })
        return
      }

      // 落到哪个根：默认全局（和 Codex 一致，装一次所有项目都能用）
      const root = body.scope === 'project'
        ? pathMod.join(currentWorkspace, '.uh', 'skills')
        : pathMod.join(uhHome(), 'skills')

      /** 名字会变成目录名，所以只接受安全字符——它同时是 skill 的 id */
      const clean = (raw: string): string => {
        const t = String(raw || '').trim()
        return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(t) ? t : ''
      }

      // GitHub 地址单独一条路：一个仓库/目录里可能有多个技能，也可能带 scripts/，
      // 所以不能当成「下载一个 md」处理。
      if (mode === 'github' || /^https?:\/\/(www\.)?github\.com\//i.test(input)) {
        try {
          const imported = await importFromGitHub(new URL(input), root, clean(body.name ?? ''))
          json(res, 200, {
            ok: true,
            name: imported[0]?.name ?? '',
            names: imported.map((x) => x.name),
            dir: imported[0]?.dir ?? '',
            files: imported.reduce((n, x) => n + x.files, 0),
            scope: body.scope === 'project' ? 'project' : 'user',
          })
        } catch (err) {
          json(res, 400, { error: err instanceof Error ? err.message : String(err) })
        }
        return
      }

      let text = ''
      let name = clean(body.name ?? '')
      let fromDir = ''
      /** SKILL.md 里写的 name 才是这个 skill 的真名；目录名应当跟着它，否则
       *  列表里叫 from-dir、磁盘上却是 src-skill，以后想找想删都得猜 */
      const fmName = (t: string): string => {
        const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(t)
        if (!fm) return ''
        const kv = /^name:\s*(.+)$/m.exec(fm[1] as string)
        return kv ? clean(String(kv[1]).replace(/["']/g, '').trim()) : ''
      }

      if (mode === 'content') {
        text = String(body.content ?? '')
        if (!text.trim()) { json(res, 400, { error: '内容为空' }); return }
      } else if (mode === 'url') {
        const target = String(body.url ?? input).trim()
        if (!/^https?:\/\//i.test(target)) { json(res, 400, { error: '给一个 http(s) 地址' }); return }
        try {
          const r = await fetch(target, { signal: AbortSignal.timeout(15000) })
          if (!r.ok) { json(res, 400, { error: `下载失败：HTTP ${r.status}` }); return }
          text = await r.text()
        } catch (err) {
          json(res, 400, { error: '下载失败：' + (err instanceof Error ? err.message : String(err)) })
          return
        }
        // 名字没给：先看 SKILL.md 自己写的 name，再退到 URL 文件名
        if (!name) name = fmName(text)
        if (!name) {
          const parts = new URL(target).pathname.split('/').filter(Boolean)
          const last = parts.pop() ?? ''
          const base = /^skill\.md$/i.test(last) ? (parts.pop() ?? '') : last.replace(/\.md$/i, '')
          name = clean(base)
        }
        if (!text.trim()) { json(res, 400, { error: '这个地址是空的' }); return }
      } else {
        fromDir = String(body.path ?? input).trim().replace(/^~(?=\/)/, os.homedir())
        const st = fromDir ? statSyncSafe(fromDir) : null
        if (!st) { json(res, 400, { error: '这个路径不存在' }); return }
        if (!name) {
          // 目录来源：优先用 SKILL.md 里的 name，其次目录名
          text = st.isFile() ? readFileSyncSafe(fromDir) : readFileSyncSafe(pathMod.join(fromDir, 'SKILL.md'))
          name = fmName(text) || clean(pathMod.basename(fromDir).replace(/\.md$/i, ''))
        }
        if (st.isFile()) {
          if (!/\.md$/i.test(fromDir)) { json(res, 400, { error: '只接受 .md 文件或目录' }); return }
          text = readFileSyncSafe(fromDir)
        } else {
          const md = pathMod.join(fromDir, 'SKILL.md')
          if (!existsSync(md)) { json(res, 400, { error: '这个目录里没有 SKILL.md' }); return }
        }
      }

      if (!name) { json(res, 400, { error: '给它起个名字（字母数字，可带 - _ .）' }); return }

      // 同名已经存在时不能悄悄覆盖：那可能正是用户在用的那份。
      const existing = discoverSkills(currentWorkspace).find((x) => x.name === name)
      if (existing) {
        json(res, 409, { error: `已经有同名 skill「${name}」了（${existing.root}）` })
        return
      }

      const targetDir = pathMod.join(root, name)
      try {
        mkdirSync(targetDir, { recursive: true })
        if (mode === 'path' && !statSyncSafe(fromDir)?.isFile()) {
          // 整目录搬（scripts/ 之类要一起带走），但跳过 .git
          cpSync(fromDir, targetDir, {
            recursive: true, force: true,
            filter: (src: string) => !/(^|[\\/])\.git([\\/]|$)/.test(src),
          })
        } else {
          const file = mode === 'path' && /\.md$/i.test(fromDir) ? fromDir : null
          const md = file ? readFileSyncSafe(file) : text
          if (!md.trim()) { json(res, 400, { error: '内容为空' }); return }
          writeFileSync(pathMod.join(targetDir, 'SKILL.md'), md)
        }
      } catch (err) {
        try { rmSync(targetDir, { recursive: true, force: true }) } catch { /* 清不干净就算了 */ }
        json(res, 500, { error: err instanceof Error ? err.message : String(err) })
        return
      }

      const skill = discoverSkills(currentWorkspace).find((x) => x.name === name)
      json(res, 200, {
        ok: true,
        name,
        dir: targetDir,
        scope: body.scope === 'project' ? 'project' : 'user',
        description: skill?.description ?? '',
      })
      return
    }

    // ---- skill 不只是一个 md：它是个目录，里面还能有 scripts/ references/ 等 ----
    // 所以管理面板要能看文件树、看内容、改内容、加文件、删文件、整个删掉。
    // 所有路径都相对 skill 目录，越界一律拒绝（这个名字来自 HTTP）。
    if (url.pathname.startsWith('/api/plugins/skill/') || (url.pathname === '/api/plugins/skill' && req.method === 'GET')) {
      const action = url.pathname.replace('/api/plugins/skill', '').replace(/^\//, '') || 'detail'
      // POST 的 name 在 body 里，GET 的在查询串里——两边都要认，否则「保存」永远报名字不合法
      const bodyOnce = req.method === 'POST'
        ? JSON.parse(await readBody(req).catch(() => '{}')) as Record<string, unknown>
        : {}
      const qname = String(url.searchParams.get('name') ?? bodyOnce.name ?? '')
      const name = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(qname) ? qname : ''
      if (!name) { json(res, 400, { error: 'name 不合法' }); return }

      const skill = discoverSkills(currentWorkspace).find((s) => s.name === name)
      if (!skill) { json(res, 404, { error: '没有这个 skill' }); return }
      const rootInfo = skillRoots(currentWorkspace).find((r) => r.label === skill.root)
      const baseDir = rootInfo
        ? pathMod.join(rootInfo.dir, fs6.existsSync(pathMod.join(rootInfo.dir, name)) ? name : name + '.md')
        : ''
      // 单文件形式的 skill（<root>/name.md）没有子文件可管，后面按「无目录」处理
      const isDir = Boolean(baseDir) && statSyncSafe(baseDir)?.isDirectory() === true
      const skillDir = isDir ? baseDir : pathMod.dirname(baseDir)

      /** 相对路径 → 绝对路径，且必须还在 skill 目录里 */
      const safe = (rel: string): string | null => {
        const clean = String(rel ?? '').replace(/^\/+/, '')
        if (!clean || clean.includes('\0')) return null
        const abs = pathMod.resolve(skillDir, clean)
        return abs === skillDir || abs.startsWith(skillDir + pathMod.sep) ? abs : null
      }

      if (req.method === 'GET' && action === 'detail') {
        const files: Array<{ path: string; size: number }> = []
        if (isDir) {
          // 深度有限：skill 目录应该很小，扫太深只会拖慢面板
          const walk = (dir: string, prefix: string, depth: number): void => {
            if (depth > 4 || files.length >= 300) return
            let entries: Array<{ name: string; isDir: boolean }> = []
            try {
              entries = fs6.readdirSync(dir, { withFileTypes: true })
                .map((e) => ({ name: String(e.name), isDir: e.isDirectory() }))
            } catch { return }
            for (const e of entries.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name))) {
              if (e.name === '.git') continue
              const rel = prefix ? prefix + '/' + e.name : e.name
              if (e.isDir) { walk(pathMod.join(dir, e.name), rel, depth + 1); continue }
              const st = statSyncSafe(pathMod.join(dir, e.name))
              files.push({ path: rel, size: Number(st?.size ?? 0) })
            }
          }
          walk(skillDir, '', 0)
        } else {
          const st = statSyncSafe(skillDir)
          files.push({ path: pathMod.basename(skillDir), size: Number(st?.size ?? 0) })
        }
        json(res, 200, {
          name: skill.name,
          description: skill.description ?? '',
          scope: skill.root ?? '',
          dir: skillDir,
          isDir,
          files,
        })
        return
      }

      if (req.method === 'GET' && action === 'file') {
        const abs = safe(url.searchParams.get('path') ?? '')
        if (!abs) { json(res, 400, { error: '路径越界' }); return }
        const st = statSyncSafe(abs)
        if (!st?.isFile()) { json(res, 404, { error: '没有这个文件' }); return }
        if (st.size > 512 * 1024) { json(res, 400, { error: '文件太大（>512KB），不在面板里打开' }); return }
        const text = readFileSyncSafe(abs)
        // 用 \0 判断二进制：编辑框里塞进一坨二进制只会让浏览器卡住
        if (text.includes('\0')) { json(res, 400, { error: '这是二进制文件' }); return }
        json(res, 200, { path: url.searchParams.get('path') ?? '', text, size: st.size })
        return
      }

      if (req.method === 'POST' && action === 'file') {
        const body = bodyOnce as { path?: string; text?: string }
        const abs = safe(body.path ?? '')
        if (!abs) { json(res, 400, { error: '路径越界' }); return }
        try {
          mkdirSync(pathMod.dirname(abs), { recursive: true })
          writeFileSync(abs, String(body.text ?? ''))
        } catch (err) {
          json(res, 500, { error: err instanceof Error ? err.message : '写不进去' })
          return
        }
        json(res, 200, { ok: true, path: pathMod.relative(skillDir, abs) })
        return
      }

      if (req.method === 'POST' && action === 'file/delete') {
        const body = bodyOnce as { path?: string }
        const abs = safe(body.path ?? '')
        if (!abs || abs === skillDir) { json(res, 400, { error: '路径越界' }); return }
        try { rmSync(abs, { recursive: true, force: true }) } catch { /* 没了也算删掉 */ }
        json(res, 200, { ok: true })
        return
      }

      if (req.method === 'POST' && action === 'delete') {
        try { rmSync(skillDir, { recursive: true, force: true }) } catch (err) {
          json(res, 500, { error: err instanceof Error ? err.message : '删不掉' })
          return
        }
        json(res, 200, { ok: true })
        return
      }

      json(res, 405, { error: '不支持的动作' })
      return
    }

    // 开关：启停是持久化的，不是这一次会话的临时状态
    if (req.method === 'POST' && url.pathname === '/api/plugins/toggle') {
      const body = JSON.parse(await readBody(req) || '{}') as { id?: string; enabled?: boolean }
      if (!body.id) { json(res, 400, { error: 'id required' }); return }
      // 只收带前缀的 id：裸名字写进去不会生效，而「关掉了却还在跑」
      // 比报错更难查，所以宁可当场拒绝
      if (!/^(mcp|skill|hook):/.test(body.id)) {
        json(res, 400, { error: 'id must look like mcp:<name>, skill:<name> or hook:<event>' })
        return
      }
      const cfg = readConfig()
      const set = new Set(cfg.disabledPlugins ?? [])
      if (body.enabled === false) set.add(body.id)
      else set.delete(body.id)
      cfg.disabledPlugins = [...set]
      writeConfig(cfg)
      json(res, 200, { ok: true, disabled: cfg.disabledPlugins })
      return
    }

    // 外观单独一个口子：它和"用哪个模型"没有关系，混在一起会让保存语义变糊——
    // 改个背景色不该顺带把 API key 重写一遍。
    if (url.pathname === '/api/ui') {
      if (req.method === 'GET') {
        json(res, 200, { ui: readConfig().ui ?? {} })
        return
      }
      if (req.method === 'POST') {
        const body = JSON.parse(await readBody(req) || '{}') as Record<string, unknown>
        const cfg = readConfig()
        const next: Record<string, unknown> = { ...(cfg.ui ?? {}) }
        for (const [k, v] of Object.entries(body)) {
          // null 表示"恢复默认"，删掉这个键，而不是存一个 null
          if (v === null || v === '') delete next[k]
          else next[k] = v
        }
        cfg.ui = next as typeof cfg.ui
        writeConfig(cfg)
        json(res, 200, { ok: true, ui: cfg.ui })
        return
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/settings') {
      let body: { provider?: string; model?: string; baseUrl?: string; apiKey?: string; clearKey?: boolean } = {}
      try { body = JSON.parse(await readBody(req)) as typeof body } catch { /* empty body */ }

      const id = body.provider?.trim()
      if (!id || !findProvider(id)) { json(res, 400, { error: 'unknown provider' }); return }

      // key 只写不读：请求里带空串表示「不改」，clearKey 才是真删
      const patch: Record<string, unknown> = {}
      if (typeof body.model === 'string') patch.model = body.model.trim()
      if (typeof body.baseUrl === 'string') patch.baseUrl = body.baseUrl.trim()
      if (typeof body.apiKey === 'string' && body.apiKey.trim()) patch.apiKey = body.apiKey.trim()

      if (Object.keys(patch).length > 0) setProviderEntry(id, patch as never)
      if (body.clearKey) setProviderEntry(id, { apiKey: undefined } as never)

      const cfg = readConfig()
      cfg.defaultProvider = id
      writeConfig(cfg)

      json(res, 200, { ok: true, provider: id, model: patch.model ?? cfg.providers[id]?.model ?? '' })
      return
    }

    // 这个 provider 到底有哪些模型 —— 只有配上 key 之后才问得出来
    if (req.method === 'GET' && url.pathname === '/api/models') {
      const id = url.searchParams.get('provider') ?? ''
      const def = findProvider(id)
      if (!def) { json(res, 400, { models: [], error: 'unknown provider' }); return }

      const cfg = readConfig()
      const entry = cfg.providers[id] ?? {}
      const base = (entry.baseUrl ?? def.baseUrl).replace(/\/$/, '')
      const key = entry.apiKey ?? process.env[def.envKey ?? ''] ?? ''

      try {
        const ctl = new AbortController()
        const timer = setTimeout(() => ctl.abort(), 6000)
        const res2 = await fetch(base + '/models', {
          headers: key ? { authorization: `Bearer ${key}` } : {},
          signal: ctl.signal,
        })
        clearTimeout(timer)
        if (!res2.ok) { json(res, 200, { models: [], error: `HTTP ${res2.status}` }); return }
        const data = (await res2.json()) as { data?: Array<{ id?: string }>; models?: Array<{ name?: string }> }
        const models = (data.data ?? data.models ?? [])
          .map((m) => (m as { id?: string; name?: string }).id ?? (m as { name?: string }).name ?? '')
          .filter(Boolean)
          .sort()
        json(res, 200, { models })
      } catch (err) {
        json(res, 200, { models: [], error: err instanceof Error ? err.message : 'fetch failed' })
      }
      return
    }

    // ---- 语音：本机转写 ---------------------------------------------------
    // 网页录音 → 这里 → 本机 whisper。音频不出机器，也不依赖任何在线服务。
    if (req.method === 'GET' && url.pathname === '/api/asr') {
      json(res, 200, asrStatus())
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/transcribe') {
      let body: { audio?: string; mediaType?: string; lang?: string } = {}
      try { body = JSON.parse(await readBody(req)) as typeof body } catch { /* empty */ }
      const data = (body.audio ?? '').trim()
      if (!data) { json(res, 400, { error: 'no audio in the request' }); return }
      const buf = Buffer.from(data, 'base64')
      if (buf.length === 0) { json(res, 400, { error: 'the recording came through empty' }); return }
      // 一段口述不该有 25 MB；超了基本是前端把别的东西传上来了
      if (buf.length > 25 * 1024 * 1024) { json(res, 413, { error: 'recording too large' }); return }
      const ext = ((body.mediaType ?? '').split(';')[0]?.split('/')[1] ?? 'webm').replace(/[^a-z0-9]/g, '') || 'webm'
      const dir = pjoin(uhHome(), 'tmp', 'asr')
      try {
        const out = await transcribe({
          audio: buf,
          ext,
          ...(body.lang ? { lang: body.lang } : {}),
          workDir: dir,
        })
        json(res, 200, { text: out.text, engine: out.engine, language: out.language ?? '' })
      } catch (err) {
        const noEngine = (err as { code?: string }).code === 'NO_ASR'
        json(res, noEngine ? 501 : 500, { error: err instanceof Error ? err.message : String(err) })
      } finally {
        // 录音是临时文件：转完就删，别把说过的每句话都留在磁盘上
        try { for (const f of fsSync.readdirSync(dir)) fsSync.rmSync(pjoin(dir, f), { force: true }) } catch { /* ignore */ }
      }
      return
    }

    // ---- 本地目录浏览（新建项目时选文件夹）---------------------------------
    // 服务只听 127.0.0.1，是给本机用户自己挑目录用的；只回目录，不回文件内容。
    if (req.method === 'GET' && url.pathname === '/api/fs') {
      const raw = (url.searchParams.get('path') ?? '').trim()
      const home = os.homedir()
      const abs = pathMod.resolve(raw ? (raw.startsWith('~') ? pjoin(home, raw.slice(1)) : raw) : home)
      let entries: import('node:fs').Dirent[]
      try {
        entries = fsSync.readdirSync(abs, { withFileTypes: true })
      } catch (err) {
        json(res, 400, { error: (err as NodeJS.ErrnoException).code === 'EACCES'
          ? 'no permission to read that folder'
          : 'cannot read that folder' })
        return
      }
      const dirs = entries
        .filter((e) => e.isDirectory() || e.isSymbolicLink())
        .map((e) => ({ name: e.name, path: pjoin(abs, e.name), hidden: e.name.startsWith('.') }))
        // 符号链接可能是文件或断链：只留真目录，点进去不会得到一堆空列表
        .filter((d) => { try { return fsSync.statSync(d.path).isDirectory() } catch { return false } })
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
      // 面包屑：从根到当前目录，每一段都能点，省得靠退格去猜
      const crumbs: Array<{ name: string; path: string }> = []
      for (let cur = abs; ; cur = pathMod.dirname(cur)) {
        const par = pathMod.dirname(cur)
        crumbs.unshift({ name: cur === par ? cur : pathMod.basename(cur) || cur, path: cur })
        if (par === cur) break
      }
      const parent = pathMod.dirname(abs)
      json(res, 200, { path: abs, parent: parent === abs ? '' : parent, home, crumbs, dirs: dirs.slice(0, 400) })
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/fs/mkdir') {
      let body: { path?: string; name?: string } = {}
      try { body = JSON.parse(await readBody(req)) as typeof body } catch { /* empty */ }
      const base = (body.path ?? '').trim()
      const name = (body.name ?? '').trim()
      // 名字里不能有分隔符或 ..：这条选择器的用途是"在当前目录里建一个子目录"，
      // 允许路径就变成了任意位置写文件，那不是这个按钮该有的权力
      if (!base || !name) { json(res, 400, { error: 'need a folder and a name' }); return }
      if (/[\\/]/.test(name) || name === '.' || name === '..') {
        json(res, 400, { error: 'the name cannot contain a path separator' }); return
      }
      const target = pjoin(pathMod.resolve(base), name)
      try {
        mkdirSync(target, { recursive: false })
      } catch (err) {
        const code = (err as { code?: string }).code
        json(res, 400, { error: code === 'EEXIST' ? 'a folder with that name already exists' : 'could not create that folder' })
        return
      }
      json(res, 200, { path: target })
      return
    }

    // ---- 项目（工作区）-----------------------------------------------------
    if (req.method === 'GET' && url.pathname === '/api/projects') {
      const store = new EventStore()
      const seen = new Map<string, { path: string; sessions: number; lastUsed: string }>()
      for (const m of store.list({ limit: 300 })) {
        const ws = (m as { workspace?: string }).workspace
        if (!ws) continue
        const cur = seen.get(ws)
        const when = m.updated_at || m.created_at
        if (cur) {
          cur.sessions++
          if (when > cur.lastUsed) cur.lastUsed = when
        } else {
          seen.set(ws, { path: ws, sessions: 1, lastUsed: when })
        }
      }
      // 被「移除」的项目只是从列表里藏起来：磁盘还在，随时能重新加回来
      const hidden = new Set(readConfig().hiddenProjects ?? [])
      // 自己打开过的项目也算一个项目，哪怕一句都还没说。
      // 之前只从会话推导，于是「打开文件夹 → 左栏多了个项目 → 没说话就切走」
      // 会让它当场消失；用户看到的是「我明明打开过，它不在列表里」。
      for (const p of readConfig().projects ?? []) {
        if (seen.has(p) || hidden.has(p)) continue
        seen.set(p, { path: p, sessions: 0, lastUsed: '' })
      }
      const list = [...seen.values()]
        .filter((p) => !hidden.has(p.path))
        .sort((a, b) => (a.lastUsed < b.lastUsed ? 1 : -1))
      // 当前工作区永远要在列表里，除非它正是被移除的那个——那种情况下补回来
      // 等于移除操作没生效
      if (!seen.has(currentWorkspace) && !hidden.has(currentWorkspace)) {
        list.unshift({ path: currentWorkspace, sessions: 0, lastUsed: new Date().toISOString() })
      }

      // 每个项目挂自己的会话：左栏要画「项目 → 会话」两级，一个请求拿全
      const names = readProjectNames()
      const pinned = new Set(readConfig().pinnedSessions ?? [])
      const withItems = list.map((p) => ({
        ...p,
        name: names[p.path] || '',
        items: collectSessions(p.path).slice(0, 30)
          .map((s) => ({
            id: s.id, label: s.label, created: s.created, events: s.events,
            // 左栏要画「这个还在跑」。事件数是静态的，跑着的会话和跑完的长得一样
            running: running.has(s.id),
            pinned: pinned.has(s.id),
          }))
          // 置顶的排前面，其余保持「新的在上」。sort 是稳定的，所以同组内顺序不变。
          .sort((a, b) => Number(b.pinned) - Number(a.pinned)),
      }))
      json(res, 200, { current: currentWorkspace, projects: withItems })
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/project') {
      let body: { path?: string; name?: string } = {}
      try { body = JSON.parse(await readBody(req)) as typeof body } catch { /* empty */ }
      const raw = (body.path ?? '').trim()
      if (!raw) { json(res, 400, { error: 'path is empty' }); return }
      const abs = raw.startsWith('~') ? pathMod.join(os.homedir(), raw.slice(1)) : raw
      if (!abs.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(abs)) {
        json(res, 400, { error: 'give an absolute path' }); return
      }
      try {
        mkdirSync(abs, { recursive: true })
      } catch (err) {
        json(res, 400, { error: err instanceof Error ? err.message : 'cannot create that directory' }); return
      }
      currentWorkspace = abs
      if (typeof body.name === 'string') writeProjectName(abs, body.name)
      // 记住「打开过」，不是「说过话」。项目列表原本完全从会话推导，
      // 于是打开一个还没说过话的目录，它会在切回来时凭空消失。
      rememberProject(abs)
      json(res, 200, { current: currentWorkspace, name: readProjectNames()[abs] || '' })
      return
    }

    // ---- 加装 MCP：写进 ~/.uh/mcp.json 的 mcpServers ----------------------
    // 结构沿用 Claude Desktop 的，所以从别处抄来的 JSON 能整块贴进来。
    // 之前 MCP 只能靠终端 `uh mcp add` 加，设置页里看得见却加不了。
    if (req.method === 'POST' && url.pathname === '/api/plugins/mcp') {
      const body = JSON.parse(await readBody(req).catch(() => '{}')) as {
        name?: string
        json?: string
        url?: string
        command?: string
        scope?: 'user' | 'project'
      }
      const file = body.scope === 'project' ? projectMcpConfigPath(currentWorkspace) : globalMcpConfigPath()
      let servers: Record<string, unknown> = {}
      try {
        const cur = JSON.parse(fs6.readFileSync(file, 'utf8')) as { mcpServers?: Record<string, unknown> }
        servers = cur.mcpServers ?? {}
      } catch { servers = {} }

      // 贴一整块 Claude Desktop 风格配置，或者只给一个 URL / 命令
      let incoming: Record<string, unknown> = {}
      const rawJson = (body.json ?? '').trim()
      if (rawJson) {
        let parsed: { mcpServers?: Record<string, unknown> } & Record<string, unknown>
        try { parsed = JSON.parse(rawJson) as typeof parsed } catch (err) {
          json(res, 400, { error: 'JSON 不合法：' + (err instanceof Error ? err.message : '') }); return
        }
        if (parsed.mcpServers && typeof parsed.mcpServers === 'object') incoming = parsed.mcpServers
        else if (Object.keys(parsed).length) incoming = { [String(body.name ?? '').trim() || 'mcp']: parsed }
        else { json(res, 400, { error: '这一段里没有 mcpServers' }); return }
      } else if ((body.url ?? '').trim()) {
        const u = String(body.url).trim()
        if (!/^https?:\/\//i.test(u)) { json(res, 400, { error: '地址要以 http(s):// 开头' }); return }
        const nm = String(body.name ?? '').trim()
        if (!nm) { json(res, 400, { error: '给这个服务起个名字（比如 linear）' }); return }
        incoming = { [nm]: { url: u } }
      } else if ((body.command ?? '').trim()) {
        const nm = String(body.name ?? '').trim()
        if (!nm) { json(res, 400, { error: '给这个服务起个名字' }); return }
        const parts = String(body.command).trim().split(/\s+/)
        incoming = { [nm]: { command: parts[0], args: parts.slice(1) } }
      } else {
        json(res, 400, { error: '贴一段 JSON，或者给一个 URL / 命令' }); return
      }

      const added: string[] = []
      const skipped: string[] = []
      for (const [k, v] of Object.entries(incoming)) {
        const name = k.trim()
        // 名字会进工具前缀，不能带空白；重复的直接跳过而不是覆盖——那份可能正在用
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/.test(name)) { skipped.push(name || '(空)'); continue }
        if (servers[name]) { skipped.push(name); continue }
        servers[name] = v
        added.push(name)
      }
      if (!added.length) {
        json(res, 409, { error: '没有新增：' + (skipped.join('、') || '没读到') + ' 已经存在或名字不合法' })
        return
      }
      mkdirSync(pathMod.dirname(file), { recursive: true })
      fs6.writeFileSync(file, JSON.stringify({ mcpServers: servers }, null, 2) + '\n', { mode: 0o600 })
      json(res, 200, { ok: true, added, skipped, file })
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/plugins/mcp/delete') {
      const body = JSON.parse(await readBody(req).catch(() => '{}')) as { name?: string; scope?: 'user' | 'project' }
      const nm = String(body.name ?? '').trim()
      const file = body.scope === 'project' ? projectMcpConfigPath(currentWorkspace) : globalMcpConfigPath()
      let servers: Record<string, unknown> = {}
      try { servers = (JSON.parse(fs6.readFileSync(file, 'utf8')) as { mcpServers?: Record<string, unknown> }).mcpServers ?? {} } catch { servers = {} }
      if (!servers[nm]) { json(res, 404, { error: '没有这个 MCP 服务' }); return }
      delete servers[nm]
      fs6.writeFileSync(file, JSON.stringify({ mcpServers: servers }, null, 2) + '\n', { mode: 0o600 })
      json(res, 200, { ok: true })
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/project/rename') {
      const body = JSON.parse(await readBody(req).catch(() => '{}')) as { path?: string; name?: string }
      const p = String(body.path ?? '').trim()
      if (!p) { json(res, 400, { error: 'path is empty' }); return }
      writeProjectName(p, String(body.name ?? ''))
      json(res, 200, { ok: true, path: p, name: readProjectNames()[p] || '' })
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/project/remove') {
      const body = JSON.parse(await readBody(req).catch(() => '{}')) as { path?: string }
      const p = String(body.path ?? '').trim()
      if (!p) { json(res, 400, { error: 'path is empty' }); return }
      const cfg = readConfig()
      const set = new Set(cfg.hiddenProjects ?? [])
      set.add(p)
      cfg.hiddenProjects = [...set]
      writeConfig(cfg)
      // 移除的是当前工作区：得换一个，否则左栏空了但界面还在一个看不见的项目里
      if (p === currentWorkspace) {
        const rest = collectSessions().map((x) => x.workspace).filter((w) => w && w !== p)
        const next = rest.find((w) => w && !set.has(w)) ?? os.homedir()
        currentWorkspace = next
      }
      json(res, 200, { ok: true, current: currentWorkspace })
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/run') {
      let body: {
        task?: string
        maxSteps?: number
        images?: { name?: string; mediaType?: string; data?: string }[]
        refs?: string[]
        /** 续上一句：给了就接着这条会话往下说，而不是新开一条 */
        sessionId?: string
      } = {}
      try { body = JSON.parse(await readBody(req)) as typeof body } catch { /* ignore */ }
      const task0 = (body.task ?? '').trim()
      if (!task0) { json(res, 400, { error: 'task is empty' }); return }
      // 网页输入框里同样能用 @文件 / $技能 / /mcp 名字。
      // 和终端共用 expandMentions，两边行为不会分叉。
      const mention = expandMentions(task0, currentWorkspace)
      const task = mention.text

      // 没有可用的模型就别返回 200：那样前端会以为接下了任务，用户盯着空白的
      // 日志等一个根本不会开始的 run。
      //
      // 注意别用 resolveProvider() 判断——它只回答「该用哪家」，没 key 也照样返回，
      // 于是这里永远放行。要看的是「这家到底能不能发请求」：本地服务不需要 key，
      // 云服务没有 key 就发不出去。
      const cfg0 = readConfig()
      const pid = cfg0.defaultProvider ?? 'deepseek'
      const pdef = findProvider(pid)
      const entry = cfg0.providers[pid]
      const hasModel = Boolean(entry?.model)
      const hasKey = Boolean(entry?.apiKey || (pdef?.envKey ? process.env[pdef.envKey] : ''))
      if (!hasModel || (!hasKey && pdef?.local !== true)) {
        json(res, 428, {
          error: !hasModel
            ? `no model set for ${pdef?.label ?? pid} — pick one in settings`
            : `${pdef?.label ?? pid} has no API key — paste one in settings`,
          needsSetup: true,
        })
        return
      }

      // ---- 多轮：接着上一句往下说 ------------------------------------------
      // 每句话都新开一条会话，左栏就是一地碎片，模型也拿不到上文；
      // 这里把「续哪一条 / 第几轮 / 在哪个工作区」一次定下来。
      const contId = (body.sessionId ?? '').trim()
      let resumeFrom: Message[] | undefined
      let turnIndex = 1
      if (contId) {
        if (running.has(contId)) {
          json(res, 409, { error: 'that conversation is still running — wait or stop it first' })
          return
        }
        const store0 = new EventStore()
        const meta = store0.get(contId)
        if (!meta) { json(res, 404, { error: 'no such conversation: ' + contId }); return }
        // 会话属于某个工作区。用户是从这条会话点进来的，就跟着它走——
        // 否则会在 A 项目的对话里改 B 项目的文件。
        if (meta.workspace && meta.workspace !== currentWorkspace) currentWorkspace = meta.workspace
        const st = readState(contId)
        // 没有 state.json（老会话、或上一轮崩在落盘之前）也能续：
        // 只是这句话不带上文，比直接拒绝让人能继续干活。
        if (st && st.messages.length) resumeFrom = st.messages
        // 轮次接着数。同一个会话里出现两个 turn_index:1，回放和撤销都分不清边界。
        turnIndex = store0.read(contId, { kinds: ['turn/start'] }).length + 1
        // 清掉上一轮的广播缓存：否则这一轮连上 SSE 会把上一轮重放一遍，屏幕上两份
        evBuf.delete(contId)
      }

      // 网页传来的图是 base64。存成文件而不是把 base64 塞进事件/state：
      // 续跑要按路径重读，而一条 3 MB 的 base64 写进日志会让 cat 都打不开。
      // 放 .uh/uploads 而不是工作区根：快照本来就跳过 .uh，交付物里不该多出用户截图。
      const images: { path: string; mediaType: string; data: string }[] = []
      for (const im of body.images ?? []) {
        const data = (im.data ?? '').trim()
        if (!data) continue
        const buf = Buffer.from(data, 'base64')
        if (buf.length === 0 || buf.length > 12 * 1024 * 1024) continue
        const sha = createHash('sha256').update(buf).digest('hex').slice(0, 16)
        const ext = ((im.name ?? '').split('.').pop() ?? 'png').toLowerCase().replace(/[^a-z0-9]/g, '') || 'png'
        const dir = pjoin(currentWorkspace, '.uh', 'uploads')
        mkdirSync(dir, { recursive: true })
        const file = pjoin(dir, `${sha}.${ext}`)
        if (!existsSync(file)) writeFileSync(file, buf)
        images.push({ path: file, mediaType: im.mediaType ?? 'image/png', data })
      }

      // @ 到的文件：小的直接放进上下文，大的只给路径。
      // 全塞进去的话，拖进一个大文件就等于把整个窗口烧掉，而模型本来就能自己读。
      const INLINE_MAX = 16 * 1024
      const blocks: string[] = []
      for (const rel of (body.refs ?? []).slice(0, 12)) {
        const abs = underWorkspace(String(rel))
        if (!abs || !existsSync(abs)) continue
        let st: import('node:fs').Stats
        try { st = fsSync.statSync(abs) } catch { continue }
        if (!st.isFile()) continue
        const rel2 = pathMod.relative(currentWorkspace, abs)
        if (st.size > INLINE_MAX) {
          blocks.push(`<file path="${rel2}" bytes="${st.size}">(too large to inline — open it with read_file)</file>`)
        } else {
          let text = ''
          try { text = fsSync.readFileSync(abs, 'utf8') } catch { continue }
          blocks.push(`<file path="${rel2}">\n${text}\n</file>`)
        }
      }
      const attachedBlock = blocks.length
        ? `<attached_files>\n${blocks.join('\n')}\n</attached_files>\n\n`
        : ''

      // 续跑时 id 现在就知道：从第一毫秒起事件就能直接推给已经连着的页面，
      // 不用再攒 earlyEvents。新会话还得等 start() 分配。
      let sid = contId
      const sidRef = { id: contId }
      // session/start、turn/start、第一轮思考都发生在 start() 之前，那时还没有 id。
      // 先攒着，拿到 id 再倒进缓冲——否则前几百毫秒发生的事对网页来说不存在
      const earlyEvents: Array<{ kind: string; payload: Record<string, unknown> }> = []
      const h = new Harness({
        record: true,
        // 网页和终端用同一份插件清单：不带这个，浏览器/手机插件在网页里等于不存在
        pluginDirs: pluginDirs(),
        // 标签只在开新会话时有用；续跑时改它会把这个对话在左栏改名成最后一句
        // 会话名用用户写的原话：用展开后的 task 会让左栏显示成
        // `<mcp_servers> - server "mock": ...`
        ...(contId ? { resumeSessionId: contId } : { label: task0.slice(0, 60) }),
        workspace: currentWorkspace,
        // 网页里也要能审批：不接这个门，破坏性命令在 UI 里只能一律失败
        gate: makeWebGate(sidRef),
        // session 在 start() 里创建，所以这里先缓冲，拿到 id 后再推送
        onEvent: (kind, payload) => {
          if (sid) broadcast(sid, kind, payload)
          else earlyEvents.push({ kind, payload: { ...payload, _ts: Date.now() } })
        },
        // 流式：模型说一个字就推一个字。没有这两行，网页就是「跑完才知道」，
        // 长任务里用户只能盯着一个不动的转圈——CLI 早就有流式了，网页不该更差。
        onText: (d) => {
          const ev = { text: d, _ts: Date.now() }
          if (sid) broadcast(sid, 'text/delta', ev)
          else earlyEvents.push({ kind: 'text/delta', payload: ev })
        },
        onReasoning: (d) => {
          const ev = { text: d, _ts: Date.now() }
          if (sid) broadcast(sid, 'reasoning/delta', ev)
          else earlyEvents.push({ kind: 'reasoning/delta', payload: ev })
        },
      })
      await h.start()          // ← 少这一句就拿不到 sessionId
      sid = h.sessionId ?? sid
      sidRef.id = sid
      // 把拿 id 之前攒下的事件按原顺序补进缓冲，前端一接上就能看到完整过程
      for (const ev of earlyEvents) bufferEvent(sid, ev.kind, ev.payload)
      running.set(sid, h)

      // 立刻把 sessionId 交给前端，任务在后台跑
      json(res, 200, { sessionId: sid, ...(contId ? { continued: true, turn: turnIndex } : {}) })

      void (async () => {
        // done 一定要在「从 running 里摘掉」之后再发：前端收到 done 会立刻重拉
        // 左栏列表，如果这时候服务端还认为它在跑，那一行就会一直挂着 running
        // （截图里跑完很久的会话还写着 running 就是这个顺序问题）
        let done: Record<string, unknown> = {}
        try {
          const out = await h.runTask({
            task: attachedBlock + task,
            // 界面上显示用户写的那句：不给的话气泡和会话名会变成一整块
            // <mcp_servers>/<attached> 原文
            displayTask: task0,
            ...(body.maxSteps ? { maxSteps: body.maxSteps } : {}),
            ...(images.length ? { images } : {}),
            ...(resumeFrom ? { resumeFrom } : {}),
            ...(turnIndex > 1 ? { turnIndex } : {}),
          })
          broadcast(sid, 'answer', { text: out.text })
          broadcast(sid, 'deliverables', {
            items: out.artifacts,
            verifications: out.verifications.map((v) => ({
              path: v.path, result: v.result, detail: v.detail,
            })),
          })
          done = { steps: out.steps, tokens: out.usage.total, compactions: out.compactions }
        } catch (err) {
          broadcast(sid, 'error', { message: err instanceof Error ? err.message : String(err) })
        } finally {
          usageCache = null  // 这次 run 产生了新 token，旧的汇总立刻作废
          running.delete(sid)
          h.dispose()
          broadcast(sid, 'done', done)
        }
      })()
      return
    }

    // 人在网页上点了「允许/拒绝」
    if (req.method === 'POST' && url.pathname === '/api/approve') {
      let body: { id?: string; approved?: boolean; always?: boolean } = {}
      try { body = JSON.parse(await readBody(req)) as typeof body } catch { /* empty */ }
      const fn = body.id ? pendingApprovals.get(body.id) : undefined
      if (!fn) { json(res, 404, { error: 'no such approval request' }); return }
      pendingApprovals.delete(body.id as string)
      pendingInfo.delete(body.id as string)
      // 三种回答：拒绝 / 就这一次 / 一直都行。第三种的持久化由 harness 做，
      // 这里只把意图传下去——服务端不该偷偷往规则文件里写东西。
      const decision: 'allow' | 'allow-always' | 'deny' =
        body.approved === true
          ? (body.always === true ? 'allow-always' : 'allow')
          : 'deny'
      fn(decision)
      json(res, 200, { ok: true, decision })
      return
    }

    // 停止：跑飞了要能按停，而不是等它把步数烧完
    // 运行中追加指令：不新建 run，插到正在跑的那一次里
    if (req.method === 'POST' && url.pathname === '/api/steer') {
      let body: { sessionId?: string; text?: string } = {}
      try { body = JSON.parse(await readBody(req)) as typeof body } catch { /* empty */ }
      const sid = (body.sessionId ?? '').trim()
      const text = (body.text ?? '').trim()
      if (!text) { json(res, 400, { error: 'nothing to add' }); return }
      const h = running.get(sid)
      if (!h) {
        json(res, 404, { error: 'that run already finished — send it as a new task instead' })
        return
      }
      const id = h.steer(text)
      json(res, 200, { ok: true, queued: true, id })
      return
    }

    // 撤回一条还没生效的插话。前端「点开排队中的消息去编辑」要先走这一步，
    // 否则用户改的时候原句已经在下一个 step 边界按旧样子生效了。
    if (req.method === 'POST' && url.pathname === '/api/steer/withdraw') {
      let body: { sessionId?: string; id?: string } = {}
      try { body = JSON.parse(await readBody(req)) as typeof body } catch { /* empty */ }
      const sid = (body.sessionId ?? '').trim()
      const id = (body.id ?? '').trim()
      if (!id) { json(res, 400, { error: 'which note?' }); return }
      const h = running.get(sid)
      if (!h) { json(res, 404, { error: 'that run already finished' }); return }
      // ok:false 表示它已经被取走并生效了——前端据此提示「已生效，改完会再发一次」
      json(res, 200, { ok: h.withdrawSteer(id) })
      return
    }

    /**
     * 用本机 IDE 打开一个文件（Codex 也是这么做的：点一下就在编辑器里打开）。
     * 只认明确被点名的编辑器，路径必须在本次会话的工作区里——
     * 这是个「替用户启动进程」的接口，不能拿它去开任意路径。
     */
    if (req.method === 'POST' && url.pathname === '/api/open') {
      let body: Record<string, unknown> = {}
      try { body = JSON.parse(await readBody(req)) as Record<string, unknown> } catch { /* empty */ }
      const sid = String(body.sessionId ?? '')
      const rel = String(body.path ?? '')
      const which = String(body.editor ?? '')
      if (!rel) { json(res, 400, { error: 'path is required' }); return }
      const h = (sid ? running.get(sid) : undefined) ?? [...running.values()][0]
      const root = h?.workspace ?? (opts.workspace ?? process.cwd())
      const abs = pathMod.resolve(root, rel)
      // 逃出工作区的路径一律拒绝：这是边界，不是提示
      if (!(abs === root || abs.startsWith(root + pathMod.sep))) {
        json(res, 403, { error: 'that path is outside this project' }); return
      }
      if (!fsSync.existsSync(abs)) { json(res, 404, { error: 'no such file' }); return }
      const editors = editorCandidates(which)
      for (const e of editors) {
        try {
          spawn(e.cmd, e.args(abs), { detached: true, stdio: 'ignore' }).unref()
          json(res, 200, { ok: true, editor: e.name, path: abs })
          return
        } catch { /* 换下一个 */ }
      }
      json(res, 501, { error: 'no editor found', tried: editors.map((e) => e.name) })
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/stop') {
      let body: { sessionId?: string } = {}
      try { body = JSON.parse(await readBody(req)) as typeof body } catch { /* empty */ }
      const h = body.sessionId ? running.get(body.sessionId) : undefined
      if (!h) { json(res, 404, { error: 'that session is not running' }); return }
      h.abort()
      json(res, 200, { ok: true, stopped: body.sessionId })
      return
    }

    if (req.method === 'GET' && url.pathname === '/api/stream') {
      const sessionId = url.searchParams.get('session') ?? ''
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      res.write(': connected\n\n')

      // 先补发这个会话已经发生的事，再往下走实时：否则 run 到 attach 之间的
      // 第一轮思考和工具调用会永远丢掉。
      //
      // `after=<seq>` 是「我从磁盘读到的快照到第几条为止」。读快照和接上这条
      // 连接之间有一小段空隙——模型正在飞速跑的时候，那几百毫秒里发生的事
      // 两头都没有：快照里没有，实时流还没接上。表现就是**切到别的会话再切
      // 回来，正在跑的那一轮凭空少了一截，看着像停了**。带上游标，缺口正好
      // 被服务端补齐。
      //
      // `live=1` 是旧参数（只接实时、不补发），保留给还没更新的页面。
      const afterRaw = url.searchParams.get('after')
      const afterSeq = afterRaw === null ? null : Number(afterRaw)
      if (afterSeq !== null && Number.isFinite(afterSeq)) {
        try {
          const store = new EventStore()
          for (const ev of store.read(sessionId, { fromSeq: afterSeq + 1 })) {
            res.write(`event: ${ev.kind}\ndata: ${JSON.stringify(ev.payload)}\n\n`)
          }
        } catch { /* 读不到就让实时流兜着，至少不会比之前更差 */ }
      } else if (url.searchParams.get('live') !== '1') {
        for (const ev of evBuf.get(sessionId) ?? []) {
          res.write(`event: ${ev.kind}\ndata: ${JSON.stringify(ev.payload)}\n\n`)
        }
      }

      // 重放这个会话还没被回答的审批：页面刚连上时，请求可能早就发过了
      for (const [, info] of pendingInfo) {
        if (info.sid === sessionId) {
          res.write(`event: approval/needs\ndata: ${JSON.stringify(info.payload)}\n\n`)
        }
      }

      const sub: Subscriber = { write: (c: string) => res.write(c) }
      if (!subs.has(sessionId)) subs.set(sessionId, new Set())
      subs.get(sessionId)!.add(sub)

      const keepAlive = setInterval(() => {
        try { res.write(': ping\n\n') } catch { /* closed */ }
      }, 15_000)

      // 文件监听：跟着这条连接走。
      // 工作区变了要能推给页面，否则 agent 改了文件、界面还停在旧内容上。
      const clientId = '__fs' + nextWatchClient++
      const wsRoot = currentWorkspace || process.cwd()
      fileSubs.set(clientId, sub)
      try {
        // 递归听整个工作区；听不上就算了，界面照样能用
        if (!watchManager.watch(clientId, 'workspace', { path: wsRoot, recursive: true })) {
          fileSubs.delete(clientId)
        }
      } catch {
        fileSubs.delete(clientId)
      }

      req.on('close', () => {
        clearInterval(keepAlive)
        subs.get(sessionId)?.delete(sub)
        if (subs.get(sessionId)?.size === 0) subs.delete(sessionId)
        // 不清就漏句柄：反复刷新页面会让文件数 × 连接数 的 watcher 都留在进程里
        watchManager.clientClosed(clientId)
        fileSubs.delete(clientId)
      })
      return
    }

    if (req.method === 'GET' && url.pathname.startsWith('/api/session/')) {
      const id = decodeURIComponent(url.pathname.slice('/api/session/'.length))
      try {
        const store = new EventStore()
        const events = store.read(id)
        // 只要文本。之前把整个 payload 递出去，UI 拿到一个对象，
        // 于是重放历史会话时回答区显示的是 "[object Object]"。
        const answerEvent = [...events].reverse().find(
          (e) => e.kind === 'assistant/message' && typeof (e.payload as { text?: unknown })?.text === 'string',
        )
        const answer = typeof (answerEvent?.payload as { text?: unknown })?.text === 'string'
          ? (answerEvent!.payload as { text: string }).text
          : null
        const artifacts = events.filter((e) => e.kind === 'artifact/emitted').map((e) => e.payload)
        const verifications = events
          .filter((e) => e.kind === 'verification/asserted')
          .map((e) => {
            const a = (e.payload as { assertion?: { kind?: string; path?: string } }).assertion
            return {
              path: a?.path ?? '',
              result: (e.payload as { result?: string }).result,
              detail: e.payload,
            }
          })
        // lastSeq 给页面当游标：它拿着这个数去接实时流，中间那段才不会漏
        const lastSeq = events.at(-1)?.seq ?? 0
        json(res, 200, {
          id, events, artifacts, verifications, answer, lastSeq,
          running: running.has(id),
        })
      } catch (err) {
        json(res, 404, { error: err instanceof Error ? err.message : 'session not found' })
      }
      return
    }

    json(res, 404, { error: 'not found' })
  }

  let server: http.Server

  const listenOnce = (): Promise<void> => new Promise<void>((resolve, reject) => {
    const s = http.createServer(handleRequest)
    s.once('error', reject)
    s.listen(port, bindAddr, () => resolve())
    server = s
  })

  await listenOnce()

  /**
   * 换绑定地址。
   *
   * 一个 socket 不能中途改自己绑在哪，所以必须关掉再听——但关之前要把现有连接
   * 全部掐断，否则 `close()` 会一直等 keep-alive 超时，表现为「点了开关没反应」。
   * 端口号不变，页面上不用改任何地址。
   */
  const applyRemoteMode = async (mode: RemoteMode): Promise<void> => {
    remoteMode = mode
    const cfg = readConfig()
    cfg.remote = mode
    writeConfig(cfg)
    const next = mode === 'off' ? '127.0.0.1' : '0.0.0.0'
    if (next === bindAddr) return
    const old = server
    await new Promise<void>((resolve) => {
      old.closeAllConnections?.()
      old.close(() => resolve())
    })
    bindAddr = next
    await listenOnce()
  }

  return {
    url: `http://${bindAddr === '127.0.0.1' ? '127.0.0.1' : lanAddresses()[0] ?? '127.0.0.1'}:${port}`,
    close: () => server.close(),
    /** 给测试用：改完不用重启进程 */
    setRemoteMode: (m: 'off' | 'tailnet' | 'lan') => applyRemoteMode(m),
  }
}

// ---- 端口归属与「强制重启」------------------------------------------------
//
// 改了代码之后最常见的一句抱怨是「桌面端还是旧的」。原因不是构建没生效，而是
// 7878 上还跑着上一次的 `uh serve`——新进程 listen 失败退出，界面连的还是老进程。
// 这里把「谁占着端口」查清楚，并在明确要求时接管它。
//
// 接管有一条硬底线：**只杀确认是 UnitHarness 的进程**。端口上可能是用户的
// 其他服务，误杀的代价远大于多看一次报错。

export interface PortOwner {
  pid: number
  /** 命令行，用来判断它到底是不是我们 */
  command: string
  isUharness: boolean
}

function sh(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return ''
  }
}

/** 一条命令是不是「我们的 uh serve」——注意不能只判端口，必须判进程身份 */
function looksLikeUs(command: string): boolean {
  if (!command) return false
  const c = command.replace(/\\/g, '/')
  // 只认「<uh|unitai> serve/desktop」这一种形状：路径里出现 unit-harness 的关键词
  // 完全可能是编辑器或 npm 在工作，那不是可以杀的东西
  return /(?:^|\/|\s)(?:uh(?:\.cjs)?|unitai|unit-harness)\s+(?:serve|desktop)\b/.test(c)
}

export function findPortOwner(port: number): PortOwner | null {
  let pid = 0
  if (process.platform === 'linux') {
    // ss 是 iproute2 自带的；-H 去掉表头，避免把标题行当数据解析
    const out = sh('ss', ['-lptnH', `sport = :${port}`])
    const m = /pid=(\d+)/.exec(out)
    if (m) pid = Number(m[1])
    if (!pid) {
      const l = sh('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']).trim().split('\n')[0]
      if (l) pid = Number(l)
    }
  } else if (process.platform === 'darwin') {
    const l = sh('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']).trim().split('\n')[0]
    if (l) pid = Number(l)
  } else if (process.platform === 'win32') {
    const out = sh('netstat', ['-ano'])
    for (const line of out.split('\n')) {
      if (!line.includes('LISTENING')) continue
      if (!new RegExp(`[:.]${port}\\s`).test(line)) continue
      const parts = line.trim().split(/\s+/)
      const last = parts[parts.length - 1]
      if (last && /^\d+$/.test(last)) { pid = Number(last); break }
    }
  }
  if (!pid || pid <= 0) return null

  let command = ''
  if (process.platform === 'linux') {
    try {
      // /proc/<pid>/cmdline 是 NUL 分隔的，直接 readFile 会得到一串内联 NUL
      command = fsSync.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ')
    } catch { /* 权限或已退出 */ }
  }
  if (!command) command = sh('ps', ['-p', String(pid), '-o', 'command=']).trim()
  if (!command && process.platform === 'win32') {
    command = sh('powershell', ['-NoProfile', '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`]).trim()
  }
  return { pid, command, isUharness: looksLikeUs(command) }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function portBusyHint(port: number, owner: PortOwner | null): string {
  if (!owner) {
    return `port ${port} is already in use, but I cannot tell which process owns it.\n` +
      '  try:  uh serve --force     (needs iproute2/ss or lsof installed)\n' +
      `  or:   uh serve --port ${port + 1}`
  }
  const who = owner.command || `pid ${owner.pid}`
  if (!owner.isUharness) {
    // 这里绝不能「顺手杀掉重来」：桌上可能正跑着用户的另一个服务
    return `port ${port} is taken by something that is not UnitHarness (pid ${owner.pid}): ${who}\n` +
      `  refusing to kill it — use another port:  uh serve --port ${port + 1}`
  }
  return `port ${port} is already served by UnitHarness (pid ${owner.pid}): ${who}\n` +
    `  restart it in place:  uh serve --force\n` +
    `  or use another port:  uh serve --port ${port + 1}`
}

/**
 * 起服务；端口被自己上一版占着时按 force 接管。
 *
 * 返回 replaced 表示真的替换掉了某个进程——调用方要把它打出来，否则用户
 * 会以为自己刚杀的进程还活着（或者反过来，以为什么都没动）。
 */
export async function startServerOrRestart(opts: { port: number; host?: string; force?: boolean; workspace?: string }): Promise<{
  srv: { url: string; close: () => void }
  replaced: PortOwner | null
}> {
  const attempt = () => startServer({
    port: opts.port,
    ...(opts.host ? { host: opts.host } : {}),
    ...(opts.workspace ? { workspace: opts.workspace } : {}),
  })
  try {
    return { srv: await attempt(), replaced: null }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err
    const owner = findPortOwner(opts.port)
    if (!opts.force) throw new Error(portBusyHint(opts.port, owner))
    if (!owner) throw new Error(portBusyHint(opts.port, owner))
    if (!owner.isUharness) throw new Error(portBusyHint(opts.port, owner))

    // 先礼后兵：SIGTERM 让它自己收尾（关 SSE、落状态），5 秒不退再 SIGKILL
    try {
      if (process.platform === 'win32') {
        sh('taskkill', ['/PID', String(owner.pid), '/T', '/F'])
      } else {
        process.kill(owner.pid, 'SIGTERM')
      }
    } catch { /* 已经退了 */ }

    for (let i = 0; i < 50; i++) {
      await sleep(100)
      const still = findPortOwner(opts.port)
      if (!still) break
      if (i === 49) {
        try {
          if (process.platform === 'win32') sh('taskkill', ['/PID', String(owner.pid), '/T', '/F'])
          else process.kill(owner.pid, 'SIGKILL')
        } catch { /* ignore */ }
        await sleep(300)
      }
    }
    if (findPortOwner(opts.port)) {
      throw new Error(`could not stop pid ${owner.pid} on port ${opts.port} — stop it yourself, or use --port`)
    }
    return { srv: await attempt(), replaced: owner }
  }
}

/**
 * 能打开文件的编辑器，按优先级排。
 *
 * 传了 editor 就只用它（用户明确选了），否则按常见顺序试：先 IDE，再通用打开。
 * 每个候选都带 `name`，失败的会原样报给前端，而不是沉默地什么都不发生。
 */
function editorCandidates(which: string): { name: string; cmd: string; args: (p: string) => string[] }[] {
  const all: { name: string; cmd: string; args: (p: string) => string[] }[] = []
  if (process.env.UH_EDITOR) {
    const parts = process.env.UH_EDITOR.split(/\s+/).filter(Boolean)
    const head = parts[0]
    if (head) all.push({ name: process.env.UH_EDITOR, cmd: head, args: (p) => [...parts.slice(1), p] })
  }
  all.push(
    { name: 'goland', cmd: 'goland', args: (p) => [p] },
    { name: 'idea', cmd: 'idea', args: (p) => [p] },
    { name: 'webstorm', cmd: 'webstorm', args: (p) => [p] },
    { name: 'pycharm', cmd: 'pycharm', args: (p) => [p] },
    { name: 'vs code', cmd: 'code', args: (p) => ['-g', p] },
    { name: 'cursor', cmd: 'cursor', args: (p) => ['-g', p] },
    { name: 'zed', cmd: 'zed', args: (p) => [p] },
    { name: 'default app', cmd: process.platform === 'darwin' ? 'open' : 'xdg-open', args: (p) => [p] },
  )
  if (!which) return all
  const w = which.toLowerCase()
  const hit = all.filter((e) => e.name === w)
  return hit.length ? hit : all
}

/** 用系统默认浏览器打开；返回是否成功 */
export function openBrowser(url: string): boolean {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start'
    : 'xdg-open'
  try {
    spawn(cmd, [url], { detached: true, stdio: 'ignore', shell: process.platform === 'win32' }).unref()
    return true
  } catch {
    return false
  }
}

export { Harness }
