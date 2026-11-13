/**
 * 文件监听：工作区变了，界面要知道。
 *
 * 这是照 Codex 的 `codex-rs/file-watcher` 做的，三层结构不变：
 *
 *   1. `FileWatcher`            —— 底层，一个进程一个；订阅者可增减
 *   2. `DebouncedWatchReceiver` —— 把一堆事件合成一批
 *   3. `WatchManager`           —— 按「谁在听 + 听什么」管生命周期
 *
 * 三处细节是照抄的，因为都是踩过才知道的：
 *
 *   **一、防抖是固定窗口，不是 trailing。**
 *   收到第一个事件时开窗，窗口内的事件全部并进来，到点一次性发出。
 *   trailing debounce（每次事件重置计时器）在持续写入时会永远不发——
 *   编译产物目录一刷就是几百次事件，界面就再也不更新了。
 *
 *   **二、要听的文件还不存在时，听它最近的存在的祖先目录。**
 *   agent 常常先 watch 再创建文件（编辑器也一样）。`fs.watch` 一个不存在的路径
 *   直接 ENOENT，于是换个做法：向上找第一个存在的目录，听那个目录（非递归），
 *   再把事件路径映射回原本请求的路径。没有这一条，「新建文件」永远收不到通知。
 *
 *   **三、通知里的路径要排序。**
 *   同一批事件两次到达的顺序本来就不稳定，排序之后前端才能按顺序比对、
 *   也才好写测试。
 */
import fs from 'node:fs'
import nodePath from 'node:path'

export interface WatchPath {
  path: string
  /** 递归听子目录。默认 false：工作区整棵树递归在文件多时开销很大 */
  recursive: boolean
}

export interface WatchEvent {
  /** 这一批变化的绝对路径，去重且已排序 */
  paths: string[]
}

export interface Subscription {
  /** 取消监听并释放底层 watcher */
  close(): void
}

type Listener = (paths: string[]) => void

/** 内部：一个订阅者注册的一组路径 → 实际的 fs.watch 句柄 */
interface Registration {
  /** 原本请求的路径（可能是尚不存在的文件） */
  requested: string
  /** 实际被 fs.watch 的路径（最近的存在的祖先，或 requested 本身） */
  actual: string
  /** true = actual 是因为 requested 不存在才向上找的 */
  fallback: boolean
  recursive: boolean
  watcher: fs.FSWatcher | null
}

/**
 * 就近找一个「现在就能听」的路径。
 *
 * requested 存在 → 听它自己。
 * 不存在 → 向上找到第一个存在的目录，听那个目录。
 *
 * 之所以不是「向上找到存在的文件」：要听的本来就是还没出现的那个文件，
 * 记下它相对祖先的位置，事件来了再拼回去。
 */
function resolveWatchPath(requested: string): { actual: string; fallback: boolean } {
  try {
    if (fs.existsSync(requested)) return { actual: fs.realpathSync.native(requested), fallback: false }
  } catch { /* 权限问题当不存在 */ }

  // 从父目录往上找，第一个存在的目录就是落点
  let dir = nodePath.dirname(requested)
  const guard = new Set<string>()
  while (dir && dir !== nodePath.dirname(dir)) {
    if (guard.has(dir)) break    // 极端情况下防死循环
    guard.add(dir)
    try {
      if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) return { actual: dir, fallback: true }
    } catch { /* 继续往上 */ }
    dir = nodePath.dirname(dir)
  }
  // 连根都不存在（几乎不可能），交给调用方处理
  return { actual: requested, fallback: true }
}

/** 一次批量监听请求。可以有多组，每组一个 fs.watch */
export class FileWatcher {
  private readonly registrations = new Map<number, Registration[]>()
  private nextId = 1
  private readonly listeners = new Map<number, Listener>()

  /**
   * 加一个订阅者。返回的操作对象和 Codex 的 subscriber 语义一致：
   * `register` 拿到一组路径，`close` 全部撤掉。
   */
  addSubscriber(): {
    register: (paths: WatchPath[], onEvent: Listener) => Subscription
  } {
    const id = this.nextId++
    return {
      register: (paths, onEvent) => {
        this.listeners.set(id, onEvent)
        this.registrations.set(id, paths.map((p) => this.attach(id, p)))
        return {
          close: () => {
            for (const r of this.registrations.get(id) ?? []) {
              try { r.watcher?.close() } catch { /* 已经关了 */ }
            }
            this.registrations.delete(id)
            this.listeners.delete(id)
          },
        }
      },
    }
  }

  /** 实际挂上 fs.watch；失败不抛，留给降级——监听不到比崩掉好 */
  private attach(id: number, wp: WatchPath): Registration {
    const { actual, fallback } = resolveWatchPath(wp.path)
    const reg: Registration = { requested: wp.path, actual, fallback, recursive: wp.recursive, watcher: null }
    try {
      reg.watcher = fs.watch(actual, { recursive: wp.recursive, persistent: false }, (_ev, filename) => {
        // filename 可能是 null（某些平台不报），那就把整条路径报上去
        const changed = filename
          ? nodePath.join(actual, filename.toString())
          : actual
        this.emit(id, [this.mapBack(reg, changed)])
      })
      // 监听器自己出错时不能把进程带走
      reg.watcher.on('error', () => { /* 忽略：下次事件还会来 */ })
    } catch {
      // 挂不上就记录一个空句柄，调用方看到的是「静默无事件」，不是异常
      reg.watcher = null
    }
    return reg
  }

