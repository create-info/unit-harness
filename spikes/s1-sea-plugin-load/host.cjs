// 最小 host：模拟 uh 加载外部插件并调用 apply（CJS bundle，SEA 主程序必须是 CJS）
const { readdir, stat } = require('node:fs/promises')
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')
const { homedir } = require('node:os')

// SEA 产物是 CJS main；动态 import 用 new Function 包一层，
// 既避免打包器把 import() 改写，也保证运行时走原生 ESM loader。
const dynamicImport = new Function('s', 'return import(s)')

async function main() {
  const dir = process.env.UH_PLUGIN_DIR || join(homedir(), '.uh', 'plugins')
  console.log('[host] node version:', process.version)
  console.log('[host] execPath:', process.execPath)
  console.log('[host] plugin dir:', dir)
  console.log('[host] typeof import:', typeof dynamicImport('data:text/javascript,export default 1').then)

  let entries = []
  try { entries = await readdir(dir) } catch { console.log('[host] plugin dir missing') }

  const loaded = []
  for (const name of entries) {
    const p = join(dir, name, 'index.js')
    try { await stat(p) } catch { continue }
    const url = pathToFileURL(p).href
    try {
      const mod = await dynamicImport(url)   // 关键点：SEA 产物中动态 import 用户目录 ESM
      const plugin = mod.default || mod
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
