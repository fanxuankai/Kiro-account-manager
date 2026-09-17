// 动态提链代理：全局单例提链池 + 统一出口路由（主进程共享模块，对齐 KiroLuker proxyPool 形态）
//
// 面向 white.novproxy.com 这类白名单提链接口：GET 一次返回 N 行 IP:port 纯文本，
// 每个端点是一个独立会话（同入口 IP 不同端口 = 不同出口 IP），按 URL 里的 time
// 参数（分钟）短期有效。会话粘滞的接口反复单取会返回同一端点，所以一律批量提取
// （num=N）+ 队列逐号消费，用过的端点绝不复用（同一出口连续提链会被 Kiro 403）。
// 实测要点（2026-09 验证）：端点从本机直连不通，必须经本地可信中转两跳；
// 提链请求本身可直连，但也默认走同一中转（接口按来源 IP 白名单鉴权，出口稳定）。
//
// 全局唯一一份池：号池注册（每窗口一个出口）、批量订阅取链接（每链接一个出口）
// 共用同一个队列与「已用」记忆（磁盘持久化，重启不忘），配置归属「代理池」页。
// 出口按真实 IP 计次（池端点 IP ≠ 真实出口，同主机相邻端口各走不同上游出口），
// 同一出口 24 小时内最多用 MAX_USES_PER_IP 次，超额端点在装配阶段就被弃用。

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isIP } from 'node:net'
import { app } from 'electron'
import { fetch as undiciFetch, type RequestInit as UndiciRequestInit } from 'undici'
import { ChainProxyRelay } from '../registration/chainProxy'
import { getSystemProxy, safeCreateProxyAgent } from './systemProxy'
import { maskProxyUrl, probeExitIp, proxyUrlHasCredentials } from './proxyTools'

const API_RESPONSE_LIMIT = 4096
const API_TIMEOUT_MS = 20_000
/** 每次批量提取的重试上限：每次尝试都消耗接口的提取频率额度，见好就收 */
const MAX_BATCH_ATTEMPTS = 2
/** 出口路由（端点→中继→探测）最多连试几个端点 */
const EXIT_MAX_ATTEMPTS = 3
/** 已用端点历史的磁盘保留条数（最近优先；端点本身约 10 分钟过期，历史只为防粘滞窗口内撞车） */
const USED_HISTORY_MAX = 200
/** 同一真实出口 IP 在窗口内的最大使用次数（KiroLuker 同款：同出口连续提链会被 Kiro 403） */
export const MAX_USES_PER_IP = 2
/** 出口计次窗口：24 小时 */
const USAGE_WINDOW_MS = 24 * 60 * 60 * 1000

export interface ProxyEndpoint {
  host: string
  port: number
}

/** 严格解析单行 IP:port（IPv4 或 [IPv6]:port）；错误页、带协议头的 URL 一律拒绝 */
export function parseEndpoint(line: string): ProxyEndpoint {
  const value = line.trim()
  const ipv4 = /^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/.exec(value)
  const ipv6 = /^\[([0-9a-f:]+)\]:(\d{1,5})$/i.exec(value)
  const match = ipv4 || ipv6
  if (!match || !isIP(match[1])) throw new Error('invalid endpoint')
  const port = Number(match[2])
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid endpoint')
  return { host: match[1], port }
}

function endpointUrl(endpoint: ProxyEndpoint): string {
  const host = endpoint.host.includes(':') ? `[${endpoint.host}]` : endpoint.host
  return `http://${host}:${endpoint.port}`
}

interface QueuedEndpoint {
  url: string
  key: string
  fetchedAt: number
}

/** 已用端点记忆：端口背后的会话按 time 参数轮换（同端口过期后 = 新出口，可安全复用），
 *  记忆只活一个时效窗口；跨窗口的同出口防撞由「出口 IP 24h 计次」兜底 */
interface UsedEndpoint {
  key: string
  at: number
}

export interface DynamicProxySourceConfig {
  /** 提链接口地址（num 参数会被批量值覆盖） */
  url: string
  /** 本地可信中转（http/socks）；空串表示直连提链 */
  viaProxy: string
  /** 单次批量提取数量（写入 num 参数） */
  batchSize: number
}

export interface DynamicProxySourceOptions {
  /** 历史里已用过的端点（磁盘恢复），新实例继承 */
  initialUsed?: readonly UsedEndpoint[]
  /** 每消费一个新端点后回调（磁盘持久化用），参数为最近优先的完整历史 */
  onUsedChange?: (used: readonly UsedEndpoint[]) => void
}

