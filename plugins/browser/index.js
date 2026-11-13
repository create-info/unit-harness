/**
 * @unit-harness/plugin-browser — 用 CDP 操作一个真实的浏览器。
 *
 * 设计参考 Codex 浏览器控制的四个要点，逐条对应：
 *
 * 1) **复用真实浏览器状态**
 *    attach 优先：探测 9222 等调试端口上已经在跑的浏览器，用他那份 session（带登录态）。
 *    连不上才自己起，而且用真实 profile 目录而不是一次性干净 profile。
 *    profile 被占用会撞 ProcessSingleton——这时把原因翻成"先关掉 Chrome"，不偷偷换空 profile。
 *
 * 2) **持久化的运行时环境**
 *    浏览器进程跨工具调用、跨 run 存活，状态落在 <uhHome>/browser/state.json。
 *    下次先看那个 pid 还活着没有，活着就接着用。每次重启都丢登录态，事就干不成。
 *
 * 3) **基于语义的增量观察**
 *    不重发全量快照。ref 按 (role + name + 次序) 稳定，页面没变时一行都不发；
 *    变了只发增删改。模型看到的是"这次页面发生了什么"，不是重复的整棵树。
 *
 * 4) **事务化的动作执行**
 *    每个动作 = 前置检查 → 执行 → 等页面稳定 → 回读确认。
 *    等的是"连续两次观察一致"，不是固定 sleep；确认不通过就报没生效，不假装成功。
 *
 * CDP 只是通道（pipe 或 WebSocket），上层逻辑不关心。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Observer, describe } from '../shared/observe.js'

// ─────────────────────────── 常量 ───────────────────────────

/** 现成浏览器优先从这些端口找。用户手动开过带调试端口的 Chrome 时直接命中。 */
const PROBE_PORTS = [9222, 9223, 9224, 9229]

const CHROME_CANDIDATES = [
  process.env.UH_CHROME,
  'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser',
  'microsoft-edge', 'brave-browser',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean)

// ─────────────────────────── 路径与状态 ───────────────────────────

function uhHome() {
  return process.env.UH_HOME || path.join(os.homedir(), '.uh')
}

function statePath() {
  return path.join(uhHome(), 'browser', 'state.json')
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(statePath(), 'utf8'))
  } catch {
    return null
  }
}

function writeState(st) {
  const p = statePath()
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(st, null, 2), { mode: 0o600 })
}

function clearState() {
  try { fs.unlinkSync(statePath()) } catch { /* 本来就没有 */ }
}

function alive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function findChrome() {
  for (const c of CHROME_CANDIDATES) {
    if (c.includes('/') || c.includes('\\')) {
      try { fs.accessSync(c, fs.constants.X_OK); return c } catch { /* 继续找 */ }
    } else {
      for (const dir of (process.env.PATH || '').split(path.delimiter)) {
        if (!dir) continue
        const p = path.join(dir, c)
        try { fs.accessSync(p, fs.constants.X_OK); return p } catch { /* 继续 */ }
      }
    }
  }
  return null
}

/**
 * 自启时用的 profile 目录。
 *
 * 默认用我们自己的一份，不去碰用户的真实 profile。理由有两个：
 *   - 真实 profile 里是用户所有网站的登录态，让 agent 默认读写它，风险不对等；
 *   - 真实 profile 通常正被用户的浏览器占着，进程内会话锁会直接让启动失败。
 *
 * 需要登录态时走的是另一条路：attach 到用户自己开的浏览器（见 connect）。
 * 想强制用真实 profile 才显式配 useRealProfile，而且不该轻易打开。
 */
