/**
 * 哪些目录不算「工作区内容」。
 *
 * 这份清单只有一处，因为散着写过一次就出了事：ppt-master 在自己的工作区里装了
 * 依赖，生成了 `.venv` 和 `.uvcache`（uv 的缓存，几万个文件）。文件遍历、检查点、
 * 交付物列表各自记着自己的黑名单，而这个目录谁都没排除——于是模型被喂进几百个
 * `lxml/includes/libxslt/*.h`，一条会话烧到三千多步都没开始做正事。
 *
 * 判据不是「名字眼熟」，而是：**这不是人写的，删掉还能再生成**。
 * 依赖、构建产物、工具缓存都符合；源码、
 * 笔记、生成的 .pptx 不符合——它们再小也不能跳。
 */
import fs from 'node:fs'
import path from 'node:path'

export const JUNK_DIRS: ReadonlySet<string> = new Set([
  // 依赖
  'node_modules', 'bower_components', '.pnpm-store', '.yarn',
  // 版本控制 / 本工具自己的状态
  '.git', '.hg', '.svn', '.uh',
  // 构建产物
  'dist', 'build', 'out', '.next', '.nuxt', '.output', '.svelte-kit', 'target',
  // 各种缓存
  '.cache', '.uvcache', 'uv-cache', '.gocache', 'gocache', 'go-build', '.go-build',
  '.turbo', '.parcel-cache', '.nyc_output', 'coverage', '.ruff_cache', '.mypy_cache',
  '.pytest_cache', '.tox', '.nox', '.ipynb_checkpoints', '.gradle', '.cargo',
  '__pycache__', '.idea', '.vscode',
  // Python 环境
  '.venv', 'venv', 'env', '.conda',
  // 任意 venv 内部必然存在的目录（`pptvenv`、`.venv-ppt` 这类自定义名字
  // 靠上面那行枚举永远盖不住，见 isVenvDir）
  'site-packages', 'dist-packages',
])

/** 名字像垃圾但不是目录的（打包产物、系统杂项）也一并跳过 */
export const JUNK_FILES: ReadonlySet<string> = new Set([
  '.DS_Store', 'Thumbs.db',
])

/** 这个路径的某一段是不是缓存/依赖目录 */
export function isJunkPath(rel: string): boolean {
  const parts = rel.split(/[\\/]+/).filter(Boolean)
  return parts.some((p) => JUNK_DIRS.has(p))
}

/** 遍历时是否该跳过这个目录（按 basename 判断，调用方已有 abs） */
export function isJunkDirName(name: string): boolean {
  return JUNK_DIRS.has(name)
}

/**
 * 这是一个 venv 吗？判据是根下的 `pyvenv.cfg`，不是目录名。
 *
 * 按名字枚举只能盖住默认的 `venv` / `.venv`：`pptvenv`、`.venv-ppt`、用户随手
 * 起的名字一个都盖不住，而它们里面都有 config 和 site-packages。一次跑完，
 * 几百个 `site-packages/*.py` 就变成了「交付物」刷满界面——用户看到的是一屏
 * 和自己工作无关的哈希，跟 Codex 只报自己补丁的做法完全不同。
 *
 * 依赖和解释器不是人的产出：删掉还能装回来，所以整棵跳过。
 */
export function isVenvDir(abs: string): boolean {
  try {
    return fs.statSync(path.join(abs, 'pyvenv.cfg')).isFile()
  } catch {
    return false
  }
}
