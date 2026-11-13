/**
 * MCP OAuth 端到端：真起一个要授权的 MCP server，走完整条链路。
 *
 * 单测覆盖的是每个零件；这里验的是**串起来能不能用**——
 * 而串起来的 bug 恰恰是零件测试看不见的那一类
 * （令牌没带上、重试用了旧 id、回调路径拼错）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import crypto from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('..', import.meta.url))
const tmpHome = mkdtempSync(join(tmpdir(), 'uh-oauth-e2e-'))
process.env.UH_HOME = tmpHome

const { McpClient } = await import(
  pathToFileURL(join(here, 'packages', 'core', 'src', 'mcp', 'client.ts')).href
)

/**
 * 一个「要 OAuth 才给用」的 MCP server + 它身后的授权服务器。
 *
 * 行为照 RFC：401 时回 `WWW-Authenticate: Bearer resource_metadata="…"`；
 * 拿到正确 token 后才处理 JSON-RPC。
 */
function rig(opts = {}) {
  const state = {
    /** 发出去的 code → 它的 code_challenge */
    codes: new Map(),
    /** 发出去的 access token */
    tokens: new Set(),
    /** 授权端点被调用时记一次，用来断言"真的去批准过" */
    approved: 0,
    registered: null,
    authHeader: null,
  }
  let port = 0
  const base = () => `http://127.0.0.1:${port}`

  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', base())
    const j = (o, code = 200) => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(o))
    }
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      // ---- MCP 端点：没 token 就 401 ----
      if (u.pathname === '/mcp') {
        const auth = req.headers.authorization ?? ''
        state.authHeader = auth
        const bearer = auth.replace(/^Bearer\s+/i, '')
        if (!state.tokens.has(bearer)) {
          res.writeHead(401, {
            'content-type': 'application/json',
            'www-authenticate': opts.noResourceMetadata
              ? 'Bearer'
              : `Bearer resource_metadata="${base()}/.well-known/oauth-protected-resource"`,
          })
          res.end(JSON.stringify({ error: 'unauthorized' }))
          return
        }
        const parsed = JSON.parse(body || '{}')
        // initialize 是握手，其余给一条假数据
        if (parsed.method === 'initialize') {
          return j({ jsonrpc: '2.0', id: parsed.id, result: {
            protocolVersion: '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'guarded', version: '1' },
          } })
        }
        if (parsed.method === 'tools/list') {
          return j({ jsonrpc: '2.0', id: parsed.id, result: {
            tools: [{ name: 'secret_echo', description: 'echo', inputSchema: { type: 'object' } }],
          } })
        }
        return j({ jsonrpc: '2.0', id: parsed.id, result: { ok: true, sawAuth: bearer.slice(0, 3) } })
      }

      // ---- 发现 ----
      if (u.pathname === '/.well-known/oauth-protected-resource') {
        return j({ authorization_servers: [base()] })
      }
      if (u.pathname === '/.well-known/oauth-authorization-server') {
        return j({
          issuer: base(),
          authorization_endpoint: `${base()}/authorize`,
          token_endpoint: `${base()}/token`,
          registration_endpoint: `${base()}/register`,
          code_challenge_methods_supported: ['S256'],
          // 明确声明会带 iss，于是客户端必须校验
          authorization_response_iss_parameter_supported: opts.issSupported === true,
        })
      }
      if (u.pathname === '/register') {
        state.registered = JSON.parse(body || '{}')
        return j({ client_id: 'client-123', redirect_uris: state.registered?.redirect_uris ?? [] })
      }

      // ---- 授权：真的检查 PKCE，然后跳回回调 ----
      if (u.pathname === '/authorize') {
        state.approved++
        const redirect = u.searchParams.get('redirect_uri') ?? ''
        const st = u.searchParams.get('state') ?? ''
        const challenge = u.searchParams.get('code_challenge') ?? ''
        const code = 'code-' + crypto.randomBytes(6).toString('hex')
        state.codes.set(code, challenge)
        const back = new URL(redirect)
        back.searchParams.set('code', code)
        back.searchParams.set('state', st)
        if (opts.issSupported) back.searchParams.set('iss', opts.wrongIss ? 'https://evil.example' : base())
        res.writeHead(302, { location: back.toString() })
        res.end()
        return
      }

      // ---- 换 token：校验 PKCE ----
      if (u.pathname === '/token') {
        const form = Object.fromEntries(new URLSearchParams(body))
        const expected = state.codes.get(form.code ?? '')
        const sent = crypto.createHash('sha256').update(form.code_verifier ?? '').digest('base64url')
        if (!expected || sent !== expected) {
          return j({ error: 'invalid_grant', error_description: 'pkce mismatch' }, 400)
        }
        state.codes.delete(form.code ?? '')
        const at = 'at-' + crypto.randomBytes(6).toString('hex')
        state.tokens.add(at)
        return j({ access_token: at, refresh_token: 'rt-1', expires_in: 3600, token_type: 'Bearer' })
      }

      j({ error: 'not found' }, 404)
    })
  })

  const started = new Promise((r) => server.listen(0, '127.0.0.1', () => {
    port = server.address().port
    r()
  }))

  return { server, state, base, started: async () => { await started; return base() } }
}

