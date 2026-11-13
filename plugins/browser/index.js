/**
 * @unit-harness/plugin-browser — 用 CDP 操作一个真实的浏览器。
 *
 * 两个决定值得先说清楚，因为它们是这个插件存在的理由：
 *
 * 1) **走 --remote-debugging-pipe，不走 --remote-debugging-port。**
 *    port 方式在 snap / 容器 / 某些企业策略下直接被挡（实测本机 snap chromium：
 *    端口在听，但 HTTP 和 WS 都被 reset）。pipe 走 fd 3/4，不过网络，拦不住。
 *    代价是浏览器必须由我们启动，不能 attach 用户手动开的那一个。
 *
 * 2) **给模型看的是裁剪过的可访问性树，不是 HTML。**
 *    实测同一个页面：DOM 273 字符、原始 AX JSON 7125 字符、裁剪后 80 字符。
 *    原始 AX 比 DOM 还大七倍——直接吐 JSON 等于自残上下文。
 *
 * 这个插件不受沙箱约束：它启动的是本机浏览器，碰的是真实网络。
 * 所以每一类动作都在 description 里写明，且不提供「读任意文件」这类能力。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

/** 只留下人和模型都会关心的角色。其余（generic / none / InlineTextBox）纯噪声。 */
const KEEP = new Set([
  'button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox',
  'listbox', 'menuitem', 'menuitemcheckbox', 'tab', 'switch', 'slider',
  'heading', 'img', 'navigation', 'main', 'form', 'dialog', 'alert', 'table',
])

/** 这些角色即使没名字也要留着——空输入框正是最需要看见的东西 */
const NAMELESS_OK = new Set(['textbox', 'searchbox', 'checkbox', 'switch', 'slider'])

const CANDIDATES = [
  process.env.UH_CHROME,
  'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser',
  'microsoft-edge', 'brave-browser',
  '/snap/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean)

function findChrome() {
  for (const c of CANDIDATES) {
    if (c.includes('/') || c.includes('\\')) {
      try { fs.accessSync(c, fs.constants.X_OK); return c } catch { /* 继续找 */ }
    } else {
      // PATH 里找，不引 which 依赖
      for (const dir of (process.env.PATH || '').split(path.delimiter)) {
        const p = path.join(dir, c)
        try { fs.accessSync(p, fs.constants.X_OK); return p } catch { /* 继续 */ }
      }
    }
  }
  return null
}

class Cdp {
  constructor(child) {
    this.child = child
    this.buf = ''
    this.id = 0
    this.pending = new Map()
    this.closed = false
    // 管道另一端是浏览器；它一死这两个流会各自抛 ECONNRESET。
    // 不接住就是未处理错误事件，整个 CLI 带着堆栈退出，看起来像插件把宿主搞崩了。
    child.stdio[4].on('error', () => { this.closed = true })
    child.stdio[3].on('error', () => { this.closed = true })
    child.stdio[4].on('data', (c) => this._onData(c))
    child.on('error', () => { this.closed = true })
    child.on('close', () => {
      this.closed = true
      for (const [, { reject }] of this.pending) reject(new Error('browser closed'))
      this.pending.clear()
    })
  }

  _onData(chunk) {
    this.buf += chunk.toString('utf8')
    let i
    while ((i = this.buf.indexOf('\0')) >= 0) {
      const raw = this.buf.slice(0, i)
      this.buf = this.buf.slice(i + 1)
      if (!raw.trim()) continue
      let m
      try { m = JSON.parse(raw) } catch { continue }
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id)
        this.pending.delete(m.id)
        m.error ? reject(new Error(m.error.message)) : resolve(m.result)
      }
    }
  }

  send(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(new Error('browser is not running'))
    const mid = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(mid, { resolve, reject })
      const msg = JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) })
      try {
        this.child.stdio[3].write(msg + '\0')
      } catch (e) {
        this.pending.delete(mid)
        reject(e)
        return
      }
      // 不设超时会挂死在那儿，用户只能杀进程
      setTimeout(() => {
        if (this.pending.has(mid)) {
          this.pending.delete(mid)
          reject(new Error(`timed out: ${method}`))
        }
      }, 20_000)
    })
  }

  kill() {
    try { this.child.kill('SIGKILL') } catch { /* 已经死了 */ }
  }
}

