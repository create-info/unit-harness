/**
 * 剧本（recipe）：固定任务 + 我们自己的验收单。
 *
 * 要证明的是「检查真的跑了」而不是「检查被写上了」：
 * 让模型（mock）生成一个能跑的 CLI，再断言三个 check 都是 pass；
 * 再跑一个故意不合格的剧本，断言整体退出码非 0。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'

const CLI = join(process.cwd(), 'dist', 'uh.cjs')

const CLI_PY = `import sys

def main(argv):
    if '--help' in argv:
        print('usage: cli.py add A B')
        return 0
    if len(argv) == 3 and argv[0] == 'add':
        print(int(argv[1]) + int(argv[2]))
        return 0
    print('usage: cli.py add A B', file=sys.stderr)
    return 2

if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
`

function patchBody(text) {
  return text.split('\n').map((l) => `+${l}`).join('\n')
}

function startModel(patchText) {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'mock' }] }))
      return
    }
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : {}
      const hadTool = (parsed.messages ?? []).some((m) => m.role === 'tool')
      const payload = hadTool
        ? { model: 'mock', choices: [{ message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }
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
                      patch: `*** Begin Patch\n*** Add File: cli.py\n${patchBody(patchText)}\n*** End Patch`,
                    }),
                  },
                }],
              },
              finish_reason: 'tool_calls',
            }],
            usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
          }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    })
  })
  return server
}

function runDo(args, home, port) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, 'do', ...args], {
      env: { ...process.env, UH_HOME: home, UH_BASE_URL: `http://127.0.0.1:${port}/v1`, UH_MODEL: 'mock' },
    })
    let out = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (out += d))
    p.on('close', (code) => resolve({ out, code }))
  })
}

const POSIX_ONLY = process.platform === 'win32' ? 'built-in recipes shell out via sh; not available on Windows' : false

test('uh do python-cli: the checks actually execute and pass', { skip: POSIX_ONLY }, async () => {
  const server = startModel(CLI_PY)
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const home = mkdtempSync(join(tmpdir(), 'uh-recipe-'))

  try {
    const { out, code } = await runDo(['python-cli'], home, port)
    assert.equal(code, 0, out)
    assert.match(out, /✓ cli\.py 已创建/)
    assert.match(out, /✓ --help 可用/)
    assert.match(out, /✓ add 2 3 输出 5/)

    // 验收结果必须落事件，否则回放时看不出「当时是怎么判的」
    const sid = basename(sessionDirOf(home))
    const events = readFileSync(join(sessionDirOf(home), 'events.jsonl'), 'utf8')
      .trim().split('\n').map((l) => JSON.parse(l))
    assert.ok(events.some((e) => e.kind === 'tool/call' && e.payload.tool === 'exec'),
      'the checks must go through the sandboxed exec, not a side channel')
  } finally {
    server.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('uh do reports failure when a check does not hold', { skip: POSIX_ONLY }, async () => {
  // 模型生成一个空文件：file check 会 pass（存在）但 --help check 会 fail
  const server = startModel('')
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const home = mkdtempSync(join(tmpdir(), 'uh-recipe-bad-'))

  try {
    const { out, code } = await runDo(['python-cli'], home, port)
    assert.notEqual(code, 0, 'a failing check must fail the run')
    assert.match(out, /did not pass/)
  } finally {
    server.close()
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
