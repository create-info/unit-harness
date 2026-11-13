/**
 * 语义树的增量观察器。浏览器和手机共用这一份，避免两处逻辑慢慢漂移。
 *
 * 输入是归一化节点 { role, name, flags, id }：
 * 浏览器把 CDP 的 AX 树转成它，手机把 uiautomator / uitest / WDA 的控件树转成它。
 *
 * 两件事同时被解决：
 *   - ref 稳定：fingerprint = role|name|同类第几，界面局部刷新后同一个按钮还是同一个 ref，
 *     模型不用重新学一遍界面；
 *   - 增量输出：只有真的增删改才出现在 diff 里，上下文只承载"变化"。
 */

/** 只留下有语义的角色。generic / none / InlineTextBox 这类纯噪声一律丢掉。 */
export const KEEP = new Set([
  'button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox',
  'listbox', 'menuitem', 'menuitemcheckbox', 'tab', 'switch', 'slider',
  'heading', 'img', 'navigation', 'main', 'form', 'dialog', 'alert', 'table', 'row',
])

/** 这些角色没名字也要留着——空输入框正是最需要看见的东西 */
export const NAMELESS_OK = new Set(['textbox', 'searchbox', 'checkbox', 'switch', 'slider'])

export class Observer {
  /**
   * extraRoles: 调用方额外的角色。
   * 手机界面上文字本身就是内容（菜单项、列表项），所以要收 'text'；
   * 网页里 StaticText 遍地都是，收进来只会把上下文塞满——所以浏览器不收。
   */
  constructor(extraRoles) {
    this.keep = extraRoles ? new Set([...KEEP, ...extraRoles]) : KEEP
    this.prev = new Map()    // fingerprint -> { ref, shape, tail, id }
    this.byRef = new Map()   // ref -> id（当前有效的元素句柄）
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
      const { role, name = '', flags = [], id } = node
      if (!role || !this.keep.has(role)) continue
      if (!name && !NAMELESS_OK.has(role)) continue

      // 同 role+name 可能多个（多个相同按钮、列表项），用出现次序区分
      const key = `${role}|${name}`
      const nth = (ordinal.get(key) ?? 0) + 1
      ordinal.set(key, nth)
      const fp = `${key}|${nth}`
      seen.add(fp)

      const shape = `- ${role} "${name.slice(0, 80)}"`
      const tail = flags.length ? ' (' + flags.join(', ') + ')' : ''
      let entry = this.prev.get(fp)

      if (!entry) {
        const ref = 'e' + (++this.lastRef)
        entry = { ref, shape, tail, id }
        this.prev.set(fp, entry)
        added.push(`${shape} [ref=${ref}]${tail}`)
      } else {
        // 指纹没变说明还是同一个元素，只更新句柄和变化过的属性
        if (entry.tail !== tail) {
          entry.tail = tail
          updated.push(`${shape} [ref=${entry.ref}]${tail}`)
        }
        entry.id = id
      }
      lines.push(`${entry.shape} [ref=${entry.ref}]${entry.tail}`)
    }

    for (const [fp, entry] of [...this.prev]) {
      if (!seen.has(fp)) {
        removed.push(`${entry.shape} [ref=${entry.ref}]${entry.tail}`)
        this.prev.delete(fp)
      }
    }

    this.byRef.clear()
    for (const entry of this.prev.values()) {
      if (entry.id !== undefined && entry.id !== null) this.byRef.set(entry.ref, entry.id)
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

export function describe(o) {
  const parts = []
  if (o.added.length) parts.push('added:\n' + o.added.map((x) => '  ' + x).join('\n'))
  if (o.removed.length) parts.push('gone:\n' + o.removed.map((x) => '  ' + x).join('\n'))
  if (o.updated.length) parts.push('changed:\n' + o.updated.map((x) => '  ' + x).join('\n'))
  return parts.join('\n')
}
