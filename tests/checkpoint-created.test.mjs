/**
 * checkpoint/created 的边界语义。
 *
 * 这一条之前是个死声明：校验表要求 `checkpoint/created` 带 `commit` 字段，
 * 可整份代码里从没人发过这个事件——因为我们的 checkpoint 是日志式的，压根没有 commit。
 * 一个永远不会被满足的要求，等于一个永远不会被执行的检查，也跟着误导所有读代码的人。
 *
 * 现在它真的会发了，字段也改成真实存在的：`label` + `files`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import http from 'node:http'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pathToFileURL } from 'node:url'

const here = fileURLToPath(new URL('..', import.meta.url))
const CLI = join(here, 'dist', 'uh.cjs')

const kinds = await import(
  pathToFileURL(join(here, 'packages', 'core', 'src', 'evidence', 'kinds.ts')).href
)

// ─────────────────────── 校验表本身 ───────────────────────

test('checkpoint/created requires fields that actually exist', () => {
  // 用一条真实的 payload 过校验：如果它还在问 commit，这里会抛
  assert.doesNotThrow(() =>
    kinds.validatePayload('checkpoint/created', { label: 'turn 3 steps, model', files: ['a.ts'] }),
  )
})

test('a checkpoint with no files is not a checkpoint', () => {
  assert.throws(
    () => kinds.validatePayload('checkpoint/created', { label: 'x' }),
    /E_EVENT_PAYLOAD.*files/,
  )
})

test('the old commit field is gone, so nothing can quietly rely on it', () => {
  assert.throws(
    () => kinds.validatePayload('checkpoint/created', { files: ['a.ts'] }),
    /label/,
  )
})

// ─────────────────────── 端到端 ───────────────────────

/** 让模型写一个文件，然后收尾 */
function modelServer() {
  return http.createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'mock' }] }))
      return
    }
    let b = ''
    req.on('data', (c) => (b += c))
    req.on('end', () => {
      const parsed = JSON.parse(b || '{}')
      const msgs = parsed.messages ?? []
      const hadTool = msgs.some((m) => m.role === 'tool')
      const usage = { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 }
      const payload = hadTool
        ? { model: 'mock', choices: [{ message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }], usage }
        : {
            model: 'mock',
            choices: [{
              message: {
                role: 'assistant', content: '',
                tool_calls: [{
                  id: 'c1', type: 'function',
                  function: {
                    name: 'apply_patch',
                    arguments: JSON.stringify({
                      patch: '*** Begin Patch\n*** Add File: note.txt\n+hi\n*** End Patch\n',
                    }),
                  },
                }],
              },
              finish_reason: 'tool_calls',
            }],
            usage,
          }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    })
  })
}

function run(args, env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { env })
    let out = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (out += d))
    p.on('close', (code) => resolve({ out, code }))
  })
}

const sessionDir = (home) => {
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (e.name.startsWith('ses_')) return join(d, e.name)
        const found = walk(join(d, e.name))
        if (found) return found
      }
    }
    return null
  }
  return walk(join(home, 'sessions'))
}

test('a turn that writes files seals one checkpoint at the end', async () => {
  const server = modelServer()
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const home = mkdtempSync(join(tmpdir(), 'uh-ckpt-'))
  const ws = mkdtempSync(join(tmpdir(), 'uh-ckpt-ws-'))

  try {
    const { out, code } = await run(['run', 'write a note', '--workspace', ws, '--max-steps', '4'], {
      ...process.env, UH_HOME: home, UH_BASE_URL: `http://127.0.0.1:${port}/v1`, UH_MODEL: 'mock',
    })
    assert.equal(code, 0, out)

    const events = readFileSync(join(sessionDir(home), 'events.jsonl'), 'utf8')
      .trim().split('\n').map((l) => JSON.parse(l))

    // 只有经 agent 工具写出的文件才进 checkpoint：`sh -c 'echo > f'` 不进来，
    // 这是已知边界，不是这个测试要验的东西
    const created = events.filter((e) => e.kind === 'checkpoint/created')
    // 一轮一次，不是每写一个文件一次
    assert.equal(created.length, 1, `expected exactly one checkpoint/created, got ${created.length}`)

    const p = created[0].payload
    assert.ok(Array.isArray(p.files))
    assert.ok(p.file_count >= 1)
    assert.match(String(p.label), /turn \d+ steps/)

    // 每个文件都得先有 checkpoint/file 才有它出现在 created 里
    const fileEvents = events.filter((e) => e.kind === 'checkpoint/file')
    assert.ok(fileEvents.length >= 1, 'a checkpoint without the underlying file records cannot be undone')
  } finally {
    server.close()
    rmSync(home, { recursive: true, force: true })
    rmSync(ws, { recursive: true, force: true })
  }
})

test('a read-only turn leaves no checkpoint behind', async () => {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'mock' }] }))
      return
    }
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      // 一句话都不做，直接收尾
      res.end(JSON.stringify({
        model: 'mock',
        choices: [{ message: { role: 'assistant', content: 'nothing to do' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      }))
    })
    req.resume()
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const home = mkdtempSync(join(tmpdir(), 'uh-ckpt2-'))
  const ws = mkdtempSync(join(tmpdir(), 'uh-ckpt2-ws-'))

  try {
    const { code } = await run(['run', 'just talk', '--workspace', ws, '--max-steps', '3'], {
      ...process.env, UH_HOME: home, UH_BASE_URL: `http://127.0.0.1:${port}/v1`, UH_MODEL: 'mock',
    })
    assert.equal(code, 0)

    const events = readFileSync(join(sessionDir(home), 'events.jsonl'), 'utf8')
      .trim().split('\n').map((l) => JSON.parse(l))
    // 空 checkpoint 会让 undo 以为"这一轮改过东西"
    assert.equal(events.filter((e) => e.kind === 'checkpoint/created').length, 0)
  } finally {
    server.close()
    rmSync(home, { recursive: true, force: true })
    rmSync(ws, { recursive: true, force: true })
  }
})
