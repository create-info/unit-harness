/**
 * 回答里的 markdown 渲染。
 *
 * 这段逻辑住在 ui.html 的内联脚本里（没有构建步骤可以拆），所以测试直接把
 * 那几个函数从文件里取出来跑——它能挡住两件事：
 *
 *   1. 回归：代码块的 ``` 又露到屏幕上、或者代码被折行；
 *   2. 安全：答案里出现 `<img onerror=...>` 时绝不能真的变成标签。
 *      这一页背后是一个能跑 shell 的 agent，模型输出不能当 HTML 信。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const html = readFileSync(join(process.cwd(), 'packages/cli/src/ui.html'), 'utf8')

// 把需要的三个函数切出来：esc 是转义，mdInline 处理行内，md 处理块
function slice(name, endAt) {
  const start = html.indexOf('function ' + name + '(')
  assert.ok(start > 0, 'could not find function ' + name + ' in ui.html')
  const end = html.indexOf(endAt, start)
  assert.ok(end > start, 'could not find the end of ' + name)
  return html.slice(start, end)
}

const src = [
  slice('esc', '\n'),
  slice('mdInline', 'function md('),
  slice('md', 'function applySearch('),
].join('\n')

const render = new Function(src + '\nreturn { md, mdInline, esc }')()
const { md } = render

test('a fenced block becomes a scrollable code block, not visible backticks', () => {
  const out = md('before\n\n```sh\ncd /a/very/long/path && make run\n```\n\nafter')
  assert.ok(!out.includes('```'), 'the fence must not reach the screen:\n' + out)
  assert.match(out, /class="mdc"/)
  assert.match(out, /class="mdcbar">sh</, 'the language tag rides in a little bar')
  // 代码原样保留，但 HTML 实体必须转义：`&&` 在页面上仍然是 `&&`，源里是 &amp;&amp;
  assert.match(out, /<pre class="mdpre">cd \/a\/very\/long\/path &amp;&amp; make run<\/pre>/, 'code is verbatim')
  assert.match(out, /before/, 'text before the fence survives')
  assert.match(out, /after/, 'text after the fence survives')
})

test('code blocks keep their whitespace and angle brackets escaped', () => {
  const out = md('```\n  indented\n  <div class="x">a && b</div>\n```')
  assert.match(out, /<pre class="mdpre">  indented\n  &lt;div class=&quot;x&quot;&gt;a &amp;&amp; b&lt;\/div&gt;<\/pre>/)
})

test('inline code, bold and links', () => {
  const out = md('run `uh serve --lan` then **restart** and see [docs](https://example.com/x)')
  assert.match(out, /<code>uh serve --lan<\/code>/)
  assert.match(out, /<b>restart<\/b>/)
  assert.match(out, /<a href="https:\/\/example.com\/x" target="_blank" rel="noopener noreferrer">docs<\/a>/)
})

test('a javascript: link is not a link', () => {
  const out = md('[click](javascript:alert(1))')
  assert.ok(!out.includes('<a '), 'javascript: must not become an anchor:\n' + out)
  assert.ok(out.includes('javascript:alert(1)'), 'the text stays as text')
})

test('model output cannot smuggle html into the page', () => {
  const out = md('<img src=x onerror="fetch(\'//evil\')">\n\n<script>alert(1)</script>')
  assert.ok(!out.includes('<img'), out)
  assert.ok(!out.includes('<script'), out)
  assert.match(out, /&lt;img/)
})

test('headings, bullets and quotes keep their shape', () => {
  const out = md('## 结果\n\n- 一\n- 二\n\n1. 甲\n2. 乙\n\n> 注意')
  assert.match(out, /class="mdh mdh2">结果</)
  assert.equal((out.match(/class="mdli"/g) || []).length, 4)
  assert.match(out, /class="mdq">注意</)
})

test('markdown inside a code span is left alone', () => {
  const out = md('use `**not bold**` here')
  assert.ok(!out.includes('<b>'), 'bold markers inside code must not be interpreted:\n' + out)
})

test('an empty answer does not produce html', () => {
  assert.equal(md(''), '')
  assert.equal(md(null), '')
})
