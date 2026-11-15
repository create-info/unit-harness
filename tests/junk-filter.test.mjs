/**
 * 缓存目录不许出现在「改动/交付物」里。
 *
 * 这条测试是从事故里长出来的：ppt-master 在一个工作区里装了依赖，uv 把缓存写成
 * `.uvcache/…`，模型被喂进几千个 `lxml/includes/libxslt/*.h`，一条会话烧到三千步
 * 也没做出 PPT；界面上那一列「文件改动」点开全是 404。
 *
 * 判据：**删掉还能再生成的东西不是用户的工作成果**。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const { snapshotDir, diffSnapshots, collectArtifacts } = await import('../packages/core/src/artifact/snapshot.ts')
const { JUNK_DIRS, isJunkPath } = await import('../packages/core/src/fs/junk.ts')

test('清单认得工具缓存目录', () => {
  for (const d of ['.uvcache', '.venv', 'node_modules', '.git', '__pycache__', '.cache', 'dist', 'target']) {
    assert.ok(JUNK_DIRS.has(d), `${d} 应该在清单里`)
  }
  assert.ok(isJunkPath('.uvcache/archive-v0/abc/lxml/includes/libxslt/xslt.h'))
  assert.ok(isJunkPath('pkg/node_modules/x.js'))
  assert.equal(isJunkPath('slides/deck.pptx'), false)
  assert.equal(isJunkPath('notes/lecture/w1.md'), false)
})

test('缓存里的变化不算交付物，源码的变化算', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uh-junk-'))
  try {
    fs.mkdirSync(path.join(dir, '.uvcache/archive-v0/x'), { recursive: true })
    fs.writeFileSync(path.join(dir, '.uvcache/archive-v0/x/xslt.h'), 'header')
    fs.mkdirSync(path.join(dir, 'slides'), { recursive: true })

    const before = snapshotDir(dir)
    // 会话期间：工具往缓存里写，人写了一个真正的东西
    fs.writeFileSync(path.join(dir, '.uvcache/archive-v0/x/xslt2.h'), 'header2')
    fs.writeFileSync(path.join(dir, 'slides/deck.md'), '# 狼牙山五壮士')
    const after = snapshotDir(dir)

    const changes = diffSnapshots(before, after)
    const arts = collectArtifacts(dir, changes, after)
    const paths = arts.map((a) => a.path)

    assert.deepEqual(paths, ['slides/deck.md'], `只该有真文件，实际：${JSON.stringify(paths)}`)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('老快照里夹带的缓存路径，读的时候也滤掉', () => {
  // 模拟旧版本拍下来的快照：垃圾路径已经在里面了
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uh-junk2-'))
  try {
    const after = {
      '.uvcache/archive-v0/y/a.h': { size: 10, mtimeMs: 0, sha256: 'x' },
      'real.txt': { size: 3, mtimeMs: 0, sha256: 'y' },
    }
    const changes = { added: Object.keys(after), modified: [], removed: [] }
    const arts = collectArtifacts(dir, changes, after)
    assert.deepEqual(arts.map((a) => a.path), ['real.txt'])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
