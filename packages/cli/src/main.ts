#!/usr/bin/env node
/**
 * uh CLI —— 内核的两种壳之一（CLI / 桌面共用同一引擎，D12）。
 *
 * P0 范围：version / doctor / plugin list / tool。
 * 不含 LLM 与剧本执行——那是 P1。
 */
import os from 'node:os'
import { join } from 'node:path'

import {
  Harness, EventStore, describeIsolation, describeAssertion, resolveProvider,
  PROVIDERS, findProvider, maskKey, listModels,
  readConfig, setProviderEntry, unsetProvider, setDefaultProvider, configPath, apiKeyFor,
  loadMcpServers, upsertMcpServer, removeMcpServer, McpRegistry,
  listRecipes, loadRecipe, resolveVars, renderTemplate, runRecipeChecks,
} from '@unit-harness/core'

import { VERSION } from './version.ts'
import { startServer, openBrowser } from './serve.ts'

const argv = process.argv.slice(2)
const cmd = argv[0] ?? 'help'

function localTime(iso: string): string {
  const d = new Date(iso)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function pluginDirs(): string[] {
  const env = process.env.UH_PLUGIN_DIR
  if (env) return env.split(':').filter(Boolean)
  return [join(os.homedir(), '.uh', 'plugins'), join(process.cwd(), '.uh', 'plugins')]
}

function fail(msg: string, code = 1): never {
  console.error(msg)
  process.exit(code)
}

const VALUE_FLAGS = new Set(['--model', '--base-url', '--api-key', '--max-steps', '--provider', '--max-context'])

function flag(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}

/** 该参数是不是上面某个 flag 的取值（而不是任务文本） */
function isFlagValue(tok: string): boolean {
  const i = argv.indexOf(tok)
  return i > 0 && VALUE_FLAGS.has(argv[i - 1] as string)
}

async function withHarness<T>(
  fn: (h: Harness) => Promise<T>,
  opts: { record?: boolean; label?: string; onEvent?: (kind: string, payload: Record<string, unknown>) => void } = {},
): Promise<T> {
  const h = new Harness({
    pluginDirs: pluginDirs(),
    logLevel: (process.env.UH_LOG_LEVEL as never) ?? 'warn',
    unconfined: argv.includes('--allow-unconfined'),
    allowHome: argv.includes('--allow-home'),
    denyNetwork: argv.includes('--no-net'),
    harnessVersion: VERSION,
    ...(opts.record === undefined ? {} : { record: opts.record }),
    ...(opts.label === undefined ? {} : { label: opts.label }),
    ...(opts.onEvent === undefined ? {} : { onEvent: opts.onEvent }),
  })
  try {
    await h.start()
    return await fn(h)
  } finally {
    h.dispose()
  }
}

async function cmdDoctor(): Promise<void> {
  await withHarness(async (h) => {
    const r = h.isolation
    const yn = (b: boolean) => (b ? 'yes' : 'no')
    console.log(`UnitHarness ${VERSION}  (node ${process.version})`)
    console.log(`platform    ${r.platform}/${r.arch}  kernel=${r.release}`)
    console.log(`isolation   ${describeIsolation(r)}`)
    console.log(`enforcement ${(h as unknown as { describeEnforcement?: () => string }).describeEnforcement?.() ?? '—'}`)
    if (r.available !== r.enforced) {
      console.log(`            capability detected but not yet applied by this build`)
    }
    console.log('')
    console.log(`  landlock   ${r.landlock.available ? `available (abi ${String(r.landlock.abi)})` : `unavailable — ${r.landlock.reason ?? 'unknown'}`}`)
    console.log(`  bwrap      ${r.bwrap.available ? `available — ${String(r.bwrap.path)}` : `unavailable — ${r.bwrap.reason ?? 'unknown'}`}`)
    console.log(`  seatbelt   ${r.seatbelt.available ? 'available' : `unavailable — ${r.seatbelt.reason ?? 'unknown'}`}`)
    if (r.notes.length) {
      console.log('')
      for (const n of r.notes) console.log(`  note: ${n}`)
    }
    console.log('')
    console.log(`plugins     ${pluginDirs().join(', ')}`)
    console.log(`  loaded    ${h.plugins.filter((p) => p.status === 'loaded').length}`)
    for (const p of h.plugins) {
      console.log(`  ${p.status === 'loaded' ? 'ok  ' : 'FAIL'} ${p.name}${p.error ? ` — ${p.error}` : ''}`)
    }
    // 模型可用性：装完第一件事就是跑 uh run，这里先告诉他能不能跑
    console.log('')
    try {
      const prov = await resolveProvider()
      console.log(`model       ${prov.model}`)
      console.log(`provider    ${prov.def.id} (${prov.def.protocol})  @ ${prov.baseUrl}`)
      console.log(`            ${prov.source}`)
    } catch {
      console.log('model       none')
      console.log('            → start LM Studio (http://127.0.0.1:1234) or Ollama (http://127.0.0.1:11434),')
      console.log('              or export UH_BASE_URL / UH_MODEL / UH_API_KEY')
    }

    const { servers: mcpServers, sources: mcpSources } = loadMcpServers()
    const mcpNames = Object.keys(mcpServers)
    if (mcpNames.length === 0) {
      console.log('mcp         (none configured)')
    } else {
      console.log(`mcp         ${mcpNames.length} server(s) from ${mcpSources.join(', ')}`)
      console.log('            NOTE: MCP servers run outside the sandbox reported above')
      for (const n of mcpNames) console.log(`            - ${n}`)
    }

    if (r.enforced === 'none' || r.enforced === 'path-guard') {
      console.log('')
      console.log('WARNING: exec is NOT isolated in this build. It is refused unless --allow-unconfined.')
    }
  }, { record: false })
}

async function cmdPlugin(sub?: string): Promise<void> {
  await withHarness(async (h) => {
    if (sub === 'list' || sub === undefined) {
      if (h.plugins.length === 0) {
        console.log('no plugins found in: ' + pluginDirs().join(', '))
        return
      }
      for (const p of h.plugins) {
        console.log(`${p.status === 'loaded' ? 'ok  ' : 'FAIL'}  ${p.name}`)
        console.log(`      ${p.file}`)
        if (p.error) console.log(`      error: ${p.error}`)
      }
      return
    }
    fail(`unknown plugin subcommand: ${sub}`)
  })
}

async function cmdSandbox(sub?: string): Promise<void> {
  if (sub !== 'check') fail('usage: uh sandbox check')

  await withHarness(async (h) => {
    const info = h.isolation
    const enforcer = (h as unknown as { describeEnforcement: () => string }).describeEnforcement()
    console.log(`isolation: ${enforcer}`)
    console.log('')

    const probes: Array<{ name: string; argv: [string, ...string[]]; expect: 'ok' | 'deny' }> = [
      { name: 'write inside workspace', argv: ['sh', '-c', 'echo ok > ./sb-check.txt && cat ./sb-check.txt'], expect: 'ok' },
      { name: 'write outside workspace', argv: ['sh', '-c', 'echo x > "$HOME/uh-sb-outside.txt"'], expect: 'deny' },
      { name: 'read $HOME/.gitconfig', argv: ['sh', '-c', 'cat "$HOME/.gitconfig"'], expect: argv.includes('--allow-home') ? 'ok' : 'deny' },
      { name: 'write to /etc', argv: ['sh', '-c', 'echo x >> /etc/uh-sb-etc.txt'], expect: 'deny' },
    ]

    let pass = 0
    for (const p of probes) {
      let status: 'ok' | 'deny'
      try {
        const r = await h.exec({ argv: p.argv, timeoutMs: 8000 })
        status = r.exitCode === 0 ? 'ok' : 'deny'
      } catch {
        status = 'deny'
      }
      const good = status === p.expect
      if (good) pass++
      console.log(`${good ? 'PASS' : 'FAIL'}  ${p.name}  (expected ${p.expect}, got ${status})`)
      h.recordVerification(
        { kind: 'sandbox-probe', name: p.name, argv: p.argv, expect: p.expect },
        good ? 'pass' : 'fail',
        { got: status },
      )
    }

    console.log('')
    console.log(`${pass}/${probes.length} checks passed`)
    if (info.enforced === 'none' || info.enforced === 'path-guard') {
      console.log('note: no kernel isolation active — results above are meaningless')
    }
    if (pass !== probes.length) process.exitCode = 1
  })
}

async function cmdTool(name?: string, rest: string[] = []): Promise<void> {
  if (!name) fail('usage: uh tool <name> [--json <args>]')
  await withHarness(async (h) => {
    const tools = await Promise.resolve(h.ctx)
      .then(() => null)
      .catch(() => null)
    void tools

    // 直接调用已注册工具（工具注册在 harness 内部）
    if (argv.includes('--list')) {
      const list = h.plugins.filter((p) => p.status === 'loaded')
      console.log('loaded plugins: ' + list.map((p) => p.name).join(', '))
      return
    }

    const jsonIdx = rest.indexOf('--json')
    const args = jsonIdx >= 0 ? JSON.parse(rest[jsonIdx + 1] ?? '{}') : {}
    try {
      const res = await h.callTool(name, args)
      console.log(res.content)
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err))
    }
  })
}

