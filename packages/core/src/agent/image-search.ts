/**
 * 找图片 —— 用图库接口，而不是去爬搜索引擎。
 *
 * 起因：让它「生成一张安庆炒面的照片」，它拿 curl 去扒 Bing，再写个正则解析
 * HTML（会话里那个 parse_bing.py）。这条路的产物是缩略图、带水印、没有授权
 * 信息，还随时会被反爬挡掉——看起来在干活，其实什么都没得到。
 *
 * 这里换成 Openverse（Creative Commons / 公有领域聚合，免 key）为主，
 * Wikimedia Commons（免 key、图片质量高）为备。两个都不需要用户注册，
 * 都能给出「标题 / 作者 / 许可证 / 原始页面」——没有这几样东西，图片就不能
 * 用来交付。
 *
 * 几条硬规矩：
 *   - 只下 http(s)，别的 scheme 一律不跟（file:// 能让它读本机文件）；
 *   - 必须真是图片（内容类型 + 魔数两道），HTML 错误页不能存成 .jpg；
 *   - 单个文件封顶 12MB，整次封顶 8 张——一个工具调用不该拖垮一次运行。
 */
import type { AgentDeps } from './loop.ts'

export interface ImageHit {
  title: string
  url: string
  page: string
  author: string
  license: string
}

export interface SearchResult {
  saved: string[]
  text: string
}

const MAX_BYTES = 12 * 1024 * 1024
const UA = 'unit-harness/0.1 (+https://github.com/create-info/unit-harness)'

function apiBase(): string {
  // 测试要指向本地假服务，所以留一个出口
  return (process.env.UH_IMAGE_API || 'https://api.openverse.org').replace(/\/+$/, '')
}

/**
 * Commons 的出口同样可指向假服务。
 *
 * 不这么做的话，测试只覆盖了第二个图库：第一个图库会真的连外网，
 * 于是「假数据里那两条」根本不是被测数据——上一次就是这样，
 * 断言 1 张却拿到 2 张，因为 Commons 真的返回了图。
 */
function commonsApi(): string {
  return process.env.UH_IMAGE_COMMONS_API || 'https://commons.wikimedia.org/w/api.php'
}

async function getJson(url: string, timeoutMs = 15000): Promise<unknown> {
  const r = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': UA },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!r.ok) throw new Error(`${r.status} from ${new URL(url).host}`)
  return r.json()
}

/** Openverse：一条结果带标题、作者、许可证、落地页 */
async function searchOpenverse(q: string, want: number): Promise<ImageHit[]> {
  const u = `${apiBase()}/v1/images/?q=${encodeURIComponent(q)}`
    + `&page_size=${Math.min(want * 3, 20)}`
    + '&license_type=commercial,modification'
    + '&mature=false'
  const j = await getJson(u) as { results?: Array<Record<string, unknown>> }
  const out: ImageHit[] = []
  for (const r of j.results ?? []) {
    const url = String(r.url ?? '')
    if (!/^https?:\/\//i.test(url)) continue
    out.push({
      title: String(r.title ?? '').trim() || q,
      url,
      page: String(r.foreign_landing_url ?? ''),
      author: String(r.creator ?? '').trim() || 'unknown',
      license: [r.license, r.license_version].filter(Boolean).join(' ').toUpperCase() || 'unknown',
    })
  }
  return out
}

/** Wikimedia Commons：Openverse 空手时的第二站，署名信息在 extmetadata 里 */
async function searchCommons(q: string, want: number): Promise<ImageHit[]> {
  const u = commonsApi() + '?action=query&format=json&origin=*'
    + '&generator=search&gsrnamespace=6'
    + `&gsrsearch=${encodeURIComponent('filetype:bitmap ' + q)}`
    + `&gsrlimit=${Math.min(want * 3, 20)}`
    // 只要缩略图：原图动辄 6MB，一次搜索就把工作区塞满，而这个尺寸够看
    + '&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=1280'
  const j = await getJson(u) as { query?: { pages?: Record<string, Record<string, unknown>> } }
  const pages = Object.values(j.query?.pages ?? {})
  const out: ImageHit[] = []
  for (const p of pages) {
    const info = (p.imageinfo as Array<Record<string, unknown>> | undefined)?.[0]
    if (!info) continue
    const url = String(info.thumburl || info.url || '')
    if (!/^https?:\/\//i.test(url)) continue
    const meta = (info.extmetadata ?? {}) as Record<string, { value?: string }>
    out.push({
      title: String(p.title ?? '').replace(/^File:/, '') || q,
      url,
      page: String(info.descriptionurl ?? ''),
      author: stripTags(meta.Artist?.value) || 'unknown',
      license: stripTags(meta.LicenseShortName?.value) || 'unknown',
    })
  }
  return out
}

function stripTags(s: string | undefined): string {
  return String(s ?? '').replace(/<[^>]*>/g, '').trim()
}

/** 扩展名只认我们验证过的那几种，别相信 URL 的后缀 */
function extFor(mime: string, url: string): string {
  if (mime.includes('png')) return 'png'
  if (mime.includes('webp')) return 'webp'
  if (mime.includes('gif')) return 'gif'
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg'
  const m = /\.(png|jpe?g|webp|gif)(?:\?|$)/i.exec(url)
  return m && m[1] ? m[1].toLowerCase().replace('jpeg', 'jpg') : 'jpg'
}

/** 魔数：内容类型可以说谎，前几个字节不会 */
function looksLikeImage(b: Uint8Array): boolean {
  if (b.length < 12) return false
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return true          // JPEG
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return true // PNG
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return true          // GIF
  // RIFF....WEBP
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
      && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return true
  return false
}

function slug(s: string, i: number): string {
  // 图库的标题常常自带后缀（`Fried noodles of Northeast China.png`），
  // 直接 slug 会得到 `...-china-png-1.png` —— 文件名里再重复一次扩展名
  const base = s.toLowerCase()
    .replace(/\.(png|jpe?g|webp|gif|svg)$/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')
  return (base || 'image') + '-' + (i + 1)
}

async function download(url: string): Promise<{ bytes: Uint8Array; mime: string }> {
  const r = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'image/*' },
    redirect: 'follow',
    signal: AbortSignal.timeout(30000),
  })
  if (!r.ok) throw new Error(`${r.status} downloading image`)
  const mime = String(r.headers.get('content-type') ?? '').toLowerCase()
  if (!mime.startsWith('image/')) throw new Error('not an image: ' + (mime || 'no content-type'))
  const len = Number(r.headers.get('content-length') ?? 0)
  if (len > MAX_BYTES) throw new Error('image too large: ' + len + ' bytes')
  const buf = new Uint8Array(await r.arrayBuffer())
  if (buf.length > MAX_BYTES) throw new Error('image too large: ' + buf.length + ' bytes')
  if (!looksLikeImage(buf)) throw new Error('downloaded bytes are not an image')
  return { bytes: buf, mime }
}