  /**
   * 把「实际监听到的路径」翻译回「用户请求的路径」。
   *
   * 这是 fallback 的另一半：当初因为目标不存在才听祖先目录，那么祖先目录里
   * 发生的**其他**事跟用户无关，必须丢掉——否则「只看这一个文件」会变成
   * 「整个目录一有动静就通知」。
   *
   * 返回空串表示丢弃。
   */
  private mapBack(reg: Registration, changed: string): string {
    if (!reg.fallback) return changed
    const target = nodePath.resolve(reg.requested)
    const got = nodePath.resolve(changed)
    return got === target ? target : ''
  }

  private emit(id: number, paths: string[]): void {
    const kept = paths.filter((p) => p !== '')
    if (!kept.length) return
    const fn = this.listeners.get(id)
    if (fn) fn(kept)
  }

  /** 全部关掉。进程退出前调用 */
  closeAll(): void {
    for (const list of this.registrations.values()) {
      for (const r of list) {
        try { r.watcher?.close() } catch { /* 已经关了 */ }
      }
    }
    this.registrations.clear()
    this.listeners.clear()
  }
}

/**
 * 把事件流合成批次。
 *
 * 固定窗口：第一个事件开窗，窗口内全并进来，到点发出。
 * 连续不断的写入不会推迟发送——一定要推迟的写法在编译产物目录上会饿死。
 */
export class DebouncedWatchReceiver {
  private readonly buffer = new Set<string>()
  private timer: NodeJS.Timeout | null = null
  private readonly interval: number
  private readonly onBatch: (ev: WatchEvent) => void

  constructor(intervalMs: number, onBatch: (ev: WatchEvent) => void) {
    this.interval = intervalMs
    this.onBatch = onBatch
  }

  push(paths: string[]): void {
    for (const p of paths) this.buffer.add(p)
    if (this.timer) return          // 窗口已经开着，继续攒
    this.timer = setTimeout(() => this.flush(), this.interval)
    // 不要因为一个 watcher 没关就拖住整个进程退出
    this.timer.unref?.()
  }

  private flush(): void {
    this.timer = null
    if (!this.buffer.size) return
    // 排序：同一批事件的到达顺序不稳定，排好了前端才能稳定比对
    const paths = [...this.buffer].sort()
    this.buffer.clear()
    this.onBatch({ paths })
  }

  /** 立刻发出攒着的东西（关闭连接时用，不然最后一批会丢） */
  flushNow(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    this.flush()
  }

  close(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    this.buffer.clear()
  }
}

/**
 * 第三层：按「谁在听 + 听什么」管生命周期。
 *
 * 语义照 Codex 的 `FsWatchManager`，三条都是防真实事故的：
 *
 *   1. **同一个 (客户端, watchId) 不能重复注册。** 重复不报错而是覆盖的话，
 *      前一个 fs.watch 就漏了引用，进程里悄悄多一个句柄，谁也不知道。
 *   2. **unwatch 必须等监听任务真的退出再返回。** 否则调用方收到「已取消」之后
 *      还可能再收到一条变化通知，前端就会对着已经关掉的界面刷。
 *   3. **连接断开要清掉它全部的 watch。** 一个标签页反复开关，不清就是句柄泄漏。
 */
export interface WatchManagerOptions {
  /** 防抖窗口，毫秒 */
  debounceMs?: number
  /** 发通知的回调；通常接 WebSocket */
  onBatch: (clientId: string, watchId: string, ev: WatchEvent) => void
}

interface ManagedWatch {
  subscription: Subscription
  receiver: DebouncedWatchReceiver
}

export class WatchManager {
  private readonly watcher = new FileWatcher()
  private readonly watches = new Map<string, ManagedWatch>()
  private readonly debounceMs: number
  private readonly onBatch: (clientId: string, watchId: string, ev: WatchEvent) => void

  constructor(opts: WatchManagerOptions) {
    this.debounceMs = opts.debounceMs ?? 200
    this.onBatch = opts.onBatch
  }

  private key(clientId: string, watchId: string): string {
    return clientId + '\u0000' + watchId
  }

  /**
   * 开始听一个路径。
   * 返回 false 表示这个 (client, watchId) 已经存在——调用方应当报错而不是静默覆盖。
   */
  watch(clientId: string, watchId: string, wp: WatchPath): boolean {
    const k = this.key(clientId, watchId)
    if (this.watches.has(k)) return false

    const receiver = new DebouncedWatchReceiver(this.debounceMs, (ev) => {
      this.onBatch(clientId, watchId, ev)
    })
    const subscriber = this.watcher.addSubscriber()
    const subscription = subscriber.register([wp], (paths) => receiver.push(paths))

    this.watches.set(k, { subscription, receiver })
    return true
  }

  /**
   * 停止监听。**同步等到真的停了**（Node 里没有 tokio task，所以直接
   * 先把攒着的一批发出去、再关 watcher、最后删记录，顺序不能反）。
   */
  unwatch(clientId: string, watchId: string): boolean {
    const k = this.key(clientId, watchId)
    const m = this.watches.get(k)
    if (!m) return false
    // 先发后关：已经发生的变化不该因为用户点了「别听了」而消失
    m.receiver.flushNow()
    m.receiver.close()
    m.subscription.close()
    this.watches.delete(k)
    return true
  }

  /** 一个客户端走了：清掉它全部 watch */
  clientClosed(clientId: string): number {
    const prefix = clientId + '\u0000'
    let n = 0
    for (const [k, m] of [...this.watches]) {
      if (!k.startsWith(prefix)) continue
      m.receiver.close()
      m.subscription.close()
      this.watches.delete(k)
      n++
    }
    return n
  }

  /** 当前开着的条数，给诊断和测试用 */
  size(): number {
    return this.watches.size
  }

  closeAll(): void {
    for (const m of this.watches.values()) {
      m.receiver.close()
      m.subscription.close()
    }
    this.watches.clear()
    this.watcher.closeAll()
  }
}
