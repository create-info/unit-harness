/**
 * 三个手机平台的实际调用层。
 *
 * 每条命令都走 execFile 而不是 shell 字符串：设备名、输入文字、坐标都可能带引号和空格，
 * 拼进 shell 就是注入面。execFile 直接传 argv，没有这个问题。
 *
 * 三家的工具链完全不同，这里不抽象成"统一抽象层"去假装它们一样，
 * 只保证**对外输出同一件事**：可操作的控件列表 + 点击/输入/滑动/截图。
 *
 *   Android   adb  ：uiautomator dump / input tap / input text / screencap
 *   HarmonyOS hdc  ：uitest dumpLayout / uitest uiInput / snapshot_display
 *   iOS       WDA  ：HTTP JSON，/session + /source + /wda/tap + /wda/keys
 */
import { execFile } from 'node:child_process'

const TIMEOUT = 30_000

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: opts.timeout ?? TIMEOUT, maxBuffer: 32 * 1024 * 1024, encoding: 'buffer' }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        stdout: stdout ? stdout.toString('utf8') : '',
        raw: stdout || Buffer.alloc(0),
        stderr: stderr ? stderr.toString('utf8') : '',
        code: err?.code,
        err: err?.message,
      })
    })
  })
}

/** 某个命令在不在 PATH 里。不引 which，跨平台一致。 */
async function have(cmd) {
  const probe = process.platform === 'win32' ? ['where', [cmd]] : ['sh', ['-c', `command -v ${cmd}`]]
  const r = await run(probe[0], probe[1], { timeout: 5000 })
  return r.ok && r.stdout.trim().length > 0
}

// ───────────────────────────── Android ─────────────────────────────

