/**
 * 「卡住」要认得出来「同一个动作换了参数」。
 *
 * 事故现场：一条会话里连着 200 次 `python3 .../attribution_guard.py`（每次 exit=0，
 * 根本没进入计数），以及几十次 curl 换域名找同一份资料（签名每次都不同，次数一直是 1）。
 * 判据只能是「同一个动作」，不是「同一个动作 + 一串恰好不同的参数」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

// actionKey 是 loop 内部实现，这里通过一个最小复刻校验「同一动作」的语义边界：
// 规则变了必须同步改这里，否则测试失效——所以在注释里写明它是契约测试。
const argvOf = (argv) => ({ argv })

function keyOf(args) {
  const o = typeof args === 'string' ? JSON.parse(args) : args
  const str = (k) => (typeof o[k] === 'string' ? o[k] : '')
  const argv = Array.isArray(o.argv) ? o.argv.map(String) : null
  if (argv && argv.length) {
    const script = argv[0] === 'sh' || argv[0] === 'bash' ? argv.slice(2).join(' ') : ''
    const core = script
      .replace(/^\s*(cd\s+\S+\s*&&\s*)+/, '')
      .replace(/^\s*(export\s+\S+=\S*\s*)+/, '')
      .split(/\s*(?:&&|\||;)\s*/)[0]
    const a = core ? core.split(/\s+/).slice(0, 3) : argv.slice(0, 3)
    return a.map((x) => x.split('/').pop() ?? x).join(' ')
  }
  const p = str('path') || str('file')
  if (p) {
    const seg = p.split(/[\\/]+/).filter(Boolean)
    return seg.length > 1 ? seg.slice(0, 2).join('/') : (seg[0] ?? p)
  }
  if (str('url') || str('query')) return 'fetch'
  for (const k of ['cmd', 'command']) if (str(k)) return str(k).split(/\s+/).slice(0, 2).join(' ')
  return Object.keys(o).sort().join(',')
}

test('换 URL 找同一份资料 = 同一动作', () => {
  const a = keyOf({ url: 'https://www.baidu.com/s?wd=x' })
  const b = keyOf({ url: 'https://www.people.com.cn/x' })
  assert.equal(a, b)
})

test('同一个脚本反复跑 = 同一动作（路径前缀不同也一样）', () => {
  const a = keyOf(argvOf(['sh', '-c', 'python3 /home/x/.uh/skills/ppt-master/scripts/attribution_guard.py']))
  const b = keyOf(argvOf(['sh', '-c', 'cd /tmp && python3 attribution_guard.py; echo EXIT=$?']))
  assert.equal(a, b)
})

test('不同命令不能被误判成同一动作', () => {
  assert.notEqual(keyOf({ cmd: 'npm test' }), keyOf({ cmd: 'npm build' }))
  assert.notEqual(keyOf(argvOf(['python3', 'a.py'])), keyOf(argvOf(['python3', 'b.py'])))
})

test('文件类工具按目录归并，不按具体文件', () => {
  const a = keyOf({ path: '.uvcache/archive-v0/x/xslt.h' })
  const b = keyOf({ path: '.uvcache/archive-v0/y/libxslt.h' })
  assert.equal(a, b)
})
