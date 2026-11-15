/**
 * 内置技能：跟着版本走的几个「怎么做事」的说明。
 *
 * 为什么要有：一个 agent 装好之后的第一个问题永远是「怎么写一个 skill / 怎么
 * 审一段改动 / 怎么复现一个 bug」。把这些写成技能，模型就能自己查、自己照着做，
 * 不用人去翻文档，也不用把它们硬编码进 system prompt 吃满上下文。
 *
 * 落盘策略（见 syncBuiltinSkills）：
 *  - 用户改过的，永不覆盖——他改的那份就是他要的；
 *  - 用户删掉的，永不复活——删掉是一个明确的意思；
 *  - 其余按版本同步，这样内置技能能随版本更新。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

import { uhHome } from '../paths.ts'

export interface BuiltinSkill {
  name: string
  /** 一句话描述会直接进模型的技能索引，所以要写「什么时候用它」 */
  description: string
  content: string
}

const sha = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16)

const CREATE_SKILL = `---
name: create-skill
description: 要新建或修改一个技能（skill）时用它——给出目录结构、frontmatter 写法、验证方式
allowed-tools: run_command, write_file, read_file
---

# 写一个新技能

技能就是磁盘上的一个目录，没有注册表：

\`\`\`
<skills 根>/<name>/
  SKILL.md          # 必须有：frontmatter + 正文
  scripts/          # 可选：这个技能要跑的脚本
  references/       # 可选：长资料，正文里引用路径而不是贴进来
\`\`\`

两个根，作用域不同：

- 全局 \`~/.uh/skills/<name>/\` —— 所有项目可用（默认选这个）
- 项目 \`<工作区>/.uh/skills/<name>/\` —— 跟着这个仓库走，同名会覆盖全局那份

## 1. 先想清楚「什么时候触发」

\`description\` 是模型唯一能看到的线索（正文只在 \`use_skill\` 时才加载），所以它必须写
**触发条件**，不是自我介绍：

\`\`\`yaml
description: 用户要发布 npm 包或改版本号时用它——按 semver 选版本、跑检查、打 tag
\`\`\`

反例：\`release-helper 的说明\`——模型看到这句话不知道什么时候该用。

## 2. 写 SKILL.md

\`\`\`markdown
---
name: my-skill
description: 什么时候用它（一句话，写触发条件）
allowed-tools: run_command, write_file
---

# 做什么

一句话说清这个技能解决什么问题、产出什么。

## 步骤

1. 先做 X（命令：\`npm test\`）
2. 再判断 Y：如果 A 就 B，否则 C
3. 产出：写到 \`report.md\`，格式如下……

## 边界

- 不要动 X（原因）
- 失败时不要重试超过 2 次，直接报告
\`\`\`

写作要点：

- **短**。正文是给模型执行的，不是给人读的文章；能一条命令说清就别写一段话。
- **可执行**。写具体命令和路径，不要写「适当处理」。
- **写出边界**。什么不能做、什么情况该停下来问，比步骤更有价值。
- \`allowed-tools\` 只是声明，不是沙箱——真正的门在审批层。

## 3. 需要脚本就放 scripts/

\`\`\`bash
mkdir -p ~/.uh/skills/my-skill/scripts
cat > ~/.uh/skills/my-skill/scripts/check.sh <<'EOF'
#!/bin/sh
set -eu
echo "ok"
EOF
chmod +x ~/.uh/skills/my-skill/scripts/check.sh
\`\`\`

正文里写 \`scripts/check.sh\` 这个相对路径，模型会用 \`run_skill_script\` 跑它，
并自动拿到这个技能最后列出来的那几行输出。

## 4. 验证

\`\`\`bash
uh skill list                # 出现在列表里就说明被发现了
\`\`\`

网页端：设置 → 插件 → 技能，能看到、能点开改正文、能直接删。
改完不用重启——发现逻辑每次读磁盘。

## 常见坑

- 目录名和 frontmatter 的 \`name\` 不一致 → 列表显示一个名字、磁盘是另一个，删的时候找不到。
- \`description\` 写成口号 → 该用的时候模型想不起来。
- 正文里贴大段参考资料 → 每次加载都吃上下文；放 \`references/\` 里，正文只写「见 references/x.md」。
- 忘了 \`chmod +x\` → 脚本跑不起来。
- 把密钥写进 SKILL.md → 它会进模型上下文、进事件日志。写「从环境变量读」，不要写值。
`

