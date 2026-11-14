/**
 * 本地语音转写：网页录音 → 本机 whisper → 文本。
 *
 * 为什么不用浏览器自带的 `SpeechRecognition`：
 *  1. 它是**云端**识别（Chrome 把音频发给 Google）。在中国大陆基本连不上，
 *     只会回一个 `network` 错误——界面上那句 “speech: network” 就是这么来的，
 *     对用户没有任何信息量：既没说清是网络、也没法自己修。
 *  2. 桌面端（Tauri/WebKitGTK）里干脆没有这个 API。
 * 所以改成录音 + 本机引擎：音频不出这台机器，也不依赖任何在线服务。
 *
 * 引擎按这个顺序找，找到就用（用户自己装了哪个都不浪费）：
 *   1. `UH_ASR_CMD`：自定义命令模板，支持 {in} {lang}，stdout 当文本
 *   2. faster-whisper（scripts/asr-install.sh 装到 ~/.uh/asr/venv）
 *   3. whisper.cpp 的 whisper-cli / main + ~/.uh/asr/models/ggml-*.bin
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import pathMod from 'node:path'
import { uhHome } from '@unit-harness/core'

export interface AsrEngine {
  id: 'custom' | 'faster-whisper' | 'whisper-cpp'
  /** 界面上说清楚现在用的是哪一套 */
  label: string
  model: string
}

export interface AsrStatus {
  ready: boolean
  engine?: AsrEngine
  /** 没装的时候给出可以直接复制的那一条命令 */
  hint?: string
}

export interface TranscribeResult {
  text: string
  engine?: AsrEngine
  /** 引擎猜出来的语言；猜不准时不影响文本本身 */
  language?: string
}

/**
 * 引擎和模型可能在这两个地方，先看当前 UH_HOME，再看共享的 ~/.uh。
 *
 * 只看 UH_HOME 的话，`UH_HOME=/tmp/x uh serve` 就会找不到已经装好的模型，
 * 而这个模型有 500 MB——按会话目录分家是合理的，按模型分家不是。
 */
function asrDirs(): string[] {
  const a = pathMod.join(uhHome(), 'asr')
  const b = pathMod.join(os.homedir(), '.uh', 'asr')
  return a === b ? [a] : [a, b]
}

function asrDir(): string {
  // 写文件（worker 脚本）落在第一个目录；读模型时两个都找
  return asrDirs()[0]!
}

const INSTALL_HINT = 'no local speech engine yet — run: bash scripts/asr-install.sh'

/**
 * 把外部命令的 stderr 压成一句能看的错误。
 *
 * Python 的 traceback 有十几行，最后一行才是「发生了什么」；把整段倒进界面，
 * 用户只能看到一堆自己没写过的路径。
 */
function tidy(stderr: string): string {
  const lines = stderr.split('\n').map((l) => l.trim()).filter(Boolean)
  const last = lines[lines.length - 1] ?? ''
  if (/^[A-Za-z_]*Error:|^[A-Za-z_]+Exception:/.test(last)) return last.slice(0, 300)
  return (last || stderr.trim()).slice(0, 300)
}

/**
 * 跑一个外部命令，把 stdout 收下来。
 * 超时给得很宽：CPU 上转写三十秒语音要几秒，第一次还要加载模型。
 */
function run(cmd: string, args: string[], timeoutMs = 180_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(tidy(`${stderr || err.message}`)))
        return
      }
      resolve(String(stdout))
    })
  })
}

/**
 * faster-whisper 的 worker。
 *
 * 单独写一个脚本文件而不是塞进 `python -c`：模型加载是常驻的，而且报错时
 * 用户要能在终端里手动复现这一句。
 */
const WORKER_SRC = `#!/usr/bin/env python3
"""UnitHarness 的本地转写 worker：吃一个音频文件，吐一行 JSON。

argv: <model_dir> <audio> [lang]
"""
import json
import sys

from faster_whisper import WhisperModel


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: whisper_worker.py <model_dir> <audio> [lang]", file=sys.stderr)
        return 2
    model_dir, audio = sys.argv[1], sys.argv[2]
    lang = sys.argv[3] if len(sys.argv) > 3 else ""

    try:
        model = WhisperModel(model_dir, device="cpu", compute_type="int8")
    except Exception as exc:  # noqa: BLE001 - 原样回给调用方，别再包一层
        print(f"cannot load model at {model_dir}: {exc}", file=sys.stderr)
        return 3

    # vad_filter：录音里经常有长段静音，不切开的话模型会自己编词
    try:
        segments, info = model.transcribe(
            audio,
            language=lang or None,
            vad_filter=True,
            beam_size=1,
        )
        text = "".join(seg.text for seg in segments).strip()
    except Exception as exc:  # noqa: BLE001
        # 一段读不出来的音频不该把 Python 栈丢给用户看：他要的是「这份录音用不了」
        print(json.dumps({"error": f"could not read that recording: {type(exc).__name__}"}))
        return 0
    print(json.dumps({"text": text, "language": getattr(info, "language", "")}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
`

function workerPath(): string {
  const dir = asrDir()
  const p = pathMod.join(dir, 'whisper_worker.py')
  try {
    mkdirSync(dir, { recursive: true })
    const cur = existsSync(p) ? readFileSync(p, 'utf8') : ''
    if (cur !== WORKER_SRC) writeFileSync(p, WORKER_SRC, { mode: 0o644 })
  } catch { /* 只读目录就退回内联执行 */ }
  return p
}

/** 找一个可用的模型目录：asr/models/<name>/model.bin */
function findWhisperModel(): string | null {
  // large > medium > small…：装了几个就用准确率最高的那个
  const order = ['large-v3', 'medium', 'small', 'base', 'tiny']
  for (const name of order) {
    for (const root of asrDirs()) {
      const abs = pathMod.join(root, 'models', name)
      if (existsSync(pathMod.join(abs, 'model.bin'))) return abs
    }
  }
  return null
}

