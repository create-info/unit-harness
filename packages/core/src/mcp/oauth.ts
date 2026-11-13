/**
 * MCP 的 OAuth（远程 MCP server 用 401 要求授权时）。
 *
 * 流程是标准的三段发现 + PKCE：
 *
 *   401 + WWW-Authenticate: Bearer resource_metadata="https://mcp.example/.well-known/oauth-protected-resource"
 *     → GET 那个地址，拿到 authorization_servers[]
 *     → GET 授权服务器的 /.well-known/oauth-authorization-server（RFC 8414）
 *     → 动态注册客户端（RFC 7591）拿 client_id
 *     → PKCE 授权码流程，本地起一个回调服务器收 code
 *     → 换 token，0600 存起来，过期前刷新
 *
 * Codex 把这一段交给 `rmcp` 的 `AuthorizationManager`；我们没有那个库，
 * 所以自己写。写的时候照抄了它两个安全决定：
 *
 *   **一、授权服务器混淆（authorization-server mix-up，RFC 9700 §4.4）。**
 *   一个人会连很多 MCP server。如果它们共用同一个回调 URL，而授权响应里
 *   不说明它来自哪一台，那条 code 就可能被交给另一台的 token 端点——
 *   等于把钥匙递给了别人。防御有两个，优先用第一个：
 *
 *     - **IssuerBound**：授权服务器在响应里带 `iss`，且它的 metadata 声明
 *       `authorization_response_iss_parameter_supported`。我们就校验 `iss`
 *       和发现阶段的 issuer 一致，不一致直接拒绝。
 *     - **CallbackSpecific**：服务器不支持 `iss` 时，每个 server 用**不同的
 *       回调路径**（路径里带 server URL 的摘要）。这样一条响应只会落到
 *       它该去的那条路径上。
 *
 *   **二、`state` 必须校验且一次性。** 回调里 state 对不上就是拒绝，
 *   不"先接受再说"。
 */
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { uhHome } from '../paths.ts'

export interface BearerChallenge {
  /** RFC 9728：指向 protected resource metadata 的 URL */
  resourceMetadata?: string
  /** 需要的权限范围，空格分隔 */
  scope?: string
  /** 授权服务器要求的错误类型，例如 insufficient_scope */
  error?: string
}

/**
 * 从一个（或多个）`WWW-Authenticate` 头的值里挑出 Bearer 挑战。
 *
 * 头部语法是 RFC 7235 的 auth-param 列表，不是 JSON：值可以是 token 或
 * quoted-string，quoted-string 里的 `\"` 要还原。逗号既可能分隔两个挑战、
 * 也可能出现在引号里，所以必须先按「引号外」切。
 */
export function parseBearerChallenge(headers: string[]): BearerChallenge | null {
  for (const raw of headers) {
    const challenge = parseOne(raw)
    if (challenge) return challenge
  }
  return null
}

function parseOne(raw: string): BearerChallenge | null {
  const segments = splitUnquoted(raw)
  if (!segments) return null

  let current: BearerChallenge | null = null
  for (const seg of segments) {
    const trimmed = seg.trim()
    if (!trimmed) continue

    const eq = trimmed.indexOf('=')
    const isParam = eq > 0 && !/\s/.test(trimmed.slice(0, eq).trim())

    if (isParam && current) {
      const name = trimmed.slice(0, eq).trim().toLowerCase()
      const value = parseValue(trimmed.slice(eq + 1).trim())
      if (value === null) continue
      if (name === 'resource_metadata' || name === 'resource_metadata_uri') current.resourceMetadata = value
      else if (name === 'scope') current.scope = value
      else if (name === 'error') current.error = value
      continue
    }

    // 不是参数 → 这是个新挑战的开头，例如 `Bearer` 或 `Basic realm="x"`
    const space = trimmed.search(/\s/)
    const scheme = (space < 0 ? trimmed : trimmed.slice(0, space)).toLowerCase()
    // 同一个头里可以有多条挑战：`Bearer resource_metadata="…", Basic realm="…"`。
    // 遇到下一条时，上一条已经解析完的部分不能丢——先把 Bearer 结算掉。
    if (scheme !== 'bearer' && current) return current
    if (scheme === 'bearer') {
      current = {}
      if (space > 0) {
        const first = trimmed.slice(space).trim()
        const e2 = first.indexOf('=')
        if (e2 > 0) {
          const name = first.slice(0, e2).trim().toLowerCase()
          const value = parseValue(first.slice(e2 + 1).trim())
          if (value !== null) {
            if (name === 'resource_metadata') current.resourceMetadata = value
            else if (name === 'scope') current.scope = value
            else if (name === 'error') current.error = value
          }
        }
      }
    } else {
      // 别的 scheme（Basic、Digest…）：丢掉当前挑战，继续往后找 Bearer
      current = null
    }
  }
  if (!current) return null
  // 一个光秃秃的 `Bearer` 也算挑战（有 401 但没给 metadata 地址）
  return current
}

