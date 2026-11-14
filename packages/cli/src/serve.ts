/**
 * 本地 Web UI（`uh serve`）。
 *
 * 形态参考 DeepSeek Harness 的 apps/web + host/webserver：一个本机 HTTP 服务，
 * 前端是纯静态页面，事件走 SSE 实时推送。这样"桌面端"不需要 Electron，
 * 一个二进制的体积和启动速度都和 CLI 一样。
 */
import http from 'node:http'
import os from 'node:os'
import pathMod, { join as pjoin } from 'node:path'
import fsSync, { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import fs6 from 'node:fs'
import { spawn, execFileSync } from 'node:child_process'
import {
  EventStore, Harness, PROVIDERS, findProvider, hydrateEdits, maskKey, readState,
  readConfig, resolveProvider, setProviderEntry, uhHome, workspaceDir, writeConfig } from '@unit-harness/core'
import { describeTool, describeToolResult, describeThinking, describeFilesChanged, normalizeBudget, WatchManager } from '@unit-harness/core'
import { loadMcpServers, discoverSkills } from '@unit-harness/core'
import type { ApprovalGate, ApprovalRequest, Message } from '@unit-harness/core'
import UI from './ui.html'
import { asrStatus, transcribe } from './asr.ts'

/** 和桌面端、站上同一个图标：32px PNG 直接内联，省一个静态文件路由 */
const FAVICON_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAIBElEQVR42tVXa3BV1RX+1t7nnHtz84AEDUzFBxBRAgIhEEJAblCQtjJqa28Uq2BfsdoHbaWIrfVwcHRqn6RoH+lotVOUuWmntaXoGIRcRJRHqLaToFihWK0YAnmQ5N5zz9lr9cdN0LGp4Gid6f6z13ns17e/9a21gP/PJoREUg8+DNn0Ya1Obzfog5rstE8OkstvXl186A1zZ8YPFgCUjUbQnJhWdJfneZnBOeV/sQECXKqvRzT1r55tRhdWgbMgRYB2oPzux+5aPu/qurY2gefx6U6qTvfHeNzVgMe7OnquZ51fpTjtW0rYghgKBrJsxa6855Htl8HzOJFI6A98A6nB3merCgQmgga0YhFNBEWiTP8AygGgo6OcPngEBntLwiMEpYSFmRkAA0JMSmnbVp3vlYT/uYFEQgMJDUDF43FriCelpe0CgMaeN67BZPt8Q5YjYliEWHSeI9nMm4mVDRvguipVCwYA13UVRHLX4boqMWS/CwmHZXA8HrdSqVQIAOWzam6UaOmCcGTZDIaaAgFsbe3Sx/e3Iexpbnt268ZBzliplBcCgA3A5LB6Vy9QAPjCyrnLg1A+BSAase2t48dc0LBpU+PAhfMunaizZiUs++9tO5u/l0y6znd+9vIq7ThH2574VWNtLemOzCW3CUlxYckZP9izuemIu3nb2K35sdt7smE1a+k+m4PfNy9ccF/ougqeJ4N+nYMHnsdlM+b8kMj+BgQgAkhpBJnMnyIRJ8mE2kjE+eVfdzTvGlv99bzXnvtxesK5E2qzh185+k+grdxNOu1eXXZyzWULAt+/duT4c1uyX/jcmhMjiidyOg0DwI7lYWzXsYanFy/4GieTGnV1hnL33WQmzZxTkQ3VPkUUKk0AhIQRslBEQTYsveLSZZ7nMSorbbS2BkuX1p+xV4obRi2s7Fs3/5xvVk+s7kV9vY3GxmAqRufrdWt3HJs1ezp6u7JKkQUBByDENFnzbS5/oLZ2vyuiVDzeQQAQZLmaSDHlaGkBpEHQRIpNGL7m5SCD2tcaTK+7Y9m+EyX7Qrv4uo6ysvqbXse+K1t2Xmc3NgYA0IY3+1Exowe+L6xIG4gSsKURgqN5/KovlQDQ0tKiTnqBVlYPCGqIhCICgYjAKKXVmQBkzrJvz5941ept/aH1sBGcjdCH39sjxwxPaNPOhpktzzXfuCU1AwBMZ8eZrBWT0FtRgwkaUAW26gKA0trak19RWRkf1R34L2rbHiXC4eB7HYahidr2OokUFWdHTfoM7BFEQT8r7SgV073q+oud/oKCKPelQ11QaEXCIB379W83OmeV5h1bsuhav6sXSsGwMFNBkT063X/45yUTymdWfiQ9xHwBQK2tqc48B1ebMDwoAktENIt02opu2t+6Y6V/orOPX99LfOyATyQmP4IHy2MDkz9eYleeE/iPRxzbkv6+jB+N5unL44da7161dFx31/qiqBNG8qI6v7DIHgPzj9mxyNKZM88acAECkdA7NaCqqqqo10SqwbJcWfz99j07nwegzr+o+lax6F4xhiL5Javbn33i3qGBFoBZW3b87nXtfMLSCqVh+ubnLpnXSCD56J33XNOprasmLIonrz9+tGXJkiVdECEQydDYk7EWgNq9e/cJAE9OmTF3pIh1NhKJv6GpyTDE0cohKAsU9B1GZb1dPr6L4Lpo9zwT+tnDVBghIgIxWwCJuK468MgfIug8sn6Pu2rnxiGXJ+L/JsWcy3AS2minjQ1PRVOTyeFjseRuC6KcEK2NwZkdHar9qacITU1Gn1GsYFkgYbDkToc1a8QuGTl55Ny5BxIiekhvThWMGE1NXBrjl0hZIy+oqSkEQAbGYWYxYWCyWf/m6VXzylOpVAYrVvhTKmrmdD348GJ1vDPUIwphcxgFhKZeccN5EGRbNz3a2URrhs0Tho+GiYRKpVJGRDrY15MAiCY+xmzIiCEhuaTPN3snTpt994SpVfcPCJ7JtGy/kNferempbchnOg6QZI8frVDaOQjXVfF4i3qv4VgsW221oWaLCL3ywu77LMJvNGkfImBCnmj7W8pyblEEsgtisP3MgDzw0H1PfmzBQ19paChynMLKgr4Xm+F5nErV8ummZARAZs2Kj+llvj80vFjC8KC29Hal9N4R+dFU94m+24zI50lpDQKEZcBSWF9QctZP00HmCipbdHHaKZkfhEFxYZT+WDFar9hwxw1HIIIh9r8bAuS6ruoOzaNC9icJElO2vgjK+pJifnP3082HDjz/7BfzHFXNHG4yQbDRtlXFS/t2rm7d0vSqM/XqwhNFZXU+0xhWltNrjUr85Y3gIREB1qyhUyDgKsDjybPnT8r40q5IDEgUKQQiSnE2fCx/TMHyno6sffiFVPfJ5MF1Vdnjuwoq8tLcev6yPb5TVGZLBoDokGxGkM2cF+0et2P9iqNv14B36gAADwBgmE0OLiUEMATEhrVoVZ7pCW+3FaisYj4ppYUUEW1uEWhLXgojxEF6tFgxYgCKiC0AosHIt8PhOGANowPqxT07Xj5/WvVjpOwrc2cUTQpwFH11/+5tW4bzZ9cV5XnE0yqu6ey1Yj8Ks2kwBDo2AgXZNzY+891bupBIahCZ0yEhampqCo6msTYUWqiBHtvWP9m/Z3tyKHMadpzrklrr8fQv/2LlAMc+a0DRwhj+/OlZzqpb6xKZnI6RvJ/S6bTTbRFQMpl03l/Z9laB8Xb71O2twhUfduH6TrROufC/AWI5xQIRYc6sAAAAAElFTkSuQmCC',
  'base64',
)