function makePrinter(): (kind: string, p: Record<string, unknown>) => void {
  let verifyingShown = false
  return (kind: string, p: Record<string, unknown>) => {
    if (kind === 'artifact/emitted' && !verifyingShown) {
      console.log('· verifying deliverables')
      verifyingShown = true
    }
    printEvent(kind, p)
  }
}

function printEvent(kind: string, p: Record<string, unknown>): void {
  switch (kind) {
    case 'turn/start':
      console.log('· turn start')
      break
    case 'step/start':
      console.log(`· step ${p.step_index as number}`)
      break
    case 'llm/request':
      console.log(`  → ${p.model as string}`)
      break
    case 'llm/response': {
      const u = p.usage as { total_tokens?: number } | undefined
      const tc = p.tool_calls as number
      console.log(`  ← ${tc} tool call(s), ${u?.total_tokens ?? 0} tokens`)
      break
    }
    case 'tool/call': {
      // exec 记 argv；内置工具记 args_preview；插件工具记 args
      const argv = p.argv as string[] | undefined
      const preview = p.args_preview as string | undefined
      const args = p.args as Record<string, unknown> | undefined
      const detail = argv ? argv.join(' ') : preview ?? JSON.stringify(args ?? {})
      console.log(`  ⚙ ${p.tool as string}: ${detail.replace(/\s+/g, ' ').slice(0, 110)}`)
      break
    }
    case 'tool/result': {
      const ok = p.status === 'ok'
      const exit = p.exit_code
      console.log(`  ${ok ? '✓' : '✗'} ${exit !== undefined ? `exit=${String(exit)}` : String(p.status)}`)
      break
    }
    case 'plan/updated': {
      const steps = p.steps as Array<{ step: string; status: string }> | undefined
      if (steps) {
        console.log('  plan:')
        for (const s of steps) {
          const mark = s.status === 'completed' ? '✓' : s.status === 'in_progress' ? '▸' : ' '
          console.log(`    ${mark} ${s.step}`)
        }
      }
      break
    }
    case 'session/compacted':
      console.log(`  ⟳ compacted: dropped ${String(p.dropped_messages)} msg(s), summary ~${String(p.summary_chars)} chars (prompt was ${String(p.prompt_tokens_before)} tokens)`)
      break
    case 'turn/end':
      console.log(`· turn end (${String(p.stop_reason)}, ${String(p.steps)} steps)`)
      break
    default:
      break
  }
}