/**
 * 搜 + 下 + 记账。
 *
 * 失败的候选直接跳过而不是整体失败：图库里总有几张死链，
 * 一张死链不该让「找三张图」变成「一张也没有」。只有当一张都没成功时才抛错。
 */
export async function searchImages(
  query: string,
  want: number,
  deps: Pick<AgentDeps, 'writeBytes' | 'writeFile'>,
  dir: string,
): Promise<SearchResult> {
  // Commons 优先：它在这台机器上实测 1.1 秒返回（openverse 直接连不上），
  // 而且署名/许可证字段更规整。openverse 留着当第二站——网络环境不一样，
  // 哪边能通用哪边，写死一个就是把另一种网络下的用户挡在门外。
  let hits = await searchCommons(query, want).catch(() => [] as ImageHit[])
  if (hits.length === 0) hits = await searchOpenverse(query, want).catch(() => [] as ImageHit[])
  if (hits.length === 0) {
    throw new Error(`no results for "${query}" (Openverse and Wikimedia Commons both came back empty)`)
  }

  const saved: string[] = []
  const credits: string[] = []
  const problems: string[] = []

  for (const hit of hits) {
    if (saved.length >= want) break
    const rel = `${dir}/${slug(hit.title || query, saved.length)}.${extFor('', hit.url)}`
    try {
      const { bytes, mime } = await download(hit.url)
      // 扩展名按真实类型纠正：URL 说 .jpg、实际是 png 的情况很常见
      const real = `${dir}/${slug(hit.title || query, saved.length)}.${extFor(mime, hit.url)}`
      deps.writeBytes(real, bytes)
      saved.push(real)
      credits.push(
        `## ${real}\n`
        + `- title: ${hit.title}\n`
        + `- author: ${hit.author}\n`
        + `- license: ${hit.license}\n`
        + (hit.page ? `- source: ${hit.page}\n` : '')
        + (rel === real ? '' : ''),
      )
    } catch (err) {
      problems.push(`${hit.url} — ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  if (saved.length === 0) {
    throw new Error('every candidate failed to download: ' + problems.slice(0, 3).join('; '))
  }

  // 授权信息落在旁边，而不是只留在这一次的工具输出里：
  // 图被谁拿走用、用在哪儿，事后都得能查到出处
  try {
    deps.writeFile(`${dir}/CREDITS.md`, '# Image credits\n\n' + credits.join('\n'))
  } catch { /* 写不进去不影响图片本身 */ }

  const lines = saved.map((p, i) => {
    const c = credits[i] ?? ''
    const m = /- author: (.*)\n- license: (.*)/.exec(c)
    return `- ${p}  (${m?.[1] ?? 'unknown'}, ${m?.[2] ?? 'unknown'})`
  })
  return {
    saved,
    text: `saved ${saved.length} image${saved.length === 1 ? '' : 's'} for "${query}":\n`
      + lines.join('\n')
      + `\n\ncredits written to ${dir}/CREDITS.md`
      + (problems.length ? `\n${problems.length} candidate(s) skipped (dead link / not an image).` : ''),
  }
}
