/**
 * 测试的临时目录，跑完就删。
 *
 * 以前每个文件自己 `mkdtempSync`，然后「记得」在 finally 里 `rmSync`——
 * 只要有一个用例中途断言失败、或者干脆没写清理，`/tmp` 里就多一个 uh-xxx 目录，
 * 一次全量跑下来能攒十几个，看起来像有进程在漏。测试留下的东西应该是零。
 *
 * 用法：
 *   import { tmpHome } from './helpers/tmp.mjs'
 *   const home = tmpHome('uh-cases-')
 *
 * 不需要写 finally：文件里所有用例跑完后由 after() 统一删。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after } from 'node:test'

const created = []

export function tmpHome(prefix = 'uh-test-') {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  created.push(dir)
  return dir
}

after(() => {
  for (const dir of created) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch { /* 已经删了就算了 */ }
  }
  created.length = 0
})