/** 按「引号外」的逗号切分，并处理 `\"` 转义 */
function splitUnquoted(s: string): string[] | null {
  const out: string[] = []
  let start = 0
  let inQuotes = false
  let escaped = false
  for (let i = 0; i < s.length; i++) {
    const ch = s[i] as string
    if (escaped) { escaped = false; continue }
    if (ch === '\\' && inQuotes) { escaped = true; continue }
    if (ch === '"') { inQuotes = !inQuotes; continue }
    if (ch === ',' && !inQuotes) {
      out.push(s.slice(start, i))
      start = i + 1
    }
  }
  // 引号没闭合 = 头部坏了，宁可当没有挑战也不要猜
  if (inQuotes || escaped) return null
  out.push(s.slice(start))
  return out
}

function parseValue(v: string): string | null {
  if (v.startsWith('"')) {
    if (!v.endsWith('"') || v.length < 2) return null
    // 去掉外层引号，还原 quoted-pair
    return v.slice(1, -1).replace(/\\(.)/g, '$1')
  }
  if (!v) return null
  return v
}

// ─────────────────────── 发现 ───────────────────────

export interface ProtectedResourceMeta {
  resource?: string
  authorization_servers: string[]
  scopes_supported?: string[]
}

export interface AuthorizationServerMeta {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  registration_endpoint?: string
  code_challenge_methods_supported?: string[]
  /** RFC 9207：响应里会带 iss，且这个字段声明它支持 */
  authorization_response_iss_parameter_supported?: boolean
  scopes_supported?: string[]
  grant_types_supported?: string[]
}

export interface Discovery {
  /** 从 401 拿到，或按约定构造 */
  protectedResource?: ProtectedResourceMeta
  /** 第一个授权服务器 */
  authServer: AuthorizationServerMeta
  /** 要不要校验回调里的 iss */
  issuerBound: boolean
}

type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal; method?: string; body?: string },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown>; text?: () => Promise<string> }>

const DISCOVERY_TIMEOUT_MS = 5000

function withTimeout(): { signal: AbortSignal; done: () => void } {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), DISCOVERY_TIMEOUT_MS)
  return { signal: ctl.signal, done: () => clearTimeout(timer) }
}

/**
 * 三段发现。
 *
 * 每一段都可能被服务端省略（很多实现只做了标准的一半），所以每一段都有
 * 从「当前地址」推导默认值的兜底，而不是遇到缺失就失败——但也只在能推导时
 * 才兜底，推不出来就如实报错，不猜。
 */