/** ref → backendDOMNodeId 的对应关系只在一个页面生命周期内有效 */
function makeSession(page) {
  const refs = new Map()
  return {
    page,
    refs,
    reset() { refs.clear() },
  }
}

function defaultProfile() {
  // 不要放在 os.tmpdir()：snap / 容器里的浏览器看到的是私有 /tmp，
  // 拿到的目录它写不进 lock，启动会死在 ProcessSingleton 上。
  const home = process.env.UH_HOME || path.join(os.homedir(), '.uh')
  const dir = path.join(home, 'browser', 'profile')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

async function launch(chromePath, opts) {
  const profile = opts.profileDir || defaultProfile()
  const args = [
    ...(opts.headless === false ? [] : ['--headless=new']),
    '--remote-debugging-pipe',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--window-size=1280,900',
    'about:blank',
  ]
  // root 下跑必须加这个，否则浏览器直接不启动
  if (process.getuid && process.getuid() === 0) args.unshift('--no-sandbox')

  const child = spawn(chromePath, args, { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] })
  const cdp = new Cdp(child)
  let stderr = ''
  child.stderr.on('data', (d) => { stderr += String(d) })

  // 等浏览器真的能应答，而不是等固定秒数
  const deadline = Date.now() + 20_000
  let pageSession = null
  while (Date.now() < deadline) {
    try {
      const { targetInfos } = await cdp.send('Target.getTargets')
      const page = targetInfos.find((t) => t.type === 'page')
      if (page) {
        const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: page.targetId, flatten: true })
        await cdp.send('Page.enable', {}, sessionId)
        await cdp.send('DOM.enable', {}, sessionId)
        await cdp.send('Accessibility.enable', {}, sessionId)
        await cdp.send('Runtime.enable', {}, sessionId)
        pageSession = sessionId
        break
      }
    } catch { /* 还没准备好 */ }
    await new Promise((r) => setTimeout(r, 250))
  }
  if (!pageSession) {
    cdp.kill()
    const why = stderr.split('\n').filter(Boolean).slice(-3).join(' | ')
    throw new Error('browser did not start' + (why ? ': ' + why : ''))
  }
  return { cdp, sessionId: pageSession, profile }
}

/** 把 AX 树压成一行一个节点；refs 记录 ref → backendNodeId */
function snapshotOf(nodes, refs) {
  refs.clear()
  const lines = []
  let n = 0
  for (const node of nodes) {
    if (node.ignored) continue
    const role = node.role?.value
    if (!role || !KEEP.has(role)) continue
    const name = node.name?.value ? String(node.name.value).replace(/\s+/g, ' ').trim() : ''
    if (!name && !NAMELESS_OK.has(role)) continue

    const props = {}
    for (const p of node.properties || []) props[p.name] = p.value?.value

    const ref = 'e' + (++n)
    if (node.backendDOMNodeId) refs.set(ref, node.backendDOMNodeId)

    const flags = []
    if (props.checked === true) flags.push('checked')
    if (props.disabled === true) flags.push('disabled')
    if (props.expanded === true) flags.push('expanded')
    if (props.required === true) flags.push('required')
    if (props.selected === true) flags.push('selected')

    lines.push(`- ${role} "${name.slice(0, 80)}" [ref=${ref}]${flags.length ? ' (' + flags.join(', ') + ')' : ''}`)
  }
  return lines.join('\n')
}