test('a 401 leads to authorization, and the retried call carries the token', async () => {
  const r = rig()
  const url = await r.started()
  try {
    const client = new McpClient('guarded', {
      url: `${url}/mcp`,
      oauth: true,          // 显式打开：默认关闭，不替用户弹浏览器
    }, {
      // 模拟「用户去浏览器点了一下」：这里直接把授权 URL 走一遍
      onOAuthNeeded: (_msg, authorizeUrl) => { void fetch(authorizeUrl) },
    })

    await client.connect()
    const tools = await client.listTools()
    assert.equal(tools.length, 1)
    assert.equal(tools[0].name, 'secret_echo')

    assert.equal(r.state.approved, 1, 'the authorization endpoint must actually have been visited')
    assert.equal(r.state.registered?.token_endpoint_auth_method, 'none',
      'a public client authenticates with PKCE, not a secret')
    assert.match(String(r.state.authHeader), /^Bearer at-/, 'the retry must carry the access token')
  } finally {
    r.server.close()
    rmSync(tmpHome, { recursive: true, force: true })
  }
})

test('oauth disabled means the 401 is reported as-is, with no browser popping up', async () => {
  const r = rig()
  const url = await r.started()
  try {
    const client = new McpClient('guarded', { url: `${url}/mcp` })   // 没开 oauth
    await assert.rejects(() => client.connect(), /E_MCP_HTTP 401/)
    assert.equal(r.state.approved, 0, 'nothing must be opened on the user\'s behalf')
  } finally {
    r.server.close()
    rmSync(tmpHome, { recursive: true, force: true })
  }
})

test('a token from the wrong issuer is refused even though everything else is valid', async () => {
  // 这条是 mix-up 防御的验收：服务器的 metadata 声明会带 iss，却回了别人的 iss
  const r = rig({ issSupported: true, wrongIss: true })
  const url = await r.started()
  try {
    const client = new McpClient('guarded', { url: `${url}/mcp`, oauth: true }, {
      onOAuthNeeded: (_m, u) => { void fetch(u) },
    })
    await assert.rejects(() => client.connect(), /iss 不匹配/)
  } finally {
    r.server.close()
    rmSync(tmpHome, { recursive: true, force: true })
  }
})

test('an issuer-bound server that actually sends the right iss works end to end', async () => {
  const r = rig({ issSupported: true })
  const url = await r.started()
  try {
    const client = new McpClient('guarded', { url: `${url}/mcp`, oauth: true }, {
      onOAuthNeeded: (_m, u) => { void fetch(u) },
    })
    await client.connect()
    const tools = await client.listTools()
    assert.equal(tools[0].name, 'secret_echo')
  } finally {
    r.server.close()
    rmSync(tmpHome, { recursive: true, force: true })
  }
})
