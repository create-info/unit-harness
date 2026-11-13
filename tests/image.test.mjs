/**
 * 图片输入。
 *
 * 断言的是**线上协议**，不是"我们造了个对象"：OpenAI 要求 content 变成 parts 数组
 * 且图片是 data URL，Anthropic 要求 image block + base64 source。这两家在这一点上
 * 完全不一样，写错了不会报错——模型只是"看不见图"，然后一本正经地瞎猜。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'

const CLI = join(process.cwd(), 'dist', 'uh.cjs')

// 1x1 PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

function startModel(seen) {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'mock' }] }))
      return
    }
    let b = ''
    req.on('data', (c) => (b += c))
    req.on('end', () => {
      seen.push(JSON.parse(b || '{}'))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        model: 'mock',
        choices: [{ message: { role: 'assistant', content: 'I see a pixel.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      }))
    })
  })
  return server
}

function run(args, env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { env })
    let s = ''
    p.stdout.on('data', (d) => (s += d))
    p.stderr.on('data', (d) => (s += d))
    p.on('close', (code) => resolve({ s, code }))
  })
}

test('--image sends an OpenAI image part as a data URL', async () => {
  const seen = []
  const server = startModel(seen)
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const home = mkdtempSync(join(tmpdir(), 'uh-img-'))
  const img = join(home, 'shot.png')
  writeFileSync(img, PNG)

  try {
    const { s, code } = await run(['run', 'what is in this image', '--image', img], {
      ...process.env, UH_HOME: home, UH_BASE_URL: `http://127.0.0.1:${port}/v1`, UH_MODEL: 'mock',
    })
    assert.equal(code, 0, s)

    const userMsg = seen[0].messages.find((m) => m.role === 'user')
    assert.ok(Array.isArray(userMsg.content), 'content must become a parts array when an image is attached')
    const imagePart = userMsg.content.find((p) => p.type === 'image_url')
    assert.ok(imagePart, 'an image_url part must be present')
    assert.match(imagePart.image_url.url, /^data:image\/png;base64,/, 'must be a data URL')
    const textPart = userMsg.content.find((p) => p.type === 'text')
    assert.equal(textPart.text, 'what is in this image', 'the text and the image travel together')

    // base64 不落盘
    const sid = basename(sessionDirOf(home))
    const state = JSON.parse(readFileSync(join(sessionDirOf(home), 'state.json'), 'utf8'))
    const withImg = state.messages.find((m) => m.images?.length)
    assert.ok(withImg, 'the state file should remember that an image was sent')
    assert.equal(withImg.images[0].data, '', 'base64 must not be persisted — re-read it on resume')
    assert.equal(withImg.images[0].path, img)
  } finally {
    server.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('--image rejects unsupported file types instead of sending garbage', async () => {
  const home = mkdtempSync(join(tmpdir(), 'uh-img2-'))
  const bad = join(home, 'notes.txt')
  writeFileSync(bad, 'not an image')
  try {
    const { s, code } = await run(['run', 'look', '--image', bad], {
      ...process.env, UH_HOME: home,
    })
    assert.notEqual(code, 0)
    assert.match(s, /unsupported image type/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

/** 会话按 YYYY/MM/DD 分层了：从 sessions/ 往下走到第一个带 meta.json 的目录 */
function sessionDirOf(home) {
  let dir = join(home, 'sessions')
  for (let depth = 0; depth < 5; depth++) {
    let sub = []
    try { sub = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) } catch { return dir }
    if (sub.length === 0) return dir
    const next = join(dir, sub[0])
    if (existsSync(join(next, 'meta.json'))) return next
    dir = next
  }
  return dir
}
