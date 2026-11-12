/**
 * 远端执行的策略层。
 *
 * 这里测的不是"能不能连上"（那是 ssh 的事），而是**什么命令会被放行**、
 * 以及被放行/被拒绝时**留下什么记录**——安全关键逻辑写错了，
 * 就是"模型一句话把生产机删了"，而且事后查不出它试过。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(process.cwd(), 'dist', 'uh.cjs')
const POSIX_ONLY = process.platform === 'win32' ? 'remote execution shells out; POSIX only' : false

/** 跑一次远端执行（走 CLI + 假 ssh），返回退出码与输出 */
async function tryRemote(args, env) {
  return await new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, 'exec', '--host', 'prod', '--', ...args], { env })
    let s = ''
    p.stdout.on('data', (d) => (s += d))
    p.stderr.on('data', (d) => (s += d))
    p.on('close', (code) => resolve({ s, code }))
  })
}

function envFor(home, bin) {
  return { ...process.env, UH_HOME: home, PATH: `${bin}:${process.env.PATH}` }
}

test('read-only commands are allowed', { skip: POSIX_ONLY }, async () => {
  const home = setupHome()
  const bin = fakeSsh(home)
  const env = envFor(home, bin)
  const read = [
    ['df', '-h', '/'],
    ['ls', '-la', '/var/log'],
    ['ps', 'aux'],
    ['uname', '-a'],
    ['cat', '/etc/nginx/nginx.conf'],
    ['systemctl', 'status', 'nginx'],
    ['docker', 'ps'],
  ]
  try {
    for (const args of read) {
      const r = await tryRemote(args, env)
      assert.equal(r.code, 0, `${args.join(' ')} → ${r.s}`)
      assert.ok(r.s.includes('arg:'), `${args.join(' ')} should have reached ssh`)
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('anything that changes the host is refused', { skip: POSIX_ONLY }, async () => {
  const home = setupHome()
  const bin = fakeSsh(home)
  const env = envFor(home, bin)
  const write = [
    ['mkdir', '-p', '/srv/app'],
    ['cp', 'a', 'b'],
    ['npm', 'install'],
    ['systemctl', 'restart', 'nginx'],
    ['docker', 'run', '-d', 'nginx'],
    ['git', 'pull'],
    ['tar', '-xzf', 'app.tgz'],
    ['cat list.txt && rm trash.txt'], // 首词只读救不了整条
  ]
  try {
    for (const args of write) {
      const r = await tryRemote(args, env)
      assert.equal(r.code, 1, `${args.join(' ')} should be refused`)
      assert.match(r.s, /refused/, args.join(' '))
      assert.ok(!r.s.includes('arg:'), `${args.join(' ')} must never reach ssh`)
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('irreversible commands are refused with their own message', { skip: POSIX_ONLY }, async () => {
  const home = setupHome()
  const bin = fakeSsh(home)
  const env = envFor(home, bin)
  const destructive = [
    ['rm', '-rf', '/'],
    ['shutdown', '-h', 'now'],
    ['systemctl', 'disable', 'sshd'],
    ['echo DROP TABLE users | psql'],
  ]
  try {
    for (const args of destructive) {
      const r = await tryRemote(args, env)
      assert.equal(r.code, 1, args.join(' '))
      assert.match(r.s, /destructive|refused/, args.join(' '))
      assert.ok(!r.s.includes('arg:'), 'destructive must never reach ssh')
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

/** 放一个假的 ssh 在 PATH 前面：既能测审批路径，又不会真连任何机器 */
function fakeSsh(dir) {
  const bin = join(dir, 'bin')
  mkdirSync(bin, { recursive: true })
  const p = join(bin, 'ssh')
  writeFileSync(p, '#!/bin/sh\nfor a in "$@"; do printf "arg:%s\\n" "$a"; done\nexit 0\n')
  chmodSync(p, 0o755)
  return bin
}

function setupHome() {
  const home = mkdtempSync(join(tmpdir(), 'uh-remote-'))
  writeFileSync(join(home, 'hosts.json'), JSON.stringify({
    hosts: { prod: { host: 'example.invalid', user: 'deploy' } },
  }))
  return home
}

test('a refused write never reaches the remote', { skip: POSIX_ONLY }, async () => {
  const home = setupHome()
  const bin = fakeSsh(home)
  try {
    const out = await new Promise((resolve) => {
      const p = spawn(process.execPath, [CLI, 'exec', '--host', 'prod', '--', 'mkdir', '/srv/app'], {
        env: { ...process.env, UH_HOME: home, PATH: `${bin}:${process.env.PATH}` },
      })
      let s = ''
      p.stdout.on('data', (d) => (s += d))
      p.stderr.on('data', (d) => (s += d))
      p.on('close', (code) => resolve({ s, code }))
    })
    assert.equal(out.code, 1)
    assert.match(out.s, /refused: modifies the remote host/)
    assert.ok(!out.s.includes('arg:'), 'the command must not have been sent to ssh at all')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a read command runs and is recorded as external, not sandboxed', { skip: POSIX_ONLY }, async () => {
  const home = setupHome()
  const bin = fakeSsh(home)

  // mock 模型：先调 remote_exec，再给结论
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
        ? { model: 'mock', choices: [{ message: { role: 'assistant', content: 'checked' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }
        : {
            model: 'mock',
            choices: [{
              message: {
                role: 'assistant', content: '',
                tool_calls: [{ id: 'c1', type: 'function', function: { name: 'remote_exec', arguments: '{"host":"prod","command":"df -h /"}' } }],
              },
              finish_reason: 'tool_calls',
            }],
            usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
          }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port

  try {
    const out = await new Promise((resolve) => {
      const p = spawn(process.execPath, [CLI, 'run', 'check the disk', '--max-steps', '3'], {
        env: {
          ...process.env, UH_HOME: home, PATH: `${bin}:${process.env.PATH}`,
          UH_BASE_URL: `http://127.0.0.1:${port}/v1`, UH_MODEL: 'mock',
        },
      })
      let s = ''
      p.stdout.on('data', (d) => (s += d))
      p.stderr.on('data', (d) => (s += d))
      p.on('close', () => resolve(s))
    })
    assert.match(out, /checked/)

    const sid = readdirSync(join(home, 'sessions'))[0]
    const events = readFileSync(join(home, 'sessions', sid, 'events.jsonl'), 'utf8')
      .trim().split('\n').map((l) => JSON.parse(l))

    const call = events.find((e) => e.kind === 'tool/call' && e.payload.tool === 'remote_exec')
    assert.ok(call, 'remote_exec must be audited')
    assert.equal(call.payload.risk, 'read')
    assert.equal(call.payload.host, 'prod')

    const result = events.find((e) => e.kind === 'tool/result' && e.payload.tool === 'remote_exec')
    assert.ok(result)
    assert.equal(result.payload.isolation, 'none', 'remote is NOT sandboxed and must say so')
    assert.equal(result.payload.external, true)
    assert.equal(result.payload.scope, 'remote')
  } finally {
    server.close()
    rmSync(home, { recursive: true, force: true })
  }
})
