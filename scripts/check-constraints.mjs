#!/usr/bin/env node
/**
 * 四条不可回退约束（docs/design-decisions.md 附录）。
 * 任一违反 -> 退出码 1。
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, extname } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'spikes'])

const errors = []
const files = []

function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p)
    else if (['.ts', '.js', '.mjs', '.cjs', '.json', '.md', '.yml', '.yaml'].includes(extname(p))) {
      files.push(p)
    }
  }
}
walk(ROOT)

// 1. 不得引入 Bun
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
  for (const name of Object.keys(pkg[field] ?? {})) {
    if (/^bun$/i.test(name) || /bun-/.test(name)) errors.push(`C1: bun dependency "${name}" in package.json`)
  }
}
for (const f of files) {
  if (f.endsWith('.md') || f.endsWith('check-constraints.mjs')) continue
  const src = readFileSync(f, 'utf8')
  if (/\bBun\./.test(src)) errors.push(`C1: forbidden Bun API usage in ${f}`)
}

// 2. 不得 vendor Cordis
if (existsSync(join(ROOT, 'vendor/cordis'))) errors.push('C2: vendor/cordis exists; use the npm dependency')

// 3. 核心 schema 不得出现同步字段
const SYNC_FIELDS = /\b(remote_id|synced_at|server_version|server_id)\b/
for (const f of files) {
  if (!/\.(ts|sql)$/.test(f)) continue
  const src = readFileSync(f, 'utf8')
  if (SYNC_FIELDS.test(src) && !f.includes('/sync')) {
    errors.push(`C3: sync field in core source ${f}`)
  }
}

// 4. 不得声称能力声明是安全边界
// 只扫面向用户的文档；允许"不得声称"这类否定语境
const CLAIM = /capability (manifest|declaration)[^.]{0,60}(prevents|enforces|blocks|guarantees)/i
const NEGATED = /\b(not|never|do not|don't|不得|不是|并非)\b/i
for (const f of files) {
  if (!/(^|\/)(README[^/]*|SECURITY|[A-Z_]+\.md)$/.test(f)) continue
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    if (CLAIM.test(line) && !NEGATED.test(line)) errors.push(`C4: false security claim in ${f}: ${line.trim().slice(0, 80)}`)
  }
}

if (errors.length) {
  console.error('constraint violations:\n' + errors.map((e) => '  - ' + e).join('\n'))
  process.exit(1)
}
console.log(`constraints: ok (${files.length} files scanned)`)
