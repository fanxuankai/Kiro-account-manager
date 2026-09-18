// 系统代理检测（Windows 注册表 / macOS scutil）+ 安全 ProxyAgent 工厂
// 含 SOCKS5/SOCKS4 代理支持（通过 socks 包 + undici Agent.connect 钩子）

import { ProxyAgent, Agent, type Dispatcher } from 'undici'
import * as tls from 'tls'

let _cachedSystemProxy: string | null = null
let _systemProxyCacheTime = 0
const SYSTEM_PROXY_CACHE_TTL = 30_000 // 30秒缓存

/**
 * 检查 URL 是否为 undici ProxyAgent 支持的协议（http / https）
 */
function isHttpLikeProxyUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * 解析 Windows ProxyServer 注册表值，仅返回 undici 可用的 http(s) 代理 URL
 *
 * 可能的格式：
 *   1) "host:port"            — 单一代理，应用于所有协议
 *   2) "http=host:port;https=host:port;ftp=host:port;socks=host:port"
 *                              — 按协议分别配置
 *   3) "scheme://host:port"   — 已带 scheme（http / https / socks5 ...）
 *
 * 不支持 socks/socks4/socks5/pac 等非 http(s) 协议，遇到时返回 null（回退直连）
 */
function parseWindowsProxyServer(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null

  // 形如 "http=host:port;https=host:port;socks=host:port" 的多协议格式
  if (trimmed.includes('=')) {
    const map = new Map<string, string>()
    for (const seg of trimmed.split(';')) {
      const eq = seg.indexOf('=')
      if (eq > 0) {
        const k = seg.slice(0, eq).trim().toLowerCase()
        const v = seg.slice(eq + 1).trim()
        if (k && v) map.set(k, v)
      }
    }
    const https = map.get('https')
    if (https) return `http://${https}`
    const http = map.get('http')
    if (http) return `http://${http}`
    return null
  }

  // 已带 scheme
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    return isHttpLikeProxyUrl(trimmed) ? trimmed : null
  }

  // 裸的 host:port，按 http 处理
  return `http://${trimmed}`
}

export function getSystemProxy(): string | null {
  const now = Date.now()
  if (_systemProxyCacheTime > 0 && now - _systemProxyCacheTime < SYSTEM_PROXY_CACHE_TTL) {
    return _cachedSystemProxy
  }
  try {
    if (process.platform === 'win32') {
      const { execSync } = require('child_process')
      const result = execSync(
        'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable',
        { encoding: 'utf8', timeout: 3000, windowsHide: true }
      )
      if (result.includes('0x1')) {
        const serverResult = execSync(
          'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer',
          { encoding: 'utf8', timeout: 3000, windowsHide: true }
        )
        const match = serverResult.match(/ProxyServer\s+REG_SZ\s+(.+)/)
        if (match) {
          const parsed = parseWindowsProxyServer(match[1])
          _cachedSystemProxy = parsed
          _systemProxyCacheTime = now
          return _cachedSystemProxy
        }
      }
    } else if (process.platform === 'darwin') {
      const { execSync } = require('child_process')
      const result = execSync('scutil --proxy', { encoding: 'utf8', timeout: 3000 })
      // 优先 HTTPS 代理，回退到 HTTP 代理（仅 undici 支持的 http/https 协议）
      const httpsEnabled = /HTTPSEnable\s*:\s*1/.test(result)
      if (httpsEnabled) {
        const hostMatch = result.match(/HTTPSProxy\s*:\s*(\S+)/)
        const portMatch = result.match(/HTTPSPort\s*:\s*(\d+)/)
        if (hostMatch) {
          const proxy = `http://${hostMatch[1]}${portMatch ? ':' + portMatch[1] : ''}`
          _cachedSystemProxy = proxy
          _systemProxyCacheTime = now
          return _cachedSystemProxy
        }
      }
      const httpEnabled = /HTTPEnable\s*:\s*1/.test(result)
      if (httpEnabled) {
        const hostMatch = result.match(/HTTPProxy\s*:\s*(\S+)/)
        const portMatch = result.match(/HTTPPort\s*:\s*(\d+)/)
        if (hostMatch) {
          const proxy = `http://${hostMatch[1]}${portMatch ? ':' + portMatch[1] : ''}`
          _cachedSystemProxy = proxy
          _systemProxyCacheTime = now
          return _cachedSystemProxy
        }
      }
      // macOS 仅配 SOCKS 时 undici 不支持，静默回退直连（safeCreateProxyAgent 也会兜底）
    }
  } catch { /* 检测失败静默回退直连 */ }
  _cachedSystemProxy = null
  _systemProxyCacheTime = now
  return null
}

/**
 * Agent 缓存：ProxyAgent/Agent 内部维护连接池，每个请求都新建一个等于放弃 keep-alive
 * （每个请求都重新 TCP+TLS 握手，走 HTTP 代理还要先建 CONNECT 隧道，批量刷新时开销成倍放大）。
 * 按代理 URL 缓存复用，同一代理的后续请求直接复用池内连接。
 * 桌面应用代理地址有限；超上限时按插入序淘汰最旧的并关闭其连接池。
 */
