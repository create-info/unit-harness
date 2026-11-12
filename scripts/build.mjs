import esbuild from 'esbuild'
import { readFileSync, existsSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

// Linux 单文件发行版需要自举 landlock helper：把它 base64 内嵌进 bundle。
// 其他平台（helper 是 Linux ELF）以及未构建 helper 的环境注入空串。
const helperPath = 'native/landlock-helper/build/landlock-helper'
const embedHelper =
  process.platform === 'linux' && existsSync(helperPath)
    ? readFileSync(helperPath).toString('base64')
    : ''

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