export async function discover(
  serverUrl: string,
  challenge: BearerChallenge | null,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<Discovery> {
  const origin = new URL(serverUrl)

  // ① protected resource metadata
  let protectedResource: ProtectedResourceMeta | undefined
  const prmUrl = challenge?.resourceMetadata
    ?? `${origin.protocol}//${origin.host}/.well-known/oauth-protected-resource`
  try {
    const { signal, done } = withTimeout()
    const res = await fetchImpl(prmUrl, { signal })
    done()
    if (res.ok) {
      const j = (await res.json()) as Partial<ProtectedResourceMeta>
      if (Array.isArray(j.authorization_servers) && j.authorization_servers.length) {
        protectedResource = {
          authorization_servers: j.authorization_servers,
          ...(j.resource ? { resource: j.resource } : {}),
          ...(j.scopes_supported ? { scopes_supported: j.scopes_supported } : {}),
        }
      }
    }
  } catch { /* 没有就往下走 */ }

  // ② 授权服务器地址：优先用 ① 给的，没有就把 resource 自己当授权服务器（单机 MCP 常见）
  const issuerUrl = protectedResource?.authorization_servers[0] ?? `${origin.protocol}//${origin.host}`
  const issuerOrigin = new URL(issuerUrl)

  // ③ RFC 8414 metadata，两个路径都试（规范要求 A，有些实现只做 B）
  const candidates = [
    `${issuerOrigin.protocol}//${issuerOrigin.host}/.well-known/oauth-authorization-server${issuerOrigin.pathname.replace(/\/$/, '')}`,
    `${issuerOrigin.protocol}//${issuerOrigin.host}${issuerOrigin.pathname.replace(/\/$/, '')}/.well-known/openid-configuration`,
  ]
  let authServer: AuthorizationServerMeta | null = null
  for (const url of candidates) {
    try {
      const { signal, done } = withTimeout()
      const res = await fetchImpl(url, { signal })
      done()
      if (!res.ok) continue
      const j = (await res.json()) as Partial<AuthorizationServerMeta>
      if (!j.authorization_endpoint || !j.token_endpoint) continue
      authServer = {
        issuer: j.issuer ?? issuerUrl,
        authorization_endpoint: j.authorization_endpoint,
        token_endpoint: j.token_endpoint,
        ...(j.registration_endpoint ? { registration_endpoint: j.registration_endpoint } : {}),
        ...(j.code_challenge_methods_supported ? { code_challenge_methods_supported: j.code_challenge_methods_supported } : {}),
        ...(j.authorization_response_iss_parameter_supported !== undefined
          ? { authorization_response_iss_parameter_supported: j.authorization_response_iss_parameter_supported }
          : {}),
        ...(j.scopes_supported ? { scopes_supported: j.scopes_supported } : {}),
        ...(j.grant_types_supported ? { grant_types_supported: j.grant_types_supported } : {}),
      }
      break
    } catch { /* 试下一个 */ }
  }
  if (!authServer) {
    throw new Error(
      `E_MCP_OAUTH: ${issuerUrl} 没有公布 authorization server metadata` +
      `（试过 ${candidates.join(' 和 ')}）`,
    )
  }

  // 只认 S256：plain 在公开客户端上等于没有 PKCE
  const methods = authServer.code_challenge_methods_supported
  if (methods && methods.length && !methods.includes('S256')) {
    throw new Error(`E_MCP_OAUTH: 授权服务器只支持 ${methods.join(',')}，我们只接受 S256`)
  }

  return {
    ...(protectedResource ? { protectedResource } : {}),
    authServer,
    issuerBound: authServer.authorization_response_iss_parameter_supported === true,
  }
}

// ─────────────────────── PKCE ───────────────────────

export interface Pkce {
  verifier: string
  challenge: string
}

export function makePkce(): Pkce {
  // 43~128 字符，RFC 7636 允许 43 个 base64url 字符；32 字节随机刚好
  const verifier = crypto.randomBytes(32).toString('base64url')
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

/**
 * 回调路径按 server URL 派生。
 *
 * 这是 mix-up 防御的 fallback：不同 server 用不同回调路径，一条授权响应
 * 只会落到它该去的那条路径上。用摘要而不是完整 URL，是因为路径里不能出现
 * 斜杠和查询串。
 */
export function callbackPath(serverUrl: string): string {
  const digest = crypto.createHash('sha256').update(serverUrl).digest('hex').slice(0, 16)
  return `/oauth/callback/${digest}`
}

/** state 是 CSRF 防御；用 CSPRNG，不要 Math.random */
export function makeState(): string {
  return crypto.randomBytes(16).toString('base64url')
}

// ─────────────────────── 动态注册 ───────────────────────

export interface ClientRegistration {
  client_id: string
  client_secret?: string
  redirect_uris?: string[]
}

export async function registerClient(
  meta: AuthorizationServerMeta,
  redirectUri: string,
  clientName: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<ClientRegistration> {
  if (!meta.registration_endpoint) {
    // 没有注册端点就必须让用户手动填 client_id；不假装能自己搞定
    throw new Error(
      `E_MCP_OAUTH: ${meta.issuer} 不提供动态注册端点（RFC 7591），` +
      `需要在配置里手动填 clientId`,
    )
  }
  const { signal, done } = withTimeout()
  const res = await fetchImpl(meta.registration_endpoint, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',   // 公开客户端，靠 PKCE
    }),
  })
  done()
  if (!res.ok) throw new Error(`E_MCP_OAUTH: 动态注册失败 ${res.status}`)
  const j = (await res.json()) as Partial<ClientRegistration>
  if (!j.client_id) throw new Error('E_MCP_OAUTH: 注册响应里没有 client_id')
  return {
    client_id: j.client_id,
    ...(j.client_secret ? { client_secret: j.client_secret } : {}),
    ...(j.redirect_uris ? { redirect_uris: j.redirect_uris } : {}),
  }
}

