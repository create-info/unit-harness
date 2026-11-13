/**
 * 审批记忆的持久化（Codex 的 prefix_rule）。
 *
 * 会话内的记忆只活到进程退出，于是每开一个新会话，`npm install` 要重新批一遍。
 * 这里把它存到磁盘，跨会话生效。
 *
 * 但持久化把「一次同意」放大成「一直同意」，所以三条硬约束：
 *
 *   1. **破坏性命令永不持久化。** 删文件、dd、mkfs、写设备——即使这次批准了，
 *      也只对这一次有效。这类动作的代价是不可逆的，而"上次点过同意"不是
 *      这次的理由。
 *   2. **规则带工作区。** 在 `~/proj-a` 里信任 `npm install` 不代表在 `~/proj-b`
 *      里也信任——两个项目的依赖脚本能干完全不同的事。
 *   3. **规则是前缀，不是工具名。** 记住 `npm install` 不等于记住 `npm`：
 *      后者会让 `npm publish` 也静默通过。
 *
 * 存 `~/.uh/approval-rules.json`，0600。
 */
import fs from 'node:fs'
import path from 'node:path'
import { uhHome } from '../paths.ts'
import type { RiskLevel } from '../remote/risk.ts'

export interface ApprovalRule {
  /** 命令前缀，逐 token 精确匹配：['npm','install'] */
  prefix: string[]
  /** 这条规则只在哪个工作区生效 */
  cwd: string
  /** 什么时候批的、批了几次，给用户看「它记住了什么」 */
  createdAt: string
  uses: number
}

export interface RuleStore {
  rules: ApprovalRule[]
}

/** 永远不会绕过审批的命令动词，哪怕用户批准过 */
const NEVER_PERSIST = new Set([
  'rm', 'rmdir', 'unlink', 'shred', 'wipe',
  'dd', 'mkfs', 'mkfs.ext4', 'mke2fs', 'fdisk', 'parted',
  'shutdown', 'reboot', 'halt', 'poweroff', 'init',
  'chown', 'chmod',
  'kill', 'killall', 'pkill',
  'sudo', 'su', 'doas',
  'curl', 'wget',          // 常配 `| sh`，读不出意图就别记
  'eval', 'exec', 'source',
  'git',                   // git 的破坏性子命令太多（push --force / reset --hard），
                           // 只在下面白名单里单独放行
])

/** 明确能安全记住的（无副作用的构建/测试/安装类） */
const SAFE_HEADS = new Set([
  'npm', 'pnpm', 'yarn', 'bun',
  'pytest', 'tox', 'nox', 'jest', 'vitest', 'mocha',
  'cargo', 'go', 'make', 'cmake', 'mvn', 'gradle',
  'tsc', 'eslint', 'prettier', 'ruff', 'black', 'mypy',
  'node', 'python', 'python3', 'deno',
  'ls', 'cat', 'grep', 'rg', 'find', 'head', 'tail', 'wc',
  'mkdir', 'touch', 'cp', 'mv',
])

/** 这些子命令虽然归在 git 下，但仍然有副作用，不记 */
const GIT_NEVER = /^(push|reset|clean|rebase|filter-branch|gc)$/

/**
 * 把一条命令行规范化成 token 数组。
 * `sh -c "npm test"` 这种外壳要看穿——否则规则会记成 `['sh','-c']`，
 * 之后任何 `sh -c …` 都放行，等于关掉了整个审批。
 */