export class DynamicProxySource {
  private readonly queue: QueuedEndpoint[] = []
  /** 已用端点历史（最近优先；条目按端点时效自动过期，过期端口 = 新会话新出口） */
  private readonly used: UsedEndpoint[] = []
  private fetchChain: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly cfg: DynamicProxySourceConfig,
    private readonly log: (msg: string) => void,
    options: DynamicProxySourceOptions = {}
  ) {
    if (options.initialUsed?.length) {
      this.used.push(...options.initialUsed.slice(0, USED_HISTORY_MAX))
    }
    this.onUsedChange = options.onUsedChange
  }

  private readonly onUsedChange?: (used: readonly UsedEndpoint[]) => void

  /** 端点是否在有效记忆内被用过（过期条目视为未用过，顺手清理） */
  private hasUsed(key: string): boolean {
    const ttl = this.ttlMs()
    const now = Date.now()
    let changed = false
    for (let i = this.used.length - 1; i >= 0; i--) {
      if (now - this.used[i].at >= ttl) {
        this.used.splice(i, 1)
        changed = true
      }
    }
    if (changed) this.onUsedChange?.(this.used)
    return this.used.some((u) => u.key === key)
  }

  private addUsed(key: string): void {
    this.used.unshift({ key, at: Date.now() })
    if (this.used.length > USED_HISTORY_MAX) this.used.length = USED_HISTORY_MAX
    this.onUsedChange?.(this.used)
  }

  /** URL 里 time 参数（分钟）决定的端点有效期；留 1 分钟安全余量 */
  private ttlMs(): number {
    let minutes = 10
    try {
      const parsed = Number(new URL(this.cfg.url).searchParams.get('time'))
      if (Number.isFinite(parsed) && parsed > 0) minutes = parsed
    } catch {
      // URL 无效时真正的请求会失败，这里先按默认估
    }
    return Math.max(60_000, minutes * 60_000 - 60_000)
  }

  /** 从队列取一个未用过且未过期的端点；顺手清掉过期条目 */
  private popFresh(): string | null {
    const ttl = this.ttlMs()
    const now = Date.now()
    while (this.queue.length) {
      const item = this.queue.shift()!
      if (now - item.fetchedAt >= ttl) continue
      this.addUsed(item.key)
      return item.url
    }
    return null
  }

  private async fetchBatch(): Promise<void> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS)
    const dispatcher = this.cfg.viaProxy ? safeCreateProxyAgent(this.cfg.viaProxy) : undefined
    if (this.cfg.viaProxy && !dispatcher) throw new Error('本地中转代理协议不支持')
    try {
      const url = new URL(this.cfg.url)
      url.searchParams.set('num', String(this.cfg.batchSize))
      const resp = await undiciFetch(url, {
        ...(dispatcher ? { dispatcher } : {}),
        method: 'GET',
        signal: controller.signal,
        headersTimeout: API_TIMEOUT_MS,
        bodyTimeout: API_TIMEOUT_MS,
        headers: { accept: 'text/plain', 'cache-control': 'no-store' }
      } as UndiciRequestInit)
      if (resp.status !== 200) throw new Error(`提链接口返回 HTTP ${resp.status}`)
      if (!resp.body) throw new Error('提链响应为空')
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of resp.body) {
        const next = Buffer.from(chunk)
        size += next.length
        if (size > API_RESPONSE_LIMIT) throw new Error('提链响应过大')
        chunks.push(next)
      }
      const body = Buffer.concat(chunks).toString('utf8')
      const lines = body.trim().split(/\r?\n/).filter(Boolean)
      if (!lines.length) throw new Error('提链响应为空')
      let endpoints: ProxyEndpoint[]
      try {
        // 任一行非法（错误页、垃圾内容）整体拒绝，不把半截结果当可用端点
        endpoints = lines.map((line) => parseEndpoint(line))
      } catch {
        throw new Error('提链响应格式异常')
      }
      let fresh = 0
      for (const endpoint of endpoints) {
        const endpointAsUrl = endpointUrl(endpoint)
        if (this.hasUsed(endpointAsUrl) || this.queue.some((q) => q.key === endpointAsUrl)) continue
        this.queue.push({ url: endpointAsUrl, key: endpointAsUrl, fetchedAt: Date.now() })
        fresh++
      }
      this.log(`提链接口返回 ${endpoints.length} 个端点，其中 ${fresh} 个未用过`)
      if (!fresh) throw new Error('提链接口未能提供新端点（会话粘滞）')
    } catch (e) {
      // 已知的业务错误原样上抛；传输层异常不把 URL、响应体细节带进用户可见信息
      const msg = e instanceof Error ? e.message : ''
      if (/^(提链|本地中转)/.test(msg)) throw new Error(msg)
      if (controller.signal.aborted) throw new Error('提链接口请求超时')
      throw new Error('无法访问提链接口')
    } finally {
      clearTimeout(timer)
      // safeCreateProxyAgent 的 agent 按 URL 缓存共享，这里不能 close
    }
  }

  /**
   * 取一个端点代理 URL。全程串行：并发提链既容易撞重复端点，也容易触发接口限流。
   * 队列有货直接消费；没货批量提取（内部最多重试 MAX_BATCH_ATTEMPTS 次）。
   */
  acquire(): Promise<string> {
    const run = this.fetchChain.then(async () => {
      const cached = this.popFresh()
      if (cached) return cached
      for (let attempt = 1; attempt <= MAX_BATCH_ATTEMPTS; attempt++) {
        await this.fetchBatch()
        const fresh = this.popFresh()
        if (fresh) return fresh
      }
      throw new Error('提链接口连续未能提供可用端点')
    })
    this.fetchChain = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }
}