interface Subscriber {
  write: (chunk: string) => void
}

export interface ServeOptions {
  port?: number
  host?: string
  /** 需要 MCP / skills 时置 false */
  quietStartup?: boolean
}

const subs = new Map<string, Set<Subscriber>>()

/**
 * 当前工作区。桌面端要能切项目，所以它不能是启动时定死的常量——
 * 每次 run 都把它传给 Harness。刷新页面不丢（服务端内存），重启回到默认。
 */
let currentWorkspace = process.env.UH_WORKSPACE || workspaceDir()
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

export async function startServer(opts: ServeOptions = {}): Promise<{ url: string; close: () => void }> {
  const port = opts.port ?? 7878
  const host = opts.host ?? '127.0.0.1'

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${host}:${port}`)

    // 浏览器标签页的图标：不提供就会去要 /favicon.ico，然后拿到 404
    if (req.method === 'GET' && (url.pathname === '/favicon.ico' || url.pathname === '/favicon.png')) {
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' })
      res.end(FAVICON_PNG)
      return
    }

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(UI)
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
      })
      return
    }

    if (req.method === 'GET' && url.pathname === '/api/sessions') {
      const ws = url.searchParams.get('workspace') ?? undefined
      json(res, 200, collectSessions(ws))
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
          id: name,
          name,
          // stdio 说命令，http 说地址——"它到底是什么"要在列表里看得见
          command: cfg.command ? [cfg.command, ...(cfg.args ?? [])].join(' ') : '',
          url: cfg.url ?? '',
          transport: cfg.url ? 'http' : 'stdio',
          enabled: !disabled.has('mcp:' + name),
        })),
        skills: skills.map((s) => ({
          id: s.name,
          name: s.name,
          description: s.description ?? '',
          allowedTools: s.allowedTools ?? [],
          scripts: (s.scripts ?? []).map((x) => x.rel),
          scope: s.root ?? '',
          enabled: !disabled.has('skill:' + s.name),
        })),
        hooks: Object.keys(hooks).map((k) => ({ id: 'hook:' + k, name: k, enabled: !disabled.has('hook:' + k) })),
        sources: mcp.sources,
        counts: { mcp: Object.keys(mcp.servers).length, skills: skills.length, hooks: Object.keys(hooks).length },
      })
      return
    }

    // 开关：启停是持久化的，不是这一次会话的临时状态
    if (req.method === 'POST' && url.pathname === '/api/plugins/toggle') {
      const body = JSON.parse(await readBody(req) || '{}') as { id?: string; enabled?: boolean }
      if (!body.id) { json(res, 400, { error: 'id required' }); return }
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
      const list = [...seen.values()].sort((a, b) => (a.lastUsed < b.lastUsed ? 1 : -1))
      if (!seen.has(currentWorkspace)) {
        list.unshift({ path: currentWorkspace, sessions: 0, lastUsed: new Date().toISOString() })
      }

      // 每个项目挂自己的会话：左栏要画「项目 → 会话」两级，一个请求拿全
      const names = readProjectNames()
      const withItems = list.map((p) => ({
        ...p,
        name: names[p.path] || '',
        items: collectSessions(p.path).slice(0, 30).map((s) => ({
          id: s.id, label: s.label, created: s.created, events: s.events,
          // 左栏要画「这个还在跑」。事件数是静态的，跑着的会话和跑完的长得一样
          running: running.has(s.id),
        })),
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
      json(res, 200, { current: currentWorkspace, name: readProjectNames()[abs] || '' })
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
      const task = (body.task ?? '').trim()
      if (!task) { json(res, 400, { error: 'task is empty' }); return }

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
        // 标签只在开新会话时有用；续跑时改它会把这个对话在左栏改名成最后一句
        ...(contId ? { resumeSessionId: contId } : { label: task.slice(0, 60) }),
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
        try {
          const out = await h.runTask({
            task: attachedBlock + task,
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
          broadcast(sid, 'done', { steps: out.steps, tokens: out.usage.total, compactions: out.compactions })
        } catch (err) {
          broadcast(sid, 'error', { message: err instanceof Error ? err.message : String(err) })
          broadcast(sid, 'done', {})
        } finally {
          usageCache = null  // 这次 run 产生了新 token，旧的汇总立刻作废
          running.delete(sid)
          h.dispose()
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
      h.steer(text)
      json(res, 200, { ok: true, queued: true })
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
      // `live=1` 是「我正在从磁盘回放这条会话，只要新的」——没有它，打开一条
      // 刚跑完的会话会把最后一轮再放一遍，屏幕上出现两份。
      if (url.searchParams.get('live') !== '1') {
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
        json(res, 200, { id, events, artifacts, verifications, answer })
      } catch (err) {
        json(res, 404, { error: err instanceof Error ? err.message : 'session not found' })
      }
      return
    }

    json(res, 404, { error: 'not found' })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => resolve())
  })

  return {
    url: `http://${host}:${port}`,
    close: () => server.close(),
  }
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
