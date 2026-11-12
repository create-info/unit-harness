import esbuild from 'esbuild'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

await esbuild.build({
  entryPoints: ['packages/cli/src/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',           // SEA 主程序必须是 CJS（Node 22 已验证）
  target: 'node22',
  outfile: 'dist/uh.cjs',
  sourcemap: false,
  minify: false,
  define: { __UH_VERSION__: JSON.stringify(pkg.version) },
  logLevel: 'info',
})
console.log('built dist/uh.cjs')