// ─────────────────────── 组装授权 URL ───────────────────────

export function buildAuthorizeUrl(opts: {
  meta: AuthorizationServerMeta
  clientId: string
  redirectUri: string
  pkce: Pkce
  state: string
  scope?: string
  resource?: string
}): string {
  const u = new URL(opts.meta.authorization_endpoint)
  u.searchParams.set('response_type', 'code')
  u.searchParams.set('client_id', opts.clientId)
  u.searchParams.set('redirect_uri', opts.redirectUri)
  u.searchParams.set('code_challenge', opts.pkce.challenge)
  u.searchParams.set('code_challenge_method', 'S256')
  u.searchParams.set('state', opts.state)
  if (opts.scope) u.searchParams.set('scope', opts.scope)
  // RFC 8707：告诉授权服务器这个 token 是给谁用的，防止拿 A 的 token 打 B
  if (opts.resource) u.searchParams.set('resource', opts.resource)
  return u.toString()
}

// ─────────────────────── token 存储 ───────────────────────

export interface StoredToken {
  /** 哪个 server 的 token，作为索引 */
  serverUrl: string
  accessToken: string
  refreshToken?: string
  /** 绝对时间戳（毫秒）。没有就是不知道什么时候过期 */
  expiresAt?: number
  scope?: string
  tokenType: string
  /** 签发者。下次用之前要对一下，防止旧配置指向了别的服务器 */
  issuer: string
}

interface TokenFile {
  tokens: Record<string, StoredToken>
}

function tokenPath(): string {
  return path.join(uhHome(), 'mcp-oauth.json')
}

function readTokens(): Record<string, StoredToken> {
  try {
    const parsed = JSON.parse(fs.readFileSync(tokenPath(), 'utf8')) as TokenFile
    return parsed.tokens ?? {}
  } catch {
    return {}
  }
}

function writeTokens(tokens: Record<string, StoredToken>): void {
  const dir = uhHome()
  fs.mkdirSync(dir, { recursive: true })
  const p = tokenPath()
  fs.writeFileSync(p, JSON.stringify({ tokens } satisfies TokenFile, null, 2) + '\n', { mode: 0o600 })
  try { fs.chmodSync(p, 0o600) } catch { /* 不支持的平台 */ }
}

export function loadToken(serverUrl: string): StoredToken | null {
  return readTokens()[serverUrl] ?? null
}

export function saveToken(t: StoredToken): void {
  const all = readTokens()
  all[t.serverUrl] = t
  writeTokens(all)
}

export function forgetToken(serverUrl: string): void {
  const all = readTokens()
  delete all[serverUrl]
  writeTokens(all)
}

/** 提前 60 秒当过期，避免"还差 3 秒"那种边缘失败 */
export function isExpired(t: StoredToken, skewMs = 60_000): boolean {
  if (!t.expiresAt) return false          // 没给过期时间就当不过期
  return Date.now() >= t.expiresAt - skewMs
}

// ─────────────────────── 回调服务器 ───────────────────────

export interface CallbackResult {
  code: string
  state: string
  /** RFC 9207 的 iss；服务器支持时必须有 */
  iss?: string
}

