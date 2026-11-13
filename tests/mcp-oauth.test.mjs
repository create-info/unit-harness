/**
 * MCP OAuth 测试。
 *
 * 重点不在「能连上」，而在**该拒绝的都在拒绝**：
 * state 不对、iss 不对、缺少 iss、只支持 plain PKCE、url 头坏了。
 * 这一层的 bug 不会让程序崩，只会让一个本该失败的授权悄悄成功。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, rmSync, statSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('..', import.meta.url))

// token 落在 uhHome() 下，先隔离
const tmpHome = mkdtempSync(join(tmpdir(), 'uh-oauth-'))
process.env.UH_HOME = tmpHome

const oauth = await import(
  pathToFileURL(join(here, 'packages', 'core', 'src', 'mcp', 'oauth.ts')).href
)
const {
  parseBearerChallenge, discover, makePkce, callbackPath, makeState,
  startCallbackServer, buildAuthorizeUrl, exchangeCode, refreshToken,
  loadToken, saveToken, isExpired,
} = oauth

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ─────────────────────── WWW-Authenticate ───────────────────────

test('a plain Bearer challenge with resource_metadata is understood', () => {
  const c = parseBearerChallenge([
    'Bearer resource_metadata="https://mcp.example/.well-known/oauth-protected-resource"',
  ])
  assert.equal(c.resourceMetadata, 'https://mcp.example/.well-known/oauth-protected-resource')
})

test('scope and error come through', () => {
  const c = parseBearerChallenge(['Bearer error="insufficient_scope", scope="files:read files:write"'])
  assert.equal(c.error, 'insufficient_scope')
  assert.equal(c.scope, 'files:read files:write')
})

test('quoted-pair escapes in the header are unescaped', () => {
  // RFC 9110 §5.6.4：quoted-string 里的 \" 要还原成 "
  const c = parseBearerChallenge(['Bearer resource_metadata="https://x/a\\"b"'])
  assert.equal(c.resourceMetadata, 'https://x/a"b')
})

test('a comma inside quotes does not split the challenge', () => {
  const c = parseBearerChallenge(['Bearer scope="a,b", error="insufficient_scope"'])
  assert.equal(c.scope, 'a,b', 'a comma in a quoted value is data, not a separator')
  assert.equal(c.error, 'insufficient_scope')
})

test('Basic is skipped in favour of Bearer, whichever order they come in', () => {
  assert.equal(
    parseBearerChallenge(['Basic realm="x"', 'Bearer resource_metadata="https://y"']).resourceMetadata,
    'https://y',
  )
  assert.equal(
    parseBearerChallenge(['Bearer resource_metadata="https://z", Basic realm="q"']).resourceMetadata,
    'https://z',
  )
})

test('an unclosed quote is treated as no challenge, not as a guess', () => {
  assert.equal(parseBearerChallenge(['Bearer resource_metadata="https://x']), null)
})

test('no WWW-Authenticate at all means no challenge', () => {
  assert.equal(parseBearerChallenge([]), null)
})

// ─────────────────────── PKCE 与路径 ───────────────────────

test('pkce produces an S256 challenge that matches its verifier', async () => {
  const { verifier, challenge } = makePkce()
  const { createHash } = await import('node:crypto')
  assert.equal(createHash('sha256').update(verifier).digest('base64url'), challenge)
  assert.ok(verifier.length >= 43, 'RFC 7636 requires at least 43 characters')
})

test('two calls never produce the same verifier or state', () => {
  assert.notEqual(makePkce().verifier, makePkce().verifier)
  assert.notEqual(makeState(), makeState())
})

test('each server gets its own callback path — the mix-up fallback', () => {
  const a = callbackPath('https://mcp-a.example/mcp')
  const b = callbackPath('https://mcp-b.example/mcp')
  assert.notEqual(a, b, 'two servers must not share a callback path')
  // 同一个地址永远得到同一条路径，否则重启后老的回调就失效了
  assert.equal(a, callbackPath('https://mcp-a.example/mcp'))
})

test('the authorize URL carries S256, state and resource', () => {
  const url = new URL(buildAuthorizeUrl({
    meta: {
      issuer: 'https://as.example',
      authorization_endpoint: 'https://as.example/authorize',
      token_endpoint: 'https://as.example/token',
    },
    clientId: 'cid',
    redirectUri: 'http://127.0.0.1:1234/oauth/callback/x',
    pkce: { verifier: 'v', challenge: 'c' },
    state: 'st',
    scope: 'read write',
    resource: 'https://mcp.example/mcp',
  }))
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(url.searchParams.get('code_challenge'), 'c')
  assert.equal(url.searchParams.get('state'), 'st')
  // RFC 8707：不带上 resource，token 就可能被拿去打别的 server
  assert.equal(url.searchParams.get('resource'), 'https://mcp.example/mcp')
  assert.equal(url.searchParams.get('response_type'), 'code')
})

// ─────────────────────── 发现 ───────────────────────

function discoveryServer(opts = {}) {
  const server = http.createServer((req, res) => {
    const p = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    const j = (o, code = 200) => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(o))
    }
    if (p.startsWith('/.well-known/oauth-protected-resource')) {
      return opts.noPrm ? j({}, 404) : j({ authorization_servers: [opts.issuer ?? `http://127.0.0.1:${port}`] })
    }
    if (p.startsWith('/.well-known/oauth-authorization-server')) {
      if (opts.noMeta) return j({}, 404)
      return j({
        issuer: opts.issuer ?? `http://127.0.0.1:${port}`,
        authorization_endpoint: `http://127.0.0.1:${port}/authorize`,
        token_endpoint: `http://127.0.0.1:${port}/token`,
        registration_endpoint: `http://127.0.0.1:${port}/register`,
        code_challenge_methods_supported: opts.pkce ?? ['S256'],
        ...(opts.issSupported !== undefined
          ? { authorization_response_iss_parameter_supported: opts.issSupported } : {}),
      })
    }
    j({}, 404)
  })
  let port = 0
  const started = new Promise((r) => server.listen(0, '127.0.0.1', () => {
    port = server.address().port
    r()
  }))
  return { server, started: async () => { await started; return port } }
}

test('discovery follows 401 -> protected resource -> authorization server', async () => {
  const s = discoveryServer()
  const port = await s.started()
  try {
    const d = await discover(`http://127.0.0.1:${port}/mcp`, null)
    assert.ok(d.authServer.authorization_endpoint.endsWith('/authorize'))
    assert.ok(d.authServer.token_endpoint.endsWith('/token'))
    assert.equal(d.issuerBound, false)
  } finally { s.server.close() }
})

test('issuerBound is only true when the server actually advertises iss', async () => {
  const s = discoveryServer({ issSupported: true })
  const port = await s.started()
  try {
    const d = await discover(`http://127.0.0.1:${port}/mcp`, null)
    assert.equal(d.issuerBound, true)
  } finally { s.server.close() }
})

test('a server that only offers plain PKCE is refused', async () => {
  const s = discoveryServer({ pkce: ['plain'] })
  const port = await s.started()
  try {
    await assert.rejects(
      () => discover(`http://127.0.0.1:${port}/mcp`, null),
      /只接受 S256/,
      'plain PKCE on a public client is no PKCE at all',
    )
  } finally { s.server.close() }
})

test('discovery works without a protected-resource document', async () => {
  // 很多只做了半个标准的服务器：401 但不给 metadata 地址，也没有 well-known
  const s = discoveryServer({ noPrm: true })
  const port = await s.started()
  try {
    const d = await discover(`http://127.0.0.1:${port}/mcp`, {})
    assert.ok(d.authServer.token_endpoint)
  } finally { s.server.close() }
})

test('no authorization server metadata at all is an error that says where it looked', async () => {
  const s = discoveryServer({ noMeta: true, noPrm: true })
  const port = await s.started()
  try {
    await assert.rejects(
      () => discover(`http://127.0.0.1:${port}/mcp`, {}),
      (e) => /没有公布 authorization server metadata/.test(e.message) && /well-known/.test(e.message),
    )
  } finally { s.server.close() }
})

// ─────────────────────── 回调服务器 ───────────────────────

test('a matching callback is accepted and returns the code', async () => {
  const cb = await startCallbackServer({ callbackPathname: '/oauth/callback/t', expectedState: 'good' })
  try {
    const u = new URL(cb.redirectUri)
    u.searchParams.set('code', 'abc')
    u.searchParams.set('state', 'good')
    const res = await fetch(u)
    assert.equal(res.status, 200)

    const got = await cb.waitForCode()
    assert.equal(got.code, 'abc')
  } finally { cb.close() }
})

test('a mismatched state is refused', async () => {
  const cb = await startCallbackServer({ callbackPathname: '/oauth/callback/t2', expectedState: 'good' })
  try {
    const u = new URL(cb.redirectUri)
    u.searchParams.set('code', 'abc')
    u.searchParams.set('state', 'evil')
    // 先挂上 catch 再发请求：服务端会在这次 fetch 里就 reject，
    // 晚一步挂监听的话它已经成了未处理的 rejection
    const pending = cb.waitForCode().catch((e) => e.message)
    const res = await fetch(u)
    assert.equal(res.status, 400)
    assert.match(await pending, /state 不匹配/)
  } finally { cb.close() }
})

test('when iss is required, a missing iss is refused', async () => {
  // 服务器声明支持 iss 却不带 —— 这正是 mix-up 攻击的样子
  const cb = await startCallbackServer({
    callbackPathname: '/oauth/callback/t3', expectedState: 's', expectedIssuer: 'https://as.example',
  })
  try {
    const u = new URL(cb.redirectUri)
    u.searchParams.set('code', 'abc')
    u.searchParams.set('state', 's')
    const pending = cb.waitForCode().catch((e) => e.message)
    assert.equal((await fetch(u)).status, 400)
    assert.match(await pending, /缺少 iss/)
  } finally { cb.close() }
})

test('an iss from a different authorization server is refused', async () => {
  const cb = await startCallbackServer({
    callbackPathname: '/oauth/callback/t4', expectedState: 's', expectedIssuer: 'https://good.example',
  })
  try {
    const u = new URL(cb.redirectUri)
    u.searchParams.set('code', 'abc')
    u.searchParams.set('state', 's')
    u.searchParams.set('iss', 'https://evil.example')
    const pending = cb.waitForCode().catch((e) => e.message)
    assert.equal((await fetch(u)).status, 400)
    assert.match(await pending, /iss 不匹配/)
  } finally { cb.close() }
})

test('a matching iss is accepted', async () => {
  const cb = await startCallbackServer({
    callbackPathname: '/oauth/callback/t5', expectedState: 's', expectedIssuer: 'https://good.example',
  })
  try {
    const u = new URL(cb.redirectUri)
    u.searchParams.set('code', 'abc')
    u.searchParams.set('state', 's')
    u.searchParams.set('iss', 'https://good.example')
    assert.equal((await fetch(u)).status, 200)
    const got = await cb.waitForCode()
    assert.equal(got.iss, 'https://good.example')
  } finally { cb.close() }
})

test('an error response surfaces the server\'s reason', async () => {
  const cb = await startCallbackServer({ callbackPathname: '/oauth/callback/t6', expectedState: 's' })
  try {
    const u = new URL(cb.redirectUri)
    u.searchParams.set('error', 'access_denied')
    const pending = cb.waitForCode().catch((e) => e.message)
    assert.equal((await fetch(u)).status, 400)
    assert.match(await pending, /access_denied/)
  } finally { cb.close() }
})

test('an unrelated path on the callback server is 404, and does not settle anything', async () => {
  const cb = await startCallbackServer({ callbackPathname: '/oauth/callback/t7', expectedState: 's' })
  try {
    const base = new URL(cb.redirectUri)
    const res = await fetch(`http://127.0.0.1:${base.port}/favicon.ico`)
    assert.equal(res.status, 404)
  } finally { cb.close() }
})

test('the callback server binds only to loopback', async () => {
  const cb = await startCallbackServer({ callbackPathname: '/oauth/callback/t8', expectedState: 's' })
  try {
    const u = new URL(cb.redirectUri)
    assert.equal(u.hostname, '127.0.0.1', 'binding 0.0.0.0 would expose the callback to the LAN')
  } finally { cb.close() }
})

test('a callback that never arrives times out', async () => {
  const cb = await startCallbackServer({
    callbackPathname: '/oauth/callback/t9', expectedState: 's', timeoutMs: 120,
  })
  try {
    await assert.rejects(() => cb.waitForCode(), /没有收到授权回调/)
  } finally { cb.close() }
})

// ─────────────────────── token ───────────────────────

function tokenServer(handler) {
  const server = http.createServer((req, res) => {
    let b = ''
    req.on('data', (c) => (b += c))
    req.on('end', () => {
      const form = Object.fromEntries(new URLSearchParams(b))
      const out = handler(form)
      res.writeHead(out.status ?? 200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(out.body))
    })
  })
  let port = 0
  const started = new Promise((r) => server.listen(0, '127.0.0.1', () => {
    port = server.address().port
    r()
  }))
  return { server, started: async () => { await started; return port } }
}

test('exchanging a code stores a token with an expiry', async () => {
  const s = tokenServer(() => ({
    body: { access_token: 'at', refresh_token: 'rt', expires_in: 3600, token_type: 'Bearer' },
  }))
  const port = await s.started()
  try {
    const t = await exchangeCode({
      meta: { issuer: 'https://as', authorization_endpoint: 'https://as/a', token_endpoint: `http://127.0.0.1:${port}/token` },
      clientId: 'cid', code: 'c', redirectUri: 'http://127.0.0.1:1/cb', codeVerifier: 'v',
      serverUrl: 'https://mcp.example/mcp',
    })
    assert.equal(t.accessToken, 'at')
    assert.equal(t.refreshToken, 'rt')
    assert.ok(t.expiresAt && t.expiresAt > Date.now())
    assert.equal(t.issuer, 'https://as')
  } finally { s.server.close() }
})

test('a token endpoint error is reported with its description', async () => {
  const s = tokenServer(() => ({
    status: 400, body: { error: 'invalid_grant', error_description: 'code expired' },
  }))
  const port = await s.started()
  try {
    await assert.rejects(
      () => exchangeCode({
        meta: { issuer: 'https://as', authorization_endpoint: 'https://as/a', token_endpoint: `http://127.0.0.1:${port}/token` },
        clientId: 'cid', code: 'c', redirectUri: 'http://127.0.0.1:1/cb', codeVerifier: 'v',
        serverUrl: 'https://mcp.example/mcp',
      }),
      /invalid_grant.*code expired/,
    )
  } finally { s.server.close() }
})

test('refresh keeps the old refresh_token when the server does not rotate it', async () => {
  const s = tokenServer(() => ({ body: { access_token: 'at2', expires_in: 60 } }))
  const port = await s.started()
  try {
    const next = await refreshToken({
      meta: { issuer: 'https://as', authorization_endpoint: 'https://as/a', token_endpoint: `http://127.0.0.1:${port}/token` },
      current: { serverUrl: 'https://mcp.example', accessToken: 'at1', refreshToken: 'rt1', tokenType: 'Bearer', issuer: 'https://as' },
      clientId: 'cid',
    })
    assert.equal(next.accessToken, 'at2')
    // 不保留就会导致第二次刷新直接失败
    assert.equal(next.refreshToken, 'rt1')
  } finally { s.server.close() }
})

test('refresh takes the rotated refresh_token when the server sends one', async () => {
  const s = tokenServer(() => ({ body: { access_token: 'at2', refresh_token: 'rt2', expires_in: 60 } }))
  const port = await s.started()
  try {
    const next = await refreshToken({
      meta: { issuer: 'https://as', authorization_endpoint: 'https://as/a', token_endpoint: `http://127.0.0.1:${port}/token` },
      current: { serverUrl: 'https://mcp.example', accessToken: 'at1', refreshToken: 'rt1', tokenType: 'Bearer', issuer: 'https://as' },
      clientId: 'cid',
    })
    assert.equal(next.refreshToken, 'rt2')
  } finally { s.server.close() }
})

test('refreshing without a refresh_token fails with a clear reason', async () => {
  await assert.rejects(
    () => refreshToken({
      meta: { issuer: 'https://as', authorization_endpoint: 'https://as/a', token_endpoint: 'https://as/t' },
      current: { serverUrl: 'https://x', accessToken: 'at', tokenType: 'Bearer', issuer: 'https://as' },
      clientId: 'cid',
    }),
    /没有 refresh_token/,
  )
})

test('expiry has a small skew so a token is not used in its last seconds', () => {
  const soon = { serverUrl: 'x', accessToken: 'a', tokenType: 'Bearer', issuer: 'i', expiresAt: Date.now() + 30_000 }
  assert.equal(isExpired(soon), true, 'a token expiring in 30s should already be treated as expired')
  const later = { serverUrl: 'x', accessToken: 'a', tokenType: 'Bearer', issuer: 'i', expiresAt: Date.now() + 3600_000 }
  assert.equal(isExpired(later), false)
  // 不知道过期时间 = 不过期，不要凭猜测每隔几分钟就重新授权一次
  assert.equal(isExpired({ serverUrl: 'x', accessToken: 'a', tokenType: 'Bearer', issuer: 'i' }), false)
})

test('stored tokens are readable back and the file is 0600', () => {
  saveToken({ serverUrl: 'https://keep.example', accessToken: 'secret-at', tokenType: 'Bearer', issuer: 'https://as' })
  const back = loadToken('https://keep.example')
  assert.equal(back.accessToken, 'secret-at')
  if (process.platform !== 'win32') {
    const mode = statSync(join(tmpHome, 'mcp-oauth.json')).mode & 0o777
    assert.equal(mode, 0o600, `tokens must not be world-readable, got ${mode.toString(8)}`)
  }
})

test('a corrupt token file behaves like no tokens, not like a crash', async () => {
  const { writeFileSync } = await import('node:fs')
  writeFileSync(join(tmpHome, 'mcp-oauth.json'), '{oops')
  assert.equal(loadToken('https://keep.example'), null)
})
