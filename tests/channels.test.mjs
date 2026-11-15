/**
 * 渠道接入：验签、加解密、去重、会话绑定。
 *
 * 这些都不需要真连微信/企微/飞书——报文格式是公开的，验签逻辑是纯函数。
 * 真机联调只能证明「今天网络通」，错了也不会报错：机器人就是不回话，
 * 或者更糟——谁都能伪造一条「删库」把它跑起来。所以这里按攻击面测。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const {
  wecomEncrypt, wecomDecrypt, wecomSignature, feishuEncrypt, feishuDecrypt, feishuSignature,
  weixinSignature, safeEqual, xmlValue,
} = await import('../packages/core/src/channel/crypto.ts')

const AES_KEY = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG' // 43 位

test('企业微信报文能加密再解开，且回错身份会被拒', () => {
  const xml = '<xml><Content><![CDATA[跑一下测试]]></Content></xml>'
  const sealed = wecomEncrypt(xml, AES_KEY, 'ww123456')
  assert.equal(wecomDecrypt(sealed, AES_KEY, 'ww123456'), xml)
  // 别的企业的报文：解出来的 receiveid 对不上，必须拒绝，否则谁都能往你这扔任务
  assert.throws(() => wecomDecrypt(sealed, AES_KEY, 'ww999999'), /receiveid/)
})

test('企业微信签名是按字典序拼四个值再 sha1', () => {
  const sig = wecomSignature('tok', '1700000000', 'nonce', 'ENC')
  const manual = createHash('sha1').update(['tok', '1700000000', 'nonce', 'ENC'].sort().join('')).digest('hex')
  assert.equal(sig, manual)
  assert.equal(safeEqual(sig, manual), true)
  assert.equal(safeEqual(sig, manual.slice(0, -1) + '0'), false, '改一位就必须不相等')
})

test('飞书事件能解开，签名对不上要拒', () => {
  const body = JSON.stringify({ type: 'event_callback', event: { x: 1 } })
  const sealed = JSON.stringify({ encrypt: feishuEncrypt(body, 'enc-key') })
  assert.equal(feishuDecrypt(JSON.parse(sealed).encrypt, 'enc-key'), body)

  const ts = '1700000000'
  const nonce = 'n1'
  const good = feishuSignature(ts, nonce, 'enc-key', sealed)
  const bad = feishuSignature(ts, nonce, 'enc-key', sealed + ' ')
  assert.notEqual(good, bad, '正文被改过，签名必须不同')
})

test('微信订阅号验签与 XML 取值', () => {
  const sig = weixinSignature('token', '1700000000', '123')
  assert.equal(sig, createHash('sha1').update(['token', '1700000000', '123'].sort().join('')).digest('hex'))
  const xml = '<xml><FromUserName><![CDATA[openid-1]]></FromUserName><MsgType>text</MsgType><Content>你好</Content></xml>'
  assert.equal(xmlValue(xml, 'FromUserName'), 'openid-1')
  assert.equal(xmlValue(xml, 'MsgType'), 'text')
  assert.equal(xmlValue(xml, 'Content'), '你好')
  assert.equal(xmlValue(xml, 'Nope'), '')
})

test('渠道配置与会话绑定分开存，密钥不混进主配置', async () => {
  const home = mkdtempSync(join(tmpdir(), 'uh-ch-'))
  const prev = process.env.UH_HOME
  process.env.UH_HOME = home
  try {
    const { readChannels, writeChannels, buildAdapters, missingFields, getBinding, setBinding, claimMessage, channelsPath } =
      await import('../packages/core/src/channel/store.ts')

    // 只配了一半的渠道：不启动，且能说清缺什么
    writeChannels({ feishu: { appId: 'cli_x', appSecret: 's' }, wecom: { corpId: 'ww1' } })
    assert.deepEqual(buildAdapters(readChannels()).map((a) => a.id), ['feishu'])
    assert.deepEqual(missingFields(readChannels()).wecom, ['agentId', 'secret', 'token', 'encodingAesKey'])
    assert.ok(channelsPath().startsWith(home), '渠道配置写在 UH_HOME 里')

    setBinding('feishu', 'oc_1', { sessionId: 'ses_1', turns: 1, updatedAt: 'now' })
    assert.equal(getBinding('feishu', 'oc_1')?.sessionId, 'ses_1')
    assert.equal(getBinding('wecom', 'oc_1'), null, '不同渠道的同名 chat 不能串')

    // 去重：同一条消息第二次必须被判为重复
    assert.equal(claimMessage('feishu', 'evt_1'), true)
    assert.equal(claimMessage('feishu', 'evt_1'), false)
    assert.equal(claimMessage('feishu', 'evt_2'), true)
    assert.equal(claimMessage('wecom', 'evt_1'), true, '不同渠道的 id 各自计数')
    assert.equal(claimMessage('feishu', undefined), true, '没有 id 的不去重，也别当成重复')
  } finally {
    if (prev === undefined) delete process.env.UH_HOME
    else process.env.UH_HOME = prev
    rmSync(home, { recursive: true, force: true })
  }
})
