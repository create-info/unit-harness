/**
 * read_file / list_dir / grep。
 *
 * 在这之前模型只能 `cat`：拿不到行号（改代码时对不上位置），也没法只读一段
 * （一个大文件就把上下文冲掉）。这三个工具是它看代码的主路。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'

const CLI = join(process.cwd(), 'dist', 'uh.cjs')

/** 按顺序返回一串工具调用，最后收尾 */
function scriptedServer(calls) {
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
      const parsed = JSON.parse(b || '{}')
      const toolMsgs = (parsed.messages ?? []).filter((m) => m.role === 'tool')
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
            choices: [{ message: { role: 'assistant', content: `after ${toolMsgs.length} tool results` }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
          }
      round++
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    })
  })
}

async function runWith(calls, setup) {
  const server = scriptedServer(calls)
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const home = mkdtempSync(join(tmpdir(), 'uh-fs-'))
  const work = join(home, 'work')
  mkdirSync(work, { recursive: true })
  if (setup) setup(work)

  const out = await new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, 'run', 'inspect the workspace', '--max-steps', String(calls.length + 2)], {
      env: { ...process.env, UH_HOME: home, UH_BASE_URL: `http://127.0.0.1:${port}/v1`, UH_MODEL: 'mock' },
    })
    let s = ''
    p.stdout.on('data', (d) => (s += d))
    p.stderr.on('data', (d) => (s += d))
    p.on('close', () => resolve(s))
  })

  const sid = basename(sessionDirOf(home))
  const events = readFileSync(join(sessionDirOf(home), 'events.jsonl'), 'utf8')
    .trim().split('\n').map((l) => JSON.parse(l))
  server.close()
  rmSync(home, { recursive: true, force: true })
  return { out, events }
}

test('read_file returns numbered lines and honours offset/limit', async () => {
  const { events } = await runWith(
    [{ name: 'read_file', args: { path: 'notes.txt', offset: 2, limit: 2 } }],
    (work) => writeFileSync(join(work, 'notes.txt'), 'alpha\nbeta\ngamma\ndelta\n'),
  )
  const results = events.filter((e) => e.kind === 'tool/result' && e.payload.tool === 'read_file')
  assert.equal(results.length, 1)
  assert.equal(results[0].payload.status, 'ok')
  assert.equal(results[0].payload.lines, 2, 'limit=2 must return two lines')
  assert.equal(results[0].payload.total, 5, 'and report the real file length')
})

test('read_file refuses paths that escape the workspace', async () => {
  const { events } = await runWith([{ name: 'read_file', args: { path: '../../../etc/passwd' } }])
  const r = events.find((e) => e.kind === 'tool/result' && e.payload.tool === 'read_file')
  assert.equal(r.payload.status, 'error', 'safeJoin must keep the agent inside the workspace')
})

test('list_dir lists directories before files, with sizes', async () => {
  const { events } = await runWith(
    [{ name: 'list_dir', args: { path: '.', depth: 1 } }],
    (work) => {
      mkdirSync(join(work, 'src'))
      writeFileSync(join(work, 'src', 'main.ts'), 'x')
      writeFileSync(join(work, 'README.md'), 'hello')
    },
  )
  const r = events.find((e) => e.kind === 'tool/result' && e.payload.tool === 'list_dir')
  assert.equal(r.payload.status, 'ok')
})

test('grep finds matches and reports a count', async () => {
  const { events } = await runWith(
    [{ name: 'grep', args: { pattern: 'TODO', glob: '*.ts' } }],
    (work) => {
      mkdirSync(join(work, 'src'))
      writeFileSync(join(work, 'src', 'a.ts'), 'const x = 1 // TODO: fix\n')
      writeFileSync(join(work, 'src', 'b.ts'), 'nothing here\n')
      writeFileSync(join(work, 'c.md'), 'TODO in markdown, must be filtered out by glob\n')
    },
  )
  const r = events.find((e) => e.kind === 'tool/result' && e.payload.tool === 'grep')
  assert.equal(r.payload.status, 'ok')
  assert.equal(r.payload.matches, 1, 'glob *.ts must exclude the markdown file')
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