/**
 * 起一个只监听 127.0.0.1 的回调服务器。
 *
 * 返回时要**先拿到 redirectUri**——调用方得拿它去拼授权 URL，然后才等人回来。
 * 所以这里分成两步：`start()` 返回地址，`waitForCode()` 才开始等。
 * 一开始我把它写成「一个 Promise 同时返回 code 和 redirectUri」，那样调用方
 * 永远拿不到地址，流程从一开始就走不通。
 *
 * 几条必须：
 *   - 只 bind 环回地址，不要 0.0.0.0——那会打开整个局域网
 *   - 校验 `state`（CSRF）
 *   - 声明支持 `iss` 的服务器，回调必须带 `iss` 且与发现的一致（mix-up）
 *   - 无论成功失败都要关掉，否则端口一直占着
 */
export interface CallbackServer {
  redirectUri: string
  /** 等授权服务器把 code 送回来 */
  waitForCode: () => Promise<CallbackResult>
  close: () => void
}

export async function startCallbackServer(opts: {
  callbackPathname: string
  expectedState: string
  /** 给了就必须校验回调里的 iss */
  expectedIssuer?: string
  timeoutMs?: number
}): Promise<CallbackServer> {
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000

  let settle: ((r: CallbackResult) => void) | null = null
  let fail: ((e: Error) => void) | null = null
  const pending = new Promise<CallbackResult>((resolve, reject) => { settle = resolve; fail = reject })

  let done = false
  let timer: NodeJS.Timeout | null = null

  const page = (title: string, detail: string) => `<!doctype html><meta charset="utf-8">
<title>${title}</title>
<body style="font:15px/1.6 -apple-system,system-ui,sans-serif;max-width:520px;margin:80px auto;padding:0 20px">
<h2 style="font-size:17px">${title}</h2><p style="color:#666">${detail}</p></body>`

  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (u.pathname !== opts.callbackPathname) { res.writeHead(404).end('not found'); return }

    const send = (status: number, title: string, detail: string) => {
      try {
        res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' })
        res.end(page(title, detail))
      } catch { /* 客户端可能已经走了 */ }
    }

    const err = u.searchParams.get('error')
    const code = u.searchParams.get('code')
    const state = u.searchParams.get('state') ?? ''
    const iss = u.searchParams.get('iss') ?? undefined

    if (err) {
      send(400, 'Authorization failed', `The server said: ${err}`)
      if (!done) { done = true; fail?.(new Error(`E_MCP_OAUTH: 授权被拒（${err}）`)) }
      return
    }
    if (!code) {
      send(400, 'Authorization failed', 'No code came back.')
      if (!done) { done = true; fail?.(new Error('E_MCP_OAUTH: 回调里没有 code')) }
      return
    }
    if (!timingSafeEqual(state, opts.expectedState)) {
      send(400, 'Authorization failed', 'The response did not match this request.')
      if (!done) { done = true; fail?.(new Error('E_MCP_OAUTH: state 不匹配，拒绝')) }
      return
    }
    if (opts.expectedIssuer !== undefined) {
      if (!iss) {
        send(400, 'Authorization failed', 'The server promised an issuer but sent none.')
        if (!done) { done = true; fail?.(new Error('E_MCP_OAUTH: 缺少 iss（服务器声明支持 iss 参数）')) }
        return
      }
      if (iss !== opts.expectedIssuer) {
        send(400, 'Authorization failed', 'The response came from a different authorization server.')
        if (!done) { done = true; fail?.(new Error(`E_MCP_OAUTH: iss 不匹配（期望 ${opts.expectedIssuer}，收到 ${iss}）`)) }
        return
      }
    }

    send(200, 'Connected', 'You can close this tab and go back to the terminal.')
    if (!done) { done = true; settle?.({ code, state, ...(iss ? { iss } : {}) }) }
  })

  const close = () => {
    if (timer) { clearTimeout(timer); timer = null }
    try { server.close() } catch { /* 已关 */ }
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })

  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  const redirectUri = `http://127.0.0.1:${port}${opts.callbackPathname}`

  timer = setTimeout(() => {
    if (done) return
    done = true
    close()
    fail?.(new Error(`E_MCP_OAUTH: 等了 ${Math.round(timeoutMs / 1000)} 秒没有收到授权回调`))
  }, timeoutMs)
  timer.unref?.()

  return {
    redirectUri,
    waitForCode: () => pending,
    close,
  }
}

/** 长度一致时逐个字节比完，不因为前面不一样就提前返回 */
function timingSafeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return crypto.timingSafeEqual(ab, bb)
}

