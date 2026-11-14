/**
 * 构建缓存不是工作成果。
 *
 * 一个 Go 项目把 GOCACHE 指到了工程里的 .gocache，一次运行产出的「交付物」
 * 里就有两千个哈希文件名。后果是三重的：屏幕刷成两千行、跑完报
 * 「文件被移除了」（缓存自己会清理自己）、每次快照都把两万次哈希算一遍。
 *
 * 这条用例从外面钉住这件事（走 CLI + 假模型，和用户实际跑的一样）：
 * 源码要算数，缓存一个都不许进交付物，也不许因为缓存被清理而报错。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(process.cwd(), 'dist', 'uh.cjs')

/** 假模型：先写一个源码文件 + 一片构建缓存，然后收尾 */
function startMock() {
  const CMD = 'mkdir -p src .gocache/aa && echo "package main" > src/main.go && echo cache > .gocache/aa/8c8cc60497dec9d10cc2f54f4a5b855f54322cb85e9b65358781b74e77df8e83-a && echo cache > .gocache/aa/893ffd6b6b1e2a3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4-d'
  let n = 0
  const server = http.createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'mock' }] }))
      return
    }
    let b = ''
    req.on('data', (c) => (b += c))
    req.on('end', () => {
      const body = JSON.parse(b || '{}')
      const hasTools = Array.isArray(body.tools) && body.tools.length > 0
      n++
      const payload = !hasTools || n > 1
        ? {
            model: 'mock',
            choices: [{ message: { role: 'assistant', content: 'wrote src/main.go' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
          }
        : {
            model: 'mock',
            choices: [{
              message: {
                role: 'assistant', content: '',
                tool_calls: [{ id: 'c1', type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ argv: ['sh', '-c', CMD] }) } }],
              },
              finish_reason: 'tool_calls',
            }],
            usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
          }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    })
  })
  return server
}

function sessionDirOf(home) {
  let dir = join(home, 'sessions')
  for (let i = 0; i < 5; i++) {
    let subs = []
    try { subs = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) } catch { return dir }
    if (!subs.length) return dir
    const next = join(dir, subs[0])
    if (existsSync(join(next, 'meta.json'))) return next
    dir = next
  }
  return dir
}

test('a run does not report the build cache as deliverables', async () => {
  const server = startMock()
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const home = mkdtempSync(join(tmpdir(), 'uh-cache-'))
  const work = mkdtempSync(join(tmpdir(), 'uh-cache-work-'))
  try {
    const code = await new Promise((resolve) => {
      const p = spawn(process.execPath, [CLI, 'run', 'write the project', '--base-url', `http://127.0.0.1:${port}/v1`, '--model', 'mock', '--cwd', work], {
        env: { ...process.env, UH_HOME: home },
      })
      p.on('close', (c) => resolve(c))
    })
    assert.equal(code, 0)

    const events = readFileSync(join(sessionDirOf(home), 'events.jsonl'), 'utf8')
      .trim().split('\n').map((l) => JSON.parse(l))

    const artifacts = events.filter((e) => e.kind === 'artifact/emitted').map((e) => String(e.payload.path))
    assert.ok(artifacts.includes('src/main.go'), 'source must count as a deliverable: ' + artifacts.join(','))
    assert.ok(!artifacts.some((p) => p.includes('.gocache')), 'the build cache must never be a deliverable: ' + artifacts.slice(0, 5).join(','))

    // 缓存被清理不算错误
    const bad = events.filter((e) => e.kind === 'error')
    assert.equal(bad.length, 0, 'no error events: ' + JSON.stringify(bad.map((e) => e.payload).slice(0, 3)))
  } finally {
    server.close()
    rmSync(home, { recursive: true, force: true })
    rmSync(work, { recursive: true, force: true })
  }
})