function profileDir(bin, cfg) {
  if (cfg.profileDir) return cfg.profileDir
  if (cfg.useRealProfile === true) return REAL_PROFILE(bin)
  const dir = path.join(uhHome(), 'browser', 'profile')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** 用户真实浏览器的 profile。只给显式配置用，见 profileDir 的注释。 */
function REAL_PROFILE(bin) {
  const p = (bin || '').toLowerCase()
  if (process.platform === 'darwin') {
    if (p.includes('chrome')) return path.join(os.homedir(), 'Library/Application Support/Google/Chrome')
    if (p.includes('edge')) return path.join(os.homedir(), 'Library/Application Support/Microsoft Edge')
    if (p.includes('brave')) return path.join(os.homedir(), 'Library/Application Support/BraveSoftware/Brave-Browser')
  }
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData/Local')
    if (p.includes('chrome')) return path.join(local, 'Google/Chrome/User Data')
    if (p.includes('edge')) return path.join(local, 'Microsoft/Edge/User Data')
  }
  if (p.includes('chrome')) return path.join(os.homedir(), '.config/google-chrome')
  if (p.includes('chromium')) return path.join(os.homedir(), '.config/chromium')
  if (p.includes('edge')) return path.join(os.homedir(), '.config/microsoft-edge')
  if (p.includes('brave')) return path.join(os.homedir(), '.config/BraveSoftware/Brave-Browser')
  // 认不出来就用自己的目录，绝不去猜一个可能不存在的位置
  return path.join(uhHome(), 'browser', 'profile')
}

// ─────────────────────────── CDP 传输 ───────────────────────────

/**
 * 一条 CDP 连接。两种传输形状不同，对外都是 send(method, params, sessionId)。
 *   pipe: 走 fd 3/4，snap / 容器 / 受限网络都拦不住，但浏览器必须由我们启动。
 *   ws:   走 WebSocket，能 attach 别人的浏览器（这是复用登录态的唯一途径）。
 */
class Transport {
  constructor() {
    this.buf = ''
    this.id = 0
    this.pending = new Map()
    this.closed = false
    this.error = null
  }

  _onMessage(raw) {
    if (!raw || !raw.trim()) return
    let m
    try { m = JSON.parse(raw) } catch { return }
    if (m.id && this.pending.has(m.id)) {
      const { resolve, reject } = this.pending.get(m.id)
      this.pending.delete(m.id)
      m.error ? reject(new Error(m.error.message)) : resolve(m.result)
    }
  }

  _fail(reason) {
    this.closed = true
    this.error = reason
    for (const [, { reject }] of this.pending) reject(new Error(reason))
    this.pending.clear()
  }

  send(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(new Error(this.error || 'browser is not running'))
    const mid = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(mid, { resolve, reject })
      try {
        this._write(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) }) + (this.framing === 'nul' ? '\0' : ''))
      } catch (e) {
        this.pending.delete(mid)
        reject(e)
        return
      }
      // 不设超时会挂死，用户只能杀进程
      setTimeout(() => {
        if (this.pending.has(mid)) {
          this.pending.delete(mid)
          reject(new Error(`timed out: ${method}`))
        }
      }, 20_000)
    })
  }

  close() { /* 子类实现 */ }
}

class PipeTransport extends Transport {
  constructor(child) {
    super()
    this.child = child
    this.framing = 'nul'
    // 管道另一端是浏览器；它一死两个流都会各自抛 ECONNRESET。
    // 不接住就是未处理的 error 事件，整个进程带堆栈退出。
    child.stdio[4].on('error', () => this._fail('browser pipe closed'))
    child.stdio[3].on('error', () => this._fail('browser pipe closed'))
    child.stdio[4].on('data', (c) => this._onData(c))
    child.on('error', () => this._fail('browser process failed'))
    child.on('close', () => this._fail('browser closed'))
  }

  _onData(chunk) {
    this.buf += chunk.toString('utf8')
    let i
    while ((i = this.buf.indexOf('\0')) >= 0) {
      const raw = this.buf.slice(0, i)
      this.buf = this.buf.slice(i + 1)
      this._onMessage(raw)
    }
  }

  _write(s) {
    this.child.stdio[3].write(s)
  }

  close() {
    try { this.child.kill('SIGKILL') } catch { /* 已经死了 */ }
  }
}

class WsTransport extends Transport {
  constructor(ws) {
    super()
    this.ws = ws
    this.framing = 'plain'
    ws.addEventListener('message', (e) => this._onMessage(String(e.data)))
    ws.addEventListener('error', () => this._fail('browser websocket failed'))
    ws.addEventListener('close', () => this._fail('browser connection closed'))
  }

  _write(s) {
    this.ws.send(s.trimEnd())
  }

  close() {
    try { this.ws.close() } catch { /* 已关 */ }
  }
}

// ─────────────────────────── 连接：复用优先 ───────────────────────────

