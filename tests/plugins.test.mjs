/**
 * 插件页：我们的「插件」就是 MCP server、技能、钩子这三样真实存在的东西。
 *
 * 这里钉住的是「开关必须真的生效」——一个记在配置里、界面上能拨、但执行路径上
 * 谁也不读的开关，比没有开关更糟：用户会以为自己已经关掉了。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import http from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(process.cwd(), 'dist', 'uh.cjs')
const PORT = 7831 + Math.floor(Math.random() * 60)

function startServer(env) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [CLI, 'serve', '--port', String(PORT)], { env })
    let log = ''
    p.stdout.on('data', (d) => {
      log += d
      if (/http:\/\/127\.0\.0\.1:/.test(log)) resolve(p)
    })
    p.stderr.on('data', (d) => (log += d))
    p.on('close', (c) => reject(new Error('server exited: ' + c + '\n' + log)))
    setTimeout(() => reject(new Error('server did not start:\n' + log)), 15_000)
  })
}

const get = async (p) => (await fetch('http://127.0.0.1:' + PORT + p)).json()
const post = async (p, body) =>
  (await fetch('http://127.0.0.1:' + PORT + p, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })).json()

test('the plugins page lists what is really installed, and a toggle is persisted and honoured', async () => {
  const home = mkdtempSync(join(tmpdir(), 'uh-plug-'))
  const work = join(home, 'work')
  mkdirSync(join(work, '.uh', 'skills', 'deploy-check'), { recursive: true })
  mkdirSync(join(work, '.uh', 'skills', 'bump-version'), { recursive: true })

  writeFileSync(join(home, 'mcp.json'), JSON.stringify({
    mcpServers: {
      github: { command: 'npx', args: ['-y', 'server-github'] },
      docs: { url: 'https://mcp.example.com/sse' },
    },
  }))
  writeFileSync(join(work, '.uh', 'skills', 'deploy-check', 'SKILL.md'),
    '---\nname: deploy-check\ndescription: 上线前检查\nallowed-tools: run_command\n---\n正文\n')
  writeFileSync(join(work, '.uh', 'skills', 'bump-version', 'SKILL.md'),
    '---\nname: bump-version\ndescription: 改版本号\n---\n正文\n')

  const srv = await startServer({ ...process.env, UH_HOME: home, UH_WORKSPACE: work })
  try {
    const p = await get('/api/plugins')
    assert.deepEqual(p.counts, { mcp: 2, skills: 2, hooks: 0 }, 'the page must show what is actually there')
    // stdio 显示命令、http 显示地址：列表里得看得出它是个什么东西
    const gh = p.mcp.find((m) => m.name === 'github')
    assert.equal(gh.command, 'npx -y server-github')
    assert.equal(gh.transport, 'stdio')
    assert.equal(p.mcp.find((m) => m.name === 'docs').transport, 'http')
    // 技能的 allowed-tools 与脚本要带出来，否则开关拨了也不知道关掉了什么
    assert.deepEqual(p.skills.find((s) => s.name === 'deploy-check').allowedTools, ['run_command'])

    await post('/api/plugins/toggle', { id: 'mcp:github', enabled: false })
    const after = await get('/api/plugins')
    assert.equal(after.mcp.find((m) => m.name === 'github').enabled, false)
    const cfg = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'))
    assert.deepEqual(cfg.disabledPlugins, ['mcp:github'], 'the switch has to survive a restart')

    // 再打开：配置里不该留下一个 false 的残渣
    await post('/api/plugins/toggle', { id: 'mcp:github', enabled: true })
    const cfg2 = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'))
    assert.deepEqual(cfg2.disabledPlugins, [])

    // 真正的判据在执行路径上：关掉的技能不该出现在给模型的工具表里。
    // 用一个必失败的 mock 模型跑一步，从请求体里数 use_skill 的候选。
    await post('/api/plugins/toggle', { id: 'skill:bump-version', enabled: false })
    const seen = []
    const mock = http.createServer((req, res) => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'mock' }] }))
        return
      }
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        if (body) seen.push(body)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          model: 'mock',
          choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }))
      })
    })
    await new Promise((r) => mock.listen(0, '127.0.0.1', r))
    const mp = mock.address().port
    const runP = spawn(process.execPath, [CLI, 'run', 'hi', '--max-steps', '1'], {
      cwd: work,
      env: {
        ...process.env, UH_HOME: home, UH_WORKSPACE: work,
        UH_BASE_URL: `http://127.0.0.1:${mp}/v1`, UH_MODEL: 'mock',
      },
    })
    await new Promise((r) => runP.on('close', r))
    mock.close()

    const prompt = seen.join('\n')
    assert.match(prompt, /deploy-check/, 'enabled skills are still offered')
    assert.equal(/bump-version/.test(prompt), false,
      'a disabled skill still reaching the model means the toggle only changed a checkbox')
  } finally {
    srv.kill()
    rmSync(home, { recursive: true, force: true })
  }
})
