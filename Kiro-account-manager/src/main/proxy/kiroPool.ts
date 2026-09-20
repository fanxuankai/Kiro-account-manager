// Kiro IP 池服务源（主进程共享模块）
//
// 面向「socks5 跑在出口线路上 + 服务端换绑出口 IP + 登录锁」这类 IP 池服务：
//   - socks5 代理端点在当前出口 IP 上：socks5://管理员账号:登录密码@<出口IP>:4722，
//     出口 IP 由 /api/kiro/ip 返回（换绑后自动换主机；控制服务器:4722 出口是服务器本机，不能用）
//   - /api/kiro/ip  查询当前出口 IP；换绑进行中返回「正在更换IP」（文本/JSON 均按此语义解析）
//   - /api/kiro/lock  登录前上锁：持锁期间服务端不会更换 IP（换绑只发生在零持锁时）
//   - /api/kiro/unlock 登录完释放；锁 30 分钟未释放由服务端自动过期（客户端崩溃无需对账）
//   - 服务端按「累计 N 把锁且全部释放」自动换绑，客户端不主动触发更换
//
// 客户端执行纪律：走此代理的操作整体包在 lease 里（acquire → 操作 → release），
// 换绑永远打不断持锁中的请求。acquire 全局串行，避免并发条目交错上锁。
// Chromium proxyRules 挂不了账密 → 与提链出口同款：ChainProxyRelay 本地中继剥凭据。

import { fetch as undiciFetch, type RequestInit as UndiciRequestInit } from 'undici'
import { ChainProxyRelay } from '../registration/chainProxy'
import { maskProxyUrl, probeExitIp, proxyUrlHasCredentials } from './proxyTools'

/** 出口装配尝试次数：lock/探测偶发失败整轮重来（每轮失败都会先释放旧锁再重来） */
const KIRO_POOL_MAX_ATTEMPTS = 2
/** 接口单次请求超时 */
const API_TIMEOUT_MS = 15_000
/** 换绑等待轮询间隔（面板实测单次换绑约 30s） */
const ROTATING_POLL_MS = 5_000
/** 换绑等待上限：覆盖偶发的慢换绑 */
const ROTATING_MAX_WAIT_MS = 150_000
/** lock 瞬时失败重试次数 */
const LOCK_ATTEMPTS = 2
const LOCK_RETRY_DELAY_MS = 3_000
/** 出口探测超时：线路多为家宽/移动线路，比默认 12s 放宽 */
const PROBE_TIMEOUT_MS = 20_000
/** socks5 代理端口（出口线路上固定 4722） */
const DEFAULT_PROXY_PORT = 4722

/** sourceKey 前缀：号池风控惩罚回路上区分 kiro-pool 出口（服务端管换绑，客户端不计数） */
export const KIRO_POOL_SOURCE_PREFIX = 'kiro-pool:'

export interface KiroPoolSourceConfig {
  /** 服务 API 地址，如 http://<服务器IP>:4721 */
  apiBase: string
  /** 平台管理员账号（= socks5 代理账号） */
  username: string
  /** 平台登录密码（= socks5 代理密码） */
  password: string
  /** socks5 代理端口，默认 4722 */
  proxyPort?: number
  /** 显式代理地址（socks5://user:pass@host:port），优先于 apiBase 主机推导 */
  proxyUrl?: string
}

type LogFn = (level: 'info' | 'warn' | 'ok', msg: string) => void