async function fetchJSON(url, ms = 2500) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), ms)
  try {
    const r = await fetch(url, { signal: ctrl.signal })
    if (!r.ok) return null
    return await r.json()
  } catch {
    return null
  } finally {
    clearTimeout(t)
  }
}

/** 连一个已经在跑的浏览器。连上才有"复用它登录态"这回事。 */
async function attach(port) {
  const ver = await fetchJSON(`http://127.0.0.1:${port}/json/version`)
  if (!ver?.webSocketDebuggerUrl) return null
  let ws
  try {
    ws = new WebSocket(ver.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('ws open timeout')), 8000)
      ws.addEventListener('open', () => { clearTimeout(t); resolve() }, { once: true })
      ws.addEventListener('error', () => { clearTimeout(t); reject(new Error('ws refused')) }, { once: true })
    })
  } catch {
    try { ws?.close() } catch { /* 没打开 */ }
    return null
  }
  return { transport: new WsTransport(ws), mode: 'attach', port, pid: null }
}

async function sessionOn(transport, targetId) {
  const { sessionId } = await transport.send('Target.attachToTarget', { targetId, flatten: true })
  await transport.send('Page.enable', {}, sessionId)
  await transport.send('DOM.enable', {}, sessionId)
  await transport.send('Accessibility.enable', {}, sessionId)
  await transport.send('Runtime.enable', {}, sessionId)
  return sessionId
}

async function firstPage(transport) {
  const { targetInfos } = await transport.send('Target.getTargets')
  return targetInfos?.find((t) => t.type === 'page') ?? null
}

/** pipe 模式：等浏览器应答并 attach 到 page target */
async function waitForPage(transport, stderrRef) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    try {
      const page = await firstPage(transport)
      if (page) return await sessionOn(transport, page.targetId)
    } catch { /* 还没就绪 */ }
    await new Promise((r) => setTimeout(r, 250))
  }
  transport.close()
  const why = (stderrRef?.() || '').split('\n').filter(Boolean).slice(-2).join(' | ')
  throw new Error('browser did not become ready' + (why ? ': ' + why : ''))
}

/**
 * 自己起一个浏览器。两条路，**不是二选一而是降级链**：
 *
 *   port 模式：成功的话下一次能 attach 复用，是首选。
 *   pipe 模式：port 被环境挡住时的兜底。实测 snap chromium 就是这样——端口在听，
 *              但 HTTP 和 WS 都被 reset（confinement 挡 TCP）。pipe 走 fd 3/4，拦不住。
 *
 * 关键点：port 失败时必须自动退 pipe，否则受限环境里这个插件一次都用不了。
 * 唯一的例外是 profile 被占用——那 pipe 也会同样撞墙，这时要直接告诉用户关掉浏览器。
 */
async function launchOwn(bin, opts) {
  const profile = opts.profileDir || profileDir(bin, opts.cfg || {})
  const usePort = opts.port !== false

  if (!usePort) return launchPipe(bin, opts, profile)

  const port = opts.port === true ? 9222 : (opts.port || 9222)
  const r = await tryPort(bin, opts, profile, port)
  if (r.ok) return r.launched
  if (r.profileBusy) {
    throw new Error(
      'Chrome is already running with this profile, so it will not open a debug port. '
      + 'Close Chrome and retry, or start it yourself with --remote-debugging-port=9222.',
    )
  }
  // 端口这条路走不通，退到 pipe。把上一次的原因带上，出问题时能看出是哪一步降级的
  return launchPipe(bin, opts, profile, r.why)
}