async function cmdExec(rest: string[]): Promise<void> {
  const argv = rest.filter((a) => a !== '--')
  if (argv.length === 0) fail('usage: uh exec -- <program> [args...]   (runs inside the sandbox)')

  await withHarness(async (h) => {
    const r = await h.exec({ argv: [argv[0] as string, ...argv.slice(1)] })
    if (r.stdout) process.stdout.write(r.stdout)
    if (r.stderr) process.stderr.write(r.stderr)
    process.exitCode = r.exitCode
  }, { label: `exec ${argv.join(' ')}`.slice(0, 60), record: false })
}

/** 收集所有 --set k=v（也接受 --k=v 形式） */
function collectVars(rest: string[]): Record<string, string> {
  const vars: Record<string, string> = {}
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] as string
    if (a === '--set' || a === '-s') {
      const kv = rest[i + 1] ?? ''
      const eq = kv.indexOf('=')
      if (eq > 0) { vars[kv.slice(0, eq)] = kv.slice(eq + 1); i++ }
    } else if (a.startsWith('--set=')) {
      const kv = a.slice(6)
      const eq = kv.indexOf('=')
      if (eq > 0) vars[kv.slice(0, eq)] = kv.slice(eq + 1)
    }
  }
  return vars
}

async function cmdDo(name?: string, rest: string[] = []): Promise<void> {
  const recipes = listRecipes()

  if (!name) {
    console.log('recipes:')
    for (const e of recipes) {
      const tag = e.source === 'user' ? '(user)' : ''
      console.log(`  ${e.recipe.name.padEnd(16)} ${e.recipe.description} ${tag}`)
    }
    if (recipes.length === 0) console.log('  (none)')
    console.log('')
    console.log('run one:  uh do <name> [--set key=value]')
    console.log('own it:   drop a .json into ~/.uh/recipes/ (same shape as the builtin ones)')
    return
  }

  const entry = loadRecipe(name)
  if (!entry) {
    fail(`no such recipe: ${name}. Available: ${recipes.map((r) => r.recipe.name).join(', ') || '(none)'}`)
  }

  const recipe = entry.recipe
  const vars = resolveVars(recipe, collectVars(rest))
  const task = renderTemplate(recipe.task.join('\n'), vars)

  console.log(`recipe: ${recipe.name}${entry.source === 'user' ? ' (user)' : ''}`)
  if (Object.keys(vars).length > 0) {
    console.log(`vars:   ${Object.entries(vars).map(([k, v]) => `${k}=${v}`).join(', ')}`)
  }
  console.log('')

  let checkResults: Awaited<ReturnType<typeof runRecipeChecks>> = []

  await withHarness(async (h) => {
    const out = await h.runTask({ task })
    console.log('')
    console.log(`--- deliverables (${out.artifacts.length}) ---`)
    for (const a of out.artifacts) {
      const rel = out.verifications.filter((v) => v.path === a.path)
      const ok = rel.length > 0 && rel.every((v) => v.result === 'pass')
      console.log(`  ${ok ? '✓' : '·'} ${a.path}  ${a.bytes} B  ${ok ? `${rel.length}/${rel.length}` : ''}`)
    }

    if ((recipe.checks ?? []).length > 0) {
      console.log('')
      console.log('--- checks ---')
      checkResults = await runRecipeChecks(h, recipe.checks ?? [], vars, h.workspace)
      for (const c of checkResults) {
        const mark = c.result === 'pass' ? '✓' : c.result === 'error' ? '!' : '✗'
        console.log(`  ${mark} ${c.label}   ${c.detail}`)
      }
    }
  })

  const failed = checkResults.filter((c) => c.result !== 'pass')
  if (failed.length > 0) {
    console.log('')
    console.log(`${failed.length} check(s) did not pass — the deliverable is not accepted.`)
    process.exit(1)
  }
}