// ── 磁盘持久化（fs JSON，与 loginPool/store.ts 同款惯用） ──

function dataFile(name: string): string {
  return join(app.getPath('userData'), name)
}

function readJson<T>(path: string, fallback: T): T {
  try {
    if (!existsSync(path)) return fallback
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return fallback
  }
}

function writeJson(path: string, data: unknown): void {
  try {
    writeFileSync(path, JSON.stringify(data), 'utf8')
  } catch {
    // 持久化失败不影响运行（内存记忆仍在），下次消费会再尝试落盘
  }
}

/** 已用端点历史（最近优先；旧版纯字符串格式无时间戳，视为过期丢弃） */
function loadUsedHistory(): UsedEndpoint[] {
  const raw = readJson<{ used?: unknown }>(dataFile('dynamic-proxy-history.json'), {})
  if (!Array.isArray(raw.used)) return []
  const out: UsedEndpoint[] = []
  for (const item of raw.used) {
    if (
      item &&
      typeof item === 'object' &&
      typeof (item as UsedEndpoint).key === 'string' &&
      typeof (item as UsedEndpoint).at === 'number' &&
      Number.isFinite((item as UsedEndpoint).at)
    ) {
      out.push({ key: (item as UsedEndpoint).key, at: (item as UsedEndpoint).at })
    }
  }
  return out.slice(0, USED_HISTORY_MAX)
}

function saveUsedHistory(used: readonly UsedEndpoint[]): void {
  writeJson(dataFile('dynamic-proxy-history.json'), { used: used.slice(0, USED_HISTORY_MAX) })
}

/** 出口 IP → 使用时间戳列表（滑动 24h 计次，48h 外的记录顺手清理） */
type UsageFile = Record<string, number[]>

function loadUsage(): UsageFile {
  return readJson<UsageFile>(dataFile('dynamic-proxy-usage.json'), {})
}

function pruneUsage(uses: UsageFile): void {
  const cutoff = Date.now() - 48 * 60 * 60 * 1000
  for (const ip of Object.keys(uses)) {
    const kept = uses[ip].filter((t) => t >= cutoff)
    if (kept.length) uses[ip] = kept
    else delete uses[ip]
  }
}

function countExitUses(exitIp: string): number {
  const uses = loadUsage()
  const since = Date.now() - USAGE_WINDOW_MS
  return (uses[exitIp] || []).filter((t) => t >= since).length
}

function recordExitUse(exitIp: string): void {
  const uses = loadUsage()
  pruneUsage(uses)
  ;(uses[exitIp] ||= []).push(Date.now())
  writeJson(dataFile('dynamic-proxy-usage.json'), uses)
}

/** 出口风控惩罚：给出口 IP 追加一次使用计数。
 *  用于「出口已确认被目标站点拉黑」的场景（如 GitHub 登录被反滥用拒绝）——
 *  正常 acquire 时已计 1 次，这里再计 1 次即达 MAX_USES_PER_IP 上限，
 *  该出口 24h 内不会再被分配，避免下一个号继续撞同一个脏 IP。 */
export function penalizeExitUse(exitIp: string): void {
  recordExitUse(exitIp)
}

// ── 全局共享单例（全应用一份队列 + 一份记忆；配置变化自动重建并继承历史） ──

/** 提链池事件订阅：号池 runner 等消费方把提链动态转发进自己的 UI 日志 */
const sourceLogListeners = new Set<(msg: string) => void>()

export function onDynamicSourceLog(listener: (msg: string) => void): () => void {
  sourceLogListeners.add(listener)
  return () => sourceLogListeners.delete(listener)
}