const CODE_REVIEW = `---
name: code-review
description: 要审一段改动（diff / PR / 未提交的修改）时用它——按正确性、边界、安全、可维护性给可执行的结论
allowed-tools: run_command, read_file, search_files
---

# 审一段改动

目标不是「看起来还行」，而是找出会出事的地方，并说清楚为什么。

## 1. 先看清改了什么

\`\`\`bash
git status --short
git diff --stat
git diff              # 未提交
git log --oneline -5  # 提交了但没有远端时
\`\`\`

**读完整文件，不要只看 diff 的几行上下文**——被删掉的分支、调用方的前提条件都在上下文之外。

## 2. 按这个顺序找问题

1. **正确性**：边界（空、0、负、超长、并发）、off-by-one、异步没 await、返回值被忽略。
2. **错误处理**：失败路径有没有把错误吞掉；异常会不会让调用方拿到 200 但实际没做成。
3. **安全**：来自用户的路径/命令/SQL/HTML 有没有被拼进危险位置；密钥有没有出现在日志、错误信息、提交里。
4. **可逆性**：删数据、改配置、发请求这类动作，出错后能不能恢复。
5. **一致性**：新代码和同目录既有写法是否冲突（命名、错误风格、日志格式）。

## 3. 能跑就跑

\`\`\`bash
npm test          # 或项目自己的命令
npx tsc --noEmit
\`\`\`

跑过和没跑过，结论的可信度差一个量级。跑不了就明说「未验证」。

## 4. 输出格式

按严重程度分组，每条都要有位置和为什么：

\`\`\`
[必须改] src/api.ts:42 — 路径拼接直接用了请求参数，\`../\` 能穿出根目录。建议 resolve 后校验前缀。
[建议]  utils/time.ts:8 — 本地时区格式化会让跨时区用户看到错日期。
[疑问]  loop.ts:120 — 这里的重试没有上限，上游挂掉时会一直转？
\`\`\`

规则：

- 不写「整体不错」这类空话；
- 不重写别人的代码，给方向即可；
- 拿不准的标成 [疑问]，不要伪装成结论；
- 用户没问就别说「可以合并」——那是决策，不是审查结论。
`

const DEBUG_REPRO = `---
name: debug-repro
description: 遇到 bug 要先定位根因时用它——先做出最小复现，再改代码，最后用测试钉住
allowed-tools: run_command, read_file, search_files, write_file
---

# 查一个 bug

最容易犯的错是「看两眼就猜一个原因然后改」。先复现，再动手。

## 1. 复现

\`\`\`bash
# 最短路径：能不能用一条命令、一个文件把它重现出来？
\`\`\`

复现不了的 bug 只能盲改。把「什么条件下必现」写成一句话，例如：
「给 \`/api/diff\` 传空 session 时返回 500，因为 store.sessionDir('') 返回 null 后没判空」。

## 2. 缩小范围

- 二分：注释掉一半、换输入、换环境，每次都要能说「这次过了/没过」。
- 读错误的第一现场：堆栈最内层是哪一行，那个值为空的变量是谁给的。
- 在关键点打日志/断点，确认「你以为发生了」的事是否真的发生了。

## 3. 找根因，不是找症状

问一句「为什么」直到答案和代码语义对上：

\`\`\`
500 → sessionDir 返回 null → id 是空串 → 前端在未选会话时也发了请求 → 这是合理行为
→ 根因是后端没处理空 id，不是前端不该发请求
\`\`\`

## 4. 修

- 改最小的那一层；
- 顺手检查同类调用点是不是有一样的问题（\`search_files\` 找一遍）；
- 不要在同一处顺手重构——修 bug 的 diff 越短，回溯越容易。

## 5. 钉住

写一个**会失败**的测试，先确认它在修复前是红的，再确认修复后是绿的。
测试名要写清「什么行为被保护」，不是「test fix bug」。

## 报告

\`\`\`
现象：……
根因：……（文件:行）
为什么之前没暴露：……
修复：……（改了什么、为什么改这层）
验证：跑的哪条命令 / 哪个测试
未验证：……
\`\`\`
`

