/**
 * 浏览器插件端到端验证：在同一个进程里连续调用工具，模拟 agent 一轮里的连续动作。
 *
 * 为什么必须这样测：uh tool 每次是新进程，插件的 ref 映射和增量基线都不共享，
 * 单独调用永远测不到"点上一眼看到的那个按钮"。
 *
 * 页面用 data: URL 而不是真实站点：这台机器的 snap chromium 连不上外网
 * （TLS 层 ERR_ACCESS_DENIED），而 data: 不联网也能把
 * snapshot / type / 回读 / click / 增量 look 整条链路跑完。
 */
import { pathToFileURL } from 'node:url'

const plugin = (await import(pathToFileURL(process.env.PLUGIN || './plugins/browser/index.js').href)).default

const tools = new Map()
const ctx = {
  config: {},
  log: { info: (m) => console.log('  [log]', m) },
  on: () => {},
  tools: { register: (t) => { tools.set(t.name, t) } },
}

plugin.apply(ctx)

const call = async (name, args = {}) => {
  const t = tools.get(name)
  if (!t) throw new Error(`no tool ${name}`)
  const r = await t.handler(args)
  return r?.content ?? String(r)
}

const show = (label, out) => {
  console.log(`\n=== ${label} ===`)
  console.log(out)
}

const t0 = Date.now()
const step = (m) => console.log(`\n⏱  ${((Date.now() - t0) / 1000).toFixed(1)}s  ${m}`)

const PAGE = 'data:text/html,' + encodeURIComponent(`<!doctype html><meta charset=utf-8>
<title>Probe</title>
<h1>Probe page</h1>
<label>Email <input id=e></label>
<button id=b onclick="document.getElementById('out').textContent='hit:'+document.getElementById('e').value">Submit</button>
<div id=out>idle</div>
<a href="#x">A link</a>`)

let failures = 0
const check = (label, cond, detail = '') => {
  console.log(`   ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}

step('open a page with an input and a button')
const opened = await call('browser_open', { url: PAGE })
show('open', opened)

const refsOf = (text, role) => [...text.matchAll(new RegExp(`- ${role} "[^"]*" \\[ref=(e\\d+)\\]`, 'g'))].map((m) => m[1])
const inputRef = refsOf(opened, 'textbox')[0] || refsOf(opened, 'searchbox')[0]
const btnRef = refsOf(opened, 'button')[0]

check('page exposed a textbox', Boolean(inputRef), inputRef || 'none')
check('page exposed a button', Boolean(btnRef), btnRef || 'none')
check('heading kept in the snapshot', /heading "Probe page"/.test(opened))

step(`type into ${inputRef}`)
const typed = await call('browser_type', { ref: inputRef, text: 'hi@x.io' })
show('type', typed)
check('readback confirms the typed value', /readback: yes/.test(typed))

step(`click ${btnRef}`)
const clicked = await call('browser_click', { ref: btnRef })
show('click', clicked)
check('click reports the page changed', /changed: yes/.test(clicked))

step('look again — should be incremental')
const looked = await call('browser_look', {})
show('look', looked)

step('look fresh — whole page again')
const fresh = await call('browser_look', { fresh: true })
show('fresh', fresh.slice(0, 400))

const btnRef2 = refsOf(fresh, 'button')[0]
check('button ref stays stable across looks', btnRef2 === btnRef, `${btnRef} -> ${btnRef2}`)

step('a stale ref must be refused, not silently mis-clicked')
const bogus = await call('browser_click', { ref: 'e999' })
check('unknown ref rejected with a clear message', /is not on the current page/.test(bogus), bogus.slice(0, 90))

step('status')
show('status', await call('browser_status'))

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`)
process.exit(failures === 0 ? 0 : 1)
