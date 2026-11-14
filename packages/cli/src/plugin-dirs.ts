/**
 * 插件目录：终端、网页、桌面端必须用同一份。
 *
 * 这份清单以前只写在 main.ts 里，于是 `uh serve` / `uh desktop` 起来以后
 * 一个插件都没有——网页里既不能驱动浏览器，也不能操作手机，而 `uh run`
 * 却有。同一个 uh，换个入口就少一半能力，这不合理。
 *
 * 顺序：显式覆盖 → 安装目录自带 → 用户目录 → 当前项目。
 */
import { join, dirname } from 'node:path'
import { existsSync, realpathSync } from 'node:fs'
import { uhHome } from '@unit-harness/core'

export function pluginDirs(): string[] {
  const env = process.env.UH_PLUGIN_DIR
  if (env) return env.split(':').filter(Boolean)
  const out: string[] = []
  // argv[1] 是这个 uh 的入口（…/dist/uh.cjs，或全局 bin 指向的真实文件）
  const entry = process.argv[1] ? realpathSync(process.argv[1]) : ''
  if (entry) {
    // 随包自带的 plugins/（browser、phone）就在 dist 的上一层
    const bundled = join(dirname(dirname(entry)), 'plugins')
    if (existsSync(bundled)) out.push(bundled)
  }
  out.push(join(uhHome(), 'plugins'), join(process.cwd(), '.uh', 'plugins'))
  return out
}