/** 通过 ref 找到元素的真实矩形。不能用 DOM.getBoxModel——它在 flatten session 下给错盒子 */
async function rectOf(cdp, sessionId, refs, ref) {
  const backendId = refs.get(ref)
  if (!backendId) throw new Error(`unknown ref "${ref}" — take a new snapshot`)
  const o = await cdp.send('DOM.resolveNode', { backendNodeId: backendId }, sessionId)
  // 元素可能已经被页面重渲染掉，objectId 会失效
  if (!o?.object?.objectId) throw new Error(`ref "${ref}" is gone — the page changed, take a new snapshot`)
  const r = await cdp.send('Runtime.callFunctionOn', {
    objectId: o.object.objectId,
    returnByValue: true,
    functionDeclaration: 'function(){const b=this.getBoundingClientRect();return {x:b.x,y:b.y,w:b.width,h:b.height}}',
  }, sessionId)
  return r.result.value
}

async function clickAt(cdp, sessionId, x, y) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, sessionId)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, sessionId)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, sessionId)
}

const TEXT = (s) => ({ content: String(s) })

export default {
  name: '@unit-harness/plugin-browser',
  apiVersion: 1,

  apply(ctx) {
    // 浏览器是长生命周期进程，几个工具共用一份；用完由 host 或 idle 超时收掉
    let live = null
    let launchErr = null

    const ensure = async () => {
      if (live && !live.cdp.closed) return live
      const bin = findChrome()
      if (!bin) {
        throw new Error('no Chrome or Chromium found. Set UH_CHROME=/path/to/chrome, or install one.')
      }
      const cfg = ctx.config || {}
      live = await launch(bin, { headless: cfg.headless !== false, profileDir: cfg.profileDir })
      live.sess = makeSession(live.sessionId)
      ctx.log.info(`browser started: ${bin}`)
      return live
    }

    const close = () => {
      if (live) { live.cdp.kill(); live = null }
    }

    ctx.tools.register({
      name: 'browser_open',
      description:
        'Open a URL in a real browser and return a compact snapshot of the page. '
        + 'Use this instead of fetching HTML: the snapshot lists interactive elements with refs you can click. '
        + 'The browser runs outside the sandbox and uses the real network.',
      schema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'http(s) URL to open' },
          wait_ms: { type: 'number', description: 'extra settle time after load, default 500' },
        },
        required: ['url'],
        additionalProperties: false,
      },
      async handler(args) {
        const url = String(args?.url ?? '')
        if (!/^https?:\/\//i.test(url)) return TEXT(`ERROR: only http(s) URLs are allowed, got "${url}"`)
        try {
          const l = await ensure()
          l.sess.reset()
          await l.cdp.send('Page.navigate', { url }, l.sessionId)
          // 等 load 事件比 sleep 固定毫秒可靠；失败也继续，有些页面永远不触发 load
          await new Promise((r) => setTimeout(r, 300 + Number(args?.wait_ms ?? 500)))
          const ax = await l.cdp.send('Accessibility.getFullAXTree', {}, l.sessionId)
          const nodes = (ax.nodes || []).filter((n) => !n.ignored)
          const snap = snapshotOf(nodes, l.sess.refs)
          const titleRes = await l.cdp.send('Runtime.evaluate', {
            expression: 'document.title || location.href', returnByValue: true,
          }, l.sessionId)
          return TEXT(`${titleRes.result.value}\n${url}\n\n${snap || '(no interactive elements)'}`)
        } catch (e) {
          launchErr = e.message
          return TEXT(`ERROR: ${e.message}`)
        }
      },
    })

    ctx.tools.register({
      name: 'browser_snapshot',
      description:
        'Re-read the current page and return its interactive elements with fresh refs. '
        + 'Call this after the page changes (§ refs from an older snapshot may no longer resolve).',
      schema: { type: 'object', properties: {}, additionalProperties: false },
      async handler() {
        try {
          const l = await ensure()
          const ax = await l.cdp.send('Accessibility.getFullAXTree', {}, l.sessionId)
          const snap = snapshotOf((ax.nodes || []).filter((n) => !n.ignored), l.sess.refs)
          return TEXT(snap || '(no interactive elements)')
        } catch (e) {
          return TEXT(`ERROR: ${e.message}`)
        }
      },
    })

    ctx.tools.register({
      name: 'browser_click',
      description:
        'Click an element by its ref from the latest snapshot. '
        + 'Uses real mouse events at the element centre; if the page moved since the snapshot, take a new one.',
      schema: {
        type: 'object',
        properties: { ref: { type: 'string', description: 'ref from the latest snapshot, e.g. e3' } },
        required: ['ref'],
        additionalProperties: false,
      },
      async handler(args) {
        const ref = String(args?.ref ?? '')
        try {
          const l = await ensure()
          const r = await rectOf(l.cdp, l.sessionId, l.sess.refs, ref)
          if (r.w <= 0 || r.h <= 0) return TEXT(`ERROR: ref "${ref}" has zero size — it is probably hidden`)
          const x = r.x + r.w / 2
          const y = r.y + r.h / 2
          // 点下去会落在谁头上？被遮住时坐标完全正确，点到的却是别人
          const hit = await l.cdp.send('Runtime.evaluate', {
            expression: `(()=>{const el=document.elementFromPoint(${x},${y});return el?el.tagName.toLowerCase():'none'})()`,
            returnByValue: true,
          }, l.sessionId)
          await clickAt(l.cdp, l.sessionId, x, y)
          await new Promise((r2) => setTimeout(r2, 250))
          return TEXT(`clicked ${ref} at ${Math.round(x)},${Math.round(y)} (topmost element: ${hit.result.value})`)
        } catch (e) {
          return TEXT(`ERROR: ${e.message}`)
        }
      },
    })

    ctx.tools.register({
      name: 'browser_type',
      description:
        'Focus an element by ref and type text into it using real key input (not setting .value, '
        + 'so framework state updates fire). Pass submit:true to press Enter afterwards.',
      schema: {
        type: 'object',
        properties: {
          ref: { type: 'string' },
          text: { type: 'string' },
          submit: { type: 'boolean', description: 'press Enter after typing' },
        },
        required: ['ref', 'text'],
        additionalProperties: false,
      },
      async handler(args) {
        const ref = String(args?.ref ?? '')
        const text = String(args?.text ?? '')
        try {
          const l = await ensure()
          const r = await rectOf(l.cdp, l.sessionId, l.sess.refs, ref)
          if (r.w <= 0 || r.h <= 0) return TEXT(`ERROR: ref "${ref}" has zero size — it is probably hidden`)
          await clickAt(l.cdp, l.sessionId, r.x + r.w / 2, r.y + r.h / 2)
          await l.cdp.send('Input.insertText', { text }, l.sessionId)
          if (args?.submit) {
            await l.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, l.sessionId)
            await l.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, l.sessionId)
          }
          await new Promise((r2) => setTimeout(r2, 200))
          return TEXT(`typed ${text.length} chars into ${ref}${args?.submit ? ' and pressed Enter' : ''}`)
        } catch (e) {
          return TEXT(`ERROR: ${e.message}`)
        }
      },
    })

    ctx.tools.register({
      name: 'browser_screenshot',
      description: 'Save a PNG of the current page and return its path. Use it to prove what the page looks like.',
      schema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'where to write the PNG (default: temp)' } },
        additionalProperties: false,
      },
      async handler(args) {
        try {
          const l = await ensure()
          const out = args?.path ? String(args.path) : path.join(os.tmpdir(), `uh-browser-${Date.now()}.png`)
          const { data } = await l.cdp.send('Page.captureScreenshot', { format: 'png' }, l.sessionId)
          fs.mkdirSync(path.dirname(out), { recursive: true })
          fs.writeFileSync(out, Buffer.from(data, 'base64'))
          return TEXT(`screenshot saved: ${out}`)
        } catch (e) {
          return TEXT(`ERROR: ${e.message}`)
        }
      },
    })

    // 插件卸载/进程退出时别留下一个孤儿浏览器
    ctx.on?.('dispose', close)
    process.once('exit', close)
  },
}
