// 代理池相关 IPC：验活 + 代理链分阶段诊断
//
// 这两个 handler 完全独立、没有外部状态依赖，从 main/index.ts 拆出来作为模块化拆分的"种子"。
// 后续可按相同模式继续拆分（machine-id / kproxy / proxy / register / kiro-settings 等）。

import { ipcMain } from 'electron'
import { fetch as undiciFetch, type RequestInit as UndiciRequestInit } from 'undici'
import { safeCreateProxyAgent, destroyCachedProxyAgent } from '../proxy/systemProxy'
import { resolveProxyUrl, resetProxyBridge, isBridgeableUrl } from '../proxy/proxyBridge'
import { ChainProxyRelay } from '../registration/chainProxy'

/**
 * 通过指定代理 URL 请求测试地址，返回延迟与出口 IP。
 * 支持 http/https/socks4/socks5/hy2 协议代理（hy2 由 proxyBridge 转成本地 socks5）。
 * 若给了 upstreamProxy，验活也走代理链（与注册流程一致），避免目标代理因来源 IP 不符被误标 dead。
 */
function registerValidateHandler(): void {
  ipcMain.handle('proxy-pool:validate', async (_event, params: {
    url: string
    testUrl?: string
    timeoutMs?: number
    upstreamProxy?: string
  }) => {
    const { url, testUrl = 'https://api.ipify.org?format=json', timeoutMs = 8000, upstreamProxy } = params || {}
    if (!url) return { success: false, error: 'Missing proxy URL' }

    let chainRelay: ChainProxyRelay | null = null
    let proxyForAgent = url
    try {
      proxyForAgent = (await resolveProxyUrl(url)) || url
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
    if (upstreamProxy && upstreamProxy.trim()) {
      try {
        const upstream = (await resolveProxyUrl(upstreamProxy.trim())) || upstreamProxy.trim()
        chainRelay = new ChainProxyRelay(upstream, proxyForAgent)
        proxyForAgent = await chainRelay.start()
      } catch (err) {
        return { success: false, error: `代理链启动失败: ${err instanceof Error ? err.message : String(err)}` }
      }
    }

    const agent = safeCreateProxyAgent(proxyForAgent)
    if (!agent) {
      if (chainRelay) await chainRelay.stop()
      return { success: false, error: '代理协议不支持（仅支持 http/https/socks4/socks5/hy2）或 URL 无效' }
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const start = Date.now()
    try {
      const resp = await undiciFetch(testUrl, {
        method: 'GET',
        dispatcher: agent,
        signal: controller.signal,
        headers: { 'User-Agent': 'KiroAccountManager-ProxyValidator/1.0' }
      } as UndiciRequestInit)
      const latencyMs = Date.now() - start
      if (resp.status >= 200 && resp.status < 400) {
        let externalIp: string | undefined
        try {
          const ct = resp.headers.get('content-type') || ''
          const text = await resp.text()
          if (ct.includes('json') || text.trimStart().startsWith('{')) {
            try {
              const body = JSON.parse(text) as Record<string, unknown>
              // 常见字段名：ip(ipify/ipinfo/ip2location/ipapi.co) / query(ip-api) / origin(httpbin) / ipAddress
              const raw = body.ip ?? body.query ?? body.origin ?? body.ipAddress ?? ''
              const ipStr = String(raw).trim()
              const m = ipStr.match(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/)
              if (m) externalIp = m[0]
            } catch { /* JSON 解析失败走下面纯文本 */ }
          }
          if (!externalIp) {
            const m = text.match(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/)
            if (m) externalIp = m[0]
          }
        } catch { /* 出口 IP 提取失败不影响验活成功 */ }
        return { success: true, latencyMs, externalIp }
      }
      return { success: false, latencyMs, error: `HTTP ${resp.status}` }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      const isAbort = controller.signal.aborted
      // 桥接协议验活失败:杀掉该实例,下次验活全新握手(等价重启应用的自愈效果)
      if (isBridgeableUrl(url)) resetProxyBridge(url)
      return {
        success: false,
        latencyMs: Date.now() - start,
        error: isAbort ? `请求超时 (${timeoutMs}ms)` : errMsg
      }
    } finally {
      clearTimeout(timer)
      // 释放连接池并同步摘除缓存条目(只 close 不摘会毒化缓存:下次同 URL 命中死实例必败)
      try { await destroyCachedProxyAgent(proxyForAgent) } catch { /* ignore */ }
      if (chainRelay) await chainRelay.stop()
    }
  })
}

/**
 * 代理链分阶段诊断：
 *   A) 上游中转 TCP 可达
 *   B) 经上游 CONNECT 抵达目标代理入口
 *   C) 经完整链路 CONNECT 抵达 testHost:testPort（默认 www.gstatic.com:443）
 * 定位问题精确到哪一层，比 validate 的"成功/失败"二元结果信息量大得多。
 */
function registerDiagnoseChainHandler(): void {
  ipcMain.handle('proxy-pool:diagnose-chain', async (_event, params: {
    targetUrl: string
    upstreamProxy: string
    testHost?: string
    testPort?: number
  }) => {
    const { targetUrl, upstreamProxy, testHost, testPort } = params || {}
    if (!targetUrl) return { success: false, error: 'Missing target proxy URL' }
    if (!upstreamProxy) return { success: false, error: 'Missing upstream proxy URL' }
    try {
      const relay = new ChainProxyRelay(
        (await resolveProxyUrl(upstreamProxy.trim())) || upstreamProxy.trim(),
        (await resolveProxyUrl(targetUrl)) || targetUrl
      )
      const diag = await relay.diagnose(testHost, testPort)
      return { success: true, diagnose: diag }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}

/** 注册"代理池"模块下的全部 IPC handler */
export function registerProxyPoolIpcHandlers(): void {
  registerValidateHandler()
  registerDiagnoseChainHandler()
}
