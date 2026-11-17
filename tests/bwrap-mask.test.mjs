/**
 * bwrap 的凭据屏蔽：目录用 --tmpfs 盖，文件用 /dev/null 盖。
 *
 * 回归点：曾经一律用 --tmpfs 盖文件（.docker/config.json、.netrc），bwrap 会报
 * "Can't mkdir …: Not a directory" 并让整条命令失败。GitHub 的 ubuntu runner 上
 * docker 是预装的，于是每一次 exec 都挂，测试整套变红——本地没装 bwrap 时完全看不到。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { buildBwrapArgv } = await import('../packages/core/src/sandbox/bwrap.ts')

test('credentials are masked with tmpfs for directories and /dev/null for files', () => {
  const home = mkdtempSync(join(tmpdir(), 'uh-bwrap-'))
  const ws = join(home, 'work')
  mkdirSync(join(home, '.ssh'), { recursive: true })
  mkdirSync(join(home, '.docker'), { recursive: true })
  writeFileSync(join(home, '.docker', 'config.json'), '{"auths":{}}')
  writeFileSync(join(home, '.netrc'), 'machine example.com')
  mkdirSync(ws, { recursive: true })

  try {
    const args = buildBwrapArgv({ path: 'bwrap' }, { argv: ['true'], workspace: ws, home })
    const iTmp = args.indexOf(join(home, '.ssh'))
    assert.equal(args[iTmp - 1], '--tmpfs', 'a directory is masked with tmpfs')

    const iFile = args.indexOf(join(home, '.docker', 'config.json'))
    assert.equal(args[iFile - 1], '/dev/null', 'a file is masked with /dev/null')
    assert.equal(args[iFile - 2], '--ro-bind', 'and it is a read-only bind')

    // 不存在的路径不能被塞进参数里，bwrap 会直接失败
    assert.ok(!args.includes(join(home, '.aws')), 'missing paths are skipped')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('--no-home masks the whole home, and a workspace under /tmp survives', () => {
  const home = mkdtempSync(join(tmpdir(), 'uh-bwrap2-'))
  const ws = join(home, 'work')
  mkdirSync(ws, { recursive: true })

  try {
    // allowHome:false → 整个 $HOME 用空 tmpfs 盖掉
    const args = buildBwrapArgv({ path: 'bwrap' }, { argv: ['true'], workspace: ws, home, allowHome: false })
    const iHome = args.lastIndexOf(home)
    assert.ok(iHome > 0, 'home appears in the argv')
    assert.equal(args[iHome - 1], '--tmpfs', 'home is masked with tmpfs when allowHome is false')

    // 工作区在 /tmp 下时不能把 /tmp 整个 tmpfs 掉，否则工作区自己消失
    const a2 = buildBwrapArgv({ path: 'bwrap' }, { argv: ['true'], workspace: '/tmp/uh-ws-probe', home })
    const iTmp = a2.indexOf('/tmp')
    assert.equal(a2[iTmp - 1], '--bind', 'workspace under /tmp keeps the real /tmp')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
