// S1b：Cordis 能否被 bundle 进 SEA，且外部插件能否加载并注册
import { Context } from '@deepseek-ai/cordis'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const dynamicImport = new Function('s', 'return import(s)')

async function main() {
  console.log('[host] node', process.version, '| execPath', process.execPath)

  // 关键点 1：Cordis（ESM）被 esbuild 内联进单文件后，能否正常实例化
  const ctx = new Context()
  console.log('[host] Context created:', !!ctx)

  const dir = process.env.UH_PLUGIN_DIR
  let entries = []
  try { entries = await readdir(dir) } catch { console.log('[host] no plugin dir') }

  const registered = []
  for (const name of entries) {
    const p = join(dir, name, 'index.js')
    try { await stat(p) } catch { continue }
    try {
      // 关键点 2：外部 ESM 插件（位于用户目录、零运行时依赖）
      const mod = await dynamicImport(pathToFileURL(p).href)
      const plugin = mod.default
      ctx.plugin(plugin)
      registered.push(plugin.name)
      console.log('[host] ctx.plugin() accepted:', plugin.name)
    } catch (e) {
      console.error('[host] FAILED', name, '->', e && e.message)
    }
  }

  await new Promise((r) => setTimeout(r, 300))

  // 关键点 3：插件通过 ctx.provide 注册的服务，是否真的挂到 Cordis 上下文上
  console.log('[host] ctx.hello =', typeof ctx.hello)
  console.log('[host] registered =', JSON.stringify(registered))
  console.log('[host] RESULT:', registered.length && typeof ctx.hello === 'object'
    ? 'CORDIS_SEA_OK' : 'CORDIS_SEA_PARTIAL')
}

main().catch((e) => { console.error('[host] FATAL', e); process.exit(1) })
