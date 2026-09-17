// 代理通用小工具：出口探测、日志脱敏、凭据检测
// 供号池注册（静态池/提链模式）与批量订阅取链接（提链出口）共用

import { fetch as undiciFetch, type RequestInit as UndiciRequestInit } from 'undici'
import { safeCreateProxyAgent } from './systemProxy'

/** 代理 URL 是否带用户名密码（Chromium proxyRules 挂不了凭据，这类必须走本地中继） */
export function proxyUrlHasCredentials(url: string): boolean {
  try {
    const u = new URL(url)
    return !!(u.username || u.password)
  } catch {
    return false
  }
}

/** 日志脱敏：隐去代理 URL 里的密码 */
export function maskProxyUrl(url: string): string {
  return url.replace(/:\/\/([^:@/]+):[^@/]+@/, '://$1:***@')
}

export interface ExitIpProbe {
  ok: boolean
  ip?: string
  ms?: number
  error?: string
}

/** 经指定代理探测真实出口 IP（ipify）。探测失败即代理不可用，由调用方换下一个。 */
export async function probeExitIp(proxyUrl: string, timeoutMs = 12_000): Promise<ExitIpProbe> {
  const agent = safeCreateProxyAgent(proxyUrl)
  if (!agent) return { ok: false, error: '代理协议不支持' }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const start = Date.now()
  try {
    const resp = await undiciFetch('https://api.ipify.org', {
      method: 'GET',
      dispatcher: agent,
      signal: controller.signal,
      headers: { accept: 'text/plain' }
    } as UndiciRequestInit)
    const text = await resp.text()
    const m = text.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/)
    if (resp.status === 200 && m) return { ok: true, ip: m[0], ms: Date.now() - start }
    return { ok: false, error: `探测服务返回 HTTP ${resp.status}` }
  } catch (e) {
    return {
      ok: false,
      error: controller.signal.aborted ? `超时 ${timeoutMs}ms` : e instanceof Error ? e.message : String(e)
    }
  } finally {
    clearTimeout(timer)
    // 不 close：safeCreateProxyAgent 的 agent 按 URL 缓存共享，close 会毒化同 URL 的其它使用方
  }
}