// ─────────────────────── 换 token ───────────────────────

interface TokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  scope?: string
  token_type?: string
  error?: string
  error_description?: string
}

async function postForm(
  url: string,
  form: Record<string, string>,
  fetchImpl: FetchLike,
): Promise<TokenResponse> {
  const { signal, done } = withTimeout()
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(form).toString(),
    })
    const j = (await res.json()) as TokenResponse
    if (!res.ok || j.error) {
      throw new Error(`E_MCP_OAUTH: token 端点拒绝了（${j.error ?? res.status}${j.error_description ? ': ' + j.error_description : ''}）`)
    }
    return j
  } finally {
    done()
  }
}

export async function exchangeCode(opts: {
  meta: AuthorizationServerMeta
  clientId: string
  clientSecret?: string
  code: string
  redirectUri: string
  codeVerifier: string
  resource?: string
  serverUrl: string
  fetchImpl?: FetchLike
}): Promise<StoredToken> {
  const fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchLike)
  const form: Record<string, string> = {
    grant_type: 'authorization_code',
    code: opts.code,
    redirect_uri: opts.redirectUri,
    client_id: opts.clientId,
    code_verifier: opts.codeVerifier,
  }
  if (opts.clientSecret) form.client_secret = opts.clientSecret
  if (opts.resource) form.resource = opts.resource

  const t = await postForm(opts.meta.token_endpoint, form, fetchImpl)
  if (!t.access_token) throw new Error('E_MCP_OAUTH: token 响应里没有 access_token')

  return {
    serverUrl: opts.serverUrl,
    accessToken: t.access_token,
    ...(t.refresh_token ? { refreshToken: t.refresh_token } : {}),
    ...(t.expires_in ? { expiresAt: Date.now() + t.expires_in * 1000 } : {}),
    ...(t.scope ? { scope: t.scope } : {}),
    tokenType: t.token_type ?? 'Bearer',
    issuer: opts.meta.issuer,
  }
}

/**
 * 用 refresh_token 换新的。
 *
 * 服务端可能轮换 refresh_token（返回新的），也可能不返回；不返回时保留原来那个，
 * 否则第二次刷新就会因为没有 refresh_token 而失败。
 */
export async function refreshToken(opts: {
  meta: AuthorizationServerMeta
  current: StoredToken
  clientId: string
  clientSecret?: string
  resource?: string
  fetchImpl?: FetchLike
}): Promise<StoredToken> {
  if (!opts.current.refreshToken) {
    throw new Error('E_MCP_OAUTH: 这个 token 没有 refresh_token，只能重新授权')
  }
  const fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchLike)
  const form: Record<string, string> = {
    grant_type: 'refresh_token',
    refresh_token: opts.current.refreshToken,
    client_id: opts.clientId,
  }
  if (opts.clientSecret) form.client_secret = opts.clientSecret
  if (opts.resource) form.resource = opts.resource

  const t = await postForm(opts.meta.token_endpoint, form, fetchImpl)
  if (!t.access_token) throw new Error('E_MCP_OAUTH: 刷新响应里没有 access_token')

  return {
    ...opts.current,
    accessToken: t.access_token,
    // 轮换了就用新的，没给就留住旧的
    ...(t.refresh_token ? { refreshToken: t.refresh_token } : {}),
    ...(t.expires_in ? { expiresAt: Date.now() + t.expires_in * 1000 } : {}),
    ...(t.scope ? { scope: t.scope } : {}),
  }
}

// ─────────────────────── 完整流程 ───────────────────────

export interface AuthorizeOptions {
  /** MCP server 的 URL */
  serverUrl: string
  /** 401 里拿到的挑战；没有也能走（会用约定路径去发现） */
  challenge?: BearerChallenge | null
  /** 本地打开的地址交给谁：默认用 xdg-open / open */
  openUrl?: (url: string) => void
  /** 告诉用户「现在需要你去浏览器里点一下」 */
  notify?: (message: string, url: string) => void
  fetchImpl?: FetchLike
  /** 已经注册过的 client_id，有就不重新注册 */
  clientId?: string
  clientSecret?: string
}

export interface AuthorizeResult {
  token: StoredToken
  discovery: Discovery
}

