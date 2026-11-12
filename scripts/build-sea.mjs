/**
 * 构建单文件发行产物（Node SEA）。
 *
 * 约束（spikes/RESULTS.md）：
 *  - 入口必须是 CJS，main 指向 dist/uh.cjs；
 *  - 动态 import 用 new Function 包裹，否则会被 SEA 的 CJS 加载器改写；
 *  - macOS 必须重新签名，否则内核直接 SIGKILL；
 *  - Windows 产物带 .exe。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, copyFileSync, chmodSync, readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// new URL('..', .../scripts/build-sea.mjs) 已经是仓库根，不要再 dirname 一次
const ROOT = fileURLToPath(new URL('..', import.meta.url))
process.chdir(ROOT)

const platform = process.platform // linux | darwin | win32
const arch = process.arch         // x64 | arm64
const isWin = platform === 'win32'
const isMac = platform === 'darwin'

const outName = `uh-${platform === 'win32' ? 'win32' : platform}-${arch}${isWin ? '.exe' : ''}`
const outDir = 'dist/bin'
const outPath = join(outDir, outName)

mkdirSync('build', { recursive: true })
mkdirSync(outDir, { recursive: true })

// 1) 打包 CJS
execFileSync(process.execPath, ['scripts/build.mjs'], { stdio: 'inherit' })

// 2) SEA blob
const configPath = 'build/sea-config.json'
writeFileSync(configPath, JSON.stringify({
  main: 'dist/uh.cjs',
  output: 'build/sea-prep.blob',
  disableExperimentalSEAWarning: true,
  useCodeCache: false,
  useSnapshot: false,
}, null, 2))

execFileSync(process.execPath, ['--experimental-sea-config', configPath], { stdio: 'inherit' })

// 3) 复制 node 可执行文件，再注入 blob
copyFileSync(process.execPath, outPath)
if (!isWin) chmodSync(outPath, 0o755)

if (isMac) {
  // 复制出来的 node 带 Apple 签名，注入前必须先去掉
  execFileSync('codesign', ['--remove-signature', outPath], { stdio: 'inherit' })
}

const postjectArgs = [
  '--yes', 'postject@1.0.0-alpha.6',
  outPath, 'NODE_SEA_BLOB', 'build/sea-prep.blob',
  '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
]
if (isMac) postjectArgs.push('--macho-segment-name', 'NODE_SEA')
execFileSync('npx', postjectArgs, { stdio: 'inherit', shell: isWin })

if (isMac) {
  // 不重新签名 → 运行即被内核 kill
  execFileSync('codesign', ['-s', '-', '--force', outPath], { stdio: 'inherit' })
}

// 4) 冒烟 + 校验和
const version = execFileSync(outPath, ['--version'], { encoding: 'utf8' }).trim()
const buf = readFileSync(outPath)
const sha = createHash('sha256').update(buf).digest('hex')
writeFileSync(`${outPath}.sha256`, `${sha}  ${outName}\n`)

const mb = (statSync(outPath).size / 1024 / 1024).toFixed(1)
console.log(`built ${outPath} (${mb} MB)`)
console.log(`smoke: ${outName} --version -> ${version}`)
console.log(`sha256: ${sha}`)
