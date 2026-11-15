/**
 * search_images。
 *
 * 背景：让它「生成一张照片」，它去 curl 百度图片、写正则解析 HTML，最后得到
 * 缩略图、水印和死链。工具缺失时模型不会说「我做不了」，它会把任何能拿到
 * 字节的路子都试一遍——所以补的不是提示词，是一条正规的路。
 *
 * 这里不连真图库（测试不该依赖外网），用本地假 Openverse 提供两个候选：
 * 一张真 PNG 和一张 HTML 错误页。要验证的是：好的存下来、坏的被拒、
 * 授权信息落盘、以及「一张都拿不到」时明确失败而不是给出空目录。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'

const CLI = join(process.cwd(), 'dist', 'uh.cjs')

/** 1×1 的合法 PNG（魔数正确，够 harness 收成交付物） */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

/** 假图库：一次搜索返回两个候选，其中一个的「图片」其实是 HTML 错误页 */
function fakeGallery(blockAll = false) {
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    // 第一站（Commons）故意返回空结果，验证 fallback 真的会走到第二站；
    // 不替代它的话，测试会真的连外网，断言拿到的就不是下面这两条假数据
    if (url.pathname === '/w/api.php') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ query: { pages: {} } }))
      return
    }
    if (url.pathname === '/v1/images/') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        results: [
          {
            title: 'Fried noodles', url: `http://127.0.0.1:${server.address().port}/img/good.png`,
            foreign_landing_url: 'https://example.org/photo/1', creator: 'A. Cook',
            license: 'by', license_version: '4.0',
          },
          {
            title: 'Blocked', url: `http://127.0.0.1:${server.address().port}/img/blocked.jpg`,
            foreign_landing_url: 'https://example.org/photo/2', creator: 'someone',
            license: 'by-sa', license_version: '4.0',
          },
        ],
      }))
      return
    }
    if (url.pathname === '/img/good.png') {
      if (blockAll) {
        // 连好图也变成 HTML：验证「一张都拿不到」时工具明确失败
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end('<html>blocked</html>')
        return
      }
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(PNG.length) })
      res.end(PNG)
      return
    }
    // 声明自己是 .jpg，实际返回 HTML —— 反爬最常见的样子
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<html><body>403 blocked</body></html>')
  })
}
let server

function scriptedLlm(calls) {
  let round = 0
  return http.createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'mock' }] }))
      return
    }
    let b = ''
    req.on('data', (c) => (b += c))
    req.on('end', () => {
      const payload = round < calls.length
        ? {
            model: 'mock',
            choices: [{
              message: {
                role: 'assistant', content: '',
                tool_calls: [{ id: `c${round}`, type: 'function', function: { name: calls[round].name, arguments: JSON.stringify(calls[round].args) } }],
              },
              finish_reason: 'tool_calls',
            }],
            usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
          }
        : {
            model: 'mock',
            choices: [{ message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
          }
      round++
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    })
  })
}

async function runWith(call, opts = {}) {
  server = fakeGallery(Boolean(opts.blockAll))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const llm = scriptedLlm([call])
  await new Promise((r) => llm.listen(0, '127.0.0.1', r))
  const llmPort = llm.address().port

  const home = mkdtempSync(join(tmpdir(), 'uh-img-'))
  const work = join(home, 'work')
  mkdirSync(work, { recursive: true })

  const out = await new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, 'run', 'find a picture of fried noodles', '--max-steps', '4'], {
      env: {
        ...process.env,
        UH_HOME: home,
        UH_BASE_URL: `http://127.0.0.1:${llmPort}/v1`,
        UH_MODEL: 'mock',
        UH_IMAGE_API: `http://127.0.0.1:${port}`,
        UH_IMAGE_COMMONS_API: `http://127.0.0.1:${port}/w/api.php`,
      },
    })
    let s = ''
    p.stdout.on('data', (d) => (s += d))
    p.stderr.on('data', (d) => (s += d))
    p.on('close', () => resolve(s))
  })

  const dir = sessionDirOf(home)
  const events = existsSync(dir)
    ? readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : []
  server.close()
  llm.close()
  return { out, events, work, home }
}

function sessionDirOf(home) {
  const root = join(home, 'sessions')
  if (!existsSync(root)) return join(root, 'none')
  const [y] = readdirSync(root)
  const [m] = readdirSync(join(root, y))
  const [d] = readdirSync(join(root, y, m))
  const [s] = readdirSync(join(root, y, m, d))
  return join(root, y, m, d, s)
}

test('a real image is saved with its credits, a fake one is refused', async () => {
  const { events, work, home } = await runWith({ name: 'search_images', args: { query: 'fried noodles', count: 2 } })
  try {
    const r = events.find((e) => e.kind === 'tool/result' && e.payload.tool === 'search_images')
    assert.ok(r, 'the call must be recorded in the audit log')
    assert.equal(r.payload.status, 'ok', 'one good image out of two is still a success')
    assert.equal(r.payload.saved, 1, 'the HTML "image" must not be counted')

    const imgs = readdirSync(join(work, 'images')).filter((f) => f.endsWith('.png'))
    assert.equal(imgs.length, 1, 'exactly the PNG should land in images/')
    assert.ok(readFileSync(join(work, 'images', imgs[0])).equals(PNG), 'bytes must survive untouched')

    const credits = readFileSync(join(work, 'images', 'CREDITS.md'), 'utf8')
    assert.match(credits, /A\. Cook/, 'author must be recorded')
    assert.match(credits, /BY 4\.0/i, 'license must be recorded')
    assert.match(credits, /example\.org\/photo\/1/, 'source page must be recorded')
    assert.ok(!credits.includes('blocked'), 'a refused candidate leaves no credit line')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('when every download is an HTML block page, the tool reports an error and writes nothing', async () => {
  const { events, work, home } = await runWith({ name: 'search_images', args: { query: 'fried noodles' } }, { blockAll: true })
  try {
    const r = events.find((e) => e.kind === 'tool/result' && e.payload.tool === 'search_images')
    assert.ok(r, 'recorded')
    assert.equal(r.payload.status, 'error', 'no usable image means failure, not an empty success')
    assert.ok(!existsSync(join(work, 'images')), 'nothing should be written when nothing downloaded')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