const android = {
  name: 'android',
  tool: 'adb',

  async probe() {
    if (!(await have('adb'))) {
      return { available: false, tool: 'adb', devices: [], need: 'install Android platform-tools and put adb on PATH' }
    }
    const r = await run('adb', ['devices'])
    if (!r.ok) return { available: false, tool: 'adb', devices: [], need: r.err || 'adb devices failed' }
    // 只认 state=device 的；unauthorized/offline 都要单独说出来，否则"没设备"是个假象
    const lines = r.stdout.split('\n').slice(1).map((l) => l.trim()).filter(Boolean)
    const devices = []
    const problems = []
    for (const line of lines) {
      const [id, state] = line.split(/\s+/)
      if (!id) continue
      if (state === 'device') devices.push(id)
      else problems.push(`${id}: ${state}`)
    }
    return {
      available: devices.length > 0,
      tool: 'adb',
      devices,
      need: devices.length ? null : (problems[0] || 'no device connected (enable USB debugging and authorise this computer)'),
    }
  },

  async dump(dev) {
    const r = await run('adb', ['-s', dev, 'exec-out', 'uiautomator', 'dump', '/dev/tty'])
    if (!r.ok) throw new Error(r.stderr.trim() || r.err || 'uiautomator dump failed')
    // 有些设备会把 dump 结果写到文件路径而不是 /dev/tty，这时 stdout 里没有 XML
    if (!r.stdout.includes('<hierarchy')) {
      throw new Error(`uiautomator did not return XML: ${r.stdout.trim().slice(0, 120) || '(empty)'}`)
    }
    return r.stdout
  },

  async tap(dev, x, y) {
    const r = await run('adb', ['-s', dev, 'shell', 'input', 'tap', String(Math.round(x)), String(Math.round(y))])
    if (!r.ok) throw new Error(r.stderr.trim() || r.err)
  },

  async swipe(dev, x1, y1, x2, y2, ms = 300) {
    const r = await run('adb', ['-s', dev, 'shell', 'input', 'swipe',
      ...[x1, y1, x2, y2].map((v) => String(Math.round(v))), String(ms)])
    if (!r.ok) throw new Error(r.stderr.trim() || r.err)
  },

  async type(dev, text) {
    // adb shell input text 不认识空格和不少符号，%s 才是空格
    const escaped = text.replace(/([\\"'`$&|;<>()*?[\]{}#~!])/g, '\\$1').replace(/ /g, '%s')
    const r = await run('adb', ['-s', dev, 'shell', 'input', 'text', escaped])
    if (!r.ok) throw new Error(r.stderr.trim() || r.err)
  },

  async key(dev, name) {
    const KEY = { back: 'KEYCODE_BACK', home: 'KEYCODE_HOME', enter: 'KEYCODE_ENTER', recents: 'KEYCODE_APP_SWITCH' }
    const code = KEY[name] || (name.startsWith('KEYCODE_') ? name : null)
    if (!code) throw new Error(`unknown key "${name}" (use back / home / enter / recents)`)
    const r = await run('adb', ['-s', dev, 'shell', 'input', 'keyevent', code])
    if (!r.ok) throw new Error(r.stderr.trim() || r.err)
  },

  async shot(dev) {
    const r = await run('adb', ['-s', dev, 'exec-out', 'screencap', '-p'])
    if (!r.ok || r.raw.length === 0) throw new Error(r.stderr.trim() || r.err || 'screencap returned nothing')
    return r.raw
  },
}

// ───────────────────────────── HarmonyOS ─────────────────────────────

const harmony = {
  name: 'harmony',
  tool: 'hdc',

  async probe() {
    if (!(await have('hdc'))) {
      return { available: false, tool: 'hdc', devices: [], need: 'install HarmonyOS Command Line Tools (hdc) from DevEco Studio' }
    }
    const r = await run('hdc', ['list', 'targets'])
    if (!r.ok) return { available: false, tool: 'hdc', devices: [], need: r.err || 'hdc list targets failed' }
    const devices = r.stdout.split('\n').map((l) => l.trim())
      .filter((l) => l && !/^\[Empty\]$/i.test(l) && !/^error/i.test(l))
    return {
      available: devices.length > 0,
      tool: 'hdc',
      devices,
      need: devices.length ? null : 'no device connected (enable USB debugging in Developer options)',
    }
  },

  async dump(dev) {
    const remote = '/data/local/tmp/uh-layout.json'
    const w = await run('hdc', ['-t', dev, 'shell', 'uitest', 'dumpLayout', '-p', remote])
    if (!w.ok) throw new Error(w.stderr.trim() || w.err || 'uitest dumpLayout failed')
    // dumpLayout 只写设备端文件，要单独拉回来
    const r = await run('hdc', ['-t', dev, 'file', 'recv', remote, '-'])
    if (!r.ok || !r.stdout.includes('{')) {
      // 拿不到用文件内容的话，退一步让 hdc 直接打印
      const cat = await run('hdc', ['-t', dev, 'shell', 'cat', remote])
      if (!cat.ok || !cat.stdout.includes('{')) {
        throw new Error(`could not read the layout dump: ${r.stderr.trim() || r.err || 'empty'}`)
      }
      return cat.stdout
    }
    return r.stdout
  },

  async tap(dev, x, y) {
    const r = await run('hdc', ['-t', dev, 'shell', 'uitest', 'uiInput', 'click',
      String(Math.round(x)), String(Math.round(y))])
    if (!r.ok) throw new Error(r.stderr.trim() || r.err)
  },

  async swipe(dev, x1, y1, x2, y2) {
    const r = await run('hdc', ['-t', dev, 'shell', 'uitest', 'uiInput', 'swipe',
      ...[x1, y1, x2, y2].map((v) => String(Math.round(v)))])
    if (!r.ok) throw new Error(r.stderr.trim() || r.err)
  },

  async type(dev, text, focus) {
    // 新版 uiInput inputText 需要焦点坐标；没有坐标说明没人点过输入框
    if (!focus) throw new Error('HarmonyOS needs a focused field: tap the textbox first, then type')
    const r = await run('hdc', ['-t', dev, 'shell', 'uitest', 'uiInput', 'inputText',
      String(Math.round(focus.x)), String(Math.round(focus.y)), text])
    if (!r.ok) throw new Error(r.stderr.trim() || r.err)
  },

  async key(dev, name) {
    const KEY = { back: 'Back', home: 'Home', enter: 'Enter' }
    const k = KEY[name]
    if (!k) throw new Error(`unknown key "${name}" (use back / home / enter)`)
    const r = await run('hdc', ['-t', dev, 'shell', 'uitest', 'uiInput', 'keyEvent', k])
    if (!r.ok) throw new Error(r.stderr.trim() || r.err)
  },

  async shot(dev) {
    const remote = '/data/local/tmp/uh-screen.jpeg'
    const w = await run('hdc', ['-t', dev, 'shell', 'snapshot_display', '-f', remote])
    if (!w.ok) throw new Error(w.stderr.trim() || w.err || 'snapshot_display failed')
    const r = await run('hdc', ['-t', dev, 'file', 'recv', remote, '-'])
    if (!r.ok || r.raw.length === 0) throw new Error(r.stderr.trim() || 'could not pull the screenshot')
    return r.raw
  },
}

// ───────────────────────────── iOS (WebDriverAgent) ─────────────────────────────

/**
 * iOS 是三个里最绕的，原因值得写清楚：
 * 真机上的点击和读取控件树只能通过 WebDriverAgent，而 WDA 必须用 Xcode 签一次名
 * 装到设备上。我们不去自动装（要 Apple 开发者账号、要用户信任证书），
 * 所以这里做的是 **attach 到用户已经跑起来的 WDA**，端口默认 8100。
 *
 * 模拟器不走这条：simctl 只能截图，不能可靠地点击，所以如实报不可用，不留假开关。
 */
const ios = {
  name: 'ios',
  tool: 'WebDriverAgent',
  baseUrl: process.env.UH_WDA_URL || 'http://127.0.0.1:8100',
  _sid: null,

  async call(method, path, body) {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 25_000)
    try {
      const r = await fetch(this.baseUrl + path, {
        method,
        signal: ctrl.signal,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      })
      const text = await r.text()
      let json = null
      try { json = JSON.parse(text) } catch { /* 有的端点返回纯文本 */ }
      if (!r.ok) {
        const msg = json?.value?.error || json?.value?.message || text.slice(0, 200)
        throw new Error(`${method} ${path} -> ${r.status}: ${msg}`)
      }
      return json ?? text
    } finally {
      clearTimeout(t)
    }
  },

  async probe() {
    try {
      const st = await this.call('GET', '/status')
      const ready = st?.value?.ready ?? st?.status === 0
      const state = st?.value?.state || ''
      return {
        available: Boolean(ready),
        tool: 'WebDriverAgent',
        devices: [`${st?.value?.device || st?.sessionId ? 'device' : 'device'} @ ${this.baseUrl}`],
        need: ready ? null : `WDA is reachable but not ready (${state || 'unknown state'})`,
        note: 'attach only — start WDA yourself once (Xcode signs it), then this can drive the phone',
      }
    } catch (e) {
      return {
        available: false,
        tool: 'WebDriverAgent',
        devices: [],
        need: `no WebDriverAgent at ${this.baseUrl}. On a Mac: build & run WebDriverAgentRunner on the device `
          + `(or use Appium), then retry. Set UH_WDA_URL if it runs elsewhere.`,
      }
    }
  },

  async session() {
    if (this._sid) return this._sid
    const r = await this.call('POST', '/session', { capabilities: { alwaysMatch: { 'appium:automationName': 'XCUITest' } } })
    const sid = r?.value?.sessionId || r?.sessionId
    if (!sid) throw new Error('WDA did not return a session id')
    this._sid = sid
    return sid
  },

  async dump() {
    const sid = await this.session()
    const r = await this.call('GET', `/session/${sid}/source?format=json`)
    const xml = typeof r === 'string' ? r : (r?.value || '')
    if (!xml.includes('XCUIElementType')) throw new Error('WDA source did not contain an element tree')
    return xml
  },

  async tap(_dev, x, y) {
    const sid = await this.session()
    // /wda/tap/0 是"按坐标点且不带元素"，比 /wda/element/0/click 稳
    await this.call('POST', `/session/${sid}/wda/tap/0`, { x: Math.round(x), y: Math.round(y) })
  },

  async swipe(_dev, x1, y1, x2, y2, ms = 300) {
    const sid = await this.session()
    await this.call('POST', `/session/${sid}/wda/dragfromtoforduration`, {
      fromX: Math.round(x1), fromY: Math.round(y1),
      toX: Math.round(x2), toY: Math.round(y2),
      duration: ms / 1000,
    })
  },

  async type(_dev, text) {
    const sid = await this.session()
    await this.call('POST', `/session/${sid}/wda/keys`, { value: [...text] })
  },

  async key(_dev, name) {
    // iOS 没有系统返回键，只有 home
    if (name !== 'home') throw new Error('iOS has no hardware back key; use phone_tap or a swipe-back gesture instead')
    const sid = await this.session()
    await this.call('POST', `/session/${sid}/wda/homescreen`)
  },

  async shot() {
    const sid = await this.session()
    const r = await this.call('GET', `/session/${sid}/screenshot`)
    const b64 = r?.value || r
    if (typeof b64 !== 'string' || b64.length < 100) throw new Error('WDA returned no screenshot data')
    return Buffer.from(b64, 'base64')
  },
}

export const drivers = { android, harmony, ios }
export const ALL = [android, harmony, ios]
export { run, have }