export interface KiroPoolExitRoute {
  /** 挂给 fetchWithProxy(account.proxyUrl) 或 Chromium setProxy 的代理地址（中继后无凭据） */
  proxyRules: string
  /** 原始 socks5 地址（带凭据；供 undici 直用） */
  proxyUrl: string
  /** 出口来源标识（无密码），风控惩罚定位用 */
  sourceKey: string
  /** 经 ipify 探测确认的真实出口 IP */
  exitIp: string
  /** 探测延迟（毫秒） */
  latencyMs: number
  /** 服务端上报的锁计数（lock_count / threshold） */
  lockCount?: number
  lockThreshold?: number
  /** 释放：解锁登录锁 + 停本地中继；操作完成必须调用 */
  release: () => Promise<void>
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function normalizeConfig(cfg: KiroPoolSourceConfig): {
  base: URL
  username: string
  password: string
} {
  const apiBase = (cfg.apiBase || '').trim()
  const username = (cfg.username || '').trim()
  if (!apiBase) throw new Error('Kiro IP 池服务地址未配置')
  if (!username || !cfg.password) throw new Error('Kiro IP 池服务账号或密码未配置')
  let base: URL
  try {
    base = new URL(apiBase)
  } catch {
    throw new Error('Kiro IP 池服务地址无效（需形如 http://host:4721）')
  }
  return { base, username, password: cfg.password }
}

/** 解析代理地址：优先显式配置；否则用查到的出口 IP + 固定端口拼 socks5
 *  （socks5 服务跑在出口线路那台机器上，不是控制服务器） */
function buildProxyUrl(cfg: KiroPoolSourceConfig, exitHost: string): string {
  const explicit = (cfg.proxyUrl || '').trim()
  if (explicit) return explicit
  const { username, password } = normalizeConfig(cfg)
  const port = cfg.proxyPort ?? DEFAULT_PROXY_PORT
  const host = exitHost.includes(':') && !exitHost.startsWith('[') ? `[${exitHost}]` : exitHost
  return `socks5://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`
}

interface ApiCallResult {
  status: number
  body: string
}

/** 调服务 API（响应体按文本返回，由调用方按语义解析） */
async function callApi(
  cfg: KiroPoolSourceConfig,
  path: string,
  init: { method: 'GET' | 'POST'; payload?: Record<string, unknown> }
): Promise<ApiCallResult> {
  const { base, username, password } = normalizeConfig(cfg)
  const url = new URL(path, base)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS)
  try {
    let resp: Awaited<ReturnType<typeof undiciFetch>>
    if (init.method === 'GET') {
      // GET 用 URL 参数鉴权（curl 示例形态）
      url.searchParams.set('username', username)
      url.searchParams.set('password', password)
      resp = await undiciFetch(url, {
        method: 'GET',
        signal: controller.signal,
        headersTimeout: API_TIMEOUT_MS,
        bodyTimeout: API_TIMEOUT_MS,
        headers: { accept: 'application/json, text/plain' }
      } as UndiciRequestInit)
    } else {
      resp = await undiciFetch(url, {
        method: 'POST',
        signal: controller.signal,
        headersTimeout: API_TIMEOUT_MS,
        bodyTimeout: API_TIMEOUT_MS,
        headers: { 'content-type': 'application/json', accept: 'application/json, text/plain' },
        body: JSON.stringify({ username, password, ...init.payload })
      } as UndiciRequestInit)
    }
    const body = await resp.text()
    return { status: resp.status, body: body.slice(0, 4096) }
  } catch (e) {
    if (controller.signal.aborted) throw new Error('Kiro IP 池接口请求超时')
    throw new Error(`无法访问 Kiro IP 池接口（${e instanceof Error ? e.message : String(e)}）`)
  } finally {
    clearTimeout(timer)
  }
}

/** 宽松解析 JSON；失败返回 null */
function tryJson(text: string): Record<string, unknown> | null {
  const t = text.trim()
  if (!t.startsWith('{') && !t.startsWith('[')) return null
  try {
    return JSON.parse(t) as Record<string, unknown>
  } catch {
    return null
  }
}

interface IpQueryResult {
  ip?: string
  rotating: boolean
  error?: string
}

/** 查询当前出口 IP；「正在更换IP」是合法中间态（rotating=true） */
function parseIpResult(res: ApiCallResult): IpQueryResult {
  if (res.status !== 200) return { rotating: false, error: `接口返回 HTTP ${res.status}` }
  const text = res.body
  const json = tryJson(text)
  if (json) {
    if (typeof json.ip === 'string' && json.ip.trim())
      return { ip: json.ip.trim(), rotating: false }
    const data = json.data
    if (
      data &&
      typeof data === 'object' &&
      typeof (data as Record<string, unknown>).ip === 'string'
    ) {
      return { ip: ((data as Record<string, unknown>).ip as string).trim(), rotating: false }
    }
    const status = String(json.status ?? '')
    const msg = String(json.message ?? json.error ?? '')
    if (/更换|rotat|chang/i.test(status + msg + text)) return { rotating: true }
    return { rotating: false, error: msg || `接口返回无法解析：${text.slice(0, 120)}` }
  }
  const plain = text.trim()
  if (/正在更换|更换中|rotating|changing/i.test(plain)) return { rotating: true }
  const m = plain.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/)
  if (m) return { ip: m[0], rotating: false }
  return { rotating: false, error: `接口返回无法解析：${plain.slice(0, 120)}` }
}