async function tryPort(bin, opts, profile, port) {
  const args = ['--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1280,900']
  if (opts.headless !== false) args.push('--headless=new')
  args.push(`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank')
  if (process.getuid && process.getuid() === 0) args.unshift('--no-sandbox')

  // 端口模式也要留 stderr：不然"起不来"就只剩一句没有原因的话
  const child = spawn(bin, args, {
    stdio: ['ignore', 'ignore', 'pipe', 'ignore', 'ignore'],
    detached: true,
  })
  let stderr = ''
  if (child.stderr) child.stderr.on('data', (d) => { stderr += String(d) })

  child.unref()
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const got = await attach(port)
    if (got) return { ok: true, launched: { ...got, mode: 'launch', pid: child.pid, profile } }
    if (!alive(child.pid)) break
    await new Promise((r) => setTimeout(r, 300))
  }
  try { process.kill(child.pid, 'SIGKILL') } catch { /* 已退出 */ }

  if (/ProcessSingleton|SingletonLock/i.test(stderr)) return { ok: false, profileBusy: true }
  const why = stderr.split('\n').map((s) => s.trim()).filter(Boolean).slice(-2).join(' | ')
  return { ok: false, why: why || `debug port ${port} is not reachable` }
}

async function launchPipe(bin, opts, profile, degradedFrom) {
  const args = ['--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1280,900']
  if (opts.headless !== false) args.push('--headless=new')
  args.push('--remote-debugging-pipe', `--user-data-dir=${profile}`, 'about:blank')
  if (process.getuid && process.getuid() === 0) args.unshift('--no-sandbox')

  const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'], detached: true })
  let stderr = ''
  if (child.stderr) child.stderr.on('data', (d) => { stderr += String(d) })

  const transport = new PipeTransport(child)
  const sessionId = await waitForPage(transport, () => stderr)
  return {
    transport, mode: 'launch-pipe', port: null, pid: child.pid, sessionId, profile,
    degradedFrom: degradedFrom || null,
  }
}

// ─────────────────────────── 动作基础设施 ───────────────────────────

/** 页面状态的廉价指纹：URL + 元素数 + 文本长度 + 滚动位置 */
async function pageSignature(cdp, sessionId) {
  const r = await cdp.send('Runtime.evaluate', {
    expression: '(()=>{const b=document.body;return [location.href,b?b.getElementsByTagName("*").length:0,b?b.innerText.length:0,Math.round(scrollY)].join("|")})()',
    returnByValue: true,
  }, sessionId)
  return r.result.value
}

/** 连续两次观察一致才算稳定。比固定 sleep 快，也比它准。 */
async function settle(cdp, sessionId, budgetMs = 6000) {
  const deadline = Date.now() + budgetMs
  let last = null
  let streak = 0
  while (Date.now() < deadline) {
    const sig = await pageSignature(cdp, sessionId).catch(() => 'ERR')
    if (sig === last) {
      streak += 120
      if (streak >= 240) return true      // 连续两次采样一致
    } else {
      streak = 0
      last = sig
    }
    await new Promise((r) => setTimeout(r, 120))
  }
  return false   // 一直没稳定：动画或长轮询，不算错，但不能声称已确认
}

/** AX 树 → 观察器认得的归一化节点。过滤留给 Observer，这里只做形状转换。 */
function normalizeAx(raw) {
  const out = []
  for (const n of raw) {
    if (n.ignored) continue
    const role = n.role?.value
    if (!role) continue
    const name = n.name?.value ? String(n.name.value).replace(/\s+/g, ' ').trim() : ''
    const props = {}
    for (const p of n.properties || []) props[p.name] = p.value?.value
    const flags = []
    if (props.checked === true) flags.push('checked')
    if (props.disabled === true) flags.push('disabled')
    if (props.expanded === true) flags.push('expanded')
    if (props.required === true) flags.push('required')
    if (props.selected === true) flags.push('selected')
    out.push({ role, name, flags, id: n.backendDOMNodeId })
  }
  return out
}

async function axNodes(cdp, sessionId) {
  const ax = await cdp.send('Accessibility.getFullAXTree', {}, sessionId)
  return normalizeAx(ax.nodes || [])
}

async function rectOf(cdp, sessionId, backendId) {
  // getBoxModel 在 flatten session 下给错盒子（实测返回文档首元素），
  // resolveNode 出来的 objectId 一定对，直接问元素自己
  const o = await cdp.send('DOM.resolveNode', { backendNodeId: backendId }, sessionId)
  if (!o?.object?.objectId) throw new Error('stale ref')
  const r = await cdp.send('Runtime.callFunctionOn', {
    objectId: o.object.objectId,
    returnByValue: true,
    functionDeclaration: 'function(){const b=this.getBoundingClientRect();return {x:b.x,y:b.y,w:b.width,h:b.height}}',
  }, sessionId)
  return r.result.value
}

async function mouseClick(cdp, sessionId, x, y) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, sessionId)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, sessionId)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, sessionId)
}

const TEXT = (s) => ({ content: String(s) })

// ─────────────────────────── 插件 ───────────────────────────

export default {
  name: '@unit-harness/plugin-browser',
  apiVersion: 1,

  apply(ctx) {
    let live = null
    const observer = new Observer()
    const cfg = ctx.config || {}

    /**
     * 拿一个能用的连接，顺序就是"复用优先"：
     *   1. 上次留下的浏览器还活着 → 复用
     *   2. 调试端口上有现成的 → attach（用户的真实 session）
     *   3. 都没有 → 用真实 profile 启一个，并记下 pid
     */
    const connect = async () => {
      if (live && !live.transport.closed) return live

      // 1) 上次那个还活着吗
      const st = readState()
      if (st?.pid && alive(st.pid) && st.port) {
        const got = await attach(st.port)
        if (got) {
          try {
            const page = await firstPage(got.transport)
            if (page) {
              const sessionId = await sessionOn(got.transport, page.targetId)
              live = { ...got, sessionId, pid: st.pid, profile: st.profile }
              ctx.log.info(`browser reused on port ${st.port}`)
              return live
            }
          } catch { got.transport.close() }
        }
      }

      // 2) 端口上现成的浏览器
      for (const port of PROBE_PORTS) {
        const got = await attach(port)
        if (!got) continue
        try {
          const page = await firstPage(got.transport)
          if (!page) { got.transport.close(); continue }
          const sessionId = await sessionOn(got.transport, page.targetId)
          live = { ...got, sessionId }
          writeState({ mode: 'attach', port, pid: null, updatedAt: new Date().toISOString() })
          observer.reset()
          ctx.log.info(`browser attached on port ${port}`)
          return live
        } catch { got.transport.close() }
      }

      // 3) 自己起
      const bin = findChrome()
      if (!bin) throw new Error('no Chrome or Chromium found. Set UH_CHROME=/path/to/chrome.')

      const launched = await launchOwn(bin, {
        headless: cfg.headless !== false,
        port: cfg.port === false ? false : (cfg.port || 9222),
        profileDir: cfg.profileDir,
        cfg,
      })
      if (!launched.sessionId) {
        const page = await firstPage(launched.transport)
        if (!page) throw new Error('browser started but has no page')
        launched.sessionId = await sessionOn(launched.transport, page.targetId)
      }
      live = launched
      writeState({
        mode: live.mode, port: live.port, pid: live.pid,
        profile: live.profile, updatedAt: new Date().toISOString(),
      })
      observer.reset()
      ctx.log.info(`browser started (${live.mode}${live.port ? ' :' + live.port : ''}, profile ${live.profile})`)
      return live
    }

    /** 看一眼：增量优先 */
    const look = async (force) => {
      const l = await connect()
      if (force) observer.reset()
      const o = observer.observe(await axNodes(l.transport, l.sessionId))
      return o
    }

    /** 动作的统一外壳：前置 → 执行 → 稳定 → 回读 */
    const perform = async (fn) => {
      const l = await connect()
      const before = await pageSignature(l.transport, l.sessionId).catch(() => '')
      await fn(l)
      const stable = await settle(l.transport, l.sessionId)
      const after = await pageSignature(l.transport, l.sessionId).catch(() => '')
      const delta = observer.observe(await axNodes(l.transport, l.sessionId))
      return { l, changed: before !== after, stable, delta }
    }

    const report = (res) => [
      `settled: ${res.stable ? 'yes' : 'no — page kept changing (animation or slow network)'}`,
      `changed: ${res.changed ? 'yes' : 'no — the action may have had no effect'}`,
      describe(res.delta) ? '\n' + describe(res.delta) : '',
    ].filter(Boolean).join('\n')

    ctx.tools.register({
      name: 'browser_open',
      description:
        'Open a URL in a real browser and return its interactive elements. Reuses an already-running '
        + 'browser so the user stays signed in, and reuses element refs from earlier looks. '
        + 'The browser runs outside the sandbox on the real network.',
      schema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'http(s) URL' },
          fresh: { type: 'boolean', description: 'forget earlier element refs and report the whole page' },
        },
        required: ['url'],
        additionalProperties: false,
      },
      async handler(args) {
        const url = String(args?.url ?? '')
        // data: 也放行——它不联网、不读本地文件，正好用来验证页面脚本和动作链。
        // file: 故意不支持：那等于把任意本地文件内容交给模型。
        if (!/^(https?:\/\/|data:text\/html)/i.test(url)) {
          return TEXT(`ERROR: only http(s) and data:text/html URLs are allowed, got "${url}"`)
        }
        try {
          const l = await connect()
          const before = await pageSignature(l.transport, l.sessionId).catch(() => '')
          if (args?.fresh) observer.reset()
          const nav = await l.transport.send('Page.navigate', { url }, l.sessionId)
          // Page.navigate 自己会报错，别把它当成"已经打开了"继续往下走。
          // 浏览器内部错误页也是一张正常页面，settle 会判定它很稳定。
          if (nav?.errorText) throw new Error(`navigation failed: ${nav.errorText}`)
          const stable = await settle(l.transport, l.sessionId)
          const after = await pageSignature(l.transport, l.sessionId).catch(() => '')
          const o = await look(false)
          const title = await l.transport.send('Runtime.evaluate', {
            expression: 'document.title || location.href', returnByValue: true,
          }, l.sessionId)

          return TEXT(
            `${title.result.value}\n${url}\nsettled: ${stable ? 'yes' : 'no'}\n`
            + (before === after ? '(no page change)\n' : '')
            + `\n${o.text || '(no interactive elements)'}`,
          )
        } catch (e) {
          return TEXT(`ERROR: ${e.message}`)
        }
      },
    })

    ctx.tools.register({
      name: 'browser_look',
      description:
        'Look at the current page again. By default returns only what changed since the last look '
        + '(added / gone / changed elements) — use fresh:true to re-read everything and re-issue refs.',
      schema: {
        type: 'object',
        properties: { fresh: { type: 'boolean' } },
        additionalProperties: false,
      },
      async handler(args) {
        try {
          const force = Boolean(args?.fresh)
          const o = await look(force)
          if (force) return TEXT(o.text || '(no interactive elements)')
          if (!o.changed) return TEXT('(nothing changed since the last look)')
          return TEXT(describe(o))
        } catch (e) {
          return TEXT(`ERROR: ${e.message}`)
        }
      },
    })

    ctx.tools.register({
      name: 'browser_click',
      description:
        'Click an element by ref from the latest look, wait for the page to settle, and report whether '
        + 'anything actually changed. If it reports changed:no, the click did not take effect — say so.',
      schema: {
        type: 'object',
        properties: { ref: { type: 'string', description: 'ref from the latest look, e.g. e3' } },
        required: ['ref'],
        additionalProperties: false,
      },
      async handler(args) {
        const ref = String(args?.ref ?? '')
        try {
          const backendId = observer.byRef.get(ref)
          if (!backendId) return TEXT(`ERROR: ref "${ref}" is not on the current page. Call browser_look with fresh:true.`)
          const l = await connect()
          const r = await rectOf(l.transport, l.sessionId, backendId)
          if (r.w <= 0 || r.h <= 0) return TEXT(`ERROR: ref "${ref}" has zero size — it is hidden`)

          const x = r.x + r.w / 2
          const y = r.y + r.h / 2
          // 点下去会落在谁头上？被遮挡时坐标完全正确，点到的却是别人
          const hit = await l.transport.send('Runtime.evaluate', {
            expression: `(()=>{const el=document.elementFromPoint(${x},${y});return el?el.tagName.toLowerCase():'none'})()`,
            returnByValue: true,
          }, l.sessionId)

          const res = await perform(async (ll) => {
            await mouseClick(ll.transport, ll.sessionId, x, y)
          })
          return TEXT(
            `clicked ${ref} at ${Math.round(x)},${Math.round(y)} (topmost: ${hit.result.value})\n`
            + report(res),
          )
        } catch (e) {
          return TEXT(`ERROR: ${e.message}`)
        }
      },
    })

    ctx.tools.register({
      name: 'browser_type',
      description:
        'Focus an element by ref and type with real key input (so framework state updates fire), then '
        + 'settle and read the value back. submit:true presses Enter afterwards.',
      schema: {
        type: 'object',
        properties: {
          ref: { type: 'string' },
          text: { type: 'string' },
          submit: { type: 'boolean' },
        },
        required: ['ref', 'text'],
        additionalProperties: false,
      },
      async handler(args) {
        const ref = String(args?.ref ?? '')
        const text = String(args?.text ?? '')
        try {
          const backendId = observer.byRef.get(ref)
          if (!backendId) return TEXT(`ERROR: ref "${ref}" is not on the current page. Call browser_look with fresh:true.`)
          const l = await connect()
          const r = await rectOf(l.transport, l.sessionId, backendId)
          if (r.w <= 0 || r.h <= 0) return TEXT(`ERROR: ref "${ref}" has zero size — it is hidden`)

          await mouseClick(l.transport, l.sessionId, r.x + r.w / 2, r.y + r.h / 2)
          await l.transport.send('Input.insertText', { text }, l.sessionId)
          if (args?.submit) {
            await l.transport.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, l.sessionId)
            await l.transport.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, l.sessionId)
          }

          const res = await perform(async () => {})

          // 回读确认：值真的进去了吗？没进去就是没生效，不能说"已输入"
          let actual = null
          try {
            const o = await l.transport.send('DOM.resolveNode', { backendNodeId: backendId }, l.sessionId)
            if (o?.object?.objectId) {
              const v = await l.transport.send('Runtime.callFunctionOn', {
                objectId: o.object.objectId,
                returnByValue: true,
                functionDeclaration: 'function(){return this.value === undefined ? null : String(this.value)}',
              }, l.sessionId)
              actual = v?.result?.value ?? null
            }
          } catch { /* 元素已被重渲染，回读不到就如实报 */ }

          const verdict = actual === null
            ? 'n/a (element has no value)'
            : actual === text ? 'yes' : `NO — field contains ${JSON.stringify(actual)}`

          // 输入文字本身不改变页面结构，pageSignature 往往不变，所以这里不能用
          // "changed:no" 去质疑它——真正的判据是回读到的值。
          const typedOk = actual === null ? res.changed : actual === text
          return TEXT(
            `typed ${text.length} chars into ${ref}${args?.submit ? ' + Enter' : ''}\n`
            + `readback: ${verdict}\n`
            + `settled: ${res.stable ? 'yes' : 'no — page kept changing'}\n`
            + `page changed: ${res.changed ? 'yes' : 'no (typing alone usually does not change the page)'}\n`
            + (typedOk ? '' : 'the field does not hold what was typed — this did NOT take effect\n')
            + (describe(res.delta) ? '\n' + describe(res.delta) : ''),
          )
        } catch (e) {
          return TEXT(`ERROR: ${e.message}`)
        }
      },
    })

    ctx.tools.register({
      name: 'browser_screenshot',
      description: 'Save a PNG of the current page and return its path.',
      schema: { type: 'object', properties: { path: { type: 'string' } }, additionalProperties: false },
      async handler(args) {
        try {
          const l = await connect()
          const out = args?.path ? String(args.path) : path.join(os.tmpdir(), `uh-browser-${Date.now()}.png`)
          const { data } = await l.transport.send('Page.captureScreenshot', { format: 'png' }, l.sessionId)
          fs.mkdirSync(path.dirname(out), { recursive: true })
          fs.writeFileSync(out, Buffer.from(data, 'base64'))
          return TEXT(`screenshot saved: ${out}`)
        } catch (e) {
          return TEXT(`ERROR: ${e.message}`)
        }
      },
    })

    ctx.tools.register({
      name: 'browser_status',
      description: 'Which browser is in use, how it is connected, and whether it was reused or launched.',
      schema: { type: 'object', properties: {}, additionalProperties: false },
      async handler() {
        const st = readState()
        const cur = live && !live.transport.closed ? live : null
        const pid = cur?.pid ?? st?.pid
        return TEXT([
          `connected: ${cur ? 'yes' : 'no'}`,
          `mode: ${cur?.mode ?? st?.mode ?? '-'}${cur?.mode === 'attach' ? ' (reusing an existing browser)' : ''}`,
          `port: ${cur?.port ?? st?.port ?? '-'}`,
          `pid: ${pid ?? '-'}${pid ? (alive(pid) ? ' (alive)' : ' (dead)') : ''}`,
          `profile: ${cur?.profile ?? st?.profile ?? '(the browser default)'}`,
          `tracked elements: ${observer.byRef.size}`,
        ].join('\n'))
      },
    })

    // 卸载时不杀浏览器：它就是"持久运行时环境"，下次还要复用。
    ctx.on?.('dispose', () => { live = null })
    process.once('exit', () => { live = null })
  },
}