export function normalizeArgv(argv: string[]): string[] {
  const raw = argv.join(' ').trim()
  const wrapped = /^(?:ba|z|d)?sh\s+-[a-z]*c\s+(.*)$/s.exec(raw)
  if (wrapped) {
    const inner = (wrapped[1] ?? '').trim().replace(/^['"]|['"]$/g, '')
    return splitTokens(inner)
  }
  return argv.map((a) => a.trim()).filter(Boolean)
}

/** 简单分词：够用即可，不实现完整 shell 语法 */
function splitTokens(s: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: string | null = null
  for (const ch of s) {
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (/\s/.test(ch)) {
      if (cur) { out.push(cur); cur = '' }
    } else {
      cur += ch
    }
  }
  if (cur) out.push(cur)
  return out
}

/**
 * 明显灾难性的目标：无论如何都不允许被记住。
 *
 * 判据不是"危险动词"，而是"目标不可恢复且范围大到没人真的会一直授权"。
 * `rm -rf node_modules` 是日常工作，`rm -rf /` 是事故。
 */
function isCatastrophic(tokens: string[]): boolean {
  const t = tokens.slice(1).join(' ')
  // 指向根、家目录本身、或上一级
  if (/(^|\s)(\/|\/\*|~|~\/\*|\$HOME|\$HOME\/\*|\.\.|\.\.\/\*)(\s|$)/.test(t)) return true
  // 顶层目录（/etc /usr /home 这类，一段路径且在根下）
  if (/(^|\s)\/[a-z]{2,6}(\/\*)?(\s|$)/.test(t) && !/\/tmp\b|\/var\/tmp\b/.test(t)) return true
  // 写整块设备
  if (/(if|of)=\/dev\/(sd|hd|nvme|vd|xvd|disk|mmcblk)/.test(t)) return true
  // 格式化
  if (tokens[0] && /^mkfs/.test(tokens[0])) return true
  // 关机类
  if (/^(shutdown|reboot|halt|poweroff)$/.test(tokens[0] ?? '')) return true
  return false
}

/**
 * 从一条命令推导「可以记住的规则」。
 * 返回 null 表示这条命令不该被记住——用户只能批准这一次。
 *
 * 两种情况：
 *   - 普通的构建/测试/安装类 → 记**前缀**（`npm install` 覆盖 `npm install lodash`）
 *   - 破坏性命令 → 只记**这一条确切的命令**（`rm -rf node_modules` 不等于 `rm -rf src`）
 *
 * 为什么破坏性也允许记：它恰恰是最常被问的一类，一律不许记等于这个功能没有用。
 * 但记住的粒度必须窄到"同一个目录下同一条命令"，让 `rm -rf ~` 永远命中不了。
 */
export function suggestPrefix(argv: string[], risk: RiskLevel): string[] | null {
  const tokens = normalizeArgv(argv)
  if (!tokens.length) return null

  if (risk === 'destructive') {
    if (isCatastrophic(tokens)) return null
    // 精确匹配：长度就是全部 token
    return tokens
  }

  const head = tokens[0] as string
  const base = head.split('/').pop() ?? head

  if (NEVER_PERSIST.has(base) && base !== 'git') return null
  if (base === 'git') {
    const sub = tokens[1] ?? ''
    if (!sub || GIT_NEVER.test(sub)) return null
    return ['git', sub]
  }

  if (SAFE_HEADS.has(base)) {
    const second = tokens[1]
    // 第二个 token 是参数而不是子命令时只记头：`pytest -q` 记成 `pytest`
    if (!second || second.startsWith('-')) return [base]
    return [base, second]
  }

  // 不在白名单里：不记。宁可下次再问，也不要凭空扩大放行范围
  return null
}

/** argv 是否落在某条规则下 */
export function matchesRule(argv: string[], cwd: string, rule: ApprovalRule): boolean {
  if (rule.cwd !== cwd) return false
  const tokens = normalizeArgv(argv)
  if (tokens.length < rule.prefix.length) return false
  for (let i = 0; i < rule.prefix.length; i++) {
    if (tokens[i] !== rule.prefix[i]) return false
  }
  return true
}

function storePath(): string {
  return path.join(uhHome(), 'approval-rules.json')
}

export function loadRules(): ApprovalRule[] {
  try {
    const raw = fs.readFileSync(storePath(), 'utf8')
    const parsed = JSON.parse(raw)
    const list = Array.isArray(parsed?.rules) ? parsed.rules : []
    return list.filter((r: unknown): r is ApprovalRule => {
      const o = r as ApprovalRule
      return !!o && Array.isArray(o.prefix) && o.prefix.length > 0 && typeof o.cwd === 'string'
    })
  } catch {
    // 文件不存在是正常的（还没批过任何东西），不要当成错误
    return []
  }
}

function saveRules(rules: ApprovalRule[]): void {
  const dir = uhHome()
  fs.mkdirSync(dir, { recursive: true })
  const p = storePath()
  fs.writeFileSync(p, JSON.stringify({ rules }, null, 2) + '\n', { mode: 0o600 })
  // 已存在的文件不会被 mode 改到，显式再来一次
  try { fs.chmodSync(p, 0o600) } catch { /* 不支持的平台就算了 */ }
}

/** 记住一条。重复添加只累加计数，不产生第二条 */
export function addRule(prefix: string[], cwd: string): ApprovalRule {
  const rules = loadRules()
  const existing = rules.find((r) => r.cwd === cwd && r.prefix.join('\u0000') === prefix.join('\u0000'))
  if (existing) {
    existing.uses += 1
    saveRules(rules)
    return existing
  }
  const rule: ApprovalRule = {
    prefix,
    cwd,
    createdAt: new Date().toISOString(),
    uses: 1,
  }
  rules.push(rule)
  saveRules(rules)
  return rule
}

/** 忘掉一条（用户想撤销的时候） */
export function removeRule(prefix: string[], cwd: string): boolean {
  const rules = loadRules()
  const next = rules.filter((r) => !(r.cwd === cwd && r.prefix.join('\u0000') === prefix.join('\u0000')))
  if (next.length === rules.length) return false
  saveRules(next)
  return true
}

/** 命中某条规则就记一次使用，返回命中的规则 */
export function touchMatching(argv: string[], cwd: string): ApprovalRule | null {
  const rules = loadRules()
  const hit = rules.find((r) => matchesRule(argv, cwd, r))
  if (!hit) return null
  hit.uses += 1
  saveRules(rules)
  return hit
}

/** 给界面看：把函数指针藏起来，只给人话 */
export function describeRule(rule: ApprovalRule): string {
  return `${rule.prefix.join(' ')} *  in ${rule.cwd}  (used ${rule.uses}×)`
}
