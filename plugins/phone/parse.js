/**
 * 三个平台的原生控件树 → 统一的归一化节点 { role, name, flags, id }。
 *
 * 单独成文件是为了能单测：这台机器上没有设备，也没有 adb/hdc/xcrun，
 * 但抓下来的真实 dump 可以直接喂给这些函数验证解析对不对。
 *
 * 一个共同的设计取舍：只做"拍平"，不重建树。
 * 我们要的是"界面上有哪些可操作的东西、各自叫什么"，不是层次结构；
 * 拍平还能顺手解决一个真问题——手机上同一个按钮常常包着好几层 View。
 */

/**
 * 反转义 XML 实体。
 * 不做这一步的话，界面上 "Network & internet" 到了模型眼里是 "Network &amp; internet"，
 * 它照着这个名字去找元素就会找错。
 */
function unescapeXml(s) {
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')      // 必须最后，否则 &amp;lt; 会被换成 < 两次
}

/** 解析 XML 属性串。不用第三方库：uiautomator / WDA 的输出都很规整。 */
function attrs(s) {
  const out = {}
  for (const m of s.matchAll(/([A-Za-z_][\w:.-]*)="([^"]*)"/g)) out[m[1]] = unescapeXml(m[2])
  return out
}

/** "[x1,y1][x2,y2]" → {x,y,w,h} */
function parseBounds(b) {
  const m = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(b || '')
  if (!m) return null
  const [x1, y1, x2, y2] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
}

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()

/**
 * Android: `adb exec-out uiautomator dump /dev/tty`
 *
 * 节点是 <node ...> （自闭合或带子节点都有）。按出现顺序拍平即可——
 * uiautomator 输出本身就是先序的，顺序对模型理解界面有用。
 */
export function parseUiAutomatorXml(xml) {
  const nodes = []
  const CLASS_ROLE = {
    'android.widget.Button': 'button',
    'android.widget.ImageButton': 'button',
    'android.widget.EditText': 'textbox',
    'android.widget.AutoCompleteTextView': 'combobox',
    'android.widget.CheckBox': 'checkbox',
    'android.widget.RadioButton': 'radio',
    'android.widget.Switch': 'switch',
    'android.widget.ToggleButton': 'switch',
    'android.widget.Spinner': 'combobox',
    'android.widget.ImageView': 'img',
    'android.widget.TextView': 'text',
    'android.widget.SeekBar': 'slider',
    'androidx.appcompat.widget.SwitchCompat': 'switch',
  }

  for (const m of xml.matchAll(/<node\b([^>]*?)\/?>/g)) {
    const a = attrs(m[1])
    const cls = a.class || ''
    let role = CLASS_ROLE[cls]

    // 没登记的 class：可点的视图当按钮处理，否则丢弃。
    // 手机界面里大量 View 只用来布局，全保留只会把上下文塞满。
    if (!role) {
      if (a.clickable === 'true' && a.enabled !== 'false') role = 'button'
      else if (!a.clickable || a.clickable === 'false') continue
    }

    const name = clean(a['content-desc']) || clean(a.text)
      // 没有可见文字时退到 resource-id 的末段：'com.x:id/search_button' → 'search_button'
      || (a['resource-id'] ? a['resource-id'].split('/').pop() : '')
    const rect = parseBounds(a.bounds)
    if (!rect || rect.w <= 0 || rect.h <= 0) continue

    const flags = []
    if (a.checked === 'true') flags.push('checked')
    if (a.enabled === 'false') flags.push('disabled')
    if (a.selected === 'true') flags.push('selected')
    if (a.focused === 'true') flags.push('focused')

    nodes.push({ role, name, flags, id: rect })
  }
  return nodes
}

/**
 * HarmonyOS: `hdc shell uitest dumpLayout`
 * 输出是带 attributes / children 的 JSON。attributes.bounds 形状同 Android。
 */
export function parseHarmonyLayout(json) {
  const root = typeof json === 'string' ? JSON.parse(json) : json
  const nodes = []
  const TYPE_ROLE = {
    Button: 'button',
    Text: 'text',
    TextInput: 'textbox',
    SearchField: 'searchbox',
    Checkbox: 'checkbox',
    Radio: 'radio',
    Toggle: 'switch',
    Image: 'img',
    Slider: 'slider',
    List: 'listbox',
    Grid: 'listbox',
  }

  const walk = (n) => {
    if (!n) return
    const a = n.attributes || {}
    let role = TYPE_ROLE[a.type]
    if (!role) {
      if (a.clickable === 'true' || a.clickable === true) role = 'button'
      else if (a.type && /Button|Item|Tab/i.test(a.type)) role = 'button'
    }
    if (role) {
      const name = clean(a.text) || clean(a.accessibilityId) || clean(a.id) || ''
      const rect = parseBounds(a.bounds)
      if (rect && rect.w > 0 && rect.h > 0) {
        const flags = []
        if (a.checked === 'true' || a.checked === true) flags.push('checked')
        if (a.enabled === 'false' || a.enabled === false) flags.push('disabled')
        if (a.selected === 'true' || a.selected === true) flags.push('selected')
        nodes.push({ role, name, flags, id: rect })
      }
    }
    for (const c of n.children || []) walk(c)
  }
  walk(root)
  return nodes
}

/**
 * iOS: WebDriverAgent `GET /session/<id>/source`
 * 元素是 <XCUIElementTypeXxx ...>，坐标是 x/y/width/height 四个属性。
 */
export function parseWdaSource(xml) {
  const nodes = []
  const MAP = {
    XCUIElementTypeButton: 'button',
    XCUIElementTypeStaticText: 'text',
    XCUIElementTypeTextField: 'textbox',
    XCUIElementTypeSecureTextField: 'textbox',
    XCUIElementTypeSearchField: 'searchbox',
    XCUIElementTypeTextView: 'textbox',
    XCUIElementTypeSwitch: 'switch',
    XCUIElementTypeSlider: 'slider',
    XCUIElementTypeImage: 'img',
    XCUIElementTypeLink: 'link',
    XCUIElementTypeCell: 'menuitem',
    XCUIElementTypeTab: 'tab',
  }

  for (const m of xml.matchAll(/<(XCUIElementType[A-Za-z]+)\b([^>]*?)\/?>/g)) {
    const tag = m[1]
    const role = MAP[tag]
    if (!role) continue
    const a = attrs(m[2])
    // visible="false" 的元素点不到，留着只会让模型对着不可见的东西发指令
    if (a.visible === 'false') continue

    const name = clean(a.name) || clean(a.label) || clean(a.value) || ''
    const x = Number(a.x), y = Number(a.y), w = Number(a.width), h = Number(a.height)
    if (!Number.isFinite(x) || !Number.isFinite(w) || w <= 0 || h <= 0) continue

    const flags = []
    if (a.enabled === 'false') flags.push('disabled')
    if (a.selected === 'true') flags.push('selected')
    if (a.focused === 'true') flags.push('focused')

    nodes.push({ role, name, flags, id: { x, y, w, h } })
  }
  return nodes
}

export { parseBounds, attrs }
