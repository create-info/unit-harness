import esbuild from 'esbuild'
import { readFileSync, existsSync, writeFileSync, unlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

// Linux 单文件发行版需要自举 landlock helper：把它 base64 内嵌进 bundle。
// 其他平台（helper 是 Linux ELF）以及未构建 helper 的环境注入空串。
const helperPath = 'native/landlock-helper/build/landlock-helper'
const embedHelper =
  process.platform === 'linux' && existsSync(helperPath)
    ? readFileSync(helperPath).toString('base64')
    : ''

// ui.html 的内联脚本没有任何工具会去查语法，缺一个括号就整个界面白屏，
// 而且页面照样 200。构建时先用 node 解析一遍，坏在构建阶段而不是用户屏幕上。
{
  const ui = readFileSync('packages/cli/src/ui.html', 'utf8')
  const m = /<script>([\s\S]*)<\/script>/.exec(ui)
  if (m) {
    const tmp = join(tmpdir(), `uh-ui-check-${process.pid}.mjs`)
    writeFileSync(tmp, m[1])
    try {
      execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' })
    } catch (err) {
      console.error('ui.html has a syntax error:\n' + String(err.stderr ?? err))
      process.exit(1)
    } finally {
      try { unlinkSync(tmp) } catch { /* ignore */ }
    }
  }
}

await esbuild.build({
  entryPoints: ['packages/cli/src/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs', // SEA 主程序必须是 CJS（Node 22 已验证）
  target: 'node22',
  outfile: 'dist/uh.cjs',
  sourcemap: false,
  minify: false,
  define: {
    __UH_VERSION__: JSON.stringify(pkg.version),
    __UH_LANDLOCK_B64__: JSON.stringify(embedHelper),
  },
  loader: { '.html': 'text' },
  logLevel: 'info',
})

console.log(`built dist/uh.cjs${embedHelper ? ` (+${Math.round(embedHelper.length / 1024)}kB embedded landlock helper)` : ''}`)
