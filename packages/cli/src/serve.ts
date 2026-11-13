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
import { spawn } from 'node:child_process'
import {
  Harness, EventStore, resolveProvider,
  PROVIDERS, findProvider, maskKey, readConfig, writeConfig, setProviderEntry, workspaceDir,
} from '@unit-harness/core'
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

function broadcast(sessionId: string, kind: string, payload: Record<string, unknown>): void {
  const set = subs.get(sessionId)
  if (!set) return
  const frame = `event: ${kind}\ndata: ${JSON.stringify(payload)}\n\n`
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

function collectSessions(): Array<{ id: string; label: string; created: string; events: number; status: string }> {
  const store = new EventStore()
  try {
    return store.list().slice(0, 50).map((s) => ({
      id: s.id,
      label: s.label ?? '(untitled)',
      created: s.created_at.replace('T', ' ').slice(0, 19),
      events: s.last_seq,
      status: s.status,
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
      json(res, 200, { isolation, model, workspace: currentWorkspace })
      return
    }

    if (req.method === 'GET' && url.pathname === '/api/sessions') {
      json(res, 200, collectSessions())
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
      json(res, 200, { current: currentWorkspace, projects: list })
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/project') {
      let body: { path?: string } = {}
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
      json(res, 200, { current: currentWorkspace })
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/run') {
      let body: { task?: string; maxSteps?: number } = {}
      try { body = JSON.parse(await readBody(req)) as typeof body } catch { /* ignore */ }
      const task = (body.task ?? '').trim()
      if (!task) { json(res, 400, { error: 'task is empty' }); return }

      let sid = ''
      const h = new Harness({
        record: true,
        label: task.slice(0, 60),
        workspace: currentWorkspace,
        // session 在 start() 里创建，所以这里先缓冲，拿到 id 后再推送
        onEvent: (kind, payload) => { if (sid) broadcast(sid, kind, payload) },
      })
      await h.start()          // ← 少这一句就拿不到 sessionId
      sid = h.sessionId ?? ''

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
          h.dispose()
        }
      })()
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