async function cmdMcp(sub?: string, rest: string[] = []): Promise<void> {
  if (sub === 'add') {
    const name = rest[0]
    const url = rest[1]
    const headerIdx = rest.indexOf('--header')
    const header = headerIdx >= 0 ? (rest[headerIdx + 1] ?? 'authorization') : null

    if (!name || !url) {
      fail('usage: uh mcp add <name> <url> [--header authorization]')
    }
    if (header && !url.startsWith('http')) {
      fail('--header is for HTTP servers only (url must start with http)')
    }

    let entry: Record<string, unknown> = url.startsWith('http') ? { url } : { command: url, args: rest.slice(2) }

    if (header) {
      // token 不回显、不进 shell history、文件 0600
      const raw = (await readSecret(`${header} value (input hidden): `)).trim()
      if (!raw) fail('empty value; nothing written')
      const value = raw.toLowerCase().startsWith('bearer ') || header.toLowerCase() !== 'authorization'
        ? raw
        : `Bearer ${raw}`
      entry = { ...entry, headers: { [header]: value } }
    }

    const res = upsertMcpServer(name, entry as never)
    console.log(`added ${res.name} → ${res.path} (mode 0600)`)
    console.log('verify with:  uh mcp test ' + res.name)
    return
  }

  if (sub === 'remove') {
    const name = rest[0]
    if (!name) fail('usage: uh mcp remove <name>')
    if (removeMcpServer(name)) console.log(`removed ${name}`)
    else fail(`no such server: ${name}`)
    return
  }

  if (sub === 'test') {
    const wanted = rest[0]
    const { servers } = loadMcpServers()
    const names = wanted ? [wanted] : Object.keys(servers)
    if (names.length === 0) fail('no MCP servers configured (see: uh mcp list)')

    for (const n of names) {
      const cfg = servers[n]
      if (!cfg) { fail(`no such server: ${n}`) }
      const reg = new McpRegistry()
      try {
        await reg.start({ [n]: cfg })
        const st = reg.status[0]
        if (!st) {
          console.log(`✗ ${n}  (no status returned)`)
        } else if (st.error) {
          console.log(`✗ ${n}  (${st.transport})`)
          console.log(`    ${st.error}`)
          if (/401|令牌|token|unauthor/i.test(st.error)) {
            console.log('    hint: the server needs a token —')
            console.log(`          uh mcp add ${n} <url> --header authorization`)
          }
        } else {
          console.log(`✓ ${n}  (${st.transport})  ${st.tools} tool(s)`)
          for (const t of reg.tools) {
            console.log(`    ${t.name}`)
            if (t.description) console.log(`        ${t.description.slice(0, 100)}`)
          }
        }
      } finally {
        await reg.close()
      }
    }
    return
  }

  const { servers, sources } = loadMcpServers()

  if (sub === 'list' || sub === undefined) {
    if (sources.length === 0) {
      console.log('no MCP config found. Create one of:')
      console.log('  ~/.uh/mcp.json          (global)')
      console.log('  ./.uh/mcp.json          (this project)')
      console.log('')
      console.log('Format (same shape as Claude Desktop):')
      console.log(JSON.stringify({
        mcpServers: {
          filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'] },
          remote: { url: 'https://example.com/mcp', headers: { authorization: 'Bearer …' } },
        },
      }, null, 2))
      return
    }

    console.log(`config: ${sources.join(', ')}`)
    console.log('')
    await withHarness(async (h) => {
      await h.mcp.start(servers)
      for (const st of h.mcp.status) {
        const mark = st.error ? '✗' : '✓'
        console.log(`${mark} ${st.name}  (${st.transport})  ${st.error ?? `${st.tools} tool(s)`}`)
      }
      if (!h.mcp.isEmpty) {
        console.log('')
        for (const t of h.mcp.tools) {
          console.log(`  ${t.name}`)
          if (t.description) console.log(`      ${t.description.slice(0, 110)}`)
        }
      }
      console.log('')
      console.log('note: MCP servers run outside the local sandbox — their calls are logged')
      console.log("      with isolation: 'none', not with the sandbox level above.")
    }, { record: false })
    return
  }

  fail(`unknown mcp command: ${sub}. Try: uh mcp list`)
}

