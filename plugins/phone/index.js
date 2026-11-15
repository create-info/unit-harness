/**
 * @unit-harness/plugin-phone — 操作真实的 Android / HarmonyOS / iOS 手机。
 *
 * 三个平台一起做，因为"只支持 Android"对用 iPhone 或华为的人是半个功能。
 * 但它们的能力并不一样，这个插件不假装一样：
 *
 *   Android    adb 全功能：读控件树、点、滑、输入、按键、截图
 *   HarmonyOS  hdc + uitest 全功能，但输入文字需要焦点坐标（先 tap 再 type）
 *   iOS        只能 attach 到用户自己跑起来的 WebDriverAgent。真机上点击和读树
 *              都必须经过 WDA，而 WDA 要用 Xcode 签一次名装到设备里——
 *              这一步要 Apple 开发者账号和用户手动信任，我们不去代劳。
 *
 * 共用一套东西：语义树归一化（parse.js）、增量观察（shared/observe.js）、
 * 动作后的"等稳定 + 回读确认"。所以三个平台对模型暴露的是同一种形状。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Observer, describe } from '../shared/observe.js'
import { parseUiAutomatorXml, parseHarmonyLayout, parseWdaSource } from './parse.js'
import { drivers, ALL } from './drivers.js'

const TEXT = (s) => ({ content: String(s) })

const PARSERS = {
  android: parseUiAutomatorXml,
  harmony: parseHarmonyLayout,
  ios: parseWdaSource,
}

export default {
  name: '@unit-harness/plugin-phone',
  apiVersion: 1,

  apply(ctx) {
    const cfg = ctx.config || {}
    // 手机的界面文字本身就是内容，不像网页那样遍地都是
    const observer = new Observer(new Set(['text']))
    let current = null        // { platform, driver, device }
    let lastFocus = null      // HarmonyOS 输入需要坐标，记最近一次 tap 的位置

    /** 探测所有平台，按 android → harmony → ios 的顺序挑第一个能用的 */
    const survey = async () => {
      const out = []
      for (const d of ALL) {
        try {
          out.push({ platform: d.name, tool: d.tool, ...(await d.probe()) })
        } catch (e) {
          out.push({ platform: d.name, tool: d.tool, available: false, devices: [], need: e.message })
        }
      }
      return out
    }

    const pick = async (wanted) => {
      if (current && !wanted) return current
      const all = await survey()
      const usable = all.filter((p) => p.available)
      if (!usable.length) {
        const why = all.map((p) => `${p.platform}: ${p.need}`).join('; ')
        throw new Error(`no phone is reachable — ${why}`)
      }
      const chosen = wanted
        ? usable.find((p) => p.platform === wanted)
        : usable[0]
      if (!chosen) {
        throw new Error(`"${wanted}" is not available. Usable right now: ${usable.map((p) => p.platform).join(', ')}`)
      }
      const driver = drivers[chosen.platform]
      const device = cfg.device || chosen.devices[0]
      current = { platform: chosen.platform, driver, device }
      observer.reset()
      return current
    }

    /** 读一次界面。dump 本身在手机上不便宜，所以只有变了才值得回读。 */
    const read = async (target) => {
      const raw = await target.driver.dump(target.device)
      const nodes = PARSERS[target.platform](raw)
      return observer.observe(nodes)
    }

    /**
     * 动作的统一外壳：执行 → 等界面稳定 → 回读。
     * 手机没有 CDP 那种事件，判断"稳定"只能靠连续两次读到的控件树一致。
     */
    const act = async (target, fn, { settleMs = 5000 } = {}) => {
      const before = await safeDump(target)
      await fn()
      const deadline = Date.now() + settleMs
      let prev = null
      let stable = false
      while (Date.now() < deadline) {
        const sig = await safeSignature(target)
        if (prev === null) { prev = sig }
        else if (sig === prev) { stable = true; break }   // 连续两次一致
        else { prev = sig }
        await new Promise((r) => setTimeout(r, 250))
      }
      const delta = await read(target)
      const after = await safeSignature(target)
      return { stable, changed: before !== after, delta }
    }

    const safeDump = async (t) => {
      try { return (await t.driver.dump(t.device)).length } catch { return null }
    }
    const safeSignature = async (t) => {
      try {
        const raw = await t.driver.dump(t.device)
        return `${raw.length}:${raw.slice(0, 2000)}`
      } catch { return 'ERR' }
    }

    const report = (res) => [
      `settled: ${res.stable ? 'yes' : 'no — the screen kept changing'}`,
      `changed: ${res.changed ? 'yes' : 'no — the action may have had no effect'}`,
      describe(res.delta) ? '\n' + describe(res.delta) : '',
    ].filter(Boolean).join('\n')

    // ─────────────────────────── 工具 ───────────────────────────

    ctx.tools.register({
      name: 'phone_status',
      description:
        'Which phones are reachable and what each platform needs. Reports Android (adb), HarmonyOS (hdc) '
        + 'and iOS (WebDriverAgent) separately, because they fail for different reasons.',
      schema: { type: 'object', properties: {}, additionalProperties: false },
      async handler() {
        const all = await survey()
        const lines = all.map((p) => [
          `${p.platform} (${p.tool}): ${p.available ? 'ready' : 'not available'}`,
          p.devices?.length ? `  devices: ${p.devices.join(', ')}` : '',
          p.need ? `  need: ${p.need}` : '',
          p.note ? `  note: ${p.note}` : '',
        ].filter(Boolean).join('\n'))
        return TEXT(lines.join('\n\n'))
      },
    })

    ctx.tools.register({
      name: 'phone_look',
      description:
        'Read the current phone screen as a list of actionable elements with refs. '
        + 'Returns only what changed since the last look; fresh:true re-reads everything.',
      schema: {
        type: 'object',
        properties: {
          platform: { type: 'string', description: 'android | harmony | ios (default: first available)' },
          fresh: { type: 'boolean' },
        },
        additionalProperties: false,
      },
      async handler(args) {
        try {
          const t = await pick(args?.platform)
          const force = Boolean(args?.fresh)
          if (force) observer.reset()
          const o = await read(t)
          const head = `${t.platform} ${t.device}\n`
          if (force) return TEXT(head + (o.text || '(no actionable elements on screen)'))
          if (!o.changed) return TEXT(head + '(nothing changed since the last look)')
          return TEXT(head + describe(o))
        } catch (e) {
          return TEXT(`ERROR: ${e.message}`)
        }
      },
    })

    ctx.tools.register({
      name: 'phone_tap',
      description:
        'Tap an element by ref from the latest phone_look, then wait for the screen to settle and say '
        + 'whether anything changed. ref:no means the tap probably did not register.',
      schema: {
        type: 'object',
        properties: {
          ref: { type: 'string' },
          platform: { type: 'string' },
        },
        required: ['ref'],
        additionalProperties: false,
      },
      async handler(args) {
        const ref = String(args?.ref ?? '')
        try {
          const t = await pick(args?.platform)
          const rect = observer.byRef.get(ref)
          if (!rect) return TEXT(`ERROR: ref "${ref}" is not on the current screen. Call phone_look with fresh:true.`)

          const x = rect.x + rect.w / 2
          const y = rect.y + rect.h / 2
          lastFocus = { x, y }
          const res = await act(t, () => t.driver.tap(t.device, x, y))
          return TEXT(`tapped ${ref} at ${Math.round(x)},${Math.round(y)}\n` + report(res))
        } catch (e) {
          return TEXT(`ERROR: ${e.message}`)
        }
      },
    })

    ctx.tools.register({
      name: 'phone_type',
      description:
        'Type text into the focused field, then settle and confirm by re-reading the screen. '
        + 'Tap the field first. HarmonyOS and iOS type into whatever has focus.',
      schema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          platform: { type: 'string' },
        },
        required: ['text'],
        additionalProperties: false,
      },
      async handler(args) {
        const text = String(args?.text ?? '')
        try {
          const t = await pick(args?.platform)
          const res = await act(t, () => t.driver.type(t.device, text, lastFocus))
          // 回读：界面上应当出现这段文字。没出现就是没输进去，不能报成功。
          const seen = res.delta.text.includes(text) || res.delta.added.some((l) => l.includes(text))
          return TEXT(
            `typed ${text.length} chars\n`
            + `shown on screen: ${seen ? 'yes' : 'not found in the element tree (some fields hide their value — check with phone_look)'}\n`
            + report(res),
          )
        } catch (e) {
          return TEXT(`ERROR: ${e.message}`)
        }
      },
    })

    ctx.tools.register({
      name: 'phone_swipe',
      description: 'Swipe between two screen coordinates (use phone_look to see the element positions).',
      schema: {
        type: 'object',
        properties: {
          x1: { type: 'number' }, y1: { type: 'number' },
          x2: { type: 'number' }, y2: { type: 'number' },
          platform: { type: 'string' },
        },
        required: ['x1', 'y1', 'x2', 'y2'],
        additionalProperties: false,
      },
      async handler(args) {
        try {
          const t = await pick(args?.platform)
          const res = await act(t, () => t.driver.swipe(t.device, args.x1, args.y1, args.x2, args.y2))
          return TEXT(`swiped ${args.x1},${args.y1} -> ${args.x2},${args.y2}\n` + report(res))
        } catch (e) {
          return TEXT(`ERROR: ${e.message}`)
        }
      },
    })

    ctx.tools.register({
      name: 'phone_key',
      description: 'Press a hardware/navigation key: back, home, enter, recents. iOS only supports home.',
      schema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'back | home | enter | recents' },
          platform: { type: 'string' },
        },
        required: ['key'],
        additionalProperties: false,
      },
      async handler(args) {
        try {
          const t = await pick(args?.platform)
          const res = await act(t, () => t.driver.key(t.device, String(args?.key ?? '')))
          return TEXT(`pressed ${args?.key}\n` + report(res))
        } catch (e) {
          return TEXT(`ERROR: ${e.message}`)
        }
      },
    })

    ctx.tools.register({
      name: 'phone_screenshot',
      description: 'Save a PNG of the phone screen and return its path.',
      schema: {
        type: 'object',
        properties: { path: { type: 'string' }, platform: { type: 'string' } },
        additionalProperties: false,
      },
      async handler(args) {
        try {
          const t = await pick(args?.platform)
          const buf = await t.driver.shot(t.device)
          const out = args?.path ? String(args.path) : path.join(os.tmpdir(), `uh-phone-${Date.now()}.png`)
          fs.mkdirSync(path.dirname(out), { recursive: true })
          fs.writeFileSync(out, buf)
          return TEXT(`screenshot saved: ${out} (${buf.length} bytes)`)
        } catch (e) {
          return TEXT(`ERROR: ${e.message}`)
        }
      },
    })

    ctx.on?.('dispose', () => { current = null })
  },
}