interface LockResult {
  lockId: number
  lockCount?: number
  threshold?: number
}

function parseLockResult(res: ApiCallResult): LockResult {
  const json = tryJson(res.body)
  const status = String(json?.status ?? '')
  const msg = String(json?.message ?? json?.error ?? '')
  if (res.status !== 200 || !json || (status && status !== 'ok')) {
    throw new Error(msg || `上锁失败（HTTP ${res.status}）`)
  }
  const lockId = Number(
    json.lock_id ?? json.lockId ?? (json.lock as Record<string, unknown> | undefined)?.id
  )
  if (!Number.isInteger(lockId) || lockId < 0) throw new Error(msg || '上锁响应缺少 lock_id')
  return {
    lockId,
    lockCount: Number.isFinite(Number(json.lock_count)) ? Number(json.lock_count) : undefined,
    threshold: Number.isFinite(Number(json.threshold)) ? Number(json.threshold) : undefined
  }
}

/** 等待出口 IP 进入稳定态（换绑完成）；超时抛错 */
async function waitForStableIp(cfg: KiroPoolSourceConfig, log: LogFn): Promise<string> {
  const deadline = Date.now() + ROTATING_MAX_WAIT_MS
  let waited = false
  for (;;) {
    const res = await callApi(cfg, '/api/kiro/ip', { method: 'GET' })
    const parsed = parseIpResult(res)
    if (parsed.ip) return parsed.ip
    if (parsed.rotating) {
      if (Date.now() >= deadline) {
        throw new Error(`服务端换绑超时（等待 ${Math.round(ROTATING_MAX_WAIT_MS / 1000)}s 未完成）`)
      }
      if (!waited) {
        log('info', '服务端正在更换出口 IP，等待换绑完成…')
        waited = true
      }
      await sleep(ROTATING_POLL_MS)
      continue
    }
    throw new Error(parsed.error || '查询出口 IP 失败')
  }
}

/** 尽力而为的解锁：失败只记日志（服务端 30min TTL 兜底） */
async function unlockQuiet(cfg: KiroPoolSourceConfig, lockId: number, log: LogFn): Promise<void> {
  try {
    await callApi(cfg, '/api/kiro/unlock', { method: 'POST', payload: { lock_id: lockId } })
  } catch (e) {
    log(
      'warn',
      `释放登录锁 #${lockId} 失败（服务端 30 分钟后自动过期）：${e instanceof Error ? e.message : String(e)}`
    )
  }
}