async function cmdRun(task?: string): Promise<void> {
  if (!task) {
    fail('usage: uh run "<task>" [--model M] [--base-url U] [--api-key K] [--max-steps N]')
  }
  const maxStepsRaw = flag('max-steps')

  await withHarness(async (h) => {
    console.log(`workspace: ${h.workspaceDir}`)
    console.log(`isolation: ${(h as unknown as { describeEnforcement: () => string }).describeEnforcement()}`)
    console.log('')
    const res = await h.runTask({
      task: task!,
      ...(flag('provider') ? { provider: flag('provider')! } : {}),
      ...(flag('model') ? { model: flag('model')! } : {}),
      ...(flag('base-url') ? { baseUrl: flag('base-url')! } : {}),
      ...(flag('api-key') ? { apiKey: flag('api-key')! } : {}),
      ...(maxStepsRaw ? { maxSteps: Number(maxStepsRaw) } : {}),
      ...(argv.includes('--no-plan') ? { plan: false } : {}),
      ...(flag('max-context') ? { maxContextTokens: Number(flag('max-context')) } : {}),
    })
    console.log('')
    console.log('--- answer ---')
    console.log(res.text || '(no text)')
    console.log('')

    // 交付物与断言：这是"proves its work"的字面兑现
    if (res.artifacts.length === 0) {
      console.log('--- deliverables ---')
      console.log('  (no files changed)')
    } else {
      console.log(`--- deliverables (${res.artifacts.length}) ---`)
      let anyFail = false
      for (const a of res.artifacts) {
        const vs = res.verifications.filter((v) => v.path === a.path)
        const passed = vs.filter((v) => v.result === 'pass').length
        const ok = passed === vs.length && vs.length > 0
        if (!ok) anyFail = true
        const size = a.bytes > 1024 ? `${(a.bytes / 1024).toFixed(1)} KB` : `${a.bytes} B`
        console.log(`  ${ok ? '✓' : '✗'} ${a.path.padEnd(28)} ${size.padStart(8)}  ${passed}/${vs.length}  sha256=${a.sha256.slice(0, 12)}`)
        for (const v of vs.filter((x) => x.result !== 'pass')) {
          console.log(`      FAILED: ${describeAssertion(v.assertion)} — ${JSON.stringify(v.detail).slice(0, 160)}`)
        }
      }
      if (anyFail) process.exitCode = 1
    }

    console.log('')
    console.log(`steps=${res.steps} tokens=${res.usage.total} stoppedBy=${res.stoppedBy}${res.compactions ? ` compactions=${res.compactions}` : ''}`)
    console.log(`session: ${h.sessionId ?? '(not recorded)'}`)
    if (res.stoppedBy === 'max-steps') process.exitCode = 2
  }, { label: task!.slice(0, 60), onEvent: makePrinter() })
}

