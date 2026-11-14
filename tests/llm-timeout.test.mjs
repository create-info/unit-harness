/**
 * 「突然就说停止了」——两条用例钉住这次的真实原因。
 *
 * 请求里那个计时器原来是一刀切的 120 秒总时限：本地 27B 模型在十万 token 的
 * 上下文上想两分钟太正常了，于是请求被自己掐掉，catch 里又把所有 AbortError
 * 一律报成 `E_LLM_ABORTED: stopped by the user`——用户一根手指都没动，屏幕上
 * 却写着是他按了停止，谁也查不出真相。
 *
 * 现在：计时器是**空闲**计时（收到数据就重新上弦），并且「自己掐的」与
 * 「用户掐的」是两句不同的话。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(process.cwd(), 'dist', 'uh.cjs')

/** 慢但活着的模型：每 chunkMs 吐一小段，总共吐 chunks 段 */
function startSlowMock({ chunks = 8, chunkMs = 150 } = {}) {
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      let i = 0
      const tick = () => {
        if (i < chunks) {
          const frame = i === 0
            ? { choices: [{ delta: { content: 'slow' }, index: 0 }] }
            : { choices: [{ delta: { content: ' but alive' }, index: 0 }] }
          res.write(`data: ${JSON.stringify(frame)}\n\n`)
          i++
          setTimeout(tick, chunkMs)
          return
        }
        res.write(`data: ${JSON.stringify({
          choices: [{ delta: {}, finish_reason: 'stop', index: 0 }],
          usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
        })}\n\n`)
        res.write('data: [DONE]\n\n')
        res.end()
      }
      // 第一口也要等：真实模型「首字等待」就是这么长
      setTimeout(tick, chunkMs)
    })
  })
  return { server }
}

/** 一声不吭的模型：连接挂着，一个字节都不回 */
function startSilentMock() {
  const sockets = new Set()
  const server = http.createServer((req, res) => {
    req.on('data', () => { /* 收下请求，然后什么都不做 */ })
  })
  server.on('connection', (s) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
  })
  return { server, sockets }
}

function runCli(args, env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, ...env } })
    let out = ''
    let err = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (err += d))
    p.on('close', (code) => resolve({ code, out, err }))
  })
}

test('a model that keeps streaming is not killed by the idle clock', async () => {
  const { server } = startSlowMock({ chunks: 8, chunkMs: 150 })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const home = mkdtempSync(join(tmpdir(), 'uh-slow-'))
  try {
    const res = await runCli(
      ['run', 'say something slowly', '--base-url', `http://127.0.0.1:${port}/v1`, '--model', 'mock'],
      // 空闲阈值 1 秒：整个请求活了 1.3 秒以上，但每 150ms 就有数据，
      // 所以不该被掐。以前这里是 120 秒总时限，超过就死
      { UH_HOME: home, UH_LLM_IDLE_TIMEOUT: '1' },
    )
    assert.equal(res.code, 0, 'exit ' + res.code + '\n' + res.out.slice(-500) + res.err.slice(-500))
    assert.match(res.out, /slow but alive/, 'the streamed text must survive')
    assert.doesNotMatch(res.out, /E_LLM_TIMEOUT|stopped by the user/)
  } finally {
    server.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('silence is reported as a timeout, never as the user stopping it', async () => {
  const { server, sockets } = startSilentMock()
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const home = mkdtempSync(join(tmpdir(), 'uh-silent-'))
  try {
    const res = await runCli(
      ['run', 'this one never answers', '--base-url', `http://127.0.0.1:${port}/v1`, '--model', 'mock'],
      { UH_HOME: home, UH_LLM_IDLE_TIMEOUT: '1' },
    )
    const all = res.out + res.err
    assert.match(all, /E_LLM_TIMEOUT/, 'a dead request must say it timed out: ' + all.slice(-400))
    assert.doesNotMatch(all, /stopped by the user/, 'nobody pressed anything, so do not blame the user')
    assert.notEqual(res.code, 0, 'a timeout is not a successful run')
  } finally {
    for (const s of sockets) s.destroy()
    server.close()
    rmSync(home, { recursive: true, force: true })
  }
})
