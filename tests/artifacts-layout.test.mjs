/**
 * 交付物那一列的排布。
 *
 * 起因是截图：一行 `419504 B sha256=2ee6a17f0…` 从对话栏一路溢出到右侧 diff
 * 面板上，还被窗口边缘切掉一半。原因是四个 span 挤在一个 flex 行里、
 * 没有任何一个允许收缩或截断。
 *
 * 这里不测样式细节，只钉住让「放不下」不会再溢出的那几条规则。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const html = readFileSync(join(process.cwd(), 'packages/cli/src/ui.html'), 'utf8')

function rule(selector) {
  const i = html.indexOf(selector + '{')
  assert.ok(i > 0, 'missing css rule: ' + selector)
  return html.slice(i, html.indexOf('}', i))
}

test('deliverable rows cannot push past the log column', () => {
  const art = rule('.art')
  assert.match(art, /min-width:0/, '.art must be allowed to shrink: ' + art)
  const col = rule('.art .artcol')
  assert.match(col, /min-width:0/, 'the text column must be allowed to shrink')
  assert.match(col, /flex:1/)
})

test('the file name and the hash each ellipsis instead of overflowing', () => {
  const n = rule('.art .n')
  assert.match(n, /text-overflow:ellipsis/)
  assert.match(n, /white-space:nowrap/)
  const meta = rule('.art .meta')
  assert.match(meta, /text-overflow:ellipsis/)
})

test('bytes and sha256 live on a second line, not one long row', () => {
  assert.ok(!/a\.sha256\.slice\(0,12\) \+ '<\/span>'\s*\n/.test(html), 'sha must not be a sibling of the path')
  assert.match(html, /class="artcol"><span class="n">/, 'path and meta share one column')
  assert.match(html, /class="meta">' \+ a\.bytes \+ ' B · sha256=/, 'bytes and sha ride together')
  assert.match(html, /d\.title = a\.path/, 'the full hash stays reachable via title')
})