/** 不回显地读一行（API key 不该出现在终端回显或 shell 历史里） */
async function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    // 管道输入：uh config set deepseek < key.txt
    const chunks: Buffer[] = []
    for await (const c of process.stdin) chunks.push(Buffer.from(c))
    return Buffer.concat(chunks).toString('utf8').trim()
  }
  return await new Promise<string>((resolve) => {
    process.stdout.write(prompt)
    const stdin = process.stdin
    stdin.setRawMode?.(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    let buf = ''
    const finish = (v: string) => {
      stdin.setRawMode?.(false)
      stdin.pause()
      stdin.removeListener('data', onData)
      process.stdout.write('\n')
      resolve(v)
    }
    const onData = (chunk: string) => {
      for (const c of chunk) {
        if (c === '\r' || c === '\n') return finish(buf)
        if (c === '\u0003') { process.stdout.write('\n'); process.exit(130) }
        if (c === '\u007f' || c === '\b') { buf = buf.slice(0, -1); continue }
        buf += c
      }
    }
    stdin.on('data', onData)
  })
}

async function cmdProvider(sub?: string): Promise<void> {
  const cfg = readConfig()
  const rows: Array<{ id: string; label: string; proto: string; key: string; model: string; note: string }> = []

  for (const def of PROVIDERS) {
    const key = apiKeyFor(def)
    let model = cfg.providers[def.id]?.model ?? ''
    let note = ''
    if (def.local) {
      const models = await listModels(def, undefined)
      if (models.length) {
        note = 'running'
        model = model || models[0] || ''
      } else {
        note = 'not running'
      }
    } else if (key) {
      const models = await listModels(def, key)
      if (models.length) {
        model = model || models[0] || ''
        note = `${models.length} models`
      } else {
        note = 'key set, models unreachable'
      }
    } else {
      note = def.keysUrl ? 'no key' : ''
    }
    rows.push({
      id: def.id,
      label: def.label,
      proto: def.protocol,
      key: def.local ? '—' : maskKey(key),
      model: model || '—',
      note,
    })
  }

  const def = cfg.defaultProvider
  console.log(`config: ${configPath()}${def ? `  default: ${def}` : ''}`)
  console.log('')
  const w = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n))
  console.log(`  ${w('id', 13)}${w('provider', 22)}${w('key', 14)}${w('model', 26)}state`)
  for (const r of rows) {
    const isDefault = r.id === def ? ' ←default' : ''
    console.log(`  ${w(r.id, 13)}${w(r.label, 22)}${w(r.key, 14)}${w(r.model, 26)}${r.note}${isDefault}`)
  }
  console.log('')
  console.log('  uh config set <id>          store an API key (hidden input)')
  console.log('  uh config use <id>          make it the default')
  console.log('  uh run --provider <id> "…"  one-off override')
  void sub
}