async function doAcquire(cfg: KiroPoolSourceConfig, log: LogFn): Promise<KiroPoolExitRoute> {
  let lastError = ''
  let lastTried = ''
  for (let attempt = 1; attempt <= KIRO_POOL_MAX_ATTEMPTS; attempt++) {
    // 1. gate：等 IP 稳定（换绑进行中会被 gate 住）；接口本身不可用时重试无意义，直接抛
    try {
      await waitForStableIp(cfg, log)
    } catch (e) {
      throw new Error(e instanceof Error ? e.message : String(e))
    }
    // 2. 上锁（瞬时失败小间隔重试；撞上换绑窗口也在这里消化）
    let lock: LockResult | null = null
    for (let i = 1; i <= LOCK_ATTEMPTS; i++) {
      try {
        lock = parseLockResult(await callApi(cfg, '/api/kiro/lock', { method: 'POST' }))
        break
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e)
        if (i < LOCK_ATTEMPTS) await sleep(LOCK_RETRY_DELAY_MS)
      }
    }
    if (!lock) continue
    // 3. 持锁后再取一次 IP：此后 IP 冻结，这个值就是本批次的 socks5 目标主机；
    //    装配 + 探测；成功路径的中继交给 release() 停，失败路径这里就地回收
    let relay: ChainProxyRelay | null = null
    try {
      const exitHost = await waitForStableIp(cfg, log)
      const proxyUrl = buildProxyUrl(cfg, exitHost)
      lastTried = maskProxyUrl(proxyUrl)
      let proxyRules = proxyUrl
      if (proxyUrlHasCredentials(proxyUrl)) {
        // 带凭据 → 本地中继剥凭据（Chromium proxyRules 挂不了账密）。
        // 中继无上游、以 socks5 为目标：本地 CONNECT → SOCKS5 握手（带账密）→ 目标站点
        relay = new ChainProxyRelay('', proxyUrl, (m) => log('warn', m))
        proxyRules = await relay.start()
      }
      const probe = await probeExitIp(proxyRules, PROBE_TIMEOUT_MS)
      if (probe.ok && probe.ip && probe.ms !== undefined) {
        if (probe.ip !== exitHost) {
          log('warn', `代理出口 ${probe.ip} 与服务端上报 ${exitHost} 不一致，以探测结果为准`)
        }
        const counter =
          lock.lockCount !== undefined && lock.threshold !== undefined
            ? ` · 锁 ${lock.lockCount}/${lock.threshold}（满 ${lock.threshold} 把全释放后服务端自动换 IP）`
            : ''
        log('ok', `IP 池出口已接通：${probe.ip}（${probe.ms}ms${counter}）`)
        const { username } = normalizeConfig(cfg)
        const host = new URL(proxyUrl).host
        const heldRelay = relay
        const heldLock = lock
        return {
          proxyRules,
          proxyUrl,
          sourceKey: `${KIRO_POOL_SOURCE_PREFIX}${username}@${host}`,
          exitIp: probe.ip,
          latencyMs: probe.ms,
          lockCount: heldLock.lockCount,
          lockThreshold: heldLock.threshold,
          release: async () => {
            await Promise.allSettled([unlockQuiet(cfg, heldLock.lockId, log), heldRelay?.stop()])
          }
        }
      }
      lastError = probe.error || '未知错误'
      log('warn', `IP 池代理 ${maskProxyUrl(proxyUrl)} 探测失败（${lastError}）`)
      if (relay) await relay.stop().catch(() => undefined)
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e)
      log('warn', `IP 池出口装配失败：${lastError}`)
      if (relay) await relay.stop().catch(() => undefined)
    }
    // 到这里一定是失败轮：锁也一并释放，避免占着锁空转
    await unlockQuiet(cfg, lock.lockId, log)
  }
  throw new Error(`Kiro IP 池出口不可用${lastTried ? `（经 ${lastTried}：${lastError}）` : `（${lastError || '无详情'}）`}`)
}

// 全局串行：并发的 acquire 排队执行，避免多条目交错上锁/解锁
let acquireChain: Promise<unknown> = Promise.resolve()

/** 取一条探测确认过的 IP 池出口（含登录锁）；用完必须 release 解锁 */
export function acquireKiroPoolExit(
  cfg: KiroPoolSourceConfig,
  log: LogFn
): Promise<KiroPoolExitRoute> {
  const run = acquireChain.then(() => doAcquire(cfg, log))
  acquireChain = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

/** 全链路演练：acquire → 立即 release，返回出口摘要与过程警告（「测试连接」按钮用） */
export async function testKiroPoolConnection(cfg: KiroPoolSourceConfig): Promise<{
  exitIp: string
  latencyMs: number
  lockCount?: number
  lockThreshold?: number
  warnings: string[]
}> {
  const warnings: string[] = []
  const route = await acquireKiroPoolExit(cfg, (level, msg) => {
    if (level === 'warn') warnings.push(msg)
  })
  try {
    return {
      exitIp: route.exitIp,
      latencyMs: route.latencyMs,
      lockCount: route.lockCount,
      lockThreshold: route.lockThreshold,
      warnings
    }
  } finally {
    await route.release()
  }
}
