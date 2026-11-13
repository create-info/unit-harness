/**
 * Windows 隔离探测。
 *
 * 这一层**没有实现隔离**，所以测试的重点是「它不能撒谎」：
 * `available` 必须永远是 false，报告必须说明后果和出路。
 *
 * 一个安全模块把"可能有"说成"有"，比它不存在更危险。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('..', import.meta.url))
const { probeWindows } = await import(
  pathToFileURL(join(here, 'packages', 'core', 'src', 'sandbox', 'windows.ts')).href
)

const winEnv = (over = {}) => ({ SystemDrive: 'C:', USERNAME: 'alice', COMPUTERNAME: 'DESKTOP-1', ...over })

test('on a non-Windows platform it reports not-windows and stays quiet', () => {
  const r = probeWindows({}, '', 'linux')
  assert.equal(r.isWindows, false)
  assert.equal(r.available, false)
  assert.equal(r.hint, '', 'no advice needed on a platform that has its own sandbox')
})

test('a plain Windows machine is told plainly that only path-guard runs', () => {
  const r = probeWindows(winEnv(), '10.0.22631', 'win32')
  assert.equal(r.isWindows, true)
  assert.equal(r.available, false, 'no isolation is implemented, so this must never say true')
  assert.match(r.reason, /no kernel-level isolation/)
  // 用户需要知道后果：命令仍然能写工作区之外
  assert.match(r.hint, /write outside the workspace/)
  assert.match(r.hint, /--allow-unconfined/)
})

test('the hint points at WSL2, which actually has a working sandbox', () => {
  const r = probeWindows(winEnv(), '10.0.22631', 'win32')
  assert.match(r.hint, /WSL2/)
  // 建议必须是能落地的：WSL2 上走 Linux landlock，那条路径是真被强制的
  assert.match(r.hint, /landlock/)
})

test('inside an AppContainer, the outer boundary is acknowledged instead of nagged about', () => {
  const r = probeWindows(
    winEnv({ LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local\\Packages\\Something_abc\\LocalCache' }),
    '10.0.22631', 'win32',
  )
  assert.equal(r.inAppContainer, true)
  assert.equal(r.available, false)
  // 这种情形下说"没有隔离"会误导人以为需要自己动手
  assert.match(r.reason, /AppContainer/)
  assert.match(r.hint, /outer container/)
})

test('inside a container, ditto', () => {
  const r = probeWindows(winEnv({ USERNAME: 'ContainerAdministrator' }), '10.0.22631', 'win32')
  assert.equal(r.inContainer, true)
  assert.match(r.reason, /container/)
})

test('a missing SystemDrive is treated as a stripped-down container', () => {
  const r = probeWindows({ USERNAME: 'x', COMPUTERNAME: 'y' }, '10.0', 'win32')
  assert.equal(r.inContainer, true)
})

test('WSL is detected, and reported as such rather than as plain Windows', () => {
  const r = probeWindows({ WSL_DISTRO_NAME: 'Ubuntu' }, '5.15.0-microsoft-standard', 'linux')
  assert.equal(r.inWsl, true)
  assert.equal(r.isWindows, false, 'under WSL the Linux sandbox applies, not the Windows story')
})

test('the kernel string alone is enough to notice WSL', () => {
  const r = probeWindows({}, '5.15.0-microsoft-standard-WSL2', 'linux')
  assert.equal(r.inWsl, true)
})

test('available is never true, on any input', () => {
  // 穷举一下：不管环境像什么，只要没实现，就不能说可用
  const cases = [
    [winEnv(), '10.0', 'win32'],
    [winEnv({ WSL_DISTRO_NAME: 'Ubuntu' }), '5.15-microsoft', 'win32'],
    [winEnv({ LOCALAPPDATA: 'C:\\x\\Packages\\y' }), '10.0', 'win32'],
    [{}, '', 'linux'],
    [{}, '', 'darwin'],
  ]
  for (const [env, release, platform] of cases) {
    assert.equal(probeWindows(env, release, platform).available, false,
      `must not claim availability for ${platform} ${release}`)
  }
})