/**
 * 走完一次授权。
 *
 * 调用方通常只需要在 MCP server 回 401 时调用它，然后拿返回的 token 重试。
 * 中间每一步失败都抛 E_MCP_OAUTH 开头的中文说明——用户看到的是「哪一步、
 * 哪个地址出的问题」，不是一串 stack。
 */
export async function authorize(opts: AuthorizeOptions): Promise<AuthorizeResult> {
  const fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchLike)
  const notify = opts.notify ?? (() => { /* 无界面时可忽略 */ })
  const openUrl = opts.openUrl ?? defaultOpen

  const discovery = await discover(opts.serverUrl, opts.challenge ?? null, fetchImpl)
  const meta = discovery.authServer

  // 每个 server 一条独立回调路径：服务器不支持 iss 时，这就是 mix-up 的防线
  const pathname = callbackPath(opts.serverUrl)
  const state = makeState()
  const pkce = makePkce()
  const scope = opts.challenge?.scope ?? discovery.protectedResource?.scopes_supported?.join(' ')

  const cb = await startCallbackServer({
    callbackPathname: pathname,
    expectedState: state,
    // 只有服务器**明确声明**会带 iss 时才强制校验；
    // 它没说支持却要求它带，会把正常的服务器全拒掉
    ...(discovery.issuerBound ? { expectedIssuer: meta.issuer } : {}),
  })

  try {
    let clientId = opts.clientId
    let clientSecret = opts.clientSecret
    if (!clientId) {
      const reg = await registerClient(meta, cb.redirectUri, 'Unit Harness', fetchImpl)
      clientId = reg.client_id
      clientSecret = reg.client_secret
    }

    const url = buildAuthorizeUrl({
      meta,
      clientId,
      redirectUri: cb.redirectUri,
      pkce,
      state,
      ...(scope ? { scope } : {}),
      resource: opts.serverUrl,
    })

    notify(`要在浏览器里批准这个 MCP server（${new URL(opts.serverUrl).host}）`, url)
    openUrl(url)

    const result = await cb.waitForCode()

    const token = await exchangeCode({
      meta,
      clientId,
      ...(clientSecret ? { clientSecret } : {}),
      code: result.code,
      redirectUri: cb.redirectUri,
      codeVerifier: pkce.verifier,
      resource: opts.serverUrl,
      serverUrl: opts.serverUrl,
      fetchImpl,
    })
    saveToken(token)
    return { token, discovery }
  } finally {
    cb.close()
  }
}

/** 尽力而为地打开浏览器；打不开就把地址留在终端里 */
function defaultOpen(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start'
    : 'xdg-open'
  try {
    const child = spawn(cmd, [url], { detached: true, stdio: 'ignore', shell: process.platform === 'win32' })
    child.unref()
  } catch { /* 没有图形界面时忽略，地址已经通过 notify 给出来了 */ }
}

/**
 * 拿一个能用的 token：没过期就复用，过期了就刷新，刷新失败再走完整授权。
 * 这是 MCP client 真正要调的那个。
 */
export async function ensureToken(opts: AuthorizeOptions & {
  meta?: AuthorizationServerMeta
}): Promise<StoredToken> {
  const existing = loadToken(opts.serverUrl)
  if (existing && !isExpired(existing)) return existing

  // 有 refresh_token 就先试刷新：比让人再点一遍浏览器好得多
  if (existing?.refreshToken) {
    try {
      const discovery = opts.meta
        ? null
        : await discover(opts.serverUrl, opts.challenge ?? null, opts.fetchImpl)
      const meta = opts.meta ?? discovery!.authServer
      if (!opts.clientId) {
        throw new Error('E_MCP_OAUTH: 刷新需要 client_id，但配置里没有')
      }
      const refreshed = await refreshToken({
        meta,
        current: existing,
        clientId: opts.clientId,
        ...(opts.clientSecret ? { clientSecret: opts.clientSecret } : {}),
        resource: opts.serverUrl,
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      })
      saveToken(refreshed)
      return refreshed
    } catch {
      // 刷新失败不在这里报错：可能只是 refresh_token 过期了，那就重走授权
      // 但要把旧 token 清掉，不然下次还会拿它去试
      forgetToken(opts.serverUrl)
    }
  }

  const { token } = await authorize(opts)
  return token
}
