// 最小 host：模拟 uh 加载外部插件并调用 apply
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { homedir } from 'node:os'

const dir = process.env.UH_PLUGIN_DIR || join(homedir(), '.uh', 'plugins')

async function main() {
  console.log('[host] node version:', process.version)
  console.log('[host] execPath:', process.execPath)
  console.log('[host] plugin dir:', dir)

  let entries = []
  try { entries = await readdir(dir) } catch { console.log('[host] plugin dir missing') }

  const loaded = []
  for (const name of entries) {
    const p = join(dir, name, 'index.js')
    try { await stat(p) } catch { continue }
    const url = pathToFileURL(p).href
    try {
      // 关键点：SEA 产物中能否动态 import 用户目录下的 ESM
      const mod = await import(url)
      const plugin = mod.default
      if (!plugin || typeof plugin.apply !== 'function') {
        console.log('[host] skip (not a plugin):', name)
        continue
      }
      const ctx = {
        apiVersion: 1,
        log: { info: (...a) => console.log('[plugin:' + name + ']', ...a) },
        provide: () => () => {},
      }
      await plugin.apply(ctx, {})
      loaded.push(plugin.name)
    } catch (e) {
      console.error('[host] LOAD FAILED', name, '->', e && e.message)
    }
  }

  console.log('[host] loaded:', JSON.stringify(loaded))
  console.log('[host] RESULT:', loaded.length > 0 ? 'SEA_DYNAMIC_IMPORT_OK' : 'SEA_DYNAMIC_IMPORT_EMPTY')
}

main().catch((e) => { console.error('[host] FATAL', e); process.exit(1) })
