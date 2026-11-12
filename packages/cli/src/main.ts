#!/usr/bin/env node
/**
 * uh CLI —— 内核的两种壳之一（CLI / 桌面共用同一引擎，D12）。
 *
 * P0 范围：version / doctor / plugin list / tool。
 * 不含 LLM 与剧本执行——那是 P1。
 */
import os from 'node:os'
import { join } from 'node:path'

import { Harness, describeIsolation } from '@unit-harness/core'

import { VERSION } from './version.ts'

const argv = process.argv.slice(2)
const cmd = argv[0] ?? 'help'

function pluginDirs(): string[] {
  const env = process.env.UH_PLUGIN_DIR
  if (env) return env.split(':').filter(Boolean)
  return [join(os.homedir(), '.uh', 'plugins'), join(process.cwd(), '.uh', 'plugins')]
}

function fail(msg: string, code = 1): never {
  console.error(msg)
  process.exit(code)
}

async function withHarness<T>(fn: (h: Harness) => Promise<T>): Promise<T> {
  const h = new Harness({
    pluginDirs: pluginDirs(),
    logLevel: (process.env.UH_LOG_LEVEL as never) ?? 'warn',
    unconfined: argv.includes('--allow-unconfined'),
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
  })
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

function cmdHelp(): void {
  console.log(`uh ${VERSION} — the agent that proves its work

Usage:
  uh doctor                 show platform, sandbox isolation, plugins
  uh plugin list            list plugins found on disk
  uh tool <name>            run a tool registered by a plugin
  uh --version              print version

Environment:
  UH_PLUGIN_DIR   colon-separated plugin roots (default: ~/.uh/plugins, ./.uh/plugins)
  UH_LOG_LEVEL    debug | info | warn | error | silent

Sandbox:
  Isolated exec requires landlock / bwrap / seatbelt. If none is available the
  effective level is "path-guard" and exec is refused unless --allow-unconfined.
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
    case 'help': case '--help': case '-h':
      cmdHelp(); return
    default:
      fail(`unknown command: ${cmd}\n\ntry: uh help`)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
