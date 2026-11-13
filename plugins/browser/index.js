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

// ─────────────────────────── 常量 ───────────────────────────

/** 只留下有语义的角色。generic / none / InlineTextBox 纯噪声。 */
const KEEP = new Set([
  'button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox',
  'listbox', 'menuitem', 'menuitemcheckbox', 'tab', 'switch', 'slider',
  'heading', 'img', 'navigation', 'main', 'form', 'dialog', 'alert', 'table', 'row',
])

/** 这些角色没名字也要留着——空输入框正是最需要看见的 */
const NAMELESS_OK = new Set(['textbox', 'searchbox', 'checkbox', 'switch', 'slider'])

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

/** 用户真实浏览器的 profile 目录。用真实 profile 才带登录态、书签和扩展。 */
function realProfile(bin) {
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
 * 自己起一个。两条路：
 *   port 模式：能被下一次 attach 复用，也能配真实 profile
 *   pipe 模式：port 被环境挡住时的兜底（snap chromium 实测：端口在听但 WS 被 reset）
 */
async function launchOwn(bin, opts) {
  const profile = opts.profileDir || realProfile(bin)
  const usePort = opts.port !== false
  const port = opts.port === true ? 9222 : (opts.port || 9222)

  const args = ['--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1280,900']
  if (opts.headless !== false) args.push('--headless=new')
  args.push(usePort ? `--remote-debugging-port=${port}` : '--remote-debugging-pipe')
  args.push(`--user-data-dir=${profile}`, 'about:blank')
  if (process.getuid && process.getuid() === 0) args.unshift('--no-sandbox')

  const child = spawn(bin, args, {
    // 端口模式也要留 stderr：不然"起不来"就只剩一句没有原因的话。
    // fd 3/4 只有 pipe 模式用得上。
    stdio: usePort ? ['ignore', 'ignore', 'pipe', 'ignore', 'ignore'] : ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
    detached: true,
  })
  let stderr = ''
  if (child.stderr) child.stderr.on('data', (d) => { stderr += String(d) })

  if (!usePort) {
    const transport = new PipeTransport(child)
    const sessionId = await waitForPage(transport, () => stderr)
    return { transport, mode: 'launch-pipe', port: null, pid: child.pid, sessionId, profile }
  }

  child.unref()
  const deadline = Date.now() + 25_000
  while (Date.now() < deadline) {
    const got = await attach(port)
    if (got) return { ...got, mode: 'launch', pid: child.pid, profile }
    if (!alive(child.pid)) break
    await new Promise((r) => setTimeout(r, 300))
  }
  try { process.kill(child.pid, 'SIGKILL') } catch { /* 已退出 */ }

  // 端口起不来最常见的原因就是 profile 被占用，把原因翻成人话
  if (/ProcessSingleton|SingletonLock/i.test(stderr)) {
    throw new Error(
      'Chrome is already running with this profile, so it will not open a debug port. '
      + 'Close Chrome and retry, or start it yourself with --remote-debugging-port=9222.',
    )
  }
  const why = stderr.split('\n').filter(Boolean).slice(-2).join(' | ')
  throw new Error('browser did not start' + (why ? ': ' + why : ''))
}

// ─────────────────────────── 增量观察 ───────────────────────────

/**
 * 把 AX 树压成"一行一个节点"，并让 ref 在页面变化之间保持稳定。
 *
 * 稳定性来自 fingerprint = role | name | 同类第几个。
 * 同一个按钮在局部刷新后仍拿同一个 ref，模型不必重新学一遍页面；
 * 只有真的增删改才出现在 diff 里，上下文于是只承载"变化"。
 */
class Observer {
  constructor() {
    this.prev = new Map()    // fingerprint -> { ref, line, backendId }
    this.byRef = new Map()   // ref -> backendDOMNodeId（当前有效）
    this.lastRef = 0
  }

  observe(nodes) {
    const lines = []
    const added = []
    const removed = []
    const updated = []
    const seen = new Set()
    const ordinal = new Map()

    for (const node of nodes) {
      if (node.ignored) continue
      const role = node.role?.value
      if (!role || !KEEP.has(role)) continue
      const name = node.name?.value ? String(node.name.value).replace(/\s+/g, ' ').trim() : ''
      if (!name && !NAMELESS_OK.has(role)) continue

      const props = {}
      for (const p of node.properties || []) props[p.name] = p.value?.value

      const flags = []
      if (props.checked === true) flags.push('checked')
      if (props.disabled === true) flags.push('disabled')
      if (props.expanded === true) flags.push('expanded')
      if (props.required === true) flags.push('required')
      if (props.selected === true) flags.push('selected')

      // 同 role+name 可能多个（多个相同按钮、列表项），用出现次序区分
      const key = `${role}|${name}`
      const nth = (ordinal.get(key) ?? 0) + 1
      ordinal.set(key, nth)
      const fp = `${key}|${nth}`
      seen.add(fp)

      const shape = `- ${role} "${name.slice(0, 80)}"`
      const tail = `${flags.length ? ' (' + flags.join(', ') + ')' : ''}`
      let entry = this.prev.get(fp)

      if (!entry) {
        const ref = 'e' + (++this.lastRef)
        entry = { ref, shape, tail, backendId: node.backendDOMNodeId }
        this.prev.set(fp, entry)
        added.push(`${shape} [ref=${ref}]${tail}`)
      } else {
        // 指纹没变说明还是同一个元素，只更新后端句柄和变化过的属性
        if (entry.tail !== tail) {
          entry.tail = tail
          updated.push(`${shape} [ref=${entry.ref}]${tail}`)
        }
        entry.backendId = node.backendDOMNodeId
      }
      lines.push(`${entry.shape} [ref=${entry.ref}]${entry.tail}`)
    }

    // 上一轮有、这一轮没有了
    for (const [fp, entry] of [...this.prev]) {
      if (!seen.has(fp)) {
        removed.push(`${entry.shape} [ref=${entry.ref}]${entry.tail}`)
        this.prev.delete(fp)
      }
    }

    // ref → backendDOMNodeId 只留这轮还在的
    this.byRef.clear()
    for (const entry of this.prev.values()) {
      if (entry.backendId) this.byRef.set(entry.ref, entry.backendId)
    }

    return {
      text: lines.join('\n'),
      changed: added.length > 0 || removed.length > 0 || updated.length > 0,
      added, removed, updated,
    }
  }

  reset() {
    this.prev.clear()
    this.byRef.clear()
    this.lastRef = 0
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

async function axNodes(cdp, sessionId) {
  const ax = await cdp.send('Accessibility.getFullAXTree', {}, sessionId)
  return (ax.nodes || []).filter((n) => !n.ignored)
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

function describe(o) {
  const parts = []
  if (o.added.length) parts.push('added:\n' + o.added.map((x) => '  ' + x).join('\n'))
  if (o.removed.length) parts.push('gone:\n' + o.removed.map((x) => '  ' + x).join('\n'))
  if (o.updated.length) parts.push('changed:\n' + o.updated.map((x) => '  ' + x).join('\n'))
  return parts.join('\n')
}

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
        if (!/^https?:\/\//i.test(url)) return TEXT(`ERROR: only http(s) URLs are allowed, got "${url}"`)
        try {
          const l = await connect()
          const before = await pageSignature(l.transport, l.sessionId).catch(() => '')
          if (args?.fresh) observer.reset()
          await l.transport.send('Page.navigate', { url }, l.sessionId)
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

          return TEXT(
            `typed ${text.length} chars into ${ref}${args?.submit ? ' + Enter' : ''}\n`
            + `readback: ${verdict}\n` + report(res),
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
