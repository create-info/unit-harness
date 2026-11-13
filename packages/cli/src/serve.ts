/**
 * 本地 Web UI（`uh serve`）。
 *
 * 形态参考 DeepSeek Harness 的 apps/web + host/webserver：一个本机 HTTP 服务，
 * 前端是纯静态页面，事件走 SSE 实时推送。这样"桌面端"不需要 Electron，
 * 一个二进制的体积和启动速度都和 CLI 一样。
 */
import http from 'node:http'
import os from 'node:os'
import pathMod from 'node:path'
import { mkdirSync } from 'node:fs'
import fs6 from 'node:fs'
import { spawn } from 'node:child_process'
import {
  EventStore, Harness, PROVIDERS, findProvider, hydrateEdits, maskKey,
  readConfig, resolveProvider, setProviderEntry, uhHome, workspaceDir, writeConfig,
} from '@unit-harness/core'
import type { ApprovalGate, ApprovalRequest } from '@unit-harness/core'
import UI from './ui.html'

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
  return { allowHome: sp.allowHome === true, denyNetwork: sp.denyNetwork === true, unconfined: sp.unconfined === true }
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
const pendingApprovals = new Map<string, (d: 'allow' | 'deny') => void>()

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
      }
      pendingInfo.set(id, { sid: sidRef.id, payload })
      broadcast(sidRef.id, 'approval/needs', payload)
      const decision = await new Promise<'allow' | 'deny'>((resolve) => {
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

function broadcast(sessionId: string, kind: string, payload: Record<string, unknown>): void {
  // 盖上发送时刻：前端算「+2.3s」要用事件自己的时间，不然补发的那一批全显示成 +0.0s
  const stamped = { ...payload, _ts: Date.now() }
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
        created: s.created_at.replace('T', ' ').slice(0, 19),
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
      let body: { task?: string; maxSteps?: number } = {}
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

      let sid = ''
      const sidRef = { id: '' }
      // session/start、turn/start、第一轮思考都发生在 start() 之前，那时还没有 id。
      // 先攒着，拿到 id 再倒进缓冲——否则前几百毫秒发生的事对网页来说不存在
      const earlyEvents: Array<{ kind: string; payload: Record<string, unknown> }> = []
      const h = new Harness({
        record: true,
        label: task.slice(0, 60),
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
      sid = h.sessionId ?? ''
      sidRef.id = sid
      // 把拿 id 之前攒下的事件按原顺序补进缓冲，前端一接上就能看到完整过程
      for (const ev of earlyEvents) bufferEvent(sid, ev.kind, ev.payload)
      running.set(sid, h)

      // 立刻把 sessionId 交给前端，任务在后台跑
      json(res, 200, { sessionId: sid })

      void (async () => {
        try {
          const out = await h.runTask({ task, ...(body.maxSteps ? { maxSteps: body.maxSteps } : {}) })
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
          running.delete(sid)
          h.dispose()
        }
      })()
      return
    }

    // 人在网页上点了「允许/拒绝」
    if (req.method === 'POST' && url.pathname === '/api/approve') {
      let body: { id?: string; approved?: boolean } = {}
      try { body = JSON.parse(await readBody(req)) as typeof body } catch { /* empty */ }
      const fn = body.id ? pendingApprovals.get(body.id) : undefined
      if (!fn) { json(res, 404, { error: 'no such approval request' }); return }
      pendingApprovals.delete(body.id as string)
      pendingInfo.delete(body.id as string)
      fn(body.approved === true ? 'allow' : 'deny')
      json(res, 200, { ok: true, decision: body.approved === true ? 'allow' : 'deny' })
      return
    }

    // 停止：跑飞了要能按停，而不是等它把步数烧完
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
      // 第一轮思考和工具调用会永远丢掉
      for (const ev of evBuf.get(sessionId) ?? []) {
        res.write(`event: ${ev.kind}\ndata: ${JSON.stringify(ev.payload)}\n\n`)
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

      req.on('close', () => {
        clearInterval(keepAlive)
        subs.get(sessionId)?.delete(sub)
        if (subs.get(sessionId)?.size === 0) subs.delete(sessionId)
      })
      return
    }

    if (req.method === 'GET' && url.pathname.startsWith('/api/session/')) {
      const id = decodeURIComponent(url.pathname.slice('/api/session/'.length))
      try {
        const store = new EventStore()
        const events = store.read(id)
        const answer = [...events].reverse().find((e) => e.kind === 'assistant/message' || e.kind === 'turn/end')
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
        json(res, 200, { id, events, artifacts, verifications, answer: answer?.payload ?? null })
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