export const BUILTIN_SKILLS: BuiltinSkill[] = [
  { name: 'create-skill', description: '要新建或修改一个技能（skill）时用它——给出目录结构、frontmatter 写法、验证方式', content: CREATE_SKILL },
  { name: 'code-review', description: '要审一段改动（diff / PR / 未提交的修改）时用它——按正确性、边界、安全给可执行结论', content: CODE_REVIEW },
  { name: 'debug-repro', description: '遇到 bug 要先定位根因时用它——先做最小复现，再改代码，最后用测试钉住', content: DEBUG_REPRO },
]

interface Ledger {
  /** 每个内置技能上次写下去的内容指纹：用来判断「用户改过」还是「原样」 */
  entries: Record<string, string>
}

function ledgerPath(): string {
  return path.join(uhHome(), 'builtin-skills.json')
}

function readLedger(): Ledger {
  try {
    const j = JSON.parse(fs.readFileSync(ledgerPath(), 'utf8')) as Ledger
    return { entries: j.entries ?? {} }
  } catch {
    return { entries: {} }
  }
}

function writeLedger(l: Ledger): void {
  const p = ledgerPath()
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(l, null, 2) + '\n', { mode: 0o600 })
}

/**
 * 把内置技能同步到 ~/.uh/skills。
 *
 * 三条规则，都是「用户优先」：
 *   1. 没装过 → 装；
 *   2. 装过且内容还是我们写的那份 → 随版本更新；
 *   3. 内容被改过 → 保留他的；文件被删掉 → 不复活。
 * 第 3 条尤其重要：删掉一个内置技能是明确的意思，下次启动又冒出来会让人不信任
 * 这个目录里到底谁说了算。
 */
export function syncBuiltinSkills(): { installed: string[]; updated: string[]; kept: string[] } {
  const result = { installed: [] as string[], updated: [] as string[], kept: [] as string[] }
  // 有人不想要「版本自带的东西」混进自己的技能目录（比如做可复现的测试环境）
  if (process.env.UH_BUILTIN_SKILLS === '0') return result
  const ledger = readLedger()
  const root = path.join(uhHome(), 'skills')

  for (const skill of BUILTIN_SKILLS) {
    const dir = path.join(root, skill.name)
    const file = path.join(dir, 'SKILL.md')
    const want = sha(skill.content)
    const prev = ledger.entries[skill.name]

    let current: string | null = null
    try { current = fs.readFileSync(file, 'utf8') } catch { current = null }

    if (current === null) {
      // 从没装过 → 装；记录里有、文件没了 → 用户删了，别复活
      if (prev) { result.kept.push(skill.name); continue }
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(file, skill.content)
      ledger.entries[skill.name] = want
      result.installed.push(skill.name)
      continue
    }

    const haveSha = sha(current)
    if (prev && haveSha === prev) {
      // 原样未动 → 跟着版本走
      if (haveSha !== want) {
        fs.writeFileSync(file, skill.content)
        ledger.entries[skill.name] = want
        result.updated.push(skill.name)
      } else {
        result.kept.push(skill.name)
      }
      continue
    }
    // 用户自己改过（或者同名技能是他自己写的）→ 一个字节都不碰
    if (!prev) ledger.entries[skill.name] = ''
    result.kept.push(skill.name)
  }

  writeLedger(ledger)
  return result
}

/** 面板里要能标出来「这是随版本来的」 */
export function isBuiltinSkill(name: string): boolean {
  return BUILTIN_SKILLS.some((s) => s.name === name)
}
