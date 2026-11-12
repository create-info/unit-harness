#!/usr/bin/env node
/**
 * uh CLI —— 内核的两种壳之一（CLI / 桌面共用同一引擎，D12）。
 *
 * P0 范围：version / doctor / plugin list / tool。
 * 不含 LLM 与剧本执行——那是 P1。
 */
import os from 'node:os'
import { join } from 'node:path'

import { Harness, EventStore, describeIsolation } from '@unit-harness/core'

import { VERSION } from './version.ts'

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

const VALUE_FLAGS = new Set(['--model', '--base-url', '--api-key', '--max-steps'])

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
      // exec 的记录字段是 argv；插件工具的是 args
      const argv = p.argv as string[] | undefined
      const args = p.args as Record<string, unknown> | undefined
      const cmd = argv ? argv.join(' ') : JSON.stringify(args ?? {})
      console.log(`  ⚙ ${p.tool as string}: ${cmd.slice(0, 120)}`)
      break
    }
    case 'tool/result':
      console.log(`  ${p.status === 'ok' ? '✓' : '✗'} exit=${String(p.exit_code ?? '-')}`)
      break
    case 'turn/end':
      console.log(`· turn end (${String(p.stop_reason)}, ${String(p.steps)} steps)`)
      break
    default:
      break
  }
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
      ...(flag('model') ? { model: flag('model')! } : {}),
      ...(flag('base-url') ? { baseUrl: flag('base-url')! } : {}),
      ...(flag('api-key') ? { apiKey: flag('api-key')! } : {}),
      ...(maxStepsRaw ? { maxSteps: Number(maxStepsRaw) } : {}),
    })
    console.log('')
    console.log('--- answer ---')
    console.log(res.text || '(no text)')
    console.log('')
    console.log(`steps=${res.steps} tokens=${res.usage.total} stoppedBy=${res.stoppedBy}`)
    console.log(`session: ${h.sessionId ?? '(not recorded)'}`)
    if (res.stoppedBy === 'max-steps') process.exitCode = 2
  }, { label: task!.slice(0, 60), onEvent: printEvent })
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
    case 'run':
      await cmdRun(argv.slice(1).filter((a) => !a.startsWith('--') && !isFlagValue(a)).join(' ')); return
    case 'help': case '--help': case '-h':
      cmdHelp(); return
    default:
      fail(`unknown command: ${cmd}\n\ntry: uh help`)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