let sharedSource: { key: string; source: DynamicProxySource } | null = null

export function getSharedDynamicSource(cfg: DynamicProxySourceConfig): DynamicProxySource {
  const key = JSON.stringify(cfg)
  if (sharedSource?.key === key) return sharedSource.source
  sharedSource = {
    key,
    source: new DynamicProxySource(
      cfg,
      (m) => {
        console.log(`[提链] ${m}`)
        for (const listener of sourceLogListeners) {
          try {
            listener(m)
          } catch {
            /* 订阅方异常不影响池 */
          }
        }
      },
      {
        initialUsed: loadUsedHistory(),
        onUsedChange: (used) => saveUsedHistory(used)
      }
    )
  }
  return sharedSource.source
}

/** 提链端点的本地中转：优先显式配置，默认取系统代理（端点直连不通且按来源 IP 白名单鉴权） */
export function resolveViaProxy(explicit?: string): string {
  return ((explicit || '').trim() || getSystemProxy() || '').trim()
}

/** 一条可用的提链出口路由（探测确认后返回；用完必须 release 释放本地中继） */
export interface DynamicExitRoute {
  /** 挂给 fetchWithProxy(account.proxyUrl) 或 Chromium setProxy 的代理地址 */
  proxyRules: string
  /** 提链端点原始 URL */
  endpointUrl: string
  /** 经 ipify 探测确认的真实出口 IP */
  exitIp: string
  /** 探测延迟（毫秒） */
  latencyMs: number
  /** 释放本地中继；无中继时为空操作 */
  release: () => Promise<void>
}

/**
 * 取一条探测确认过的出口路由：端点 →（按需）本地中继两跳 → ipify 探测 →
 * 真实出口 24h 计次检查（超额出口弃用换下一个）。全部失败抛错，绝不直连。
 */
export async function acquireDynamicExit(
  source: DynamicProxySource,
  viaProxy: string,
  log: (level: 'info' | 'warn' | 'ok', msg: string) => void
): Promise<DynamicExitRoute> {
  const upstream = viaProxy.trim()
  const exhaustedExits = new Set<string>()
  let lastError = ''
  for (let attempt = 1; attempt <= EXIT_MAX_ATTEMPTS; attempt++) {
    let targetUrl: string
    try {
      targetUrl = await source.acquire()
    } catch (err) {
      // 提链接口本身不可用（内部已重试过），换端点无意义
      throw new Error(err instanceof Error ? err.message : String(err))
    }
    // 端点必须经本地中转两跳（白名单按来源鉴权 + 直连不通）；无中转则按直连端点处理
    let relay: ChainProxyRelay | null = null
    let proxyRules = targetUrl
    if (upstream || proxyUrlHasCredentials(targetUrl)) {
      try {
        // 无中转时把端点自身当 upstream（退化为直连端点 + CONNECT 认证）
        relay = new ChainProxyRelay(upstream || targetUrl, targetUrl, (m) => log('warn', m))
        proxyRules = await relay.start()
      } catch (err) {
        log('warn', `本地代理中继启动失败：${err instanceof Error ? err.message : String(err)}`)
        continue
      }
    }
    const probe = await probeExitIp(proxyRules)
    if (probe.ok && probe.ip && probe.ms !== undefined) {
      if (countExitUses(probe.ip) >= MAX_USES_PER_IP) {
        exhaustedExits.add(probe.ip)
        lastError = `出口 ${probe.ip} 24 小时内已用满（上限 ${MAX_USES_PER_IP} 次）`
        log('warn', `端点 ${maskProxyUrl(targetUrl)} 的出口 ${probe.ip} 已用满，弃用换下一个`)
        if (relay) await relay.stop()
        continue
      }
      log('ok', `出口代理已接通：${probe.ip}（${probe.ms}ms，经 ${maskProxyUrl(targetUrl)}）`)
      recordExitUse(probe.ip)
      return {
        proxyRules,
        endpointUrl: targetUrl,
        exitIp: probe.ip,
        latencyMs: probe.ms,
        release: async () => {
          if (relay) await relay.stop()
        }
      }
    }
    if (relay) await relay.stop()
    lastError = probe.error || '未知错误'
    log('warn', `端点 ${maskProxyUrl(targetUrl)} 探测失败（${lastError}），换下一个端点`)
  }
  if (exhaustedExits.size) {
    throw new Error(
      `提链出口 24 小时内均已用满（${[...exhaustedExits].join('、')}，上限 ${MAX_USES_PER_IP} 次/出口），请稍后重试`
    )
  }
  throw new Error(`提链端点均不可用（${lastError || '无候选'}）`)
}