async function cmdConfig(sub?: string, arg?: string, value?: string): Promise<void> {
  if (!sub || sub === 'show') {
    const cfg = readConfig()
    console.log(configPath())
    console.log(`default: ${cfg.defaultProvider ?? '(auto)'}`)
    const ids = Object.keys(cfg.providers)
    if (ids.length === 0) console.log('no providers configured')
    for (const id of ids) {
      const e = cfg.providers[id] as { apiKey?: string; model?: string; baseUrl?: string }
      console.log(`  ${id}: key=${maskKey(e.apiKey)} model=${e.model ?? '(auto)'}${e.baseUrl ? ` baseUrl=${e.baseUrl}` : ''}`)
    }
    return
  }

  if (sub === 'use') {
    if (!arg) fail('usage: uh config use <provider-id>')
    if (!findProvider(arg!)) fail(`unknown provider: ${arg}`)
    setDefaultProvider(arg!)
    console.log(`default provider: ${arg}`)
    return
  }

  if (sub === 'unset') {
    if (!arg) fail('usage: uh config unset <provider-id>')
    console.log(unsetProvider(arg!) ? `removed ${arg}` : `${arg} was not configured`)
    return
  }

  if (sub === 'set') {
    if (!arg) {
      fail(
        'usage: uh config set <provider-id>[.model|.baseUrl]\n' +
        '       uh config set deepseek          (prompts for the key)',
      )
    }
    const [id, field] = arg!.split('.')
    if (!findProvider(id!)) fail(`unknown provider: ${id}\nKnown: ${PROVIDERS.map((p) => p.id).join(', ')}`)

    if (field === 'model') {
      if (!value) fail('usage: uh config set <id>.model <model-name>')
      setProviderEntry(id!, { model: value! })
      console.log(`${id}.model = ${value}`)
      return
    }
    if (field === 'baseUrl') {
      if (!value) fail('usage: uh config set <id>.baseUrl <url>')
      setProviderEntry(id!, { baseUrl: value! })
      console.log(`${id}.baseUrl = ${value}`)
      return
    }

    const key = value ?? (await readSecret(`API key for ${id} (input hidden): `))
    if (!key) fail('empty key, nothing stored')
    setProviderEntry(id!, { apiKey: key })
    console.log(`stored key for ${id}: ${maskKey(key)}  → ${configPath()}`)
    return
  }

  fail(`unknown config command: ${sub}`)
}

async function cmdSession(sub?: string, id?: string): Promise<void> {
  const store = new EventStore()

  if (sub === 'list' || sub === undefined) {
    const rows = store.list()
    if (rows.length === 0) {
      console.log('no sessions yet (run something that executes, e.g. `uh sandbox check`)')
      return
    }
    console.log('ID                              CREATED                 EVENTS  STATUS')
    for (const m of rows.slice(0, 30)) {
      const c = localTime(m.created_at)
      console.log(`${m.id.padEnd(31)} ${c.padEnd(23)} ${String(m.last_seq).padStart(6)}  ${m.status}`)
    }
    return
  }

  if (sub === 'show') {
    if (!id) fail('usage: uh session show <session-id>')
    const meta = store.get(id)
    if (!meta) fail(`session not found: ${id}`)
    const evs = store.read(id)
    console.log(`${meta.id}  ${meta.status}  ${localTime(meta.created_at)}`)
    console.log(`workspace: ${meta.workspace}`)
    console.log(`${evs.length} events`)
    console.log('')
    for (const e of evs) {
      const p = JSON.stringify(e.payload)
      const brief = p.length > 96 ? p.slice(0, 93) + '...' : p
      console.log(`#${String(e.seq).padStart(3)}  ${e.kind.padEnd(22)} ${e.source.padEnd(12)} ${brief}`)
    }
    return
  }

  if (sub === 'replay') {
    if (!id) fail('usage: uh session replay <session-id>')
    const meta = store.get(id)
    if (!meta) fail(`session not found: ${id}`)
    const verifications = store.read(id, { kinds: ['verification/asserted'] })
    if (verifications.length === 0) fail(`no verification/asserted events in ${id}`)

    // 回放：重新执行断言并比对，不重跑有副作用的钩子（docs/event-model.md §4.3）
    await withHarness(async (h) => {
      let same = 0
      let diff = 0
      for (const ev of verifications) {
        const a = ev.payload.assertion as { kind?: string; name?: string; argv?: string[]; expect?: string }
        if (a?.kind !== 'sandbox-probe' || !a.argv) {
          console.log(`SKIP  ${ev.id} (unsupported assertion kind: ${String(a?.kind)})`)
          continue
        }
        let got: 'ok' | 'deny'
        try {
          const r = await h.exec({ argv: a.argv as [string, ...string[]], timeoutMs: 8000 })
          got = r.exitCode === 0 ? 'ok' : 'deny'
        } catch {
          got = 'deny'
        }
        const recorded = ev.payload.result === 'pass' ? a.expect : (ev.payload.detail as { got?: string })?.got
        const match = got === recorded || got === a.expect
        if (match) same++
        else diff++
        console.log(`${match ? 'SAME' : 'DIFF'}  ${a.name ?? ev.id}  recorded=${String(recorded)} now=${got}`)
      }
      console.log('')
      console.log(`${same} reproduced, ${diff} diverged`)
      if (diff > 0) process.exitCode = 1
    }, { record: false })
    return
  }

  fail(`unknown session subcommand: ${sub}`)
}

