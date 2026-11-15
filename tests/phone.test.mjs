/**
 * 手机插件的解析层测试。
 *
 * 这台机器上没有 adb / hdc / WDA，也没有设备，所以测试的不是"真的点了手机"，
 * 而是三件事：
 *   1) 三个平台的真实 dump 格式能被解析成同一套节点（fixture 按官方输出格式构造）；
 *   2) 该丢的丢掉——不可见的、零尺寸的、点了也不响的布局容器，留着只会污染上下文；
 *   3) 拿不到设备时报告的是具体缺什么，而不是一句"不可用"。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const load = (rel) => import(pathToFileURL(path.join(here, '..', 'plugins', rel)).href)

const { parseUiAutomatorXml, parseHarmonyLayout, parseWdaSource } = await load('phone/parse.js')
const { Observer } = await load('shared/observe.js')

const UIA = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
<node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.android.settings" content-desc="" clickable="false" enabled="true" bounds="[0,0][1080,2400]">
  <node index="0" text="Search settings" resource-id="com.android.settings:id/search_action_bar" class="android.widget.EditText" content-desc="Search" clickable="true" enabled="true" focused="true" bounds="[0,100][1080,240]"/>
  <node index="1" text="Network &amp; internet" resource-id="" class="android.widget.TextView" content-desc="" clickable="false" enabled="true" bounds="[40,300][400,360]"/>
  <node index="2" text="" resource-id="com.android.settings:id/btn" class="android.widget.Button" content-desc="More options" clickable="true" enabled="false" bounds="[900,100][1050,240]"/>
  <node index="3" text="invisible" resource-id="" class="android.widget.Button" content-desc="" clickable="true" enabled="true" bounds="[0,0][0,0]"/>
  <node index="4" text="" resource-id="" class="android.view.View" content-desc="" clickable="false" enabled="true" bounds="[0,400][1080,500]"/>
</node>
</hierarchy>`

test('uiautomator dump becomes the same node shape the observer speaks', () => {
  const nodes = parseUiAutomatorXml(UIA)
  const byName = Object.fromEntries(nodes.map((n) => [n.name, n]))

  assert.ok(byName['Search'], 'content-desc wins over text for the search field')
  assert.equal(byName['Search'].role, 'textbox')
  assert.deepEqual(byName['Search'].id, { x: 0, y: 100, w: 1080, h: 140 })
  assert.ok(byName['Search'].flags.includes('focused'))

  // 纯文本也要留着：模型得看见菜单上有哪些选项
  assert.equal(byName['Network & internet'].role, 'text')

  assert.equal(byName['More options'].role, 'button')
  assert.ok(byName['More options'].flags.includes('disabled'))

  // 零尺寸和非可点击的布局容器不该出现
  assert.ok(!byName['invisible'], 'zero-size nodes are dropped')
  assert.equal(nodes.filter((n) => n.role === 'button').length, 1, 'the non-clickable View is dropped')
})

const HARMONY = {
  attributes: { type: 'Root', bounds: '[0,0][1260,2720]' },
  children: [
    { attributes: { type: 'TextInput', text: '', accessibilityId: 'search_box', bounds: '[0,100][1260,220]' }, children: [] },
    { attributes: { type: 'Button', text: '确定', clickable: 'true', enabled: 'true', bounds: '[900,200][1200,300]' }, children: [] },
    { attributes: { type: 'Text', text: '设置', bounds: '[40,300][400,360]' }, children: [] },
    { attributes: { type: 'Button', text: '已禁用', clickable: 'true', enabled: 'false', bounds: '[40,400][200,460]' }, children: [] },
  ],
}

test('harmony uitest dumpLayout flattens children into the same shape', () => {
  const nodes = parseHarmonyLayout(HARMONY)
  const names = nodes.map((n) => n.name)

  assert.deepEqual(names, ['search_box', '确定', '设置', '已禁用'])
  assert.equal(nodes[0].role, 'textbox')
  assert.equal(nodes[1].role, 'button')
  assert.equal(nodes[2].role, 'text')
  assert.ok(nodes[3].flags.includes('disabled'))
  assert.deepEqual(nodes[1].id, { x: 900, y: 200, w: 300, h: 100 })
})

test('harmony parser accepts a raw JSON string too', () => {
  const nodes = parseHarmonyLayout(JSON.stringify(HARMONY))
  assert.equal(nodes.length, 4)
})

const WDA = `<?xml version="1.0" encoding="UTF-8"?>
<AppiumAUT>
<XCUIElementTypeApplication name="Settings" x="0" y="0" width="390" height="844" visible="true">
  <XCUIElementTypeButton name="General" label="General" x="0" y="100" width="390" height="44" visible="true" enabled="true"/>
  <XCUIElementTypeStaticText name="Settings" x="100" y="40" width="190" height="30" visible="true"/>
  <XCUIElementTypeButton name="hidden" x="0" y="0" width="10" height="10" visible="false"/>
  <XCUIElementTypeTextField name="Wi-Fi" value="" x="0" y="200" width="390" height="44" visible="true"/>
</XCUIElementTypeApplication>
</AppiumAUT>`

test('WDA source drops invisible elements and keeps fields', () => {
  const nodes = parseWdaSource(WDA)
  const names = nodes.map((n) => n.name)

  assert.ok(names.includes('General'))
  assert.ok(names.includes('Settings'))
  assert.ok(names.includes('Wi-Fi'), 'an empty text field is still worth showing')
  assert.ok(!names.includes('hidden'), 'visible=false elements cannot be tapped, so they are dropped')

  const general = nodes.find((n) => n.name === 'General')
  assert.equal(general.role, 'button')
  assert.deepEqual(general.id, { x: 0, y: 100, w: 390, h: 44 })
})

test('the observer keeps refs stable when an unrelated element appears', () => {
  const o = new Observer()
  const first = o.observe([
    { role: 'button', name: 'Save', id: { x: 0, y: 0, w: 10, h: 10 } },
    { role: 'button', name: 'Cancel', id: { x: 20, y: 0, w: 10, h: 10 } },
  ])
  const saveRef = /- button "Save" \[ref=(e\d+)\]/.exec(first.text)[1]

  // 一个新元素插进来了，Save 还是 Save，不该换 ref
  const second = o.observe([
    { role: 'button', name: 'Save', id: { x: 0, y: 0, w: 10, h: 10 } },
    { role: 'button', name: 'Cancel', id: { x: 20, y: 0, w: 10, h: 10 } },
    { role: 'button', name: 'Delete', id: { x: 40, y: 0, w: 10, h: 10 } },
  ])
  const saveRef2 = /- button "Save" \[ref=(e\d+)\]/.exec(second.text)[1]

  assert.equal(saveRef, saveRef2, 'a stable element must keep its ref')
  assert.deepEqual(second.added.map((l) => /"([^"]+)"/.exec(l)[1]), ['Delete'])
  assert.equal(second.removed.length, 0)
})

test('the observer notices an element disappearing, not just appearing', () => {
  const o = new Observer()
  o.observe([
    { role: 'button', name: 'OK', id: { x: 0, y: 0, w: 10, h: 10 } },
    { role: 'button', name: 'Skip', id: { x: 20, y: 0, w: 10, h: 10 } },
  ])
  const after = o.observe([{ role: 'button', name: 'OK', id: { x: 0, y: 0, w: 10, h: 10 } }])
  assert.equal(after.removed.length, 1)
  assert.match(after.removed[0], /Skip/)
})

test('phone_status names what each platform is missing instead of saying "unavailable"', async () => {
  const tools = new Map()
  const mod = (await load('phone/index.js')).default
  mod.apply({
    config: {},
    log: { info: () => {} },
    on: () => {},
    tools: { register: (t) => tools.set(t.name, t) },
  })
  const out = (await tools.get('phone_status').handler({})).content

  // 三个平台都必须出现在报告里——只支持 Android 是半个功能
  for (const p of ['android', 'harmony', 'ios']) {
    assert.match(out, new RegExp(p), `${p} should be reported`)
  }
  // 没装工具时不能只说"不可用"，得说装什么
  assert.match(out, /adb/)
  assert.match(out, /hdc/)
  assert.match(out, /WebDriverAgent/)
})