interface Found {
  engine: AsrEngine
  run: (audio: string, lang: string) => Promise<TranscribeResult>
}

let cached: Found | null | undefined

/** 找引擎。结果缓存，因为探测要碰文件系统；装了新引擎后重启即可生效。 */
export function findAsr(): Found | null {
  if (cached !== undefined) return cached

  // 1) 自定义命令：给公司内部 whisper 服务、或者别的 ASR 留的口子
  const custom = process.env.UH_ASR_CMD
  if (custom) {
    const engine: AsrEngine = { id: 'custom', label: 'custom command', model: 'UH_ASR_CMD' }
    cached = {
      engine,
      run: async (audio, lang) => {
        const cmd = custom.replace(/\{in\}/g, `"${audio}"`).replace(/\{lang\}/g, lang || '')
        const out = await run('/bin/sh', ['-c', cmd])
        return { text: out.trim(), engine }
      },
    }
    return cached
  }

  // 2) faster-whisper（推荐：pip 装完就能用，不挑模型格式）
  const model = findWhisperModel()
  const venvPy = asrDirs()
    .map((d) => pathMod.join(d, 'venv', 'bin', 'python'))
    .find((p) => existsSync(p)) ?? pathMod.join(asrDir(), 'venv', 'bin', 'python')
  if (existsSync(venvPy) && model) {
    const engine: AsrEngine = { id: 'faster-whisper', label: 'faster-whisper (local)', model: pathMod.basename(model) }
    cached = {
      engine,
      run: async (audio, lang) => {
        const out = await run(venvPy, [workerPath(), model, audio, lang])
        const line = out.trim().split('\n').pop() ?? ''
        try {
          const j = JSON.parse(line) as { text?: string; language?: string; error?: string }
          if (j.error) throw new Error(j.error)
          return { text: (j.text ?? '').trim(), engine, ...(j.language ? { language: j.language } : {}) }
        } catch (err) {
          if (err instanceof Error && /could not read that recording/.test(err.message)) throw err
          // worker 可能被别人的日志污染：至少把非 JSON 的部分当文本交出去
          return { text: out.trim(), engine }
        }
      },
    }
    return cached
  }

  // 3) whisper.cpp：命令行版，模型是 ggml-*.bin
  for (const bin of ['whisper-cli', 'whisper-cpp', 'main']) {
    const found = ['/usr/local/bin', '/usr/bin', pathMod.join(uhHome(), 'bin')]
      .map((d) => pathMod.join(d, bin))
      .find((p) => existsSync(p))
    if (!found) continue
    const ggml = findGgmlModel()
    if (!ggml) continue
    const engine: AsrEngine = { id: 'whisper-cpp', label: 'whisper.cpp', model: pathMod.basename(ggml) }
    cached = {
      engine,
      run: async (audio, lang) => {
        const stem = audio.replace(/\.[^.]+$/, '') + '-uh'
        const args = ['-m', ggml, '-f', audio, '-nt', '-otxt', '-of', stem]
        if (lang) args.push('-l', lang)
        await run(found, args)
        let text = ''
        try { text = readFileSync(`${stem}.txt`, 'utf8').trim() } catch { /* 见下 */ }
        return { text, engine }
      },
    }
    return cached
  }

  cached = null
  return null
}

function findGgmlModel(): string | null {
  const dirs = asrDirs().flatMap((r) => [pathMod.join(r, 'models'), pathMod.join(r, 'models', 'ggml')])
  for (const d of dirs) {
    let names: string[]
    try { names = readdirSync(d) } catch { continue }
    const hit = names.find((n) => n.startsWith('ggml-') && n.endsWith('.bin'))
    if (hit) return pathMod.join(d, hit)
  }
  return null
}

export function asrStatus(): AsrStatus {
  const found = findAsr()
  if (!found) return { ready: false, hint: INSTALL_HINT }
  return { ready: true, engine: found.engine }
}

/**
 * 转写一段音频。
 *
 * 浏览器录出来通常是 webm/opus，别的引擎不一定吃得下，所以先统一成
 * 16k 单声道 wav（ffmpeg 在就用 ffmpeg，不在就原样交给引擎——faster-whisper
 * 自带解码器，多数格式也能读）。
 */
export async function transcribe(o: {
  audio: Buffer
  ext: string
  lang?: string
  /** 临时文件放这儿，调用方负责清 */
  workDir: string
}): Promise<TranscribeResult> {
  const found = findAsr()
  if (!found) {
    throw Object.assign(new Error(INSTALL_HINT), { code: 'NO_ASR' })
  }
  mkdirSync(o.workDir, { recursive: true })
  const stamp = `${process.pid}-${Date.now()}`
  const raw = pathMod.join(o.workDir, `rec-${stamp}.${o.ext || 'webm'}`)
  writeFileSync(raw, o.audio)

  const wav = pathMod.join(o.workDir, `rec-${stamp}.wav`)
  try {
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', raw, '-ac', '1', '-ar', '16000', wav], 60_000)
  } catch {
    // 转不动有两种情况：机器上没装 ffmpeg（那就把原始文件交给引擎，多数格式
    // 它自己会解），或者这段音频根本坏了（交给引擎只会换来一段 Python 栈）
    const known = new Set(['wav', 'wave', 'mp3', 'm4a', 'mp4', 'flac', 'ogg', 'opus', 'webm'])
    if (!known.has((o.ext || '').toLowerCase())) {
      throw new Error('could not read that recording — try again')
    }
    return await found.run(raw, o.lang ?? '')
  }
  return await found.run(wav, o.lang ?? '')
}