function cmdHelp(): void {
  console.log(`uh ${VERSION} — the agent that proves its work

Usage:
  uh run "<task>"           run a task with the model agent (sandboxed)
  uh do [name]              run a recipe: fixed task, then our own acceptance checks
  uh serve [--port N]       local web UI (default 127.0.0.1:7878)
  uh desktop                same, and open it in your browser
  uh mcp list               show MCP servers and the tools they expose
  uh mcp add <name> <url>   add an HTTP MCP server (token asked, hidden)
  uh mcp test [name]        handshake check, with a readable failure
  uh mcp remove <name>      drop a server from ~/.uh/mcp.json
  uh exec -- <cmd>          run one command inside the sandbox (debugging)
  uh provider list          supported providers, keys, live models
  uh config set <id>        store an API key (hidden input); .model / .baseUrl
  uh config use <id>        set the default provider
  uh config show            show config (keys masked)
  uh doctor                 show platform, sandbox isolation, plugins
  uh plugin list            list plugins found on disk
  uh tool <name>            run a tool registered by a plugin
  uh sandbox check          prove the sandbox actually blocks what it claims
  uh session list           recent sessions (append-only event log)
  uh session show <id>      print a session's events
  uh session replay <id>    re-run recorded assertions and compare results
  uh --version              print version

Environment:
  UH_PLUGIN_DIR   colon-separated plugin roots (default: ~/.uh/plugins, ./.uh/plugins)
  UH_LOG_LEVEL    debug | info | warn | error | silent

Sandbox:
  Isolated exec requires landlock / bwrap / seatbelt. If none is available the
  effective level is "path-guard" and exec is refused unless --allow-unconfined.

  --allow-unconfined   run without isolation (explicit risk acceptance)
  --allow-home         let sandboxed commands read $HOME (default: unreadable)
  --no-net             block TCP inside the sandbox (landlock ABI >= 4)
`)
}

async function main(): Promise<void> {
  switch (cmd) {
    case '--version': case '-v': case 'version':
      console.log(VERSION); return
    case 'doctor':
      await cmdDoctor(); return
    case 'plugin':
      await cmdPlugin(argv[1]); return
    case 'tool':
      await cmdTool(argv[1], argv.slice(2)); return
    case 'sandbox':
      await cmdSandbox(argv[1]); return
    case 'session':
      await cmdSession(argv[1], argv[2]); return
    case 'provider':
      await cmdProvider(argv[1]); return
    case 'config':
      await cmdConfig(argv[1], argv[2], argv[3]); return
    case 'serve': {
      const port = Number(flag('port') ?? 7878)
      const srv = await startServer({ port })
      console.log(`UnitHarness UI  ${srv.url}`)
      console.log('press Ctrl+C to stop')
      return
    }
    case 'desktop': {
      const port = Number(flag('port') ?? 7878)
      const srv = await startServer({ port })
      const opened = openBrowser(srv.url)
      console.log(`UnitHarness UI  ${srv.url}${opened ? '  (opened in your browser)' : ''}`)
      console.log('press Ctrl+C to stop')
      return
    }
    case 'do':
      await cmdDo(argv[1], argv.slice(2)); return
    case 'mcp':
      await cmdMcp(argv[1], argv.slice(2)); return
    case 'exec':
      await cmdExec(argv.slice(1)); return
    case 'run':
      await cmdRun(argv.slice(1).filter((a) => !a.startsWith('--') && !isFlagValue(a)).join(' ')); return
    case 'help': case '--help': case '-h':
      cmdHelp(); return
    default:
      fail(`unknown command: ${cmd}\n\ntry: uh help`)
  }
}

main().catch((e: unknown) => {
  // 打印错误本身，不甩堆栈：用户看到的应该是能照做的指引，不是我们的调用栈
  const msg = e instanceof Error ? e.message : String(e)
  console.error(msg)
  if (process.env.UH_DEBUG === '1' && e instanceof Error && e.stack) {
    console.error('')
    console.error(e.stack)
  }
  process.exit(1)
})