const AGENT_CACHE_MAX = 256
const _agentCache = new Map<string, Dispatcher>()

function cachedAgent(proxyUrl: string, create: () => Dispatcher): Dispatcher {
  const hit = _agentCache.get(proxyUrl)
  if (hit) return hit
  const agent = create()
  if (_agentCache.size >= AGENT_CACHE_MAX) {
    const oldest = _agentCache.keys().next().value
    if (oldest !== undefined) {
      const evicted = _agentCache.get(oldest)
      _agentCache.delete(oldest)
      void evicted?.close().catch(() => {})
    }
  }
  _agentCache.set(proxyUrl, agent)
  return agent
}

/**
 * 释放并摘除缓存的 agent(验活等一次性场景专用)。
 * 只 close 不删缓存条目会把"已关闭的 agent"留在缓存里——下次同 URL 命中缓存
 * 拿到死实例,请求必失败(实测:连续点第二次测试必败、重启才恢复的根因)。
 */
export async function destroyCachedProxyAgent(proxyUrl: string): Promise<void> {
  const hit = _agentCache.get(proxyUrl)
  if (!hit) return
  _agentCache.delete(proxyUrl)
  await hit.close().catch(() => {})
}

/**
 * 安全地创建 undici Dispatcher
 *
 * 支持协议：
 *   - http: / https: → undici 原生 ProxyAgent
 *   - socks5: / socks4: → 通过 socks 包 + undici Agent 的 connect 钩子实现 SOCKS 隧道
 *
 * URL 无效或协议无法支持时返回 undefined，让调用方回退直连，
 * 而不会让异常向上传播阻塞业务流程。
 */
export function safeCreateProxyAgent(
  proxyUrl: string | null | undefined
): Dispatcher | undefined {
  if (!proxyUrl) return undefined

  // 校验 URL
  let u: URL
  try {
    u = new URL(proxyUrl)
  } catch {
    console.warn(`[Proxy] 代理 URL 无效: ${proxyUrl}`)
    return undefined
  }

  const protocol = u.protocol

  // http / https 走原生 ProxyAgent
  if (protocol === 'http:' || protocol === 'https:') {
    try {
      return cachedAgent(proxyUrl, () =>
        new ProxyAgent({ uri: proxyUrl, requestTls: { rejectUnauthorized: false } })
      )
    } catch (err) {
      console.warn(`[Proxy] 创建 HTTP ProxyAgent 失败，回退直连: ${proxyUrl}`, err)
      return undefined
    }
  }

  // SOCKS 走自定义 connect
  if (protocol === 'socks5:' || protocol === 'socks5h:' || protocol === 'socks4:' || protocol === 'socks4a:') {
    try {
      return cachedAgent(proxyUrl, () => createSocksDispatcher(u))
    } catch (err) {
      console.warn(`[Proxy] 创建 SOCKS Agent 失败，回退直连: ${proxyUrl}`, err)
      return undefined
    }
  }

  console.warn(`[Proxy] 忽略不支持的代理协议 (仅支持 http/https/socks5/socks4): ${proxyUrl}`)
  return undefined
}

/**
 * 通过 undici Agent 的 connect 钩子实现 SOCKS5/4 隧道
 * 流程：socks.createConnection 建立 TCP 隧道 → 如目标是 https 再 TLS 升级 → 把 socket 交给 undici
 */
function createSocksDispatcher(u: URL): Agent {
  const isSocks5 = u.protocol === 'socks5:' || u.protocol === 'socks5h:'
  const type: 4 | 5 = isSocks5 ? 5 : 4
  const proxyHost = u.hostname
  const proxyPort = Number(u.port) || 1080
  const userId = u.username ? decodeURIComponent(u.username) : undefined
  const password = u.password ? decodeURIComponent(u.password) : undefined

  // undici Agent.connect callback 的类型签名是 (err: Error, socket: null) | (err: null, socket: Socket)
  // 用宽松 any 包装避免严格类型不匹配，运行时行为完全正确
  return new Agent({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    connect: ((options: any, callback: any): void => {
      const targetHost = options.hostname || options.host || ''
      const targetPort = Number(options.port) || (options.protocol === 'https:' ? 443 : 80)

      // 动态导入 socks 库
      let SocksClient: typeof import('socks').SocksClient
      try {
        SocksClient = require('socks').SocksClient
      } catch (err) {
        callback(err as Error, null)
        return
      }

      void SocksClient.createConnection({
        proxy: { host: proxyHost, port: proxyPort, type, userId, password },
        command: 'connect',
        destination: { host: targetHost, port: targetPort }
      })
        .then(({ socket }) => {
          // HTTPS 需要 TLS 升级
          if (options.protocol === 'https:') {
            const tlsSocket = tls.connect({
              socket,
              servername: options.servername || targetHost,
              rejectUnauthorized: options.rejectUnauthorized ?? false
            })
            tlsSocket.once('secureConnect', () => callback(null, tlsSocket))
            tlsSocket.once('error', (err) => callback(err, null))
          } else {
            callback(null, socket)
          }
        })
        .catch((err: Error) => callback(err, null))
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any
  })
}
