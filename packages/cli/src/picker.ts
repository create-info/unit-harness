/**
 * 一个能上下选的列表（Codex 那种）。
 *
 * 原来的 /model 是「列出 30 个、请你输入序号」——把选择变成了考试：
 * 打错一个数字就等于没选，而且当前用的是哪个还得回头往上翻。
 * Codex 的选择器是三件事：高亮跟着方向键走、当前项有记号、打字就开始筛。
 *
 * 只在真终端里接管按键；管道/重定向时返回 null，调用方退回文字输入——
 * 非交互场景（测试、脚本）不该被一个要按键的菜单卡住。
 */
import readline from 'node:readline'

export interface PickItem {
  label: string
  /** 右侧淡色说明（当前值、来源之类） */
  hint?: string
  value: string
}

const ESC = '\x1b'
const UP = '\x1b[A'
const DOWN = '\x1b[B'

function visibleLen(s: string): number {
  // 去掉 ANSI 再数，否则重绘时按错行数，屏幕就花了
  return s.replace(/\x1b\[[0-9;]*m/g, '').length
}

function padTo(s: string, width: number): string {
  const n = visibleLen(s)
  return n >= width ? s : s + ' '.repeat(width - n)
}

/**
 * @param current 当前值：列表里给它一个 ✓，并且光标停在它上面（打开就在「我本来选的那个」）
 * @param title   第一行标题
 * @returns 选中的 value；Esc / Ctrl+C / 没得选时 null
 */
export async function pickList(
  items: PickItem[],
  opts: { current?: string; title?: string; height?: number; stream?: NodeJS.WriteStream } = {},
): Promise<string | null> {
  const out = opts.stream ?? process.stdout
  if (!process.stdin.isTTY || !out.isTTY || items.length === 0) return null

  const height = Math.max(3, Math.min(opts.height ?? 12, items.length))
  let query = ''
  let filtered = items
  let sel = Math.max(0, filtered.findIndex((i) => i.value === opts.current))
  let offset = 0
  let drawn = 0

  const stdin = process.stdin
  const wasRaw = stdin.isRaw
  readline.emitKeypressEvents(stdin)
  stdin.setRawMode(true)
  stdin.resume()
  out.write('\x1b[?25l') // 藏光标，重绘时不会闪

  const refilter = (): void => {
    const q = query.trim().toLowerCase()
    filtered = q
      ? items.filter((i) => (i.label + ' ' + i.value + ' ' + (i.hint ?? '')).toLowerCase().includes(q))
      : items
    if (sel >= filtered.length) sel = Math.max(0, filtered.length - 1)
  }

  const draw = (): void => {
    const lines: string[] = []
    const width = Math.max(...filtered.map((i) => visibleLen(i.label)), 10)
    if (drawn > 0) out.write(`\x1b[${drawn}A`) // 回到刚才那一块的顶部
    // 光标跟着选择走：保证选中项始终在窗口里
    if (sel < offset) offset = sel
    if (sel >= offset + height) offset = sel - height + 1
    const title = opts.title ? opts.title : '选择'
    lines.push('  ' + title + (query ? `  ${'\x1b[2m'}筛选: ${query}${'\x1b[0m'}` : ''))
    if (filtered.length === 0) lines.push('  \x1b[2m（没有匹配的）\x1b[0m')
    for (let i = offset; i < Math.min(offset + height, filtered.length); i++) {
      const it = filtered[i]
      if (!it) continue
      const on = i === sel
      const check = it.value === opts.current ? '\x1b[32m✓\x1b[0m' : ' '
      const text = on ? `\x1b[7m ${padTo(it.label, width)} \x1b[0m` : ` ${padTo(it.label, width)} `
      lines.push('  ' + (on ? '▸' : ' ') + text + ' ' + check + (it.hint ? ' \x1b[2m' + it.hint + '\x1b[0m' : ''))
    }
    if (filtered.length > height) {
      lines.push(`  \x1b[2m${sel + 1}/${filtered.length}\x1b[0m`)
    }
    lines.push('  \x1b[2m↑↓ 选择 · Enter 确认 · Esc 取消 · 直接打字筛选\x1b[0m')
    // 每行先清再写，避免上一屏更长的一行留下尾巴
    out.write(lines.map((l) => '\x1b[2K' + l).join('\n') + '\n')
    drawn = lines.length
  }

  draw()
  return await new Promise<string | null>((resolve) => {
    const done = (v: string | null): void => {
      stdin.removeListener('keypress', onKey)
      stdin.setRawMode(Boolean(wasRaw))
      if (!wasRaw) stdin.pause()
      out.write('\x1b[?25h') // 还光标
      resolve(v)
    }
    const onKey = (_s: string, key: readline.Key): void => {
      // 方向键、Enter 这类交给 key.name；普通字符走 key.sequence
      if (key.name === 'up' || (key.ctrl && key.name === 'p')) {
        sel = (sel - 1 + filtered.length) % Math.max(1, filtered.length)
        draw()
        return
      }
      if (key.name === 'down' || (key.ctrl && key.name === 'n')) {
        sel = (sel + 1) % Math.max(1, filtered.length)
        draw()
        return
      }
      if (key.name === 'return' || key.name === 'enter') {
        const hit = filtered[sel]
        done(hit ? hit.value : null)
        return
      }
      if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
        done(null)
        return
      }
      if (key.name === 'backspace') {
        query = query.slice(0, -1)
        refilter()
        draw()
        return
      }
      if (key.sequence && !key.ctrl && key.sequence.length === 1 && key.sequence >= ' ') {
        query += key.sequence
        refilter()
        sel = 0
        draw()
      }
    }
    stdin.on('keypress', onKey)
    // 有些终端把方向键拆成序列送过来，走一次兜底解析
    void ESC, void UP, void DOWN
  })
}
