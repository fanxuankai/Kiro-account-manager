import { app, shell, BrowserWindow, ipcMain, dialog, globalShortcut, protocol } from 'electron'
import { autoUpdater } from 'electron-updater'
import {
  checkMacUpdate,
  downloadMacUpdate,
  installMacUpdate,
  cleanupMacUpdateBackups
} from './macSelfUpdater'
import * as machineIdModule from './machineId'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { writeFile, readFile } from 'fs/promises'
import { encode, decode } from 'cbor-x'
import {
  fetch as undiciFetch,
  type RequestInit as UndiciRequestInit,
  type Dispatcher
} from 'undici'
import icon from '../../resources/icon.png?asset'
import {
  getAccountData,
  saveAccountData,
  initIdleAccountDb,
  getIdleAccountData,
  saveIdleAccountData,
  closeIdleAccountDb
} from './accountDb'
import {
  initKProxyService,
  getKProxyService,
  generateDeviceId,
  isValidDeviceId,
  type KProxyConfig,
  type DeviceIdMapping
} from './kproxy'
import {
  fetchKiroModels,
  fetchSubscriptionToken,
  fetchAvailableSubscriptions,
  setUserPreference,
  setUseKProxyForApiInProxy,
  fetchEnterpriseProfileArn,
  type ProxyAccount
} from './proxy'
import { switchSubscriptionToFree, checkRenewalStatus } from './proxy/stripePortal'
import { openAccountPortal } from './kiroPortal'
import { getSystemProxy, safeCreateProxyAgent } from './proxy/systemProxy'
import { resolveProxyUrl, shutdownProxyBridge } from './proxy/proxyBridge'
import { probeExitIp } from './proxy/proxyTools'
import { acquireDynamicExit, getSharedDynamicSource, resolveViaProxy } from './proxy/dynamicProxy'
import { proxyLogStore, interceptConsole } from './proxy/logger'
import { registerIPCHandlers as registerRegistrationHandlers } from './registration/ipc-handlers'
import { registerProxyPoolIpcHandlers } from './ipc/proxyPool'
import { registerLoginPoolIpc } from './loginPool/ipc'
import { randomBytes, createHash } from 'node:crypto'
import {
  createTray,
  destroyTray,
  updateTrayMenu,
  updateCurrentAccount,
  updateAccountList,
  setTrayTooltip,
  updateTrayLanguage,
  type TraySettings,
  defaultTraySettings
} from './tray'

// 号池登录窗口内接管 kiro:// 授权回调（protocol.handle）——必须在 app ready 前
// 把 kiro 声明为特权协议，否则页面对该协议的导航仍被当外部协议丢给 OS
// （会被同样注册了 kiro:// 的 Kiro IDE 抢走，授权链路中断）
protocol.registerSchemesAsPrivileged([
  { scheme: 'kiro', privileges: { standard: true, secure: true, supportFetchAPI: true } }
])

// ============ 自动更新配置 ============
autoUpdater.autoDownload = false
autoUpdater.autoInstallOnAppQuit = true

function setupAutoUpdater(): void {
  // 检查更新出错
  autoUpdater.on('error', (error) => {
    console.error('[AutoUpdater] Error:', error)
    mainWindow?.webContents.send('update-error', error.message)
  })

  // 检查更新中
  autoUpdater.on('checking-for-update', () => {
    console.log('[AutoUpdater] Checking for update...')
    mainWindow?.webContents.send('update-checking')
  })

  // 有可用更新
  autoUpdater.on('update-available', (info) => {
    console.log('[AutoUpdater] Update available:', info.version)
    mainWindow?.webContents.send('update-available', {
      version: info.version,
      releaseDate: info.releaseDate,
      releaseNotes: info.releaseNotes
    })
  })

  // 没有可用更新
  autoUpdater.on('update-not-available', (info) => {
    console.log('[AutoUpdater] No update available, current:', info.version)
    mainWindow?.webContents.send('update-not-available', { version: info.version })
  })

  // 下载进度
  autoUpdater.on('download-progress', (progress) => {
    console.log(`[AutoUpdater] Download progress: ${progress.percent.toFixed(1)}%`)
    mainWindow?.webContents.send('update-download-progress', {
      percent: progress.percent,
      bytesPerSecond: progress.bytesPerSecond,
      transferred: progress.transferred,
      total: progress.total
    })
  })

  // 下载完成
  autoUpdater.on('update-downloaded', (info) => {
    console.log('[AutoUpdater] Update downloaded:', info.version)
    mainWindow?.webContents.send('update-downloaded', {
      version: info.version,
      releaseDate: info.releaseDate,
      releaseNotes: info.releaseNotes
    })
  })
}

// ============ Kiro API 调用 ============
const KIRO_API_BASE = 'https://app.kiro.dev/service/KiroWebPortalService/operation'
// REST API 端点配置 - 官方 Kiro 插件仅支持 us-east-1 和 eu-central-1
const KIRO_REST_API_ENDPOINTS: Record<string, string> = {
  'us-east-1': 'https://q.us-east-1.amazonaws.com',
  'eu-central-1': 'https://q.eu-central-1.amazonaws.com'
}

// 根据 SSO 区域映射到最近的 REST API 端点
function getRestApiBase(ssoRegion?: string): string {
  if (!ssoRegion) return KIRO_REST_API_ENDPOINTS['us-east-1']
  // 如果是支持的端点区域，直接使用
  if (KIRO_REST_API_ENDPOINTS[ssoRegion]) return KIRO_REST_API_ENDPOINTS[ssoRegion]
  // EU 区域映射到 eu-central-1
  if (ssoRegion.startsWith('eu-')) return KIRO_REST_API_ENDPOINTS['eu-central-1']
  // 其他区域默认 us-east-1
  return KIRO_REST_API_ENDPOINTS['us-east-1']
}

// 获取备用 REST API 端点（用于 fallback）
function getFallbackRestApiBase(ssoRegion?: string): string {
  const primary = getRestApiBase(ssoRegion)
  // 返回另一个端点作为 fallback
  return primary === KIRO_REST_API_ENDPOINTS['eu-central-1']
    ? KIRO_REST_API_ENDPOINTS['us-east-1']
    : KIRO_REST_API_ENDPOINTS['eu-central-1']
}

// API 类型配置
type UsageApiType = 'rest' | 'cbor'
let currentUsageApiType: UsageApiType = 'rest' // 默认使用 REST API (GetUsageLimits)

export function setUsageApiType(type: UsageApiType): void {
  currentUsageApiType = type
  console.log(`[API] Usage API type set to: ${type}`)
}

export function getUsageApiType(): UsageApiType {
  return currentUsageApiType
}

// 是否使用 K-Proxy 代理发送 API 请求
let useKProxyForApi: boolean = false

export function setUseKProxyForApi(enabled: boolean): void {
  useKProxyForApi = enabled
  // 同步设置到 kiroApi.ts
  setUseKProxyForApiInProxy(enabled)
  console.log(`[API] Use K-Proxy for API requests: ${enabled}`)
}

export function getUseKProxyForApi(): boolean {
  return useKProxyForApi
}

// 获取网络代理 agent（优先 K-Proxy，其次用户设置代理，其次系统代理）
function getNetworkAgent(): Dispatcher | undefined {
  if (useKProxyForApi) {
    const kproxyService = getKProxyService()
    if (kproxyService?.isRunning()) {
      const config = kproxyService.getConfig()
      const proxyUrl = `http://${config.host}:${config.port}`
      const agent = safeCreateProxyAgent(proxyUrl)
      if (agent) return agent
    }
  }
  const envProxy =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy
  const envAgent = safeCreateProxyAgent(envProxy)
  if (envAgent) return envAgent
  return safeCreateProxyAgent(getSystemProxy())
}

/**
 * 通用 fetch 函数
 * @param url 请求 URL
 * @param options fetch 选项
 * @param overrideProxyUrl 可选：账号绑定的代理 URL（优先级最高，覆盖全局代理逻辑）
 *
 * 优先级：overrideProxyUrl > K-Proxy > 用户设置代理 > 系统代理 > 直连
 */
async function fetchWithAppProxy(
  url: string,
  options: RequestInit,
  overrideProxyUrl?: string
): Promise<Response> {
  // 优先尝试账号绑定代理(hy2 代理先转本地 socks5,桥接失败回退全局逻辑)
  if (overrideProxyUrl) {
    const resolvedOverride = await resolveProxyUrl(overrideProxyUrl).catch(() => undefined)
    const accountAgent = safeCreateProxyAgent(resolvedOverride || overrideProxyUrl)
    if (accountAgent) {
      return (await undiciFetch(url, {
        ...options,
        dispatcher: accountAgent
      } as UndiciRequestInit)) as unknown as Response
    }
  }
  const agent = getNetworkAgent()
  if (agent) {
    return (await undiciFetch(url, {
      ...options,
      dispatcher: agent
    } as UndiciRequestInit)) as unknown as Response
  }
  return await fetch(url, options)
}

// 兼容函数，指向 getNetworkAgent
function getKProxyAgent(): Dispatcher | undefined {
  return getNetworkAgent()
}

/** 展开网络错误的底层原因链：undici 只抛「fetch failed」，真凶（ECONNRESET/
 *  ETIMEDOUT/DNS…）藏在 cause 里，AggregateError 还要再进 errors 数组一层 */
function describeFetchError(error: unknown): string {
  const parts: string[] = []
  const seen = new Set<unknown>()
  const walk = (e: unknown, depth: number): void => {
    if (!e || depth > 3 || seen.has(e)) return
    seen.add(e)
    if (e instanceof Error) {
      parts.push(e.message || e.name)
      const cause = (e as { cause?: unknown }).cause
      if (cause) walk(cause, depth + 1)
      const errors = (e as { errors?: unknown[] }).errors
      if (Array.isArray(errors)) for (const inner of errors) walk(inner, depth + 1)
    }
  }
  walk(error, 0)
  return parts.join(' ← ') || String(error)
}

// ============ OIDC Token 刷新 ============
interface OidcRefreshResult {
  success: boolean
  accessToken?: string
  refreshToken?: string
  expiresIn?: number
  error?: string
}

// 社交登录 (GitHub/Google) 的 Token 刷新端点
const KIRO_AUTH_ENDPOINT = 'https://prod.us-east-1.auth.desktop.kiro.dev'

// ============ 代理设置 ============

/**
 * 规范化代理 URL，确保 protocol://host:port 格式。
 * 容错处理用户常见的格式错误：
 *   http:127.0.0.1:7890     → http://127.0.0.1:7890   (缺 //)
 *   http:/127.0.0.1:7890    → http://127.0.0.1:7890   (单 /)
 *   127.0.0.1:7890          → http://127.0.0.1:7890   (无 protocol)
 *   http://127.0.0.1:7890   → http://127.0.0.1:7890   (已规范)
 */
export function normalizeProxyUrl(url: string): string {
  const trimmed = (url || '').trim()
  if (!trimmed) return ''
  // 已是标准 protocol:// 前缀
  if (/^[a-z][a-z0-9+\-.]*:\/\//i.test(trimmed)) return trimmed
  // 有 protocol: 但缺/少 //
  const m = trimmed.match(/^([a-z][a-z0-9+\-.]*):(\/*)(.+)$/i)
  if (m) return `${m[1]}://${m[3]}`
  // 无 protocol，默认 http
  return `http://${trimmed}`
}

// 设置代理环境变量
function applyProxySettings(enabled: boolean, url: string): void {
  if (enabled && url) {
    const normalized = normalizeProxyUrl(url)
    process.env.HTTP_PROXY = normalized
    process.env.HTTPS_PROXY = normalized
    process.env.http_proxy = normalized
    process.env.https_proxy = normalized
    if (normalized !== url) {
      console.log(`[Proxy] Enabled: ${normalized} (规范化自: ${url})`)
    } else {
      console.log(`[Proxy] Enabled: ${normalized}`)
    }
  } else {
    delete process.env.HTTP_PROXY
    delete process.env.HTTPS_PROXY
    delete process.env.http_proxy
    delete process.env.https_proxy
    console.log('[Proxy] Disabled')
  }
}

// ============ 隐私模式打开浏览器 ============
import { exec, execSync } from 'child_process'

// 获取 Windows 默认浏览器
function getWindowsDefaultBrowser(): string {
  try {
    // 从注册表读取默认浏览器
    const progId = execSync(
      'reg query "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice" /v ProgId',
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    )

    if (progId.includes('ChromeHTML') || progId.includes('Google')) return 'chrome'
    if (progId.includes('MSEdgeHTM') || progId.includes('Edge')) return 'msedge'
    if (progId.includes('FirefoxURL') || progId.includes('Firefox')) return 'firefox'
    if (progId.includes('BraveHTML') || progId.includes('Brave')) return 'brave'
    if (progId.includes('Opera')) return 'opera'

    return 'unknown'
  } catch {
    return 'unknown'
  }
}

// 使用隐私模式打开浏览器
function openBrowserInPrivateMode(url: string): void {
  const platform = process.platform
  console.log(`[Browser] Opening in private mode on ${platform}: ${url}`)

  try {
    if (platform === 'win32') {
      // Windows: 检测默认浏览器并使用对应的隐私模式参数
      const defaultBrowser = getWindowsDefaultBrowser()
      console.log(`[Browser] Detected default browser: ${defaultBrowser}`)

      let command = ''
      switch (defaultBrowser) {
        case 'chrome':
          command = `start chrome --incognito "${url}"`
          break
        case 'msedge':
          command = `start msedge -inprivate "${url}"`
          break
        case 'firefox':
          command = `start firefox -private-window "${url}"`
          break
        case 'brave':
          command = `start brave --incognito "${url}"`
          break
        case 'opera':
          command = `start opera --private "${url}"`
          break
        default:
          // 未知浏览器，尝试常见浏览器
          console.log('[Browser] Unknown default browser, trying common browsers...')
          exec(`start chrome --incognito "${url}"`, (err) => {
            if (err) {
              exec(`start msedge -inprivate "${url}"`, (err2) => {
                if (err2) {
                  exec(`start firefox -private-window "${url}"`, (err3) => {
                    if (err3) {
                      console.log('[Browser] Fallback to default browser (non-private)')
                      shell.openExternal(url)
                    }
                  })
                }
              })
            }
          })
          return
      }

      exec(command, (err) => {
        if (err) {
          console.log(`[Browser] Failed to open ${defaultBrowser}, fallback to default`)
          shell.openExternal(url)
        }
      })
    } else if (platform === 'darwin') {
      // macOS: 尝试 Chrome -> Firefox -> 默认浏览器
      exec(`open -na "Google Chrome" --args --incognito "${url}"`, (err) => {
        if (err) {
          exec(`open -a Firefox --args -private-window "${url}"`, (err2) => {
            if (err2) {
              console.log('[Browser] Fallback to default browser')
              shell.openExternal(url)
            }
          })
        }
      })
    } else {
      // Linux: 尝试 Chrome -> Chromium -> Firefox
      exec(`google-chrome --incognito "${url}"`, (err) => {
        if (err) {
          exec(`chromium --incognito "${url}"`, (err2) => {
            if (err2) {
              exec(`firefox -private-window "${url}"`, (err3) => {
                if (err3) {
                  console.log('[Browser] Fallback to default browser')
                  shell.openExternal(url)
                }
              })
            }
          })
        }
      })
    }
  } catch (error) {
    console.error('[Browser] Error opening in private mode:', error)
    shell.openExternal(url)
  }
}

// ============ 瞬态网络错误自动重试 ============
/**
 * 网络层瞬态失败识别：连接超时 / DNS / TCP / TLS 握手失败（undici 统一报 "fetch failed"）。
 * 这类失败请求未到达服务端——对 token 轮换也无风险（connect 阶段失败时服务端不可能已轮换
 * 旧 refreshToken），重试安全。业务错误（HTTP 4xx/5xx、invalid_grant 等）不在此列，立即上抛。
 */
const TRANSIENT_NETWORK_ERROR =
  /fetch failed|etimedout|econnreset|econnrefused|ehostunreach|enetunreach|enotfound|socket hang up|aborted|tls handshake/i

function isTransientNetworkError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return TRANSIENT_NETWORK_ERROR.test(msg)
}

/** 网络类错误自动重试（默认重试 2 次，1s/2s 退避）；非网络错误不重试直接抛出 */
async function withNetworkRetry<T>(
  fn: () => Promise<T>,
  retries = 2,
  baseDelayMs = 1000
): Promise<T> {
  let lastErr: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (!isTransientNetworkError(err) || attempt === retries) break
      const delay = baseDelayMs * (attempt + 1)
      console.warn(
        `[NetworkRetry] 瞬态网络错误，${delay}ms 后重试 (${attempt + 1}/${retries}): ${err instanceof Error ? err.message : err}`
      )
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
  throw lastErr
}

// IdC (BuilderId) 的 OIDC Token 刷新
async function refreshOidcToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string,
  region: string = 'us-east-1',
  proxyUrl?: string // 账号绑定的代理 URL（可选，优先级最高）
): Promise<OidcRefreshResult> {
  console.log(
    `[OIDC] Refreshing token with clientId: ${clientId.substring(0, 20)}...${proxyUrl ? ' [via bound proxy]' : ''}`
  )

  const url = `https://oidc.${region}.amazonaws.com/token`

  const payload = {
    clientId,
    clientSecret,
    refreshToken,
    grantType: 'refresh_token'
  }

  try {
    const response = await withNetworkRetry(() =>
      fetchWithAppProxy(
        url,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload)
        },
        proxyUrl
      )
    )

    if (!response.ok) {
      const errorText = await response.text()
      console.error(`[OIDC] Refresh failed: ${response.status} - ${errorText}`)
      return { success: false, error: `HTTP ${response.status}: ${errorText}` }
    }

    const data = await response.json()
    console.log(`[OIDC] Token refreshed successfully, expires in ${data.expiresIn}s`)

    return {
      success: true,
      accessToken: data.accessToken,
      refreshToken: data.refreshToken || refreshToken, // 可能不返回新的 refreshToken
      expiresIn: data.expiresIn
    }
  } catch (error) {
    console.error(`[OIDC] Refresh error:`, error)
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}

// 判断错误文本是否为 token 失效（检查续费/切 Free 的过期兜底触发条件）
function isTokenExpiredError(error?: string): boolean {
  return /token|expired|expire|401|unauthorized|session/i.test(error || '')
}

// 用账号库里存的 refreshToken 刷新 accessToken（social 走 Kiro 刷新端点，BuilderId 走 OIDC）
// 供检查续费/切 Free 在 accessToken 过期时兜底；失败返回 null
async function refreshAccountAccessToken(
  accountId: string
): Promise<{ accessToken: string; refreshToken?: string; expiresIn?: number } | null> {
  try {
    const data = getAccountData() as { accounts?: Record<string, any> } | null
    const acc = data?.accounts?.[accountId]
    const cred = acc?.credentials
    if (!cred?.refreshToken) return null
    const isSocial = cred.authMethod === 'social' || ['Github', 'Google'].includes(cred.provider)
    const result = isSocial
      ? await refreshSocialToken(cred.refreshToken)
      : await refreshOidcToken(
          cred.refreshToken,
          cred.clientId || '',
          cred.clientSecret || '',
          cred.region || 'us-east-1'
        )
    if (!result.success || !result.accessToken) return null
    const refreshed = {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiresIn: result.expiresIn
    }
    // refreshToken 是轮换制：刷新成功即作废旧 token，必须立刻落库，
    // 否则后续调用若失败，新 refreshToken 丢失、账号将失去刷新能力
    try {
      const snapshot = JSON.parse(JSON.stringify(data)) as Record<string, unknown>
      const target = (
        snapshot.accounts as Record<string, { credentials?: Record<string, unknown> }> | undefined
      )?.[accountId]
      if (target?.credentials) {
        target.credentials = {
          ...target.credentials,
          ...refreshed,
          ...(refreshed.expiresIn ? { expiresAt: Date.now() + refreshed.expiresIn * 1000 } : {})
        }
        saveAccountData(snapshot)
      }
    } catch (persistErr) {
      console.warn('[StripePortal] 新凭据落库失败（仍会返回给渲染进程持久化）:', persistErr)
    }
    return refreshed
  } catch (err) {
    console.warn('[StripePortal] token 刷新兜底失败:', err)
    return null
  }
}

// 社交登录 (GitHub/Google) 的 Token 刷新
async function refreshSocialToken(
  refreshToken: string,
  proxyUrl?: string // 账号绑定的代理 URL（可选，优先级最高）
): Promise<OidcRefreshResult> {
  console.log(`[Social] Refreshing token...${proxyUrl ? ' [via bound proxy]' : ''}`)

  const url = `${KIRO_AUTH_ENDPOINT}/refreshToken`
  const machineId = getCurrentMachineId()

  try {
    const response = await withNetworkRetry(() =>
      fetchWithAppProxy(
        url,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': getKiroUserAgent(machineId)
          },
          body: JSON.stringify({ refreshToken })
        },
        proxyUrl
      )
    )

    if (!response.ok) {
      const errorText = await response.text()
      console.error(`[Social] Refresh failed: ${response.status} - ${errorText}`)
      return { success: false, error: `HTTP ${response.status}: ${errorText}` }
    }

    const data = await response.json()
    console.log(`[Social] Token refreshed successfully, expires in ${data.expiresIn}s`)

    return {
      success: true,
      accessToken: data.accessToken,
      refreshToken: data.refreshToken || refreshToken,
      expiresIn: data.expiresIn
    }
  } catch (error) {
    console.error(`[Social] Refresh error:`, error)
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}

// 通用 Token 刷新 - 根据 authMethod 选择刷新方式
async function refreshTokenByMethod(
  token: string,
  clientId: string,
  clientSecret: string,
  region: string = 'us-east-1',
  authMethod?: string,
  proxyUrl?: string // 账号绑定的代理 URL（可选，优先级最高）
): Promise<OidcRefreshResult> {
  // 如果是社交登录，使用 Kiro Auth Service 刷新
  if (authMethod === 'social') {
    return refreshSocialToken(token, proxyUrl)
  }
  // 否则使用 OIDC 刷新 (IdC/BuilderId)
  return refreshOidcToken(token, clientId, clientSecret, region, proxyUrl)
}

function generateInvocationId(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

// Kiro 版本和 User-Agent 生成
const KIRO_VERSION = '0.6.18'

function getKiroUserAgent(machineId?: string): string {
  const suffix = machineId ? `KiroIDE-${KIRO_VERSION}-${machineId}` : `KiroIDE-${KIRO_VERSION}`
  return `aws-sdk-js/1.0.18 ua/2.1 os/windows lang/js md/nodejs#20.16.0 api/codewhispererstreaming#1.0.18 m/E ${suffix}`
}

function getKiroAmzUserAgent(machineId?: string): string {
  const suffix = machineId ? `KiroIDE ${KIRO_VERSION} ${machineId}` : `KiroIDE-${KIRO_VERSION}`
  return `aws-sdk-js/1.0.18 ${suffix}`
}

function getCurrentMachineId(): string | undefined {
  const kproxyService = getKProxyService()
  if (!kproxyService) return undefined
  return kproxyService.getDeviceId()
}

async function kiroApiRequest<T>(
  operation: string,
  body: Record<string, unknown>,
  accessToken: string,
  idp: string = 'BuilderId', // 支持 BuilderId, Github, Google
  accountMachineId?: string, // 账户绑定的设备 ID
  email?: string // 用于日志标识
): Promise<T> {
  // 优先使用账户绑定的设备 ID，其次使用 K-Proxy 全局设备 ID
  const machineId = accountMachineId || getCurrentMachineId()
  const logTag = email || `token:${accessToken?.slice(-6) || '?'}`
  console.log(
    `[Kiro API] ${operation} [${logTag}] ${idp} machineId=${machineId?.slice(0, 8) || 'none'}`
  )
  const agent = getKProxyAgent()

  // 使用 undici fetch 支持代理
  const headers: Record<string, string> = {
    accept: 'application/cbor',
    'content-type': 'application/cbor',
    'smithy-protocol': 'rpc-v2-cbor',
    'amz-sdk-invocation-id': generateInvocationId(),
    'amz-sdk-request': 'attempt=1; max=1',
    'x-amz-user-agent': getKiroAmzUserAgent(machineId),
    authorization: `Bearer ${accessToken}`,
    cookie: `Idp=${idp}; AccessToken=${accessToken}`
  }

  let response: Response
  if (agent) {
    response = (await withNetworkRetry(() =>
      undiciFetch(`${KIRO_API_BASE}/${operation}`, {
        method: 'POST',
        headers,
        body: Buffer.from(encode(body)),
        dispatcher: agent
      } as UndiciRequestInit)
    )) as unknown as Response
  } else {
    response = await withNetworkRetry(() =>
      fetchWithAppProxy(`${KIRO_API_BASE}/${operation}`, {
        method: 'POST',
        headers,
        body: Buffer.from(encode(body))
      })
    )
  }

  if (!response.ok) {
    // 尝试解析 CBOR 格式的错误响应
    let errorMessage = `HTTP ${response.status}`
    const errorBuffer = await response.arrayBuffer()
    try {
      const errorData = decode(Buffer.from(errorBuffer)) as { __type?: string; message?: string }
      if (errorData.__type && errorData.message) {
        // 提取错误类型名称（去掉命名空间）
        const errorType = errorData.__type.split('#').pop() || errorData.__type
        // 在错误消息中包含 HTTP 状态码，便于封禁检测
        errorMessage = `HTTP ${response.status}: ${errorType}: ${errorData.message}`
      } else if (errorData.message) {
        errorMessage = `HTTP ${response.status}: ${errorData.message}`
      }
      console.error(`[Kiro API] Error:`, errorData)
    } catch {
      // 如果 CBOR 解析失败，显示原始内容
      const errorText = Buffer.from(errorBuffer).toString('utf-8')
      console.error(`[Kiro API] Error (raw): ${errorText}`)
    }
    throw new Error(errorMessage)
  }

  const arrayBuffer = await response.arrayBuffer()
  const result = decode(Buffer.from(arrayBuffer)) as T
  // 精简响应日志：只打一行摘要。批量刷新时逐账号全量打印响应对象会显著放大日志开销
  const r = result as Record<string, unknown>
  const resSummary = r.email ? `${r.email} [${r.status || 'ok'}]` : `${response.status}`
  console.log(`[Kiro API] ${operation} [${logTag}] → ${resSummary}`)
  return result
}

// ============ GetUsageLimits REST API (官方格式) ============
interface UsageLimitsResponse {
  // REST API 实际返回 usageBreakdownList（不是 usageBreakdowns）
  usageBreakdownList?: Array<{
    type?: string
    resourceType?: string
    displayName?: string
    displayNamePlural?: string
    currentUsage?: number
    currentUsageWithPrecision?: number
    usageLimit?: number
    usageLimitWithPrecision?: number
    currency?: string
    unit?: string
    overageRate?: number
    overageCap?: number
    overageCharges?: number
    currentOverages?: number
    freeTrialUsage?: {
      currentUsage?: number
      currentUsageWithPrecision?: number
      usageLimit?: number
      usageLimitWithPrecision?: number
      freeTrialStatus?: string
      freeTrialExpiry?: string
    }
    // REST API 直接返回 freeTrialInfo（与 freeTrialUsage 结构相同）
    freeTrialInfo?: {
      currentUsage?: number
      currentUsageWithPrecision?: number
      usageLimit?: number
      usageLimitWithPrecision?: number
      freeTrialStatus?: string
      freeTrialExpiry?: number | string
    }
    bonuses?: Array<{
      bonusCode?: string
      displayName?: string
      description?: string
      usageLimit?: number
      usageLimitWithPrecision?: number
      currentUsage?: number
      currentUsageWithPrecision?: number
      expiresAt?: number | string // REST API 返回数字时间戳
      redeemedAt?: number | string
      status?: string
    }>
  }>
  nextDateReset?: number | string // Unix 时间戳（秒）或 ISO 字符串
  subscriptionInfo?: {
    subscriptionName?: string
    subscriptionTitle?: string
    subscriptionType?: string
    status?: string
    subscriptionManagementTarget?: string
    upgradeCapability?: string
    overageCapability?: string
  }
  overageSettings?: {
    overageStatus?: string
  }
  overageConfiguration?: {
    overageEnabled?: boolean
    overageStatus?: string
  }
  userInfo?: {
    email?: string
    userId?: string
  }
}

// 辅助函数：将 Unix 时间戳（秒）或 ISO 字符串转换为 ISO 字符串
function normalizeResetDate(value: number | string | undefined): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'number') {
    // Unix 时间戳（秒），转换为毫秒后创建 Date
    return new Date(value * 1000).toISOString()
  }
  return value
}

async function fetchRestApi(
  baseUrl: string,
  path: string,
  accessToken: string,
  machineId?: string
): Promise<Response> {
  const agent = getKProxyAgent()
  const headers: Record<string, string> = {
    Accept: 'application/json',
    Authorization: `Bearer ${accessToken}`,
    'User-Agent': getKiroUserAgent(machineId),
    'x-amz-user-agent': getKiroAmzUserAgent(machineId)
  }
  const url = `${baseUrl}${path}`
  if (agent) {
    return (await withNetworkRetry(() =>
      undiciFetch(url, {
        method: 'GET',
        headers,
        dispatcher: agent
      } as UndiciRequestInit)
    )) as unknown as Response
  }
  return await withNetworkRetry(() => fetchWithAppProxy(url, { method: 'GET', headers }))
}

async function getUsageLimitsRest(
  accessToken: string,
  profileArn?: string,
  accountMachineId?: string, // 账户绑定的设备 ID
  ssoRegion?: string, // SSO 区域，用于选择正确的 REST API 端点
  email?: string // 用于日志标识
): Promise<UsageLimitsResponse> {
  // 优先使用账户绑定的设备 ID，其次使用 K-Proxy 全局设备 ID
  const machineId = accountMachineId || getCurrentMachineId()
  const logTag = email || `token:${accessToken?.slice(-6) || '?'}`
  console.log(`[Kiro REST API] GetUsageLimits [${logTag}] region=${ssoRegion || 'default'}`)

  const params = new URLSearchParams({
    origin: 'AI_EDITOR',
    resourceType: 'AGENTIC_REQUEST',
    isEmailRequired: 'true'
  })
  if (profileArn) {
    params.set('profileArn', profileArn)
  }
  const path = `/getUsageLimits?${params.toString()}`

  // 根据 SSO 区域选择主端点
  const primaryBase = getRestApiBase(ssoRegion)
  const fallbackBase = getFallbackRestApiBase(ssoRegion)

  let response = await fetchRestApi(primaryBase, path, accessToken, machineId)

  // 如果主端点返回 403，尝试备用端点
  if (response.status === 403) {
    console.log(`[Kiro REST API] Primary 403, fallback → ${fallbackBase}`)
    response = await fetchRestApi(fallbackBase, path, accessToken, machineId)
  }

  if (!response.ok) {
    const errorText = await response.text()
    console.error(`[Kiro REST API] GetUsageLimits failed: ${response.status}`, errorText)
    throw new Error(`HTTP ${response.status}: ${errorText}`)
  }

  const result = await response.json()
  console.log(`[Kiro REST API] GetUsageLimits [${logTag}] → ${response.status}`, result)
  return result
}

// 统一的用量查询接口 - 根据配置选择 API 类型
interface UnifiedUsageResponse {
  usageBreakdownList?: Array<{
    resourceType?: string
    displayName?: string
    displayNamePlural?: string
    currentUsage?: number
    currentUsageWithPrecision?: number
    usageLimit?: number
    usageLimitWithPrecision?: number
    currency?: string
    unit?: string
    overageRate?: number
    overageCap?: number
    type?: string
    freeTrialInfo?: {
      freeTrialStatus?: string
      usageLimit?: number
      usageLimitWithPrecision?: number
      currentUsage?: number
      currentUsageWithPrecision?: number
      freeTrialExpiry?: string
    }
    bonuses?: Array<{
      bonusCode?: string
      displayName?: string
      usageLimit?: number
      usageLimitWithPrecision?: number
      currentUsage?: number
      currentUsageWithPrecision?: number
      expiresAt?: string
      status?: string
    }>
  }>
  nextDateReset?: string
  subscriptionInfo?: {
    subscriptionName?: string
    subscriptionTitle?: string
    subscriptionType?: string
    status?: string
    type?: string
    subscriptionManagementTarget?: string
    upgradeCapability?: string
    overageCapability?: string
  }
  overageConfiguration?: {
    overageEnabled?: boolean
    overageStatus?: string
  }
  userInfo?: {
    email?: string
    userId?: string
  }
}

async function getUsageAndLimits(
  accessToken: string,
  idp: string = 'BuilderId',
  profileArn?: string,
  accountMachineId?: string, // 账户绑定的设备 ID
  ssoRegion?: string, // SSO 区域，用于选择正确的 REST API 端点
  email?: string // 用于日志标识
): Promise<UnifiedUsageResponse> {
  if (currentUsageApiType === 'rest') {
    // 使用 REST API (GetUsageLimits)
    const result = await getUsageLimitsRest(
      accessToken,
      profileArn,
      accountMachineId,
      ssoRegion,
      email
    )
    // REST API 返回的字段名和 CBOR API 相同，直接返回
    return {
      usageBreakdownList: result.usageBreakdownList?.map((b) => ({
        resourceType: b.resourceType || b.type,
        displayName: b.displayName,
        displayNamePlural: b.displayNamePlural,
        currentUsage: b.currentUsage,
        currentUsageWithPrecision: b.currentUsageWithPrecision,
        usageLimit: b.usageLimit,
        usageLimitWithPrecision: b.usageLimitWithPrecision,
        currency: b.currency,
        unit: b.unit,
        overageRate: b.overageRate,
        overageCap: b.overageCap,
        type: b.type,
        // REST API 直接返回 freeTrialInfo，CBOR API 返回 freeTrialUsage
        freeTrialInfo: b.freeTrialInfo
          ? {
              freeTrialStatus: b.freeTrialInfo.freeTrialStatus,
              usageLimit: b.freeTrialInfo.usageLimit,
              usageLimitWithPrecision: b.freeTrialInfo.usageLimitWithPrecision,
              currentUsage: b.freeTrialInfo.currentUsage,
              currentUsageWithPrecision: b.freeTrialInfo.currentUsageWithPrecision,
              // REST API 返回数字时间戳，需要转换为 ISO 字符串
              freeTrialExpiry:
                typeof b.freeTrialInfo.freeTrialExpiry === 'number'
                  ? new Date(b.freeTrialInfo.freeTrialExpiry * 1000).toISOString()
                  : b.freeTrialInfo.freeTrialExpiry
            }
          : b.freeTrialUsage
            ? {
                freeTrialStatus: b.freeTrialUsage.freeTrialStatus,
                usageLimit: b.freeTrialUsage.usageLimit,
                usageLimitWithPrecision: b.freeTrialUsage.usageLimitWithPrecision,
                currentUsage: b.freeTrialUsage.currentUsage,
                currentUsageWithPrecision: b.freeTrialUsage.currentUsageWithPrecision,
                freeTrialExpiry: b.freeTrialUsage.freeTrialExpiry
              }
            : undefined,
        // 转换 bonuses 中的时间戳为 ISO 字符串
        bonuses: b.bonuses?.map((bonus) => ({
          ...bonus,
          expiresAt:
            typeof bonus.expiresAt === 'number'
              ? new Date(bonus.expiresAt * 1000).toISOString()
              : bonus.expiresAt
        }))
      })),
      // REST API 返回的 nextDateReset 是 Unix 时间戳（秒），需要转换为 ISO 字符串
      nextDateReset: normalizeResetDate(result.nextDateReset),
      subscriptionInfo: result.subscriptionInfo,
      overageConfiguration: result.overageConfiguration,
      userInfo: result.userInfo
    }
  } else {
    // 使用 CBOR API (GetUserUsageAndLimits)
    // CBOR API (app.kiro.dev) 是网页端门户，仅支持 BuilderId 认证
    // Enterprise/IdC 账号可能返回 401，需要 fallback 到 REST API
    try {
      return await kiroApiRequest<UnifiedUsageResponse>(
        'GetUserUsageAndLimits',
        { isEmailRequired: true, origin: 'KIRO_IDE' },
        accessToken,
        idp,
        accountMachineId,
        email
      )
    } catch (cborError) {
      const errorMsg = cborError instanceof Error ? cborError.message : ''
      // CBOR 401/403 时自动 fallback 到 REST API
      if (errorMsg.includes('401') || errorMsg.includes('403')) {
        console.log(`[API] CBOR API failed (${errorMsg}), falling back to REST API...`)
        const result = await getUsageLimitsRest(
          accessToken,
          profileArn,
          accountMachineId,
          ssoRegion,
          email
        )
        return {
          usageBreakdownList: result.usageBreakdownList?.map((b) => ({
            resourceType: b.resourceType || b.type,
            displayName: b.displayName,
            displayNamePlural: b.displayNamePlural,
            currentUsage: b.currentUsage,
            currentUsageWithPrecision: b.currentUsageWithPrecision,
            usageLimit: b.usageLimit,
            usageLimitWithPrecision: b.usageLimitWithPrecision,
            currency: b.currency,
            unit: b.unit,
            overageRate: b.overageRate,
            overageCap: b.overageCap,
            type: b.type,
            freeTrialInfo: b.freeTrialInfo
              ? {
                  freeTrialStatus: b.freeTrialInfo.freeTrialStatus,
                  usageLimit: b.freeTrialInfo.usageLimit,
                  usageLimitWithPrecision: b.freeTrialInfo.usageLimitWithPrecision,
                  currentUsage: b.freeTrialInfo.currentUsage,
                  currentUsageWithPrecision: b.freeTrialInfo.currentUsageWithPrecision,
                  freeTrialExpiry:
                    typeof b.freeTrialInfo.freeTrialExpiry === 'number'
                      ? new Date(b.freeTrialInfo.freeTrialExpiry * 1000).toISOString()
                      : b.freeTrialInfo.freeTrialExpiry
                }
              : b.freeTrialUsage
                ? {
                    freeTrialStatus: b.freeTrialUsage.freeTrialStatus,
                    usageLimit: b.freeTrialUsage.usageLimit,
                    usageLimitWithPrecision: b.freeTrialUsage.usageLimitWithPrecision,
                    currentUsage: b.freeTrialUsage.currentUsage,
                    currentUsageWithPrecision: b.freeTrialUsage.currentUsageWithPrecision,
                    freeTrialExpiry: b.freeTrialUsage.freeTrialExpiry
                  }
                : undefined,
            bonuses: b.bonuses?.map((bonus) => ({
              ...bonus,
              expiresAt:
                typeof bonus.expiresAt === 'number'
                  ? new Date(bonus.expiresAt * 1000).toISOString()
                  : bonus.expiresAt
            }))
          })),
          nextDateReset: normalizeResetDate(result.nextDateReset as unknown as number | string),
          subscriptionInfo: result.subscriptionInfo,
          overageConfiguration: result.overageConfiguration,
          userInfo: result.userInfo
        }
      }
      throw cborError
    }
  }
}

// GetUserInfo API - 只需要 accessToken 即可调用
interface UserInfoResponse {
  email?: string
  userId?: string
  idp?: string
  status?: string
  featureFlags?: string[]
}

async function getUserInfo(
  accessToken: string,
  idp: string = 'BuilderId',
  accountMachineId?: string,
  email?: string
): Promise<UserInfoResponse> {
  return kiroApiRequest<UserInfoResponse>(
    'GetUserInfo',
    { origin: 'KIRO_IDE' },
    accessToken,
    idp,
    accountMachineId,
    email
  )
}

// 定义自定义协议
const PROTOCOL_PREFIX = 'kiro'

// electron-store 实例（延迟初始化）
let store: {
  get: (key: string, defaultValue?: unknown) => unknown
  set: (key: string, value: unknown) => void
  path: string
} | null = null

// 最后保存的数据（用于崩溃恢复）
let lastSavedData: unknown = null

async function initStore(): Promise<void> {
  if (store) return
  const Store = (await import('electron-store')).default
  const path = await import('path')

  const storeInstance = new Store({
    name: 'kiro-accounts',
    encryptionKey: 'kiro-account-manager-secret-key'
  })

  store = storeInstance as unknown as typeof store

  // 尝试从备份恢复数据（如果主数据损坏）。备份优先读加密 .enc，兼容旧明文 .json
  let legacyForDb: unknown = null
  try {
    const mainData = storeInstance.get('accountData')

    if (!mainData) {
      try {
        const { readSecureBackup } = await import('./secureBackup')
        const backupData = (await readSecureBackup(path.dirname(storeInstance.path))) as {
          accounts?: unknown
        } | null
        if (backupData && backupData.accounts) {
          console.log('[Store] Restoring data from backup...')
          storeInstance.set('accountData', backupData)
          legacyForDb = backupData
          console.log('[Store] Data restored from backup successfully')
        }
      } catch {
        // 备份也不存在，忽略
      }
    } else {
      legacyForDb = mainData
    }
  } catch (error) {
    console.error('[Store] Error checking backup:', error)
  }

  // 初始化 SQLite 账号库：首次运行自动把旧 JSON accountData 迁入（旧 JSON 保留作回退保险）
  try {
    const { app } = await import('electron')
    const { initAccountDb } = await import('./accountDb')
    initAccountDb(app.getPath('userData'), legacyForDb)
  } catch (error) {
    console.error('[AccountDb] init failed:', error)
  }
}

// ============ 备份节流配置 ============
// 备份是为容灾兜底，不需要每次保存都全量重写文件，按时间节流即可大幅降低磁盘 IO。
const BACKUP_THROTTLE_MS = 5 * 60 * 1000 // 5 分钟最多写一次备份
let lastBackupTime = 0
let pendingBackupData: unknown = null
let pendingBackupTimer: ReturnType<typeof setTimeout> | null = null

/**
 * 创建数据备份（节流）
 * - 距上次备份不足 BACKUP_THROTTLE_MS 时，仅记录数据指针，不立即写盘
 * - 节流窗口结束后，自动 flush 最新一份数据
 * - 退出前可手动调用 flushBackupNow() 强制写盘
 */
async function createBackup(data: unknown): Promise<void> {
  pendingBackupData = data
  const now = Date.now()
  const elapsed = now - lastBackupTime

  if (elapsed >= BACKUP_THROTTLE_MS) {
    // 节流窗口已过，立即写盘
    await writeBackupNow()
    return
  }

  // 在节流窗口内：调度一次延迟 flush（如果尚未调度）
  if (!pendingBackupTimer) {
    const delay = BACKUP_THROTTLE_MS - elapsed
    pendingBackupTimer = setTimeout(() => {
      pendingBackupTimer = null
      void writeBackupNow()
    }, delay)
  }
}

/**
 * 真正执行备份写盘。仅当 pendingBackupData 非空时写入。
 */
async function writeBackupNow(): Promise<void> {
  if (!store || pendingBackupData == null) return
  const data = pendingBackupData
  pendingBackupData = null
  lastBackupTime = Date.now()
  try {
    const path = await import('path')
    const { writeSecureBackup, isSecureBackupAvailable } = await import('./secureBackup')
    await writeSecureBackup(path.dirname(store.path), data)
    console.log(
      `[Backup] Data backup created (${isSecureBackupAvailable() ? 'encrypted' : 'plaintext-fallback'})`
    )
  } catch (error) {
    console.error('[Backup] Failed to create backup:', error)
  }
}

/**
 * 强制 flush 待写的备份（用于退出前兜底）
 */
async function flushBackupNow(): Promise<void> {
  if (pendingBackupTimer) {
    clearTimeout(pendingBackupTimer)
    pendingBackupTimer = null
  }
  if (pendingBackupData != null) {
    await writeBackupNow()
  }
}

// ============ 闲置账号库：容灾备份（与主库备份物理分开的独立文件） ============
// 机制与主库 createBackup 完全一致（5 分钟节流 + 延迟 flush），仅状态互相独立，
// 备份文件为 kiro-idle-accounts.backup.enc（safeStorage 加密）。

const IDLE_BACKUP_FILE_BASE = 'kiro-idle-accounts'
let lastIdleBackupTime = 0
let pendingIdleBackupData: unknown = null
let pendingIdleBackupTimer: ReturnType<typeof setTimeout> | null = null
/** 最近一次保存的闲置库数据（退出前兜底保存/备份用） */
let lastSavedIdleData: unknown = null

async function createIdleBackup(data: unknown): Promise<void> {
  pendingIdleBackupData = data
  const now = Date.now()
  const elapsed = now - lastIdleBackupTime

  if (elapsed >= BACKUP_THROTTLE_MS) {
    await writeIdleBackupNow()
    return
  }

  if (!pendingIdleBackupTimer) {
    const delay = BACKUP_THROTTLE_MS - elapsed
    pendingIdleBackupTimer = setTimeout(() => {
      pendingIdleBackupTimer = null
      void writeIdleBackupNow()
    }, delay)
  }
}

async function writeIdleBackupNow(): Promise<void> {
  if (pendingIdleBackupData == null) return
  const data = pendingIdleBackupData
  pendingIdleBackupData = null
  lastIdleBackupTime = Date.now()
  try {
    const { app } = await import('electron')
    const { writeSecureBackup, isSecureBackupAvailable } = await import('./secureBackup')
    await writeSecureBackup(app.getPath('userData'), data, IDLE_BACKUP_FILE_BASE)
    console.log(
      `[IdleBackup] Data backup created (${isSecureBackupAvailable() ? 'encrypted' : 'plaintext-fallback'})`
    )
  } catch (error) {
    console.error('[IdleBackup] Failed to create backup:', error)
  }
}

async function flushIdleBackupNow(): Promise<void> {
  if (pendingIdleBackupTimer) {
    clearTimeout(pendingIdleBackupTimer)
    pendingIdleBackupTimer = null
  }
  if (pendingIdleBackupData != null) {
    await writeIdleBackupNow()
  }
}

/**
 * 初始化闲置账号库（懒加载，首次读写前调用）。
 * 容灾恢复：库为空但存在独立备份时，从备份恢复（镜像主库 initStore 的恢复机制）。
 */
async function initIdleStore(): Promise<void> {
  const { app } = await import('electron')
  const idleDb = initIdleAccountDb(app.getPath('userData'))
  if (!idleDb.hasAccounts()) {
    try {
      const { readSecureBackup } = await import('./secureBackup')
      const backupData = (await readSecureBackup(
        app.getPath('userData'),
        IDLE_BACKUP_FILE_BASE
      )) as { accounts?: unknown } | null
      if (backupData && backupData.accounts) {
        console.log('[IdleStore] Restoring idle accounts from backup...')
        idleDb.migrateFrom(backupData)
        console.log('[IdleStore] Idle accounts restored from backup successfully')
      }
    } catch {
      // 备份不存在或损坏，空库起步
    }
  }
}

let mainWindow: BrowserWindow | null = null

// ============ 账号池 token 主动刷新（主进程调度，不依赖窗口存活）============
//
// 背景：原先只有渲染进程的 setInterval 调度池内 token 刷新，窗口最小化到托盘后会被
// Chromium 后台节流，导致 token 过期数分钟才刷新。这里把"调度"搬到主进程：主进程定时器
// 不受窗口可见性影响，到点读 store 里的账号、刷新即将过期的 token，结果经
// background-refresh-result 事件回流给渲染进程持久化（窗口隐藏但仍存活）。
// 渲染进程定时器保留（已关后台节流）做信息同步/自动换号；两边的 token 刷新由
// poolRefreshInFlightIds 去重，避免对同一 refreshToken 并发刷新把其中一个用作废。
type BackgroundRefreshAccount = {
  id: string
  idp?: string
  profileArn?: string
  needsTokenRefresh?: boolean
  machineId?: string
  credentials: {
    refreshToken: string
    clientId?: string
    clientSecret?: string
    region?: string
    authMethod?: string
    accessToken?: string
    provider?: string
    profileArn?: string
  }
}
/** background-batch-refresh 的核心实现（由 IPC 与主进程调度器共用）。在 whenReady 中赋值。 */
let backgroundBatchRefreshImpl:
  | ((
      accounts: BackgroundRefreshAccount[],
      concurrency?: number,
      syncInfo?: boolean
    ) => Promise<{
      success: boolean
      completed: number
      successCount: number
      failedCount: number
    }>)
  | null = null
/** 正在刷新中的账号 ID 去重集合，渲染进程与主进程调度器共享，防止同一 refreshToken 被并发刷新。 */
const poolRefreshInFlightIds = new Set<string>()
let mainPoolRefreshTimer: NodeJS.Timeout | null = null

/** 主进程侧的封禁/挂起判定，镜像渲染进程的 isBannedAccountError */
function isBannedAccountErrorMain(error?: string): boolean {
  if (!error) return false
  const e = error.toLowerCase()
  return (
    e.includes('accountsuspendedexception') ||
    e.includes('account suspended') ||
    e.includes('temporarily_suspended') ||
    e.includes('temporarily suspended') ||
    e.includes('已封禁') ||
    /\b423\b/.test(e)
  )
}

/** 刷新提前量：≥ 2× 检查间隔且不少于 10 分钟，确保 token 不会在两次 tick 之间过期。 */
function mainTokenRefreshLeadMs(intervalMin: number): number {
  return Math.max(intervalMin * 2 * 60 * 1000, 10 * 60 * 1000)
}

/** 读取 store 里的账号，刷新即将过期的池内 token（仅刷 token，信息同步仍由渲染进程负责）。 */
async function runMainPoolTokenRefreshTick(): Promise<void> {
  if (!backgroundBatchRefreshImpl) return
  try {
    if (!store) {
      await initStore()
    }
    if (!store) return
    const data = getAccountData() as
      | {
          accounts?: Record<
            string,
            {
              id?: string
              email?: string
              idp?: string
              profileArn?: string
              machineId?: string
              lastError?: string
              credentials?: {
                refreshToken?: string
                clientId?: string
                clientSecret?: string
                region?: string
                authMethod?: string
                accessToken?: string
                provider?: string
                profileArn?: string
                expiresAt?: number
              }
            }
          >
          autoRefreshEnabled?: boolean
          autoRefreshInterval?: number
          autoRefreshConcurrency?: number
        }
      | undefined
    if (!data?.accounts) return
    if (data.autoRefreshEnabled === false) return

    const intervalMin = Math.max(1, data.autoRefreshInterval ?? 5)
    const leadMs = mainTokenRefreshLeadMs(intervalMin)
    const concurrency = Math.max(1, Math.min(500, data.autoRefreshConcurrency ?? 100))
    const now = Date.now()

    const toRefresh: BackgroundRefreshAccount[] = []
    for (const [id, acc] of Object.entries(data.accounts)) {
      const creds = acc?.credentials
      if (!creds?.refreshToken) continue
      if (isBannedAccountErrorMain(acc.lastError)) continue
      const expiresAt = creds.expiresAt
      // 只刷"即将过期/已过期"的；没有 expiresAt 的跳过（无从判断）
      if (!expiresAt || expiresAt - now > leadMs) continue
      toRefresh.push({
        id,
        idp: acc.idp,
        profileArn: acc.profileArn,
        needsTokenRefresh: true,
        machineId: acc.machineId,
        credentials: {
          refreshToken: creds.refreshToken,
          clientId: creds.clientId,
          clientSecret: creds.clientSecret,
          region: creds.region,
          authMethod: creds.authMethod,
          accessToken: creds.accessToken,
          provider: creds.provider,
          profileArn: creds.profileArn
        }
      })
    }

    if (toRefresh.length === 0) {
      return
    }
    console.log(
      `[MainPoolRefresh] ${toRefresh.length} token(s) expiring within ${Math.round(leadMs / 60000)}min, refreshing...`
    )
    // syncInfo=false：仅刷 token；用量/订阅等信息同步由渲染进程定时器负责，避免主进程跑重活
    await backgroundBatchRefreshImpl(toRefresh, concurrency, false)
  } catch (err) {
    console.warn('[MainPoolRefresh] tick failed:', err instanceof Error ? err.message : err)
  }
}

/** 启动主进程池 token 刷新调度器（不依赖窗口可见/存活）。 */
function startMainPoolTokenRefresh(): void {
  stopMainPoolTokenRefresh()
  // 启动后稍等片刻先跑一次（让 store 与账号池就绪），之后每分钟检查一次；
  // 实际是否需要刷新由 runMainPoolTokenRefreshTick 内按 expiresAt + 提前量判定。
  setTimeout(() => {
    void runMainPoolTokenRefreshTick()
  }, 15_000)
  mainPoolRefreshTimer = setInterval(() => {
    void runMainPoolTokenRefreshTick()
  }, 60_000)
  console.log('[MainPoolRefresh] Scheduler started (main process, checks every 60s)')
}

function stopMainPoolTokenRefresh(): void {
  if (mainPoolRefreshTimer) {
    clearInterval(mainPoolRefreshTimer)
    mainPoolRefreshTimer = null
  }
}

// ============ 托盘相关变量 ============
let traySettings: TraySettings = { ...defaultTraySettings }
let isQuitting = false // 标记是否真正退出应用

// ============ 全局快捷键设置 ============
let showWindowShortcut = process.platform === 'darwin' ? 'Command+Shift+K' : 'Ctrl+Shift+K'

// 加载快捷键设置
async function loadShortcutSettings(): Promise<void> {
  try {
    await initStore()
    const saved = store?.get('showWindowShortcut') as string | undefined
    if (saved) {
      showWindowShortcut = saved
    }
  } catch (error) {
    console.error('[Shortcut] Failed to load shortcut settings:', error)
  }
}

// 保存快捷键设置
async function saveShortcutSettings(): Promise<void> {
  try {
    await initStore()
    store?.set('showWindowShortcut', showWindowShortcut)
  } catch (error) {
    console.error('[Shortcut] Failed to save shortcut settings:', error)
  }
}

// 注册显示主窗口的快捷键
function registerShowWindowShortcut(): void {
  // 先注销所有已注册的快捷键
  globalShortcut.unregisterAll()

  if (!showWindowShortcut) return

  try {
    const success = globalShortcut.register(showWindowShortcut, () => {
      if (mainWindow) {
        // macOS: 显示窗口时恢复 Dock 图标
        if (process.platform === 'darwin' && app.dock) {
          app.dock.show()
        }
        if (mainWindow.isMinimized()) mainWindow.restore()
        mainWindow.show()
        mainWindow.focus()
      }
    })
    if (success) {
      console.log(`[Shortcut] Registered: ${showWindowShortcut}`)
    } else {
      console.warn(`[Shortcut] Failed to register: ${showWindowShortcut}`)
    }
  } catch (error) {
    console.error('[Shortcut] Error registering shortcut:', error)
  }
}
let currentProxyAccount: {
  id: string
  email: string
  idp: string
  status: string
  subscription?: string
  usage?: {
    usedCredits: number
    totalCredits: number
    totalRequests: number
    successRequests: number
    failedRequests: number
  }
} | null = null
let allAccounts: { id: string; email: string; idp: string; status: string }[] = []

// 加载托盘设置
async function loadTraySettings(): Promise<void> {
  try {
    await initStore()
    const saved = store?.get('traySettings') as TraySettings | undefined
    if (saved) {
      traySettings = { ...defaultTraySettings, ...saved }
    }
  } catch (error) {
    console.error('[Tray] Failed to load tray settings:', error)
  }
}

// 保存托盘设置
async function saveTraySettings(): Promise<void> {
  try {
    await initStore()
    store?.set('traySettings', traySettings)
  } catch (error) {
    console.error('[Tray] Failed to save tray settings:', error)
  }
}

// 初始化托盘
function initTray(): void {
  if (!traySettings.enabled) return

  createTray({
    onShowWindow: () => {
      if (mainWindow) {
        // macOS: 显示窗口时恢复 Dock 图标
        if (process.platform === 'darwin' && app.dock) {
          app.dock.show()
        }
        if (mainWindow.isMinimized()) {
          mainWindow.restore()
        }
        mainWindow.show()
        mainWindow.focus()
      }
    },
    onQuit: () => {
      isQuitting = true
      app.quit()
    },
    onRefreshAccount: async () => {
      mainWindow?.webContents.send('tray-refresh-account')
    },
    onSwitchAccount: async () => {
      mainWindow?.webContents.send('tray-switch-account')
    },
    getCurrentAccount: () => currentProxyAccount,
    getAccountList: () => allAccounts
  })

  // 设置初始提示
  setTrayTooltip(`Kiro 账号管理器 v${app.getVersion()}`)
}

function createWindow(): void {
  // Create the browser window.
  const isMac = process.platform === 'darwin'
  mainWindow = new BrowserWindow({
    title: `Kiro 账号管理器 v${app.getVersion()}`,
    width: 1200, // 刚好容纳 3 列卡片 (340*3 + 16*2 + 边距)
    height: 1200,
    minWidth: 800,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    icon,
    // 自定义 titlebar：mac 保留红绿黄灯 + 隐藏标题栏；win/linux 完全无 frame
    frame: isMac,
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: isMac ? { x: 14, y: 12 } : undefined,
    // 不透明窗口（关闭透明 + Mica/Vibrancy 避免桌面元素干扰）
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // 关闭后台节流：最小化到托盘后窗口被隐藏，Chromium 默认会把渲染进程里的
      // setInterval（含 token 自动刷新定时器）重度降频（对齐到约每分钟甚至更慢），
      // 导致挂托盘时 token 过期好几分钟才刷新。关掉它保证定时器照常运行。
      backgroundThrottling: false
    }
  })

  // ============ 自定义 titlebar IPC ============
  mainWindow.on('maximize', () => mainWindow?.webContents.send('window-maximize-changed', true))
  mainWindow.on('unmaximize', () => mainWindow?.webContents.send('window-maximize-changed', false))

  mainWindow.on('ready-to-show', () => {
    // 设置带版本号的标题（HTML 加载后会覆盖初始标题）
    mainWindow?.setTitle(`Kiro 账号管理器 v${app.getVersion()}`)
    // 启动即最大化：在 show 之前调用，窗口直接以最大化出现，不闪小窗
    mainWindow?.maximize()
    mainWindow?.show()

    // K-Proxy MITM 自启动
    setTimeout(async () => {
      try {
        const savedKProxyConfig = store?.get('kproxyConfig') as KProxyConfig | undefined
        if (savedKProxyConfig?.autoStart) {
          console.log('[KProxy] Auto-starting K-Proxy MITM...')
          const service = initKProxyService(savedKProxyConfig, {
            onRequest: (info) => {
              mainWindow?.webContents.send('kproxy-request', info)
            },
            onResponse: (info) => {
              mainWindow?.webContents.send('kproxy-response', info)
            },
            onError: (error) => {
              console.error('[KProxy] Error:', error)
              mainWindow?.webContents.send('kproxy-error', error.message)
            },
            onStatusChange: (running, port) => {
              mainWindow?.webContents.send('kproxy-status-change', { running, port })
            },
            onMitmIntercept: (host, modified) => {
              mainWindow?.webContents.send('kproxy-mitm', { host, modified })
            }
          })
          await service.initialize()
          await service.start()
          console.log('[KProxy] Auto-started successfully')
        }
      } catch (error) {
        console.error('[KProxy] Auto-start failed:', error)
      }
    }, 1000)
  })

  mainWindow.on('close', (event) => {
    // 托盘最小化逻辑 - 必须同步检查并调用 preventDefault
    if (traySettings.enabled && !isQuitting) {
      if (traySettings.closeAction === 'minimize') {
        // 直接最小化到托盘
        event.preventDefault()
        mainWindow?.hide()
        // macOS: 隐藏窗口时隐藏 Dock 图标
        if (process.platform === 'darwin' && app.dock) {
          app.dock.hide()
        }
        return
      } else if (traySettings.closeAction === 'ask' && mainWindow) {
        // 询问用户 - 先阻止关闭，再异步处理
        event.preventDefault()
        // 通知渲染进程显示自定义对话框
        mainWindow.webContents.send('show-close-confirm-dialog')
        return
      }
      // closeAction === 'quit' 时继续关闭流程
    }

    // 窗口关闭前保存数据（同步保存，不等待备份）
    if (lastSavedData && store) {
      try {
        console.log('[Window] Saving data before close...')
        saveAccountData(lastSavedData as Record<string, unknown>)
        // 备份异步进行，不阻塞关闭
        createBackup(lastSavedData)
          .then(() => {
            console.log('[Window] Backup created')
          })
          .catch((err) => {
            console.error('[Window] Backup failed:', err)
          })
        console.log('[Window] Data saved successfully')
      } catch (error) {
        console.error('[Window] Failed to save data:', error)
      }
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// 注册自定义协议
function registerProtocol(): void {
  // 先注销旧的注册（防止上次异常退出未注销）
  unregisterProtocol()

  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(PROTOCOL_PREFIX, process.execPath, [join(process.argv[1])])
    }
  } else {
    app.setAsDefaultProtocolClient(PROTOCOL_PREFIX)
  }
  console.log(`[Protocol] Registered ${PROTOCOL_PREFIX}:// protocol`)
}

// 注销自定义协议 (应用退出时调用)
function unregisterProtocol(): void {
  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      app.removeAsDefaultProtocolClient(PROTOCOL_PREFIX, process.execPath, [join(process.argv[1])])
    }
  } else {
    app.removeAsDefaultProtocolClient(PROTOCOL_PREFIX)
  }
  console.log(`[Protocol] Unregistered ${PROTOCOL_PREFIX}:// protocol`)
}

// 处理协议 URL (用于 OAuth 回调)
function handleProtocolUrl(url: string): void {
  if (!url.startsWith(`${PROTOCOL_PREFIX}://`)) return

  try {
    const urlObj = new URL(url)
    const pathname = urlObj.pathname.replace(/^\/+/, '')

    // 处理 auth 回调
    if (pathname === 'auth/callback' || urlObj.host === 'auth') {
      const code = urlObj.searchParams.get('code')
      const state = urlObj.searchParams.get('state')

      if (code && state && mainWindow) {
        mainWindow.webContents.send('auth-callback', { code, state })
        mainWindow.focus()
      }
    }
  } catch (error) {
    console.error('Failed to parse protocol URL:', error)
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(async () => {
  // 初始化日志系统（尽早拦截，确保所有 console 输出都进入日志存储）
  proxyLogStore.initialize(app.getPath('userData'))
  interceptConsole()

  // 注册自定义协议
  registerProtocol()

  // 加载托盘设置并初始化托盘
  await loadTraySettings()
  initTray()

  // 初始化自动更新（仅生产环境）
  if (!is.dev) {
    // mac：清理自研更新器遗留的替换备份
    if (process.platform === 'darwin') cleanupMacUpdateBackups()
    setupAutoUpdater()
    // 启动后延迟检查更新（mac 不走 electron-updater 自动检查——
    // 无签名时 Squirrel.Mac 安装必败；检查/下载/安装全部改走 macSelfUpdater）
    if (process.platform !== 'darwin') {
      setTimeout(() => {
        autoUpdater.checkForUpdates().catch(console.error)
      }, 3000)
    }
  }

  // Set app user model id for windows
  electronApp.setAppUserModelId('com.kiro.account-manager')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // IPC: 打开外部链接
  ipcMain.on('open-external', (_event, url: string, usePrivateMode?: boolean) => {
    if (typeof url === 'string' && (url.startsWith('http://') || url.startsWith('https://'))) {
      if (usePrivateMode) {
        openBrowserInPrivateMode(url)
      } else {
        shell.openExternal(url)
      }
    }
  })

  // ============ 注册功能 IPC ============
  registerRegistrationHandlers(() => mainWindow)
  registerProxyPoolIpcHandlers()

  // ============ 号池（GitHub 账密+2FA 批量激活 Kiro）============
  registerLoginPoolIpc({
    userDataDir: app.getPath('userData'),
    getMainWindow: () => mainWindow,
    deps: {
      buildGithubLoginUrl: () => {
        const codeVerifier = randomBytes(64).toString('base64url').substring(0, 128)
        const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url')
        const oauthState = randomBytes(32).toString('base64url')
        const loginUrl = new URL(`${KIRO_AUTH_ENDPOINT}/login`)
        loginUrl.searchParams.set('idp', 'Github')
        loginUrl.searchParams.set('redirect_uri', 'kiro://kiro.kiroAgent/authenticate-success')
        loginUrl.searchParams.set('code_challenge', codeChallenge)
        loginUrl.searchParams.set('code_challenge_method', 'S256')
        loginUrl.searchParams.set('state', oauthState)
        return { url: loginUrl.toString(), codeVerifier, oauthState }
      },
      exchangeSocialToken: async (code, codeVerifier) => {
        const MAX_ATTEMPTS = 3
        for (let attempt = 1; ; attempt++) {
          try {
            const tokenRes = await fetchWithAppProxy(`${KIRO_AUTH_ENDPOINT}/oauth/token`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                code,
                code_verifier: codeVerifier,
                redirect_uri: 'kiro://kiro.kiroAgent/authenticate-success'
              })
            })
            if (!tokenRes.ok) {
              const errText = await tokenRes.text()
              console.error('[LoginPool] Token exchange failed:', tokenRes.status, errText)
              return { success: false, error: `HTTP ${tokenRes.status}: ${errText}` }
            }
            const tokenData = (await tokenRes.json()) as {
              accessToken: string
              refreshToken: string
              profileArn?: string
              expiresIn?: number
            }
            return {
              success: true,
              accessToken: tokenData.accessToken,
              refreshToken: tokenData.refreshToken,
              profileArn: tokenData.profileArn,
              expiresIn: tokenData.expiresIn
            }
          } catch (error) {
            const detail = describeFetchError(error)
            if (attempt >= MAX_ATTEMPTS) {
              return {
                success: false,
                error: `token 交换失败（已重试 ${MAX_ATTEMPTS} 次）：${detail}`
              }
            }
            console.warn(
              `[LoginPool] Token exchange network error (attempt ${attempt}/${MAX_ATTEMPTS}), retry in 1s: ${detail}`
            )
            await new Promise((r) => setTimeout(r, 1000))
          }
        }
      }
    }
  })

  // ============ 托盘相关 IPC ============

  // IPC: 获取托盘设置
  ipcMain.handle('get-tray-settings', () => {
    return traySettings
  })

  // ============ 自定义 titlebar IPC ============
  ipcMain.on('window-minimize', () => mainWindow?.minimize())
  ipcMain.on('window-maximize-toggle', () => {
    if (!mainWindow) return
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
  })
  ipcMain.on('window-close', () => mainWindow?.close())
  ipcMain.handle('window-is-maximized', () => !!mainWindow?.isMaximized())
  ipcMain.handle('window-get-platform', () => process.platform)

  // IPC: 获取显示主窗口快捷键
  ipcMain.handle('get-show-window-shortcut', () => {
    return showWindowShortcut
  })

  // IPC: 设置显示主窗口快捷键
  ipcMain.handle('set-show-window-shortcut', async (_event, shortcut: string) => {
    try {
      showWindowShortcut = shortcut
      await saveShortcutSettings()
      registerShowWindowShortcut()
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  // IPC: 保存托盘设置
  ipcMain.handle('save-tray-settings', async (_event, settings: Partial<TraySettings>) => {
    try {
      traySettings = { ...traySettings, ...settings }
      await saveTraySettings()

      // 根据设置启用/禁用托盘
      if (settings.enabled !== undefined) {
        if (settings.enabled) {
          initTray()
        } else {
          destroyTray()
        }
      }

      return { success: true }
    } catch (error) {
      console.error('[Tray] Failed to save settings:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })

  // IPC: 更新托盘账户信息（从渲染进程调用）
  ipcMain.on('update-tray-account', (_event, account: typeof currentProxyAccount) => {
    currentProxyAccount = account
    updateCurrentAccount(account)

    // 更新托盘提示
    if (account) {
      setTrayTooltip(`Kiro 账号管理器\n当前账户: ${account.email}`)
    } else {
      setTrayTooltip(`Kiro 账号管理器 v${app.getVersion()}`)
    }
  })

  // IPC: 更新托盘账户列表（从渲染进程调用）
  ipcMain.on('update-tray-account-list', (_event, accounts: typeof allAccounts) => {
    allAccounts = accounts
    updateAccountList(accounts)
  })

  // IPC: 刷新托盘菜单
  ipcMain.on('refresh-tray-menu', () => {
    updateTrayMenu()
  })

  // IPC: 更新托盘语言
  ipcMain.on('update-tray-language', (_event, language: 'en' | 'zh') => {
    updateTrayLanguage(language)
  })

  // IPC: 关闭确认对话框响应
  ipcMain.on(
    'close-confirm-response',
    (_event, action: 'minimize' | 'quit' | 'cancel', rememberChoice: boolean) => {
      if (action === 'minimize') {
        mainWindow?.hide()
        // macOS: 隐藏窗口时隐藏 Dock 图标
        if (process.platform === 'darwin' && app.dock) {
          app.dock.hide()
        }
      } else if (action === 'quit') {
        // 如果用户选择记住选择
        if (rememberChoice) {
          traySettings.closeAction = 'quit'
          saveTraySettings()
        }
        isQuitting = true
        app.quit()
      }
      // cancel 时不做任何操作

      // 如果用户选择记住"最小化"选择
      if (action === 'minimize' && rememberChoice) {
        traySettings.closeAction = 'minimize'
        saveTraySettings()
      }
    }
  )

  // IPC: 获取应用版本
  ipcMain.handle('get-app-version', () => {
    return app.getVersion()
  })

  // IPC: 检查更新
  ipcMain.handle('check-for-updates', async () => {
    if (is.dev) {
      return { hasUpdate: false, message: '开发环境不支持更新检查' }
    }
    // mac：无签名证书，electron-updater(Squirrel.Mac) 安装必败，走自研更新器
    if (process.platform === 'darwin') {
      const r = await checkMacUpdate()
      return r.hasUpdate
        ? { hasUpdate: true, version: r.version }
        : { hasUpdate: false, version: r.version, error: r.error }
    }
    try {
      const result = await autoUpdater.checkForUpdates()
      return {
        hasUpdate: !!result?.updateInfo,
        version: result?.updateInfo?.version,
        releaseDate: result?.updateInfo?.releaseDate
      }
    } catch (error) {
      console.error('[AutoUpdater] Check failed:', error)
      return { hasUpdate: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })

  // IPC: 下载更新
  ipcMain.handle('download-update', async () => {
    if (is.dev) {
      return { success: false, message: '开发环境不支持更新' }
    }
    // mac：自研下载（进度通过既有 update-download-progress 事件上报）
    if (process.platform === 'darwin') {
      const r = await downloadMacUpdate((percent, transferred, total) => {
        mainWindow?.webContents.send('update-download-progress', {
          percent,
          bytesPerSecond: 0,
          transferred,
          total
        })
      })
      if (r.success) {
        // 通知 UI 进入"已下载，可重启"状态（复用既有事件）
        mainWindow?.webContents.send('update-downloaded', { version: r.version })
      } else {
        mainWindow?.webContents.send('update-error', r.error ?? 'download failed')
      }
      return r
    }
    try {
      await autoUpdater.downloadUpdate()
      return { success: true }
    } catch (error) {
      console.error('[AutoUpdater] Download failed:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })

  // IPC: 安装更新并重启
  ipcMain.handle('install-update', (): { success: boolean; error?: string } => {
    // mac：自研替换 + relaunch
    if (process.platform === 'darwin') {
      const r = installMacUpdate()
      if (!r.success) mainWindow?.webContents.send('update-error', r.error ?? 'install failed')
      return r
    }
    autoUpdater.quitAndInstall(false, true)
    return { success: true }
  })

  // IPC: 手动检查更新（走 GitHub 静态下载地址，不消耗 api.github.com 匿名配额——
  // 匿名限额 60 次/小时且按 IP 计，办公网共享出口下极易打满，更新检查一律绕开 API）
  const GITHUB_REPO = 'fanxuankai/Kiro-account-manager'
  const RELEASE_DOWNLOAD_BASE = `https://github.com/${GITHUB_REPO}/releases/latest/download`

  /** 解析 electron-builder 的 latest*.yml：version + files（url/sha512/size） */
  function parseLatestYml(text: string): {
    version: string
    files: Array<{ name: string; sha512: string; size: number }>
  } {
    const version = /^version:\s*(\S+)/m.exec(text)?.[1] ?? ''
    const files: Array<{ name: string; sha512: string; size: number }> = []
    for (const block of text.split(/^- /m).slice(1)) {
      const name = /^url:\s*(\S+)/m.exec(block)?.[1] ?? ''
      const sha512 = /sha512:\s*(\S+)/.exec(block)?.[1] ?? ''
      const size = Number(/size:\s*(\d+)/.exec(block)?.[1] ?? 0) || 0
      if (name && sha512) files.push({ name, sha512, size })
    }
    return { version, files }
  }

  ipcMain.handle('check-for-updates-manual', async () => {
    try {
      console.log('[Update] Manual check via GitHub static download...')
      const currentVersion = app.getVersion()

      const ymlName = process.platform === 'darwin' ? 'latest-mac.yml' : 'latest.yml'
      const ymlRes = await fetchWithAppProxy(`${RELEASE_DOWNLOAD_BASE}/${ymlName}`, {
        headers: { 'User-Agent': 'Kiro-Account-Manager' }
      })
      if (!ymlRes.ok) {
        if (ymlRes.status === 404) throw new Error('未找到发布版本（更新元数据缺失）')
        throw new Error(`GitHub 下载错误: ${ymlRes.status}`)
      }
      const { version: latestVersion, files } = parseLatestYml(await ymlRes.text())
      if (!latestVersion) throw new Error('更新元数据解析失败')

      // 比较版本号
      const compareVersions = (v1: string, v2: string): number => {
        const parts1 = v1.split('.').map(Number)
        const parts2 = v2.split('.').map(Number)
        for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
          const p1 = parts1[i] || 0
          const p2 = parts2[i] || 0
          if (p1 > p2) return 1
          if (p1 < p2) return -1
        }
        return 0
      }

      const hasUpdate = compareVersions(latestVersion, currentVersion) > 0

      console.log(
        `[Update] Current: ${currentVersion}, Latest: ${latestVersion}, HasUpdate: ${hasUpdate}`
      )

      return {
        hasUpdate,
        currentVersion,
        latestVersion,
        releaseNotes: '',
        releaseName: `v${latestVersion}`,
        releaseUrl: `https://github.com/${GITHUB_REPO}/releases/tag/v${latestVersion}`,
        publishedAt: '',
        assets: files.map((f) => ({
          name: f.name,
          downloadUrl: `${RELEASE_DOWNLOAD_BASE}/${f.name}`,
          size: f.size
        }))
      }
    } catch (error) {
      console.error('[Update] Manual check failed:', error)
      return {
        hasUpdate: false,
        error: error instanceof Error ? error.message : '检查更新失败'
      }
    }
  })

  // ============ 一键诊断 ============
  // IPC: 加载账号数据
  ipcMain.handle('load-accounts', async () => {
    try {
      await initStore()
      return getAccountData()
    } catch (error) {
      console.error('Failed to load accounts:', error)
      return null
    }
  })

  // IPC: 保存账号数据
  ipcMain.handle('save-accounts', async (_event, data) => {
    try {
      await initStore()
      saveAccountData(data as Record<string, unknown>)

      // 保存最后的数据（用于崩溃恢复）
      lastSavedData = data

      // 每次保存时也创建备份
      await createBackup(data)
    } catch (error) {
      console.error('Failed to save accounts:', error)
      throw error
    }
  })

  // IPC: 加载闲置账号数据（独立 SQLite 文件，与主库物理隔离）
  ipcMain.handle('load-idle-accounts', async () => {
    try {
      await initStore()
      await initIdleStore()
      return getIdleAccountData()
    } catch (error) {
      console.error('Failed to load idle accounts:', error)
      return null
    }
  })

  // IPC: 保存闲置账号数据（独立库 + 独立容灾备份）
  ipcMain.handle('save-idle-accounts', async (_event, data) => {
    try {
      await initStore()
      await initIdleStore()
      saveIdleAccountData(data as Record<string, unknown>)

      lastSavedIdleData = data

      await createIdleBackup(data)
    } catch (error) {
      console.error('Failed to save idle accounts:', error)
      throw error
    }
  })

  // IPC: 刷新账号 Token（支持 IdC 和社交登录）
  ipcMain.handle('refresh-account-token', async (_event, account) => {
    try {
      const { refreshToken, clientId, clientSecret, region, authMethod, provider } =
        account.credentials || {}

      if (!refreshToken) {
        return { success: false, error: { message: '缺少 Refresh Token' } }
      }

      // 社交登录只需要 refreshToken，IdC 登录需要 clientId 和 clientSecret
      if (authMethod !== 'social' && (!clientId || !clientSecret)) {
        return { success: false, error: { message: '缺少 OIDC 刷新凭证 (clientId/clientSecret)' } }
      }

      // 查找账号绑定的代理 URL（账号池中已有 proxyUrl 字段）
      const boundProxyUrl = undefined

      console.log(
        `[IPC] Refreshing token (authMethod: ${authMethod || 'IdC'})...${boundProxyUrl ? ' [via bound proxy]' : ''}`
      )

      // 根据 authMethod 选择刷新方式（透传账号绑定代理）
      const refreshResult = await refreshTokenByMethod(
        refreshToken,
        clientId || '',
        clientSecret || '',
        region || 'us-east-1',
        authMethod,
        boundProxyUrl
      )

      if (!refreshResult.success || !refreshResult.accessToken) {
        return { success: false, error: { message: refreshResult.error || 'Token 刷新失败' } }
      }

      const newAccess = refreshResult.accessToken
      const newRefresh = refreshResult.refreshToken || refreshToken
      const expiresIn = refreshResult.expiresIn ?? 3600

      // 刷新后自动获取 profileArn（仅 Enterprise 需要调 API，其他类型不调）
      let resolvedEnterpriseArn: string | undefined
      const existingProfileArn = account.profileArn || account.credentials?.profileArn
      if (!existingProfileArn) {
        const isEnt = provider === 'Enterprise' || authMethod === 'external_idp'
        if (isEnt) {
          try {
            resolvedEnterpriseArn = await fetchEnterpriseProfileArn({
              id: account.id || '',
              accessToken: newAccess,
              region: region || 'us-east-1',
              provider,
              authMethod: authMethod as 'IdC' | 'social' | 'idc' | 'external_idp' | undefined,
              machineId: account.machineId
            })
            if (resolvedEnterpriseArn) {
              console.log(`[Refresh] Enterprise profileArn auto-resolved: ${resolvedEnterpriseArn}`)
            }
          } catch (e) {
            console.warn('[Refresh] Failed to fetch Enterprise profileArn:', e)
          }
        }
        // BuilderId/Social 不调 API，不需要返回 profileArn（反代自愈时用 resolveProfileArn 兜底）
      }

      return {
        success: true,
        data: {
          accessToken: newAccess,
          refreshToken: newRefresh,
          expiresIn,
          // Enterprise 自动获取的 profileArn（renderer 需要存储到账号数据）
          profileArn: resolvedEnterpriseArn || undefined
        }
      }
    } catch (error) {
      return {
        success: false,
        error: { message: error instanceof Error ? error.message : 'Unknown error' }
      }
    }
  })


  // IPC: 检查账号状态（支持自动刷新 Token）
  ipcMain.handle('check-account-status', async (_event, account) => {
    console.log(`[IPC] check-account-status [${account?.email || 'unknown'}]`)

    interface Bonus {
      bonusCode?: string
      displayName?: string
      usageLimit?: number
      usageLimitWithPrecision?: number
      currentUsage?: number
      currentUsageWithPrecision?: number
      status?: string
      expiresAt?: string // API 返回的是 expiresAt
    }

    interface FreeTrialInfo {
      usageLimit?: number
      usageLimitWithPrecision?: number
      currentUsage?: number
      currentUsageWithPrecision?: number
      freeTrialStatus?: string
      freeTrialExpiry?: string
    }

    interface UsageBreakdown {
      usageLimit?: number
      usageLimitWithPrecision?: number
      currentUsage?: number
      currentUsageWithPrecision?: number
      displayName?: string
      displayNamePlural?: string
      resourceType?: string
      currency?: string
      unit?: string
      overageRate?: number
      overageCap?: number
      bonuses?: Bonus[]
      freeTrialInfo?: FreeTrialInfo
    }

    interface SubscriptionInfo {
      subscriptionTitle?: string
      type?: string
      upgradeCapability?: string
      overageCapability?: string
      subscriptionManagementTarget?: string
    }

    interface UserInfo {
      email?: string
      userId?: string
    }

    interface OverageConfiguration {
      overageEnabled?: boolean
      overageStatus?: string
    }

    interface UsageResponse {
      daysUntilReset?: number
      nextDateReset?: string
      usageBreakdownList?: UsageBreakdown[]
      overageConfiguration?: OverageConfiguration
      subscriptionInfo?: SubscriptionInfo
      userInfo?: UserInfo
    }

    // 解析 API 响应的辅助函数
    const parseUsageResponse = (
      result: UsageResponse,
      newCredentials?: {
        accessToken: string
        refreshToken?: string
        expiresIn?: number
      },
      userInfo?: UserInfoResponse
    ) => {
      console.log(`[Kiro API] Usage [${account?.email || userInfo?.email || 'unknown'}]`, result)

      // 解析 Credits 使用量（resourceType 为 CREDIT）
      const creditUsage = result.usageBreakdownList?.find(
        (b) => b.resourceType === 'CREDIT' || b.displayName === 'Credits'
      )

      // 解析使用量（详细，使用精确小数）
      // 基础额度
      const baseLimit = creditUsage?.usageLimitWithPrecision ?? creditUsage?.usageLimit ?? 0
      const baseCurrent = creditUsage?.currentUsageWithPrecision ?? creditUsage?.currentUsage ?? 0

      // 试用额度
      let freeTrialLimit = 0
      let freeTrialCurrent = 0
      let freeTrialExpiry: string | undefined
      if (creditUsage?.freeTrialInfo?.freeTrialStatus === 'ACTIVE') {
        freeTrialLimit =
          creditUsage.freeTrialInfo.usageLimitWithPrecision ??
          creditUsage.freeTrialInfo.usageLimit ??
          0
        freeTrialCurrent =
          creditUsage.freeTrialInfo.currentUsageWithPrecision ??
          creditUsage.freeTrialInfo.currentUsage ??
          0
        freeTrialExpiry = creditUsage.freeTrialInfo.freeTrialExpiry
      }

      // 奖励额度
      const bonusesData: {
        code: string
        name: string
        current: number
        limit: number
        expiresAt?: string
      }[] = []
      if (creditUsage?.bonuses) {
        for (const bonus of creditUsage.bonuses) {
          if (bonus.status === 'ACTIVE') {
            bonusesData.push({
              code: bonus.bonusCode || '',
              name: bonus.displayName || '',
              current: bonus.currentUsageWithPrecision ?? bonus.currentUsage ?? 0,
              limit: bonus.usageLimitWithPrecision ?? bonus.usageLimit ?? 0,
              expiresAt: bonus.expiresAt
            })
          }
        }
      }

      // 计算总额度
      const totalLimit =
        baseLimit + freeTrialLimit + bonusesData.reduce((sum, b) => sum + b.limit, 0)
      const totalUsed =
        baseCurrent + freeTrialCurrent + bonusesData.reduce((sum, b) => sum + b.current, 0)
      const nextResetDate = result.nextDateReset

      // 解析订阅类型（顺序：PRO_MAX → PRO+ → POWER → PRO）
      const subscriptionTitle = result.subscriptionInfo?.subscriptionTitle ?? 'Free'
      let subscriptionType = account.subscription?.type ?? 'Free'
      const titleUpper = subscriptionTitle.toUpperCase()
      if (
        titleUpper.includes('PRO_MAX') ||
        titleUpper.includes('PRO MAX') ||
        titleUpper.includes('PROMAX')
      ) {
        subscriptionType = 'Pro_Max'
      } else if (
        titleUpper.includes('PRO+') ||
        titleUpper.includes('PRO_PLUS') ||
        titleUpper.includes('PROPLUS')
      ) {
        subscriptionType = 'Pro_Plus'
      } else if (titleUpper.includes('POWER')) {
        subscriptionType = 'Enterprise'
      } else if (titleUpper.includes('PRO')) {
        subscriptionType = 'Pro'
      } else if (titleUpper.includes('ENTERPRISE')) {
        subscriptionType = 'Enterprise'
      } else if (titleUpper.includes('TEAMS')) {
        subscriptionType = 'Teams'
      }

      // 解析重置时间并计算剩余天数
      let expiresAt: number | undefined
      let daysRemaining: number | undefined
      if (result.nextDateReset) {
        expiresAt = new Date(result.nextDateReset).getTime()
        const now = Date.now()
        daysRemaining = Math.max(0, Math.ceil((expiresAt - now) / (1000 * 60 * 60 * 24)))
      }

      // 资源详情
      const resourceDetail = creditUsage
        ? {
            resourceType: creditUsage.resourceType,
            displayName: creditUsage.displayName,
            displayNamePlural: creditUsage.displayNamePlural,
            currency: creditUsage.currency,
            unit: creditUsage.unit,
            overageRate: creditUsage.overageRate,
            overageCap: creditUsage.overageCap,
            overageEnabled:
              result.overageConfiguration?.overageStatus === 'ENABLED' ||
              result.overageConfiguration?.overageEnabled === true
          }
        : undefined

      return {
        success: true,
        data: {
          status:
            !userInfo?.status || userInfo.status === 'Active' || userInfo.status === 'Stale'
              ? 'active'
              : 'error',
          email: result.userInfo?.email,
          userId: result.userInfo?.userId,
          idp: userInfo?.idp,
          userStatus: userInfo?.status,
          featureFlags: userInfo?.featureFlags,
          subscriptionTitle,
          usage: {
            current: totalUsed,
            limit: totalLimit,
            percentUsed: totalLimit > 0 ? totalUsed / totalLimit : 0,
            lastUpdated: Date.now(),
            baseLimit,
            baseCurrent,
            freeTrialLimit,
            freeTrialCurrent,
            freeTrialExpiry,
            bonuses: bonusesData,
            nextResetDate,
            resourceDetail
          },
          subscription: {
            type: subscriptionType,
            title: subscriptionTitle,
            rawType: result.subscriptionInfo?.type,
            expiresAt,
            daysRemaining,
            upgradeCapability: result.subscriptionInfo?.upgradeCapability,
            overageCapability: result.subscriptionInfo?.overageCapability,
            managementTarget: result.subscriptionInfo?.subscriptionManagementTarget
          },
          // 如果刷新了 token，返回新的凭证
          newCredentials: newCredentials
            ? {
                accessToken: newCredentials.accessToken,
                refreshToken: newCredentials.refreshToken,
                expiresAt: newCredentials.expiresIn
                  ? Date.now() + newCredentials.expiresIn * 1000
                  : undefined
              }
            : undefined
        }
      }
    }

    try {
      const { accessToken, refreshToken, clientId, clientSecret, region, authMethod, provider } =
        account.credentials || {}

      // 查询账号绑定的代理（账号池）
      const boundProxyUrl = undefined

      // 确定正确的 idp：优先使用 credentials.provider，否则回退到 account.idp
      // 社交登录使用实际的 provider (Github/Google)，IdC 使用 BuilderId
      let idp = 'BuilderId'
      if (authMethod === 'social') {
        idp = provider || account.idp || 'BuilderId'
      } else if (provider) {
        idp = provider
      }

      if (!accessToken) {
        console.log('[IPC] Missing accessToken')
        return { success: false, error: { message: '缺少 accessToken' } }
      }

      // 获取账户绑定的设备 ID
      const accountMachineId = account?.machineId as string | undefined

      // 第一次尝试：使用当前 accessToken
      try {
        // 并行调用 GetUserInfo 和 getUsageAndLimits
        const [userInfoResult, usageResult] = await Promise.all([
          getUserInfo(accessToken, idp, accountMachineId, account?.email).catch((err: Error) => {
            // 封禁错误不能吞掉，必须向上抛出
            if (err.message.includes('423') || err.message.includes('AccountSuspended')) {
              throw err
            }
            return undefined
          }),
          getUsageAndLimits(accessToken, idp, undefined, accountMachineId, region, account?.email)
        ])
        return parseUsageResponse(usageResult, undefined, userInfoResult)
      } catch (apiError) {
        const errorMsg = apiError instanceof Error ? apiError.message : ''

        // 检查是否是明确封禁错误（423 或 AccountSuspendedException）
        if (errorMsg.includes('AccountSuspendedException') || errorMsg.includes('423')) {
          console.log('[IPC] Account suspended/banned')
          return {
            success: false,
            error: { message: errorMsg, isBanned: true }
          }
        }

        // 检查是否是 401 错误（token 过期）
        // 社交登录只需要 refreshToken，IdC 登录需要 clientId 和 clientSecret
        const canRefresh = refreshToken && (authMethod === 'social' || (clientId && clientSecret))
        if (errorMsg.includes('401') && canRefresh) {
          console.log(
            `[IPC] Token expired, attempting to refresh (authMethod: ${authMethod || 'IdC'})...${boundProxyUrl ? ' [via bound proxy]' : ''}`
          )

          // 尝试刷新 token - 根据 authMethod 选择刷新方式（透传账号代理）
          const refreshResult = await refreshTokenByMethod(
            refreshToken,
            clientId || '',
            clientSecret || '',
            region || 'us-east-1',
            authMethod,
            boundProxyUrl
          )

          if (refreshResult.success && refreshResult.accessToken) {
            console.log('[IPC] Token refreshed, retrying API call...')

            // 用新 token 并行调用 GetUserInfo 和 getUsageAndLimits
            const [userInfoResult, usageResult] = await Promise.all([
              getUserInfo(refreshResult.accessToken, idp, accountMachineId).catch((err: Error) => {
                if (err.message.includes('423') || err.message.includes('AccountSuspended')) {
                  throw err
                }
                return undefined
              }),
              getUsageAndLimits(refreshResult.accessToken, idp, undefined, accountMachineId, region)
            ])

            // 返回结果并包含新凭证
            return parseUsageResponse(
              usageResult,
              {
                accessToken: refreshResult.accessToken,
                refreshToken: refreshResult.refreshToken,
                expiresIn: refreshResult.expiresIn
              },
              userInfoResult
            )
          } else {
            console.error('[IPC] Token refresh failed:', refreshResult.error)
            return {
              success: false,
              error: { message: `Token 过期且刷新失败: ${refreshResult.error}` }
            }
          }
        }

        // 不是 401 或没有刷新凭证，抛出原错误
        throw apiError
      }
    } catch (error) {
      console.error('check-account-status error:', error)
      return {
        success: false,
        error: { message: error instanceof Error ? error.message : 'Unknown error' }
      }
    }
  })

  // IPC: 获取系统日志
  ipcMain.handle('proxy-get-logs', (_event, count?: number) => {
    try {
      if (count) {
        return proxyLogStore.getLast(count)
      }
      return proxyLogStore.getAll()
    } catch (error) {
      console.error('[ProxyLogStore] Get logs failed:', error)
      return []
    }
  })

  // IPC: 清除系统日志
  ipcMain.handle('proxy-clear-logs', () => {
    try {
      proxyLogStore.clear()
      return { success: true }
    } catch (error) {
      console.error('[ProxyLogStore] Clear logs failed:', error)
      return { success: false }
    }
  })

  // IPC: 获取系统日志数量
  ipcMain.handle('proxy-get-logs-count', () => {
    try {
      return proxyLogStore.count()
    } catch (error) {
      console.error('[ProxyLogStore] Get logs count failed:', error)
      return 0
    }
  })

  // IPC: 后台批量刷新账号（在主进程执行，不阻塞 UI）
  const backgroundBatchRefresh = async (
    accounts: BackgroundRefreshAccount[],
    concurrency: number = 10,
    syncInfo: boolean = true
  ): Promise<{
    success: boolean
    completed: number
    successCount: number
    failedCount: number
  }> => {
    console.log(
      `[BackgroundRefresh] Starting batch refresh for ${accounts.length} accounts, concurrency: ${concurrency}, syncInfo: ${syncInfo}`
    )

    let completed = 0
    let success = 0
    let failed = 0

    // 每账号完成即上报进度：渲染层进度条逐号推进（批末的批次级汇总事件仍保留）
    const sendProgress = (): void => {
      mainWindow?.webContents.send('background-refresh-progress', {
        completed,
        total: accounts.length,
        success,
        failed
      })
    }

    // 串行处理每批，避免并发过高
    for (let i = 0; i < accounts.length; i += concurrency) {
      const batch = accounts.slice(i, i + concurrency)

      await Promise.allSettled(
        batch.map(async (account) => {
          // 去重：渲染进程定时器与主进程调度器可能同时触发刷新，
          // 对同一账号并发刷新会让其中一个用到被 rotate 作废的旧 refreshToken。
          // 已在途则跳过本次（不计入成败，等在途那次的结果回流即可）。
          if (account.id && poolRefreshInFlightIds.has(account.id)) {
            return
          }
          if (account.id) poolRefreshInFlightIds.add(account.id)
          try {
            const {
              refreshToken,
              clientId,
              clientSecret,
              region,
              authMethod,
              accessToken,
              provider
            } = account.credentials
            const needsTokenRefresh = account.needsTokenRefresh !== false // 默认为 true（兼容旧版本）

            // 查询账号绑定的代理（从主进程账号池）
            const boundProxyUrl = undefined

            // 确定正确的 idp
            let idp = 'BuilderId'
            if (authMethod === 'social') {
              idp = provider || account.idp || 'BuilderId'
            } else if (provider) {
              idp = provider
            }

            let newAccessToken = accessToken
            let newRefreshToken = refreshToken
            let newExpiresIn: number | undefined

            // 只有需要刷新 Token 时才刷新
            if (needsTokenRefresh) {
              if (!refreshToken) {
                failed++
                completed++
                sendProgress()
                return
              }

              // 刷新 Token（透传账号绑定代理）
              const refreshResult = await refreshTokenByMethod(
                refreshToken,
                clientId || '',
                clientSecret || '',
                region || 'us-east-1',
                authMethod,
                boundProxyUrl
              )

              if (!refreshResult.success) {
                failed++
                completed++
                // 通知渲染进程刷新失败
                mainWindow?.webContents.send('background-refresh-result', {
                  id: account.id,
                  success: false,
                  error: refreshResult.error
                })
                sendProgress()
                return
              }

              newAccessToken = refreshResult.accessToken || accessToken
              newRefreshToken = refreshResult.refreshToken || refreshToken
              newExpiresIn = refreshResult.expiresIn
            }

            // Enterprise 账号：后台刷新后自动获取 profileArn（BuilderId/Social 不需要调 API）
            const existingProfileArn = account.profileArn || account.credentials?.profileArn
            let resolvedBgProfileArn: string | undefined
            const isEnt =
              (provider || account.idp) === 'Enterprise' || authMethod === 'external_idp'
            if (!existingProfileArn && newAccessToken && isEnt) {
              try {
                resolvedBgProfileArn = await fetchEnterpriseProfileArn({
                  id: account.id || '',
                  accessToken: newAccessToken,
                  region: region || 'us-east-1',
                  provider: provider || account.idp,
                  authMethod: authMethod as 'IdC' | 'social' | 'idc' | 'external_idp' | undefined,
                  machineId: account.machineId
                })
                if (resolvedBgProfileArn) {
                  console.log(
                    `[BackgroundRefresh] Enterprise profileArn auto-resolved: ${resolvedBgProfileArn} (${account.id})`
                  )
                }
              } catch (e) {
                console.warn(
                  `[BackgroundRefresh] Failed to fetch Enterprise profileArn for ${account.id}:`,
                  e
                )
              }
            }

            // 获取账号信息
            if (!newAccessToken) {
              failed++
              completed++
              return
            }

            // 根据 syncInfo 决定是否检测账户信息
            let parsedUsage:
              | {
                  current: number
                  limit: number
                  baseCurrent: number
                  baseLimit: number
                  freeTrialCurrent: number
                  freeTrialLimit: number
                  freeTrialExpiry?: string
                  bonuses: Array<{
                    code: string
                    name: string
                    current: number
                    limit: number
                    expiresAt?: string
                  }>
                  nextResetDate?: string
                  resourceDetail?: {
                    displayName?: string
                    displayNamePlural?: string
                    resourceType?: string
                    currency?: string
                    unit?: string
                    overageRate?: number
                    overageCap?: number
                    overageEnabled?: boolean
                  }
                }
              | undefined
            let userInfoData: UserInfoResponse | undefined
            let subscriptionData:
              | {
                  type: string
                  title: string
                  daysRemaining?: number
                  expiresAt?: number
                  overageCapability?: string
                  upgradeCapability?: string
                  subscriptionManagementTarget?: string
                }
              | undefined
            let status = 'active'
            let errorMessage: string | undefined

            if (syncInfo) {
              // 用量与用户状态并行请求：两者互不依赖，串行会让每账号多付一整个往返
              const usageTask = (async (): Promise<void> => {
                // 调用 getUsageAndLimits API（根据配置选择 REST 或 CBOR 格式）
                try {
                  interface UsageBreakdownItem {
                    resourceType?: string
                    displayName?: string
                    currentUsage?: number
                    currentUsageWithPrecision?: number
                    usageLimit?: number
                    usageLimitWithPrecision?: number
                    freeTrialInfo?: {
                      freeTrialStatus?: string
                      usageLimit?: number
                      usageLimitWithPrecision?: number
                      currentUsage?: number
                      currentUsageWithPrecision?: number
                      freeTrialExpiry?: string
                    }
                    bonuses?: Array<{
                      bonusCode?: string
                      displayName?: string
                      usageLimit?: number
                      usageLimitWithPrecision?: number
                      currentUsage?: number
                      currentUsageWithPrecision?: number
                      expiresAt?: string
                      status?: string
                    }>
                  }
                  interface UsageResponse {
                    usageBreakdownList?: UsageBreakdownItem[]
                    nextDateReset?: string
                    subscriptionInfo?: {
                      subscriptionTitle?: string
                      type?: string
                      overageCapability?: string
                      upgradeCapability?: string
                      subscriptionManagementTarget?: string
                    }
                    overageConfiguration?: {
                      overageStatus?: string
                      overageEnabled?: boolean
                      overageLimit?: number | null
                    }
                  }
                  console.log(
                    `[BackgroundRefresh] Account ${account.id} machineId: ${account.machineId || 'undefined'}`
                  )
                  const rawUsage = (await getUsageAndLimits(
                    newAccessToken,
                    idp,
                    undefined,
                    account.machineId,
                    region
                  )) as UsageResponse

                  // 解析使用量数据
                  const creditUsage = rawUsage.usageBreakdownList?.find(
                    (b) => b.resourceType === 'CREDIT'
                  )
                  const baseCurrent =
                    creditUsage?.currentUsageWithPrecision ?? creditUsage?.currentUsage ?? 0
                  const baseLimit =
                    creditUsage?.usageLimitWithPrecision ?? creditUsage?.usageLimit ?? 0
                  let freeTrialCurrent = 0
                  let freeTrialLimit = 0
                  let freeTrialExpiry: string | undefined
                  if (creditUsage?.freeTrialInfo?.freeTrialStatus === 'ACTIVE') {
                    freeTrialCurrent =
                      creditUsage.freeTrialInfo.currentUsageWithPrecision ??
                      creditUsage.freeTrialInfo.currentUsage ??
                      0
                    freeTrialLimit =
                      creditUsage.freeTrialInfo.usageLimitWithPrecision ??
                      creditUsage.freeTrialInfo.usageLimit ??
                      0
                    freeTrialExpiry = creditUsage.freeTrialInfo.freeTrialExpiry
                  }
                  const bonuses: Array<{
                    code: string
                    name: string
                    current: number
                    limit: number
                    expiresAt?: string
                  }> = []
                  if (creditUsage?.bonuses) {
                    for (const bonus of creditUsage.bonuses) {
                      if (bonus.status === 'ACTIVE') {
                        bonuses.push({
                          code: bonus.bonusCode || '',
                          name: bonus.displayName || '',
                          current: bonus.currentUsageWithPrecision ?? bonus.currentUsage ?? 0,
                          limit: bonus.usageLimitWithPrecision ?? bonus.usageLimit ?? 0,
                          expiresAt: bonus.expiresAt
                        })
                      }
                    }
                  }
                  const totalLimit =
                    baseLimit + freeTrialLimit + bonuses.reduce((sum, b) => sum + b.limit, 0)
                  const totalCurrent =
                    baseCurrent + freeTrialCurrent + bonuses.reduce((sum, b) => sum + b.current, 0)

                  parsedUsage = {
                    current: totalCurrent,
                    limit: totalLimit,
                    baseCurrent,
                    baseLimit,
                    freeTrialCurrent,
                    freeTrialLimit,
                    freeTrialExpiry,
                    bonuses,
                    nextResetDate: rawUsage.nextDateReset,
                    resourceDetail: creditUsage
                      ? {
                          displayName: creditUsage.displayName,
                          displayNamePlural: (creditUsage as { displayNamePlural?: string })
                            .displayNamePlural,
                          resourceType: creditUsage.resourceType,
                          currency: (creditUsage as { currency?: string }).currency,
                          unit: (creditUsage as { unit?: string }).unit,
                          overageRate: (creditUsage as { overageRate?: number }).overageRate,
                          overageCap: (creditUsage as { overageCap?: number }).overageCap,
                          overageEnabled:
                            rawUsage.overageConfiguration?.overageStatus === 'ENABLED' ||
                            rawUsage.overageConfiguration?.overageEnabled === true
                        }
                      : undefined
                  }

                  // 解析订阅信息（注意检查顺序：先检查更具体的类型）
                  const subscriptionTitle = rawUsage.subscriptionInfo?.subscriptionTitle || 'Free'
                  let subscriptionType = 'Free'
                  const titleUpper = subscriptionTitle.toUpperCase()
                  if (
                    titleUpper.includes('PRO_MAX') ||
                    titleUpper.includes('PRO MAX') ||
                    titleUpper.includes('PROMAX')
                  ) {
                    subscriptionType = 'Pro_Max'
                  } else if (
                    titleUpper.includes('PRO+') ||
                    titleUpper.includes('PRO_PLUS') ||
                    titleUpper.includes('PROPLUS')
                  ) {
                    subscriptionType = 'Pro_Plus'
                  } else if (titleUpper.includes('POWER')) {
                    subscriptionType = 'Enterprise'
                  } else if (titleUpper.includes('PRO')) {
                    subscriptionType = 'Pro'
                  } else if (titleUpper.includes('ENTERPRISE')) {
                    subscriptionType = 'Enterprise'
                  } else if (titleUpper.includes('TEAMS')) {
                    subscriptionType = 'Teams'
                  }

                  // 计算剩余天数和到期时间
                  let daysRemaining: number | undefined
                  let expiresAt: number | undefined
                  if (rawUsage.nextDateReset) {
                    expiresAt = new Date(rawUsage.nextDateReset).getTime()
                    daysRemaining = Math.max(
                      0,
                      Math.ceil((expiresAt - Date.now()) / (1000 * 60 * 60 * 24))
                    )
                  }

                  subscriptionData = {
                    type: subscriptionType,
                    title: subscriptionTitle,
                    daysRemaining,
                    expiresAt,
                    overageCapability: rawUsage.subscriptionInfo?.overageCapability,
                    upgradeCapability: rawUsage.subscriptionInfo?.upgradeCapability,
                    subscriptionManagementTarget:
                      rawUsage.subscriptionInfo?.subscriptionManagementTarget
                  }
                } catch (apiError) {
                  const errMsg = apiError instanceof Error ? apiError.message : String(apiError)
                  console.log(`[BackgroundRefresh] Usage API error for ${account.id}:`, errMsg)
                  if (errMsg.includes('AccountSuspendedException') || errMsg.includes('423')) {
                    status = 'error'
                    errorMessage = errMsg
                  }
                }
              })()

              // 调用 GetUserInfo API 获取用户状态
              const userInfoTask = (async (): Promise<void> => {
                try {
                  userInfoData = await getUserInfo(newAccessToken, idp, account.machineId)
                } catch (apiError) {
                  const errMsg = apiError instanceof Error ? apiError.message : String(apiError)
                  if (errMsg.includes('AccountSuspendedException') || errMsg.includes('423')) {
                    status = 'error'
                    errorMessage = errMsg
                  }
                }
              })()

              await Promise.all([usageTask, userInfoTask])
            }

            success++
            completed++

            // 通知渲染进程更新账号
            mainWindow?.webContents.send('background-refresh-result', {
              id: account.id,
              success: true,
              data: {
                accessToken: newAccessToken,
                refreshToken: newRefreshToken,
                expiresIn: newExpiresIn,
                profileArn: resolvedBgProfileArn || undefined,
                usage: parsedUsage,
                subscription: subscriptionData,
                userInfo: syncInfo ? userInfoData : undefined,
                status,
                errorMessage
              }
            })
            sendProgress()
          } catch (e) {
            failed++
            completed++
            mainWindow?.webContents.send('background-refresh-result', {
              id: account.id,
              success: false,
              error: e instanceof Error ? e.message : 'Unknown error'
            })
            sendProgress()
          } finally {
            if (account.id) poolRefreshInFlightIds.delete(account.id)
          }
        })
      )

      // 通知进度
      mainWindow?.webContents.send('background-refresh-progress', {
        completed,
        total: accounts.length,
        success,
        failed
      })

      // 批次间延迟，让主进程有喘息时间
      if (i + concurrency < accounts.length) {
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }

    console.log(`[BackgroundRefresh] Completed: ${success} success, ${failed} failed`)
    return { success: true, completed, successCount: success, failedCount: failed }
  }
  // 暴露给主进程调度器复用（startMainPoolTokenRefresh）
  backgroundBatchRefreshImpl = backgroundBatchRefresh
  ipcMain.handle(
    'background-batch-refresh',
    (
      _event,
      accounts: BackgroundRefreshAccount[],
      concurrency: number = 10,
      syncInfo: boolean = true
    ) => backgroundBatchRefresh(accounts, concurrency, syncInfo)
  )
  // 启动主进程池 token 刷新调度器（不依赖窗口可见/存活，挂托盘也照常刷新）
  startMainPoolTokenRefresh()

  // IPC: 后台批量检查账号状态（不刷新 Token，只检查状态）
  ipcMain.handle(
    'background-batch-check',
    async (
      _event,
      accounts: Array<{
        id: string
        email: string
        credentials: {
          accessToken: string
          refreshToken?: string
          clientId?: string
          clientSecret?: string
          region?: string
          authMethod?: string
          provider?: string
        }
        idp?: string
      }>,
      concurrency: number = 10
    ) => {
      console.log(
        `[BackgroundCheck] Starting batch check for ${accounts.length} accounts, concurrency: ${concurrency}`
      )

      let completed = 0
      let success = 0
      let failed = 0

      // 串行处理每批
      for (let i = 0; i < accounts.length; i += concurrency) {
        const batch = accounts.slice(i, i + concurrency)

        await Promise.allSettled(
          batch.map(async (account) => {
            try {
              const { accessToken, authMethod, provider } = account.credentials

              if (!accessToken) {
                failed++
                completed++
                mainWindow?.webContents.send('background-check-result', {
                  id: account.id,
                  success: false,
                  error: '缺少 accessToken'
                })
                return
              }

              // 确定 idp
              let idp = account.idp || 'BuilderId'
              if (authMethod === 'social' && provider) {
                idp = provider
              }

              // 调用 API 获取用量和用户信息（根据配置选择 REST 或 CBOR 格式）
              const [usageRes, userInfoRes] = await Promise.allSettled([
                getUsageAndLimits(
                  accessToken,
                  idp,
                  undefined,
                  undefined,
                  account.credentials?.region,
                  account.email
                ) as Promise<{
                  usageBreakdownList?: Array<{
                    resourceType?: string
                    displayName?: string
                    usageLimit?: number
                    usageLimitWithPrecision?: number
                    currentUsage?: number
                    currentUsageWithPrecision?: number
                    freeTrialInfo?: {
                      freeTrialStatus?: string
                      usageLimit?: number
                      usageLimitWithPrecision?: number
                      currentUsage?: number
                      currentUsageWithPrecision?: number
                      freeTrialExpiry?: string
                    }
                    bonuses?: Array<{
                      bonusCode?: string
                      displayName?: string
                      usageLimit?: number
                      usageLimitWithPrecision?: number
                      currentUsage?: number
                      currentUsageWithPrecision?: number
                      expiresAt?: string
                      status?: string
                    }>
                  }>
                  nextDateReset?: string
                  subscriptionInfo?: {
                    subscriptionTitle?: string
                    type?: string
                    overageCapability?: string
                    upgradeCapability?: string
                    subscriptionManagementTarget?: string
                  }
                  overageConfiguration?: {
                    overageStatus?: string
                    overageEnabled?: boolean
                    overageLimit?: number | null
                  }
                  userInfo?: {
                    email?: string
                    userId?: string
                  }
                }>,
                kiroApiRequest<{
                  email?: string
                  userId?: string
                  status?: string
                  idp?: string
                }>(
                  'GetUserInfo',
                  { origin: 'KIRO_IDE' },
                  accessToken,
                  idp,
                  undefined,
                  account.email
                ).catch((err: Error) => {
                  // 封禁错误不能吞掉，需要在后续逻辑中检测
                  if (err.message.includes('423') || err.message.includes('AccountSuspended')) {
                    throw err
                  }
                  return null
                })
              ])

              // 解析响应（kiroApiRequest 直接返回数据或抛出异常）
              let usageData: {
                current: number
                limit: number
                baseCurrent?: number
                baseLimit?: number
                freeTrialCurrent?: number
                freeTrialLimit?: number
                freeTrialExpiry?: string
                bonuses?: Array<{
                  code: string
                  name: string
                  current: number
                  limit: number
                  expiresAt?: string
                }>
                nextResetDate?: string
              } | null = null
              let subscriptionData: {
                type: string
                title: string
                daysRemaining?: number
                expiresAt?: number
                overageCapability?: string
                upgradeCapability?: string
                subscriptionManagementTarget?: string
              } | null = null
              let resourceDetail:
                | {
                    displayName?: string
                    displayNamePlural?: string
                    resourceType?: string
                    currency?: string
                    unit?: string
                    overageRate?: number
                    overageCap?: number
                    overageEnabled?: boolean
                  }
                | undefined
              let userInfoData: {
                email?: string
                userId?: string
                status?: string
              } | null = null
              let status = 'active'
              let errorMessage: string | undefined

              // 处理用量响应
              if (usageRes.status === 'fulfilled') {
                const rawUsage = usageRes.value
                // 解析 Credits 使用量（和单个检查一致）
                const creditUsage = rawUsage.usageBreakdownList?.find(
                  (b) => b.resourceType === 'CREDIT' || b.displayName === 'Credits'
                )

                const baseCurrent =
                  creditUsage?.currentUsageWithPrecision ?? creditUsage?.currentUsage ?? 0
                const baseLimit =
                  creditUsage?.usageLimitWithPrecision ?? creditUsage?.usageLimit ?? 0
                let freeTrialCurrent = 0
                let freeTrialLimit = 0
                let freeTrialExpiry: string | undefined
                if (creditUsage?.freeTrialInfo?.freeTrialStatus === 'ACTIVE') {
                  freeTrialLimit =
                    creditUsage.freeTrialInfo.usageLimitWithPrecision ??
                    creditUsage.freeTrialInfo.usageLimit ??
                    0
                  freeTrialCurrent =
                    creditUsage.freeTrialInfo.currentUsageWithPrecision ??
                    creditUsage.freeTrialInfo.currentUsage ??
                    0
                  freeTrialExpiry = creditUsage.freeTrialInfo.freeTrialExpiry
                }

                // 解析 bonuses
                const bonuses: Array<{
                  code: string
                  name: string
                  current: number
                  limit: number
                  expiresAt?: string
                }> = []
                if (creditUsage?.bonuses) {
                  for (const bonus of creditUsage.bonuses) {
                    if (bonus.status === 'ACTIVE') {
                      bonuses.push({
                        code: bonus.bonusCode || '',
                        name: bonus.displayName || '',
                        current: bonus.currentUsageWithPrecision ?? bonus.currentUsage ?? 0,
                        limit: bonus.usageLimitWithPrecision ?? bonus.usageLimit ?? 0,
                        expiresAt: bonus.expiresAt
                      })
                    }
                  }
                }

                const totalLimit =
                  baseLimit + freeTrialLimit + bonuses.reduce((sum, b) => sum + b.limit, 0)
                const totalCurrent =
                  baseCurrent + freeTrialCurrent + bonuses.reduce((sum, b) => sum + b.current, 0)

                usageData = {
                  current: totalCurrent,
                  limit: totalLimit,
                  baseCurrent,
                  baseLimit,
                  freeTrialCurrent,
                  freeTrialLimit,
                  freeTrialExpiry,
                  bonuses,
                  nextResetDate: rawUsage.nextDateReset
                }

                // 解析资源详情（含超额信息）
                if (creditUsage) {
                  resourceDetail = {
                    displayName: creditUsage.displayName,
                    displayNamePlural: (creditUsage as { displayNamePlural?: string })
                      .displayNamePlural,
                    resourceType: creditUsage.resourceType,
                    currency: (creditUsage as { currency?: string }).currency,
                    unit: (creditUsage as { unit?: string }).unit,
                    overageRate: (creditUsage as { overageRate?: number }).overageRate,
                    overageCap: (creditUsage as { overageCap?: number }).overageCap,
                    overageEnabled:
                      rawUsage.overageConfiguration?.overageStatus === 'ENABLED' ||
                      rawUsage.overageConfiguration?.overageEnabled === true
                  }
                }

                // 解析订阅信息（注意检查顺序：先检查更具体的类型）
                const subscriptionTitle = rawUsage.subscriptionInfo?.subscriptionTitle ?? 'Free'
                let subscriptionType = 'Free'
                const titleUpper = subscriptionTitle.toUpperCase()
                if (
                  titleUpper.includes('PRO_MAX') ||
                  titleUpper.includes('PRO MAX') ||
                  titleUpper.includes('PROMAX')
                ) {
                  subscriptionType = 'Pro_Max'
                } else if (
                  titleUpper.includes('PRO+') ||
                  titleUpper.includes('PRO_PLUS') ||
                  titleUpper.includes('PROPLUS')
                ) {
                  subscriptionType = 'Pro_Plus'
                } else if (titleUpper.includes('POWER')) {
                  subscriptionType = 'Enterprise'
                } else if (titleUpper.includes('PRO')) {
                  subscriptionType = 'Pro'
                } else if (titleUpper.includes('ENTERPRISE')) {
                  subscriptionType = 'Enterprise'
                } else if (titleUpper.includes('TEAMS')) {
                  subscriptionType = 'Teams'
                }

                // 计算剩余天数和到期时间
                let daysRemaining: number | undefined
                let expiresAt: number | undefined
                if (rawUsage.nextDateReset) {
                  expiresAt = new Date(rawUsage.nextDateReset).getTime()
                  daysRemaining = Math.max(
                    0,
                    Math.ceil((expiresAt - Date.now()) / (1000 * 60 * 60 * 24))
                  )
                }

                subscriptionData = {
                  type: subscriptionType,
                  title: subscriptionTitle,
                  daysRemaining,
                  expiresAt,
                  overageCapability: rawUsage.subscriptionInfo?.overageCapability,
                  upgradeCapability: rawUsage.subscriptionInfo?.upgradeCapability,
                  subscriptionManagementTarget:
                    rawUsage.subscriptionInfo?.subscriptionManagementTarget
                }
              } else if (usageRes.status === 'rejected') {
                // API 调用失败（可能是封禁或 Token 过期）
                const errorMsg = usageRes.reason?.message || String(usageRes.reason)
                console.log(`[BackgroundCheck] Usage API failed for ${account.email}:`, errorMsg)
                if (errorMsg.includes('AccountSuspendedException') || errorMsg.includes('423')) {
                  status = 'error'
                  errorMessage = errorMsg
                } else if (errorMsg.includes('401')) {
                  status = 'expired'
                  errorMessage = 'Token 已过期，请刷新'
                } else {
                  status = 'error'
                  errorMessage = errorMsg
                }
              }

              // 处理用户信息响应
              if (userInfoRes.status === 'fulfilled' && userInfoRes.value) {
                const rawUserInfo = userInfoRes.value
                userInfoData = {
                  email: rawUserInfo.email,
                  userId: rawUserInfo.userId,
                  status: rawUserInfo.status
                }
                // 检查用户状态（Stale 视为正常，仅 Suspended/Disabled 等视为异常）
                if (
                  rawUserInfo.status &&
                  rawUserInfo.status !== 'Active' &&
                  rawUserInfo.status !== 'Stale' &&
                  status !== 'error'
                ) {
                  status = 'error'
                  errorMessage = `用户状态异常: ${rawUserInfo.status}`
                }
              } else if (userInfoRes.status === 'rejected') {
                // GetUserInfo 失败（封禁错误会到这里）
                const errMsg = userInfoRes.reason?.message || String(userInfoRes.reason)
                if (errMsg.includes('423') || errMsg.includes('AccountSuspended')) {
                  status = 'error'
                  errorMessage = errMsg
                }
              }

              success++
              completed++

              // 通知渲染进程更新账号
              mainWindow?.webContents.send('background-check-result', {
                id: account.id,
                success: true,
                data: {
                  usage: usageData ? { ...usageData, resourceDetail } : null,
                  subscription: subscriptionData,
                  userInfo: userInfoData,
                  status,
                  errorMessage
                }
              })
            } catch (e) {
              failed++
              completed++
              mainWindow?.webContents.send('background-check-result', {
                id: account.id,
                success: false,
                error: e instanceof Error ? e.message : 'Unknown error'
              })
            }
          })
        )

        // 通知进度
        mainWindow?.webContents.send('background-check-progress', {
          completed,
          total: accounts.length,
          success,
          failed
        })

        // 批次间延迟
        if (i + concurrency < accounts.length) {
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
      }

      console.log(`[BackgroundCheck] Completed: ${success} success, ${failed} failed`)
      return { success: true, completed, successCount: success, failedCount: failed }
    }
  )

  // IPC: 导出到文件
  ipcMain.handle('export-to-file', async (_event, data: string, filename: string) => {
    try {
      const result = await dialog.showSaveDialog(mainWindow!, {
        title: '导出账号数据',
        defaultPath: filename,
        filters: [{ name: 'JSON Files', extensions: ['json'] }]
      })

      if (!result.canceled && result.filePath) {
        await writeFile(result.filePath, data, 'utf-8')
        return true
      }
      return false
    } catch (error) {
      console.error('Failed to export:', error)
      return false
    }
  })

  // IPC: 从文件导入
  ipcMain.handle('import-from-file', async () => {
    try {
      const result = await dialog.showOpenDialog(mainWindow!, {
        title: '导入账号数据',
        filters: [
          { name: '所有支持的格式', extensions: ['json', 'csv', 'txt'] },
          { name: 'JSON Files', extensions: ['json'] },
          { name: 'CSV Files', extensions: ['csv'] },
          { name: 'TXT Files', extensions: ['txt'] }
        ],
        properties: ['openFile']
      })

      if (!result.canceled && result.filePaths.length > 0) {
        const filePath = result.filePaths[0]
        const content = await readFile(filePath, 'utf-8')
        const ext = filePath.split('.').pop()?.toLowerCase() || 'json'
        return { content, format: ext }
      }
      return null
    } catch (error) {
      console.error('Failed to import:', error)
      return null
    }
  })

  // IPC: 验证凭证并获取账号信息（用于添加账号）
  ipcMain.handle(
    'verify-account-credentials',
    async (
      _event,
      credentials: {
        refreshToken: string
        clientId: string
        clientSecret: string
        region?: string
        authMethod?: string
        provider?: string // 'BuilderId', 'Github', 'Google' 等
      }
    ) => {
      console.log('[IPC] verify-account-credentials called')

      try {
        const {
          refreshToken,
          clientId,
          clientSecret,
          region = 'us-east-1',
          authMethod,
          provider
        } = credentials
        // 确定 idp：社交登录使用 provider，IdC 也需要根据 provider 区分 BuilderId 和 Enterprise
        const idp =
          provider && (provider === 'Enterprise' || provider === 'Github' || provider === 'Google')
            ? provider
            : 'BuilderId'

        // 社交登录只需要 refreshToken，IdC 需要 clientId 和 clientSecret
        if (!refreshToken) {
          return { success: false, error: '请填写 Refresh Token' }
        }
        if (authMethod !== 'social' && (!clientId || !clientSecret)) {
          return { success: false, error: '请填写 Client ID 和 Client Secret' }
        }

        // Step 1: 使用合适的方式刷新获取 accessToken
        console.log(`[Verify] Step 1: Refreshing token (authMethod: ${authMethod || 'IdC'})...`)
        const refreshResult = await refreshTokenByMethod(
          refreshToken,
          clientId,
          clientSecret,
          region,
          authMethod
        )

        if (!refreshResult.success || !refreshResult.accessToken) {
          return { success: false, error: `Token 刷新失败: ${refreshResult.error}` }
        }

        console.log('[Verify] Step 2: Getting user info...')

        // Step 2: 调用 GetUserUsageAndLimits 获取用户信息
        interface Bonus {
          bonusCode?: string
          displayName?: string
          usageLimit?: number
          usageLimitWithPrecision?: number
          currentUsage?: number
          currentUsageWithPrecision?: number
          status?: string
          expiresAt?: string // API 返回的是 expiresAt
        }

        interface FreeTrialInfo {
          usageLimit?: number
          usageLimitWithPrecision?: number
          currentUsage?: number
          currentUsageWithPrecision?: number
          freeTrialStatus?: string
          freeTrialExpiry?: string
        }

        interface UsageBreakdown {
          usageLimit?: number
          usageLimitWithPrecision?: number
          currentUsage?: number
          currentUsageWithPrecision?: number
          resourceType?: string
          displayName?: string
          displayNamePlural?: string
          currency?: string
          unit?: string
          overageRate?: number
          overageCap?: number
          bonuses?: Bonus[]
          freeTrialInfo?: FreeTrialInfo
        }

        interface UsageResponse {
          nextDateReset?: string
          usageBreakdownList?: UsageBreakdown[]
          subscriptionInfo?: {
            subscriptionTitle?: string
            type?: string
            subscriptionManagementTarget?: string
            upgradeCapability?: string
            overageCapability?: string
          }
          overageConfiguration?: { overageEnabled?: boolean; overageStatus?: string }
          userInfo?: { email?: string; userId?: string }
        }

        const usageResult = (await getUsageAndLimits(
          refreshResult.accessToken,
          idp,
          undefined,
          undefined,
          region
        )) as UsageResponse

        // 解析用户信息
        const email = usageResult.userInfo?.email || ''
        const userId = usageResult.userInfo?.userId || ''

        // 解析订阅类型（注意检查顺序：先检查更具体的类型）
        const subscriptionTitle = usageResult.subscriptionInfo?.subscriptionTitle || 'Free'
        let subscriptionType = 'Free'
        const titleUpper = subscriptionTitle.toUpperCase()
        if (
          titleUpper.includes('PRO_MAX') ||
          titleUpper.includes('PRO MAX') ||
          titleUpper.includes('PROMAX')
        ) {
          subscriptionType = 'Pro_Max'
        } else if (
          titleUpper.includes('PRO+') ||
          titleUpper.includes('PRO_PLUS') ||
          titleUpper.includes('PROPLUS')
        ) {
          subscriptionType = 'Pro_Plus'
        } else if (titleUpper.includes('POWER')) {
          subscriptionType = 'Enterprise'
        } else if (titleUpper.includes('PRO')) {
          subscriptionType = 'Pro'
        } else if (titleUpper.includes('ENTERPRISE')) {
          subscriptionType = 'Enterprise'
        } else if (titleUpper.includes('TEAMS')) {
          subscriptionType = 'Teams'
        }

        // 解析使用量（详细，使用精确小数）
        const creditUsage = usageResult.usageBreakdownList?.find((b) => b.resourceType === 'CREDIT')

        // 基础额度
        const baseLimit = creditUsage?.usageLimitWithPrecision ?? creditUsage?.usageLimit ?? 0
        const baseCurrent = creditUsage?.currentUsageWithPrecision ?? creditUsage?.currentUsage ?? 0

        // 试用额度
        let freeTrialLimit = 0
        let freeTrialCurrent = 0
        let freeTrialExpiry: string | undefined
        if (creditUsage?.freeTrialInfo?.freeTrialStatus === 'ACTIVE') {
          freeTrialLimit =
            creditUsage.freeTrialInfo.usageLimitWithPrecision ??
            creditUsage.freeTrialInfo.usageLimit ??
            0
          freeTrialCurrent =
            creditUsage.freeTrialInfo.currentUsageWithPrecision ??
            creditUsage.freeTrialInfo.currentUsage ??
            0
          freeTrialExpiry = creditUsage.freeTrialInfo.freeTrialExpiry
        }

        // 奖励额度
        const bonuses: {
          code: string
          name: string
          current: number
          limit: number
          expiresAt?: string
        }[] = []
        if (creditUsage?.bonuses) {
          for (const bonus of creditUsage.bonuses) {
            if (bonus.status === 'ACTIVE') {
              bonuses.push({
                code: bonus.bonusCode || '',
                name: bonus.displayName || '',
                current: bonus.currentUsageWithPrecision ?? bonus.currentUsage ?? 0,
                limit: bonus.usageLimitWithPrecision ?? bonus.usageLimit ?? 0,
                expiresAt: bonus.expiresAt
              })
            }
          }
        }

        // 计算总额度
        const totalLimit = baseLimit + freeTrialLimit + bonuses.reduce((sum, b) => sum + b.limit, 0)
        const totalUsed =
          baseCurrent + freeTrialCurrent + bonuses.reduce((sum, b) => sum + b.current, 0)

        // 计算重置剩余天数
        let daysRemaining: number | undefined
        let expiresAt: number | undefined
        const nextResetDate = usageResult.nextDateReset
        if (nextResetDate) {
          expiresAt = new Date(nextResetDate).getTime()
          daysRemaining = Math.max(0, Math.ceil((expiresAt - Date.now()) / (1000 * 60 * 60 * 24)))
        }

        console.log('[Verify] Success! Email:', email)

        // Enterprise 账号：验证时自动获取 profileArn（BuilderId/Social 不需要调 API）
        let enterpriseProfileArn: string | undefined
        const isEnt = provider === 'Enterprise' || authMethod === 'external_idp'
        if (isEnt) {
          try {
            enterpriseProfileArn = await fetchEnterpriseProfileArn({
              id: '',
              accessToken: refreshResult.accessToken!,
              region: region || 'us-east-1',
              provider,
              authMethod: authMethod as 'IdC' | 'social' | 'idc' | 'external_idp' | undefined
            })
            if (enterpriseProfileArn) {
              console.log(`[Verify] Enterprise profileArn auto-resolved: ${enterpriseProfileArn}`)
            }
          } catch (e) {
            console.warn('[Verify] Failed to fetch Enterprise profileArn:', e)
          }
        }

        return {
          success: true,
          data: {
            email,
            userId,
            accessToken: refreshResult.accessToken,
            refreshToken: refreshResult.refreshToken || refreshToken,
            expiresIn: refreshResult.expiresIn,
            profileArn: enterpriseProfileArn || undefined,
            subscriptionType,
            subscriptionTitle,
            subscription: {
              rawType: usageResult.subscriptionInfo?.type,
              managementTarget: usageResult.subscriptionInfo?.subscriptionManagementTarget,
              upgradeCapability: usageResult.subscriptionInfo?.upgradeCapability,
              overageCapability: usageResult.subscriptionInfo?.overageCapability
            },
            usage: {
              current: totalUsed,
              limit: totalLimit,
              baseLimit,
              baseCurrent,
              freeTrialLimit,
              freeTrialCurrent,
              freeTrialExpiry,
              bonuses,
              nextResetDate,
              resourceDetail: creditUsage
                ? {
                    displayName: creditUsage.displayName,
                    displayNamePlural: creditUsage.displayNamePlural,
                    resourceType: creditUsage.resourceType,
                    currency: creditUsage.currency,
                    unit: creditUsage.unit,
                    overageRate: creditUsage.overageRate,
                    overageCap: creditUsage.overageCap,
                    overageEnabled:
                      usageResult.overageConfiguration?.overageStatus === 'ENABLED' ||
                      usageResult.overageConfiguration?.overageEnabled === true
                  }
                : undefined
            },
            daysRemaining,
            expiresAt
          }
        }
      } catch (error) {
        console.error('[Verify] Error:', error)
        return { success: false, error: error instanceof Error ? error.message : '验证失败' }
      }
    }
  )

  // IPC: 获取本地 SSO 缓存中当前使用的账号信息
  ipcMain.handle('get-local-active-account', async () => {
    const os = await import('os')
    const path = await import('path')

    try {
      const ssoCache = path.join(os.homedir(), '.aws', 'sso', 'cache')
      const tokenPath = path.join(ssoCache, 'kiro-auth-token.json')

      const tokenContent = await readFile(tokenPath, 'utf-8')
      const tokenData = JSON.parse(tokenContent)

      if (!tokenData.refreshToken) {
        return { success: false, error: '本地缓存中没有 refreshToken' }
      }

      return {
        success: true,
        data: {
          refreshToken: tokenData.refreshToken,
          accessToken: tokenData.accessToken,
          authMethod: tokenData.authMethod,
          provider: tokenData.provider
        }
      }
    } catch {
      return { success: false, error: '无法读取本地 SSO 缓存' }
    }
  })

  // IPC: 从 Kiro 本地配置导入凭证
  ipcMain.handle('load-kiro-credentials', async () => {
    const os = await import('os')
    const path = await import('path')
    const crypto = await import('crypto')
    const fs = await import('fs/promises')

    try {
      // 从 ~/.aws/sso/cache/kiro-auth-token.json 读取 token
      const ssoCache = path.join(os.homedir(), '.aws', 'sso', 'cache')
      const tokenPath = path.join(ssoCache, 'kiro-auth-token.json')
      console.log('[Kiro Credentials] Reading token from:', tokenPath)

      let tokenData: {
        accessToken?: string
        refreshToken?: string
        clientIdHash?: string
        region?: string
        authMethod?: string
        provider?: string
      }

      try {
        const tokenContent = await readFile(tokenPath, 'utf-8')
        tokenData = JSON.parse(tokenContent)
      } catch {
        return { success: false, error: '找不到 kiro-auth-token.json 文件，请先在 Kiro IDE 中登录' }
      }

      if (!tokenData.refreshToken) {
        return { success: false, error: 'kiro-auth-token.json 中缺少 refreshToken' }
      }

      // 确定 clientIdHash：优先使用文件中的，否则计算默认值
      let clientIdHash = tokenData.clientIdHash
      if (!clientIdHash) {
        // 使用标准的 startUrl 计算 hash（与 Kiro 客户端一致）
        const startUrl = 'https://view.awsapps.com/start'
        clientIdHash = crypto.createHash('sha1').update(JSON.stringify({ startUrl })).digest('hex')
        console.log('[Kiro Credentials] Calculated clientIdHash:', clientIdHash)
      }

      // 读取客户端注册信息
      let clientRegPath = path.join(ssoCache, `${clientIdHash}.json`)
      console.log('[Kiro Credentials] Trying client registration from:', clientRegPath)

      let clientData: {
        clientId?: string
        clientSecret?: string
      } | null = null

      try {
        const clientContent = await readFile(clientRegPath, 'utf-8')
        clientData = JSON.parse(clientContent)
      } catch {
        // 如果找不到，尝试搜索目录中的其他 .json 文件（排除 kiro-auth-token.json）
        console.log('[Kiro Credentials] Client file not found, searching cache directory...')
        try {
          const files = await fs.readdir(ssoCache)
          for (const file of files) {
            if (file.endsWith('.json') && file !== 'kiro-auth-token.json') {
              try {
                const content = await readFile(path.join(ssoCache, file), 'utf-8')
                const data = JSON.parse(content)
                if (data.clientId && data.clientSecret) {
                  clientData = data
                  console.log('[Kiro Credentials] Found client registration in:', file)
                  break
                }
              } catch {
                // 忽略无法解析的文件
              }
            }
          }
        } catch {
          // 忽略目录读取错误
        }
      }

      // 社交登录不需要 clientId/clientSecret
      const isSocialAuth = tokenData.authMethod === 'social'

      if (!isSocialAuth && (!clientData || !clientData.clientId || !clientData.clientSecret)) {
        return { success: false, error: '找不到客户端注册文件，请确保已在 Kiro IDE 中完成登录' }
      }

      console.log(
        `[Kiro Credentials] Successfully loaded credentials (authMethod: ${tokenData.authMethod || 'IdC'})`
      )

      return {
        success: true,
        data: {
          accessToken: tokenData.accessToken || '',
          refreshToken: tokenData.refreshToken,
          clientId: clientData?.clientId || '',
          clientSecret: clientData?.clientSecret || '',
          region: tokenData.region || 'us-east-1',
          authMethod: tokenData.authMethod || 'IdC',
          provider: tokenData.provider || 'BuilderId'
        }
      }
    } catch (error) {
      console.error('[Kiro Credentials] Error:', error)
      return { success: false, error: error instanceof Error ? error.message : '未知错误' }
    }
  })

  // IPC: 切换账号 - 写入凭证到本地 SSO 缓存
  //
  // 关键设计：切号前必先 refresh 一次，但与旧实现不同——
  //   1. (bug A 修复) 把 OIDC 返回的新 refreshToken 也写入磁盘
  // ============ 手动登录相关 IPC ============

  // 存储当前登录状态
  let currentLoginState: {
    type: 'builderid' | 'social' | 'iamsso'
    // BuilderId / IAM SSO 相关
    clientId?: string
    clientSecret?: string
    deviceCode?: string
    userCode?: string
    verificationUri?: string
    interval?: number
    expiresAt?: number
    startUrl?: string // IAM SSO 专用
    redirectUri?: string // IAM SSO Authorization Code flow
    region?: string // IAM SSO region
    // Social Auth 相关
    codeVerifier?: string
    codeChallenge?: string
    oauthState?: string
    provider?: string
  } | null = null

  // IPC: 启动 Builder ID 手动登录
  ipcMain.handle('start-builder-id-login', async (_event, region: string = 'us-east-1') => {
    console.log('[Login] Starting Builder ID login...')

    const oidcBase = `https://oidc.${region}.amazonaws.com`
    const startUrl = 'https://view.awsapps.com/start'
    const scopes = [
      'codewhisperer:completions',
      'codewhisperer:analysis',
      'codewhisperer:conversations',
      'codewhisperer:transformations',
      'codewhisperer:taskassist'
    ]

    try {
      // Step 1: 注册 OIDC 客户端
      console.log('[Login] Step 1: Registering OIDC client...')
      const regRes = await fetchWithAppProxy(`${oidcBase}/client/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientName: 'Kiro Account Manager',
          clientType: 'public',
          scopes,
          grantTypes: ['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token'],
          issuerUrl: startUrl
        })
      })

      if (!regRes.ok) {
        const errText = await regRes.text()
        return { success: false, error: `注册客户端失败: ${errText}` }
      }

      const regData = await regRes.json()
      const clientId = regData.clientId
      const clientSecret = regData.clientSecret
      console.log('[Login] Client registered:', clientId.substring(0, 30) + '...')

      // Step 2: 发起设备授权
      console.log('[Login] Step 2: Starting device authorization...')
      const authRes = await fetchWithAppProxy(`${oidcBase}/device_authorization`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId, clientSecret, startUrl })
      })

      if (!authRes.ok) {
        const errText = await authRes.text()
        return { success: false, error: `设备授权失败: ${errText}` }
      }

      const authData = await authRes.json()
      const {
        deviceCode,
        userCode,
        verificationUri,
        verificationUriComplete,
        interval = 5,
        expiresIn = 600
      } = authData
      console.log('[Login] Device code obtained, user_code:', userCode)

      // 保存登录状态
      currentLoginState = {
        type: 'builderid',
        clientId,
        clientSecret,
        deviceCode,
        userCode,
        verificationUri,
        interval,
        expiresAt: Date.now() + expiresIn * 1000
      }

      return {
        success: true,
        userCode,
        verificationUri: verificationUriComplete || verificationUri,
        expiresIn,
        interval
      }
    } catch (error) {
      console.error('[Login] Error:', error)
      return { success: false, error: error instanceof Error ? error.message : '登录失败' }
    }
  })

  // IPC: 轮询 Builder ID 授权状态
  ipcMain.handle('poll-builder-id-auth', async (_event, region: string = 'us-east-1') => {
    console.log('[Login] Polling for authorization...')

    if (!currentLoginState || currentLoginState.type !== 'builderid') {
      return { success: false, error: '没有进行中的登录' }
    }

    if (Date.now() > (currentLoginState.expiresAt || 0)) {
      currentLoginState = null
      return { success: false, error: '授权已过期，请重新开始' }
    }

    const oidcBase = `https://oidc.${region}.amazonaws.com`
    const { clientId, clientSecret, deviceCode } = currentLoginState

    try {
      const tokenRes = await fetchWithAppProxy(`${oidcBase}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId,
          clientSecret,
          grantType: 'urn:ietf:params:oauth:grant-type:device_code',
          deviceCode
        })
      })

      if (tokenRes.status === 200) {
        const tokenData = await tokenRes.json()
        console.log('[Login] Authorization successful!')

        const result = {
          success: true,
          completed: true,
          accessToken: tokenData.accessToken,
          refreshToken: tokenData.refreshToken,
          clientId,
          clientSecret,
          region,
          expiresIn: tokenData.expiresIn
        }

        currentLoginState = null
        return result
      } else if (tokenRes.status === 400) {
        const errData = await tokenRes.json()
        const error = errData.error

        if (error === 'authorization_pending') {
          return { success: true, completed: false, status: 'pending' }
        } else if (error === 'slow_down') {
          if (currentLoginState) {
            currentLoginState.interval = (currentLoginState.interval || 5) + 5
          }
          return { success: true, completed: false, status: 'slow_down' }
        } else if (error === 'expired_token') {
          currentLoginState = null
          return { success: false, error: '设备码已过期' }
        } else if (error === 'access_denied') {
          currentLoginState = null
          return { success: false, error: '用户拒绝授权' }
        } else {
          currentLoginState = null
          return { success: false, error: `授权错误: ${error}` }
        }
      } else {
        return { success: false, error: `未知响应: ${tokenRes.status}` }
      }
    } catch (error) {
      console.error('[Login] Poll error:', error)
      return { success: false, error: error instanceof Error ? error.message : '轮询失败' }
    }
  })

  // IPC: 取消 Builder ID 登录
  ipcMain.handle('cancel-builder-id-login', async () => {
    console.log('[Login] Cancelling Builder ID login...')
    currentLoginState = null
    return { success: true }
  })

  // IAM SSO 本地服务器和状态
  let iamSsoServer: ReturnType<typeof import('http').createServer> | null = null
  let iamSsoResult: {
    completed: boolean
    success: boolean
    accessToken?: string
    refreshToken?: string
    clientId?: string
    clientSecret?: string
    region?: string
    expiresIn?: number
    error?: string
  } | null = null

  // IPC: 启动 IAM Identity Center SSO 登录 (使用 Authorization Code Grant with PKCE)
  ipcMain.handle(
    'start-iam-sso-login',
    async (_event, startUrl: string, region: string = 'us-east-1') => {
      console.log('[Login] Starting IAM Identity Center SSO login (Authorization Code flow)...')
      console.log('[Login] Start URL:', startUrl)

      // 验证 startUrl 格式
      if (!startUrl || !startUrl.startsWith('https://')) {
        return { success: false, error: 'SSO Start URL 必须以 https:// 开头' }
      }

      const crypto = await import('crypto')
      const http = await import('http')

      const oidcBase = `https://oidc.${region}.amazonaws.com`
      const scopes = [
        'codewhisperer:completions',
        'codewhisperer:analysis',
        'codewhisperer:conversations',
        'codewhisperer:transformations',
        'codewhisperer:taskassist'
      ]

      try {
        // Step 1: 注册 OIDC 客户端 (使用 authorization_code grant type)
        console.log('[Login] Step 1: Registering OIDC client...')
        const regRes = await fetchWithAppProxy(`${oidcBase}/client/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            clientName: 'Kiro Account Manager',
            clientType: 'public',
            scopes,
            grantTypes: ['authorization_code', 'refresh_token'],
            redirectUris: ['http://127.0.0.1/oauth/callback'],
            issuerUrl: startUrl
          })
        })

        if (!regRes.ok) {
          const errText = await regRes.text()
          console.error('[Login] IAM SSO client registration failed:', regRes.status, errText)

          if (errText.includes('UnauthorizedException') || errText.includes('access denied')) {
            return {
              success: false,
              error:
                '授权失败：您的组织可能未配置 Amazon Q Developer 访问权限。请联系组织管理员在 IAM Identity Center 中启用相关权限。'
            }
          }

          return { success: false, error: `注册客户端失败: ${errText}` }
        }

        const regData = await regRes.json()
        const clientId = regData.clientId
        const clientSecret = regData.clientSecret
        console.log('[Login] Client registered:', clientId.substring(0, 30) + '...')

        // Step 2: 生成 PKCE 和 state
        const codeVerifier = crypto.randomBytes(32).toString('base64url')
        const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url')
        const state = crypto.randomUUID()

        // Step 3: 启动本地 HTTP 服务器接收回调
        console.log('[Login] Step 2: Starting local OAuth callback server...')

        // 关闭之前的服务器
        if (iamSsoServer) {
          iamSsoServer.close()
          iamSsoServer = null
        }

        // 找一个可用端口
        const port = await new Promise<number>((resolve, reject) => {
          const server = http.createServer()
          server.listen(0, '127.0.0.1', () => {
            const addr = server.address()
            if (addr && typeof addr === 'object') {
              const p = addr.port
              server.close(() => resolve(p))
            } else {
              reject(new Error('无法获取端口'))
            }
          })
        })

        const redirectUri = `http://127.0.0.1:${port}/oauth/callback`
        console.log('[Login] Redirect URI:', redirectUri)

        // 重置结果
        iamSsoResult = null

        // 创建回调服务器
        iamSsoServer = http.createServer(async (req, res) => {
          const url = new URL(req.url || '', `http://127.0.0.1:${port}`)

          if (url.pathname === '/oauth/callback') {
            const code = url.searchParams.get('code')
            const returnedState = url.searchParams.get('state')
            const error = url.searchParams.get('error')

            if (error) {
              res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
              res.end('<html><body><h1>授权失败</h1><p>您可以关闭此窗口。</p></body></html>')
              iamSsoResult = { completed: true, success: false, error: `授权失败: ${error}` }
              return
            }

            if (returnedState !== state) {
              res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
              res.end('<html><body><h1>授权失败</h1><p>状态不匹配，请重试。</p></body></html>')
              iamSsoResult = { completed: true, success: false, error: '状态不匹配' }
              return
            }

            if (code) {
              res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
              res.end('<html><body><h1>授权成功！</h1><p>正在获取令牌，请稍候...</p></body></html>')

              // 自动完成 token 交换
              try {
                const tokenRes = await fetchWithAppProxy(`${oidcBase}/token`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    clientId,
                    clientSecret,
                    grantType: 'authorization_code',
                    redirectUri,
                    code,
                    codeVerifier
                  })
                })

                if (!tokenRes.ok) {
                  const errText = await tokenRes.text()
                  console.error('[Login] Token exchange failed:', tokenRes.status, errText)
                  iamSsoResult = {
                    completed: true,
                    success: false,
                    error: `获取 Token 失败: ${errText}`
                  }
                } else {
                  const tokenData = await tokenRes.json()
                  console.log('[Login] IAM SSO Authorization successful!')
                  iamSsoResult = {
                    completed: true,
                    success: true,
                    accessToken: tokenData.accessToken,
                    refreshToken: tokenData.refreshToken,
                    clientId,
                    clientSecret,
                    region,
                    expiresIn: tokenData.expiresIn
                  }
                }
              } catch (tokenError) {
                console.error('[Login] Token exchange error:', tokenError)
                iamSsoResult = {
                  completed: true,
                  success: false,
                  error: tokenError instanceof Error ? tokenError.message : '获取 Token 失败'
                }
              }
            } else {
              res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
              res.end('<html><body><h1>授权失败</h1><p>未收到授权码。</p></body></html>')
              iamSsoResult = { completed: true, success: false, error: '未收到授权码' }
            }
          } else {
            res.writeHead(404)
            res.end('Not Found')
          }
        })

        iamSsoServer.listen(port, '127.0.0.1', () => {
          console.log('[Login] OAuth callback server listening on port', port)
        })

        // Step 4: 构建授权 URL 并打开浏览器
        const authorizeParams = new URLSearchParams({
          response_type: 'code',
          client_id: clientId,
          redirect_uri: redirectUri,
          scopes: scopes.join(','),
          state: state,
          code_challenge: codeChallenge,
          code_challenge_method: 'S256'
        })
        const authorizeUrl = `${oidcBase}/authorize?${authorizeParams.toString()}`
        console.log('[Login] Opening browser for authorization...')

        // 保存登录状态
        currentLoginState = {
          type: 'iamsso',
          clientId,
          clientSecret,
          codeVerifier,
          redirectUri,
          region,
          startUrl,
          expiresAt: Date.now() + 600000
        }

        // 返回授权 URL，前端会打开浏览器
        return {
          success: true,
          authorizeUrl,
          expiresIn: 600
        }
      } catch (error) {
        console.error('[Login] Error:', error)
        return { success: false, error: error instanceof Error ? error.message : '登录失败' }
      }
    }
  )

  // IPC: 轮询 IAM SSO 授权状态 (检查本地服务器是否收到回调)
  ipcMain.handle('poll-iam-sso-auth', async () => {
    if (!currentLoginState || currentLoginState.type !== 'iamsso') {
      return { success: false, error: '没有进行中的 IAM SSO 登录' }
    }

    if (Date.now() > (currentLoginState.expiresAt || 0)) {
      if (iamSsoServer) {
        iamSsoServer.close()
        iamSsoServer = null
      }
      iamSsoResult = null
      currentLoginState = null
      return { success: false, error: '授权已过期，请重新开始' }
    }

    // 检查是否已收到回调并完成 token 交换
    if (iamSsoResult) {
      const result = { ...iamSsoResult }
      if (result.completed) {
        // 清理状态
        if (iamSsoServer) {
          iamSsoServer.close()
          iamSsoServer = null
        }
        iamSsoResult = null
        currentLoginState = null
      }
      return result
    }

    // 还在等待回调
    return { success: true, completed: false, status: 'pending' }
  })

  // IPC: 取消 IAM SSO 登录
  ipcMain.handle('cancel-iam-sso-login', async () => {
    console.log('[Login] Cancelling IAM SSO login...')
    if (iamSsoServer) {
      iamSsoServer.close()
      iamSsoServer = null
    }
    iamSsoResult = null
    currentLoginState = null
    return { success: true }
  })

  // IPC: 用无痕模式打开任意 https 页面（快捷入口用）
  ipcMain.handle('open-url-private', (_event, url: string) => {
    if (typeof url !== 'string' || !/^https:\/\//.test(url)) {
      return { success: false, error: 'Only https URLs are allowed' }
    }
    openBrowserInPrivateMode(url)
    return { success: true }
  })

  // IPC: 启动 Social Auth 登录 (Google/GitHub)
  ipcMain.handle(
    'start-social-login',
    async (_event, provider: 'Google' | 'Github', usePrivateMode?: boolean) => {
      console.log(
        `[Login] Starting ${provider} Social Auth login... (privateMode: ${usePrivateMode})`
      )

      const crypto = await import('crypto')

      // 生成 PKCE
      const codeVerifier = crypto.randomBytes(64).toString('base64url').substring(0, 128)
      const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url')
      const oauthState = crypto.randomBytes(32).toString('base64url')

      // 构建登录 URL
      const redirectUri = 'kiro://kiro.kiroAgent/authenticate-success'
      const loginUrl = new URL(`${KIRO_AUTH_ENDPOINT}/login`)
      loginUrl.searchParams.set('idp', provider)
      loginUrl.searchParams.set('redirect_uri', redirectUri)
      loginUrl.searchParams.set('code_challenge', codeChallenge)
      loginUrl.searchParams.set('code_challenge_method', 'S256')
      loginUrl.searchParams.set('state', oauthState)

      // 保存登录状态
      currentLoginState = {
        type: 'social',
        codeVerifier,
        codeChallenge,
        oauthState,
        provider
      }

      const urlStr = loginUrl.toString()
      console.log(`[Login] Opening browser for ${provider} login...`)

      // 根据是否使用隐私模式选择打开方式
      if (usePrivateMode) {
        openBrowserInPrivateMode(urlStr)
      } else {
        shell.openExternal(urlStr)
      }

      return {
        success: true,
        loginUrl: urlStr,
        state: oauthState
      }
    }
  )

  // IPC: 交换 Social Auth token
  ipcMain.handle('exchange-social-token', async (_event, code: string, state: string) => {
    console.log('[Login] Exchanging Social Auth token...')

    if (!currentLoginState || currentLoginState.type !== 'social') {
      return { success: false, error: '没有进行中的社交登录' }
    }

    // 验证 state
    if (state !== currentLoginState.oauthState) {
      currentLoginState = null
      return { success: false, error: '状态参数不匹配，可能存在安全风险' }
    }

    const { codeVerifier, provider } = currentLoginState
    const redirectUri = 'kiro://kiro.kiroAgent/authenticate-success'

    try {
      const tokenRes = await fetchWithAppProxy(`${KIRO_AUTH_ENDPOINT}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code,
          code_verifier: codeVerifier,
          redirect_uri: redirectUri
        })
      })

      if (!tokenRes.ok) {
        const errText = await tokenRes.text()
        currentLoginState = null
        return { success: false, error: `Token 交换失败: ${errText}` }
      }

      const tokenData = await tokenRes.json()
      console.log('[Login] Token exchange successful!')

      const result = {
        success: true,
        accessToken: tokenData.accessToken,
        refreshToken: tokenData.refreshToken,
        profileArn: tokenData.profileArn,
        expiresIn: tokenData.expiresIn,
        authMethod: 'social' as const,
        provider
      }

      currentLoginState = null
      return result
    } catch (error) {
      console.error('[Login] Token exchange error:', error)
      currentLoginState = null
      return { success: false, error: error instanceof Error ? error.message : 'Token 交换失败' }
    }
  })

  // IPC: 取消 Social Auth 登录
  ipcMain.handle('cancel-social-login', async () => {
    console.log('[Login] Cancelling Social Auth login...')
    currentLoginState = null
    return { success: true }
  })

  // IPC: 设置代理
  ipcMain.handle('set-proxy', async (_event, enabled: boolean, url: string) => {
    const normalizedUrl = enabled && url ? normalizeProxyUrl(url) : url
    console.log(
      `[IPC] set-proxy called: enabled=${enabled}, url=${normalizedUrl}${normalizedUrl !== url ? ` (原始: ${url})` : ''}`
    )
    try {
      applyProxySettings(enabled, url)

      // 同时设置 Electron 的 session 代理
      if (mainWindow) {
        const session = mainWindow.webContents.session
        if (enabled && normalizedUrl) {
          await session.setProxy({ proxyRules: normalizedUrl })
        } else {
          await session.setProxy({ proxyRules: '' })
        }
      }

      return { success: true, normalizedUrl }
    } catch (error) {
      console.error('[Proxy] Failed to set proxy:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })

  // IPC: 获取账户可用模型列表
  ipcMain.handle(
    'account-get-models',
    async (
      _event,
      accessToken: string,
      region?: string,
      profileArn?: string,
      machineId?: string,
      provider?: string,
      authMethod?: string,
      accountId?: string
    ) => {
      try {
        const models = await fetchKiroModels({
          id: accountId || 'model-list-request',
          accessToken,
          region: region || 'us-east-1',
          profileArn,
          machineId,
          provider,
          authMethod: authMethod as ProxyAccount['authMethod']
        } as ProxyAccount)
        return {
          success: true,
          models: models.map((m) => ({
            id: m.modelId,
            name: m.modelName,
            description: m.description,
            inputTypes: m.supportedInputTypes,
            maxInputTokens: m.tokenLimits?.maxInputTokens,
            maxOutputTokens: m.tokenLimits?.maxOutputTokens,
            rateMultiplier: m.rateMultiplier,
            rateUnit: m.rateUnit
          }))
        }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get models',
          models: []
        }
      }
    }
  )

  // IPC: 获取可用订阅列表
  ipcMain.handle(
    'account-get-subscriptions',
    async (
      _event,
      accessToken: string,
      region?: string,
      profileArn?: string,
      machineId?: string,
      provider?: string,
      authMethod?: string,
      accountId?: string
    ) => {
      try {
        const run = (token: string) =>
          fetchAvailableSubscriptions({
            id: accountId || 'subscription-request',
            accessToken: token,
            region: region || 'us-east-1',
            profileArn,
            machineId,
            provider,
            authMethod
          } as ProxyAccount)
        let result = await run(accessToken)
        // accessToken 过期兜底：刷新后重试一次，并把新凭据带回 renderer 持久化（与检查续费/切 Free 一致）。
        // 403 多为 token 失效但 AWS 响应体文案不统一，一并触发刷新重试
        if (
          !result.subscriptionPlans &&
          accountId &&
          (isTokenExpiredError(result.error) || result.error?.includes('HTTP 403'))
        ) {
          const refreshed = await refreshAccountAccessToken(accountId)
          if (refreshed) {
            result = await run(refreshed.accessToken)
            if (result.subscriptionPlans) {
              return {
                success: true,
                plans: result.subscriptionPlans,
                disclaimer: result.disclaimer,
                credentials: refreshed
              }
            }
          }
        }
        if (result.subscriptionPlans) {
          return {
            success: true,
            plans: result.subscriptionPlans,
            disclaimer: result.disclaimer
          }
        }
        return {
          success: false,
          error: result.error || 'No subscription plans returned',
          plans: []
        }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get subscriptions',
          plans: []
        }
      }
    }
  )

  // IPC: 获取订阅管理/支付链接（dynamicProxy 传入时每条链接经一个提链一次性端点发出）
  ipcMain.handle(
    'account-get-subscription-url',
    async (
      _event,
      accessToken: string,
      subscriptionType?: string,
      region?: string,
      profileArn?: string,
      machineId?: string,
      provider?: string,
      authMethod?: string,
      accountId?: string,
      dynamicProxy?: { url: string; viaProxy?: string; batchSize?: number },
      exitProxyUrl?: string
    ) => {
      // 提链出口路由（可选）：探测确认后返回，用完释放本地中继
      let releaseExit: (() => Promise<void>) | null = null
      // 本条链接实际使用的提链出口 IP（回传给订阅页展示；直连/账号代理时为空）
      let exitIp: string | undefined
      try {
        const account = {
          id: accountId || 'subscription-request',
          accessToken,
          region: region || 'us-east-1',
          profileArn,
          machineId,
          provider,
          authMethod
        } as ProxyAccount
        if (dynamicProxy?.url) {
          const cfg = {
            url: dynamicProxy.url,
            viaProxy: resolveViaProxy(dynamicProxy.viaProxy),
            batchSize: Math.min(20, Math.max(1, Math.round(dynamicProxy.batchSize ?? 5)))
          }
          const route = await acquireDynamicExit(
            getSharedDynamicSource(cfg),
            cfg.viaProxy,
            (level, msg) => console.log(`[订阅提链 ${level}] ${msg}`)
          )
          releaseExit = route.release
          exitIp = route.exitIp
          // getNetworkAgent 的第一优先级就是 account.proxyUrl，挂上本地中继即整条请求走提链出口
          account.proxyUrl = route.proxyRules
        } else if (exitProxyUrl && exitProxyUrl.trim()) {
          // 静态出口（订阅页下拉选的代理池条目，支持 hy2）：解析失败直接报错——
          // 用户显式指定的出口不该静默回退直连裸奔
          const resolvedExit = (await resolveProxyUrl(exitProxyUrl.trim())) || exitProxyUrl.trim()
          account.proxyUrl = resolvedExit
          // 探一次出口 IP 供列表展示（失败不阻断取链接，仅无 IP 列）
          const probe = await probeExitIp(resolvedExit).catch(() => undefined)
          exitIp = probe?.ip
        }
        const result = await fetchSubscriptionToken(account, subscriptionType)
        if (result.encodedVerificationUrl) {
          return { success: true, url: result.encodedVerificationUrl, status: result.status, exitIp }
        }
        return { success: false, error: result.message || 'No subscription URL returned', exitIp }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get subscription URL',
          exitIp
        }
      } finally {
        if (releaseExit) await releaseExit().catch(() => undefined)
      }
    }
  )

  // IPC: 设置用户偏好（超额开启/关闭）
  ipcMain.handle(
    'account-set-overage',
    async (
      _event,
      accessToken: string,
      overageStatus: 'ENABLED' | 'DISABLED',
      region?: string,
      profileArn?: string,
      machineId?: string,
      provider?: string,
      authMethod?: string,
      accountId?: string
    ) => {
      try {
        const result = await setUserPreference(
          {
            id: accountId || 'subscription-request',
            accessToken,
            region: region || 'us-east-1',
            profileArn,
            machineId,
            provider,
            authMethod
          } as ProxyAccount,
          overageStatus
        )
        return result
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to set overage'
        }
      }
    }
  )

  // IPC: 在系统默认浏览器无痕模式中打开订阅链接
  ipcMain.handle('open-subscription-window', async (_event, url: string) => {
    try {
      openBrowserInPrivateMode(url)
      return { success: true }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to open URL'
      }
    }
  })

  // IPC: 以指定账号身份在应用内私密浏览器打开 Kiro 官网后台（注入凭证 cookie，免登录）
  ipcMain.handle('account-open-portal', async (_event, accountId: string) => {
    // 账号库里取出的最小字段视图（凭据只在主进程读取，不下发渲染层）
    type PortalAccountRecord = {
      email?: string
      idp?: string
      profileArn?: string
      machineId?: string
      credentials?: {
        accessToken?: string
        refreshToken?: string
        profileArn?: string
        region?: string
        provider?: string
        authMethod?: string
        expiresAt?: number
      }
    }
    try {
      const data = getAccountData() as { accounts?: Record<string, PortalAccountRecord> } | null
      const acc = data?.accounts?.[accountId]
      if (!acc) return { success: false, error: '账号不存在' }
      const cred = acc.credentials || {}
      if (!cred.accessToken && !cred.refreshToken) {
        return { success: false, error: '账号缺少凭证，无法登录官网' }
      }
      // accessToken 临期/过期时先刷新一次，过期 token 进门户会被按未登录处理
      let accessToken: string | undefined = cred.accessToken
      if (
        accessToken &&
        typeof cred.expiresAt === 'number' &&
        cred.expiresAt - 60_000 < Date.now()
      ) {
        const refreshed = await refreshAccountAccessToken(accountId)
        if (refreshed?.accessToken) accessToken = refreshed.accessToken
      }
      await openAccountPortal({
        id: accountId,
        email: acc.email || '',
        idp: acc.idp,
        profileArn: acc.profileArn,
        machineId: acc.machineId,
        credentials: {
          accessToken,
          refreshToken: cred.refreshToken,
          profileArn: cred.profileArn,
          region: cred.region,
          provider: cred.provider,
          authMethod: cred.authMethod
        }
      })
      return { success: true }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to open portal'
      }
    }
  })

  // IPC: 自动把账号订阅切到 Free（走 Stripe 门户纯 HTTP 链路；dryRun 只读不提交）
  ipcMain.handle(
    'account-switch-plan-free',
    async (
      _event,
      accessToken: string,
      region?: string,
      profileArn?: string,
      machineId?: string,
      provider?: string,
      authMethod?: string,
      accountId?: string,
      dryRun?: boolean
    ) => {
      try {
        const run = (token: string) =>
          switchSubscriptionToFree(
            {
              id: accountId || 'switch-free-request',
              accessToken: token,
              region: region || 'us-east-1',
              profileArn,
              machineId,
              provider,
              authMethod
            } as ProxyAccount,
            { dryRun: dryRun === true }
          )
        let result = await run(accessToken)
        // accessToken 过期兜底：刷新后重试一次，并把新凭据带回 renderer 持久化
        if (!result.success && accountId && isTokenExpiredError(result.error)) {
          const refreshed = await refreshAccountAccessToken(accountId)
          if (refreshed) {
            result = await run(refreshed.accessToken)
            if (result.success) return { ...result, credentials: refreshed }
          }
        }
        return result
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to switch plan'
        }
      }
    }
  )

  // IPC: 只读检查订阅续费状态（cancel_at_period_end）
  ipcMain.handle(
    'account-check-renewal',
    async (
      _event,
      accessToken: string,
      region?: string,
      profileArn?: string,
      machineId?: string,
      provider?: string,
      authMethod?: string,
      accountId?: string
    ) => {
      try {
        const run = (token: string) =>
          checkRenewalStatus({
            id: accountId || 'check-renewal-request',
            accessToken: token,
            region: region || 'us-east-1',
            profileArn,
            machineId,
            provider,
            authMethod
          } as ProxyAccount)
        let result = await run(accessToken)
        // accessToken 过期兜底：刷新后重试一次，并把新凭据带回 renderer 持久化
        if (!result.success && accountId && isTokenExpiredError(result.error)) {
          const refreshed = await refreshAccountAccessToken(accountId)
          if (refreshed) {
            result = await run(refreshed.accessToken)
            if (result.success) return { ...result, credentials: refreshed }
          }
        }
        return result
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to check renewal'
        }
      }
    }
  )

  // IPC: 获取 Usage API 类型
  ipcMain.handle('get-usage-api-type', () => {
    return getUsageApiType()
  })

  // IPC: 设置 Usage API 类型
  ipcMain.handle('set-usage-api-type', (_event, type: 'rest' | 'cbor') => {
    setUsageApiType(type)
    if (store) {
      store.set('usageApiType', type)
    }
    return { success: true, type }
  })

  // IPC: 获取是否使用 K-Proxy 代理
  ipcMain.handle('get-use-kproxy-for-api', () => {
    return useKProxyForApi
  })

  // IPC: 设置是否使用 K-Proxy 代理
  ipcMain.handle('set-use-kproxy-for-api', (_event, enabled: boolean) => {
    setUseKProxyForApi(enabled)
    if (store) {
      store.set('useKProxyForApi', enabled)
    }
    return { success: true, enabled }
  })

  // ============ K-Proxy MITM 代理 IPC ============

  // IPC: 初始化 K-Proxy 服务
  ipcMain.handle('kproxy-init', async () => {
    try {
      const savedConfig = store?.get('kproxyConfig') as Partial<KProxyConfig> | undefined
      const service = initKProxyService(savedConfig || {}, {
        onRequest: (info) => {
          mainWindow?.webContents.send('kproxy-request', info)
        },
        onResponse: (info) => {
          mainWindow?.webContents.send('kproxy-response', info)
        },
        onError: (error) => {
          console.error('[KProxy] Error:', error)
          mainWindow?.webContents.send('kproxy-error', error.message)
        },
        onStatusChange: (running, port) => {
          mainWindow?.webContents.send('kproxy-status-change', { running, port })
        },
        onMitmIntercept: (host, modified) => {
          mainWindow?.webContents.send('kproxy-mitm', { host, modified })
        }
      })
      const caInfo = await service.initialize()
      return {
        success: true,
        caInfo: {
          certPath: caInfo.certPath,
          fingerprint: caInfo.fingerprint,
          validFrom: caInfo.validFrom.toISOString(),
          validTo: caInfo.validTo.toISOString()
        }
      }
    } catch (error) {
      console.error('[KProxy] Init failed:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to init K-Proxy'
      }
    }
  })

  // IPC: 启动 K-Proxy
  ipcMain.handle('kproxy-start', async (_event, config?: Partial<KProxyConfig>) => {
    try {
      const service = getKProxyService()
      if (!service) {
        return { success: false, error: 'K-Proxy not initialized' }
      }
      if (config) {
        service.updateConfig(config)
      }
      await service.start()
      // 保存配置
      if (store) {
        store.set('kproxyConfig', service.getConfig())
      }
      return { success: true, port: service.getConfig().port }
    } catch (error) {
      console.error('[KProxy] Start failed:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to start K-Proxy'
      }
    }
  })

  // IPC: 停止 K-Proxy
  ipcMain.handle('kproxy-stop', async () => {
    try {
      const service = getKProxyService()
      if (service) {
        await service.stop()
      }
      return { success: true }
    } catch (error) {
      console.error('[KProxy] Stop failed:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to stop K-Proxy'
      }
    }
  })

  // IPC: 获取 K-Proxy 状态
  ipcMain.handle('kproxy-get-status', () => {
    const service = getKProxyService()
    if (!service) {
      const savedConfig = store?.get('kproxyConfig') as KProxyConfig | undefined
      return { running: false, config: savedConfig || null, stats: null, caInfo: null }
    }
    return {
      running: service.isRunning(),
      config: service.getConfig(),
      stats: service.getStats(),
      caInfo: service.getCACertInfo()
    }
  })

  // IPC: 更新 K-Proxy 配置
  ipcMain.handle('kproxy-update-config', async (_event, config: Partial<KProxyConfig>) => {
    try {
      const service = getKProxyService()
      if (!service) {
        return { success: false, error: 'K-Proxy not initialized' }
      }
      service.updateConfig(config)
      const newConfig = service.getConfig()
      if (store) {
        store.set('kproxyConfig', newConfig)
      }
      return { success: true, config: newConfig }
    } catch (error) {
      console.error('[KProxy] Update config failed:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to update config'
      }
    }
  })

  // IPC: 设置当前设备 ID
  ipcMain.handle('kproxy-set-device-id', (_event, deviceId: string) => {
    try {
      if (!isValidDeviceId(deviceId)) {
        return { success: false, error: 'Invalid device ID format (must be 64 hex characters)' }
      }
      const service = getKProxyService()
      if (!service) {
        return { success: false, error: 'K-Proxy not initialized' }
      }
      service.setDeviceId(deviceId)
      return { success: true }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to set device ID'
      }
    }
  })

  // IPC: 生成新的设备 ID
  ipcMain.handle('kproxy-generate-device-id', () => {
    return { success: true, deviceId: generateDeviceId() }
  })

  // IPC: 添加设备 ID 映射
  ipcMain.handle('kproxy-add-device-mapping', (_event, mapping: DeviceIdMapping) => {
    try {
      const service = getKProxyService()
      if (!service) {
        return { success: false, error: 'K-Proxy not initialized' }
      }
      service.addDeviceIdMapping(mapping)
      // 保存映射
      const mappings = service.getAllDeviceIdMappings()
      if (store) {
        store.set('kproxyDeviceMappings', mappings)
      }
      return { success: true }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to add mapping'
      }
    }
  })

  // IPC: 获取所有设备 ID 映射
  ipcMain.handle('kproxy-get-device-mappings', () => {
    const service = getKProxyService()
    if (!service) {
      const savedMappings = store?.get('kproxyDeviceMappings') as DeviceIdMapping[] | undefined
      return { success: true, mappings: savedMappings || [] }
    }
    return { success: true, mappings: service.getAllDeviceIdMappings() }
  })

  // IPC: 切换到账号设备 ID
  ipcMain.handle('kproxy-switch-to-account', (_event, accountId: string) => {
    try {
      const service = getKProxyService()
      if (!service) {
        return { success: false, error: 'K-Proxy not initialized' }
      }
      const switched = service.switchToAccount(accountId)
      return { success: switched, error: switched ? undefined : 'No device ID mapping for account' }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to switch account'
      }
    }
  })

  // IPC: 获取 CA 证书 PEM（用于导出/安装）
  ipcMain.handle('kproxy-get-ca-cert', () => {
    const service = getKProxyService()
    if (!service) {
      return { success: false, error: 'K-Proxy not initialized' }
    }
    const certPem = service.getCACertPem()
    const caInfo = service.getCACertInfo()
    if (!certPem || !caInfo) {
      return { success: false, error: 'CA certificate not available' }
    }
    return {
      success: true,
      certPem,
      certPath: caInfo.certPath,
      fingerprint: caInfo.fingerprint
    }
  })

  // IPC: 导出 CA 证书到指定路径
  ipcMain.handle('kproxy-export-ca-cert', async (_event, exportPath?: string) => {
    try {
      const service = getKProxyService()
      if (!service) {
        return { success: false, error: 'K-Proxy not initialized' }
      }
      const certPem = service.getCACertPem()
      if (!certPem) {
        return { success: false, error: 'CA certificate not available' }
      }

      let targetPath = exportPath
      if (!targetPath) {
        const result = await dialog.showSaveDialog({
          title: 'Export CA Certificate',
          defaultPath: 'kproxy-ca.crt',
          filters: [{ name: 'Certificate', extensions: ['crt', 'pem'] }]
        })
        if (result.canceled || !result.filePath) {
          return { success: false, error: 'Export cancelled' }
        }
        targetPath = result.filePath
      }

      await writeFile(targetPath, certPem, 'utf-8')
      return { success: true, path: targetPath }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to export certificate'
      }
    }
  })

  // IPC: 重置 K-Proxy 统计
  ipcMain.handle('kproxy-reset-stats', () => {
    const service = getKProxyService()
    if (service) {
      service.resetStats()
    }
    return { success: true }
  })

  // IPC: 检查 CA 证书是否已安装到系统信任存储
  ipcMain.handle('kproxy-check-ca-cert-installed', async () => {
    try {
      const service = getKProxyService()
      if (!service) {
        return { success: false, installed: false, error: 'K-Proxy not initialized' }
      }

      const { execSync } = await import('child_process')
      const platform = process.platform

      if (platform === 'win32') {
        // Windows: 使用 certutil 检查证书
        try {
          const output = execSync('certutil -store -user Root "K-Proxy CA"', { encoding: 'utf-8' })
          return { success: true, installed: output.includes('K-Proxy CA') }
        } catch {
          return { success: true, installed: false }
        }
      } else if (platform === 'darwin') {
        // macOS: 使用 security 命令检查
        try {
          execSync(
            'security find-certificate -c "K-Proxy CA" ~/Library/Keychains/login.keychain-db',
            { encoding: 'utf-8' }
          )
          return { success: true, installed: true }
        } catch {
          return { success: true, installed: false }
        }
      } else {
        // Linux: 检查文件是否存在
        const fs = await import('fs')
        const targetPath = '/usr/local/share/ca-certificates/kproxy-ca.crt'
        return { success: true, installed: fs.existsSync(targetPath) }
      }
    } catch (error) {
      console.error('[KProxy] Check CA cert installed failed:', error)
      return {
        success: false,
        installed: false,
        error: error instanceof Error ? error.message : 'Check failed'
      }
    }
  })

  // IPC: 安装 CA 证书到系统信任存储
  ipcMain.handle('kproxy-install-ca-cert', async () => {
    try {
      const service = getKProxyService()
      if (!service) {
        return { success: false, error: 'K-Proxy not initialized' }
      }
      const caInfo = service.getCACertInfo()
      if (!caInfo) {
        return { success: false, error: 'CA certificate not available' }
      }

      const { execSync } = await import('child_process')
      const platform = process.platform

      if (platform === 'win32') {
        // Windows: 使用 certutil 安装到根证书存储
        try {
          execSync(`certutil -addstore -user Root "${caInfo.certPath}"`, { encoding: 'utf-8' })
          return { success: true, message: 'CA certificate installed to Windows certificate store' }
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error)
          if (errMsg.includes('already in store') || errMsg.includes('已在存储中')) {
            return { success: true, message: 'CA certificate already installed' }
          }
          throw error
        }
      } else if (platform === 'darwin') {
        // macOS: 使用 security 命令安装到钥匙串
        execSync(
          `security add-trusted-cert -r trustRoot -k ~/Library/Keychains/login.keychain-db "${caInfo.certPath}"`
        )
        return { success: true, message: 'CA certificate installed to macOS Keychain' }
      } else {
        // Linux: 复制到系统 CA 目录
        const fs = await import('fs')
        const targetPath = '/usr/local/share/ca-certificates/kproxy-ca.crt'
        fs.copyFileSync(caInfo.certPath, targetPath)
        execSync('sudo update-ca-certificates')
        return { success: true, message: 'CA certificate installed to Linux CA store' }
      }
    } catch (error) {
      console.error('[KProxy] Install CA cert failed:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to install certificate'
      }
    }
  })

  // IPC: 卸载 CA 证书从系统信任存储
  ipcMain.handle('kproxy-uninstall-ca-cert', async () => {
    try {
      const { execSync } = await import('child_process')
      const platform = process.platform

      if (platform === 'win32') {
        // Windows: 使用 certutil 删除证书
        try {
          execSync('certutil -delstore -user Root "K-Proxy CA"', { encoding: 'utf-8' })
          return { success: true, message: 'CA certificate removed from Windows certificate store' }
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error)
          if (errMsg.includes('not found') || errMsg.includes('找不到')) {
            return { success: true, message: 'CA certificate not found in store' }
          }
          throw error
        }
      } else if (platform === 'darwin') {
        // macOS: 使用 security 命令删除
        execSync(
          'security delete-certificate -c "K-Proxy CA" ~/Library/Keychains/login.keychain-db'
        )
        return { success: true, message: 'CA certificate removed from macOS Keychain' }
      } else {
        // Linux: 删除证书并更新
        const fs = await import('fs')
        const targetPath = '/usr/local/share/ca-certificates/kproxy-ca.crt'
        if (fs.existsSync(targetPath)) {
          fs.unlinkSync(targetPath)
          execSync('sudo update-ca-certificates --fresh')
        }
        return { success: true, message: 'CA certificate removed from Linux CA store' }
      }
    } catch (error) {
      console.error('[KProxy] Uninstall CA cert failed:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to uninstall certificate'
      }
    }
  })

  // ============ MCP 服务器管理 IPC ============

  // IPC: 保存 MCP 服务器配置
  ipcMain.handle(
    'save-mcp-server',
    async (
      _event,
      name: string,
      config: { command: string; args?: string[]; env?: Record<string, string> },
      oldName?: string
    ) => {
      try {
        const os = await import('os')
        const fs = await import('fs')
        const path = await import('path')
        const homeDir = os.homedir()
        const mcpPath = path.join(homeDir, '.kiro', 'settings', 'mcp.json')

        // 读取现有配置
        let mcpConfig: { mcpServers: Record<string, unknown> } = { mcpServers: {} }
        if (fs.existsSync(mcpPath)) {
          const content = fs.readFileSync(mcpPath, 'utf-8')
          mcpConfig = JSON.parse(content)
        }

        // 如果是重命名，先删除旧的
        if (oldName && oldName !== name) {
          delete mcpConfig.mcpServers[oldName]
        }

        // 添加/更新服务器
        mcpConfig.mcpServers[name] = config

        // 确保目录存在
        const dir = path.dirname(mcpPath)
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true })
        }

        fs.writeFileSync(mcpPath, JSON.stringify(mcpConfig, null, 2))
        console.log('[KiroSettings] Saved MCP server:', name)
        return { success: true }
      } catch (error) {
        console.error('[KiroSettings] Failed to save MCP server:', error)
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to save MCP server'
        }
      }
    }
  )

  // IPC: 删除 MCP 服务器
  ipcMain.handle('delete-mcp-server', async (_event, name: string) => {
    try {
      const os = await import('os')
      const fs = await import('fs')
      const path = await import('path')
      const homeDir = os.homedir()
      const mcpPath = path.join(homeDir, '.kiro', 'settings', 'mcp.json')

      if (!fs.existsSync(mcpPath)) {
        return { success: false, error: '配置文件不存在' }
      }

      const content = fs.readFileSync(mcpPath, 'utf-8')
      const mcpConfig = JSON.parse(content)

      if (!mcpConfig.mcpServers || !mcpConfig.mcpServers[name]) {
        return { success: false, error: '服务器不存在' }
      }

      delete mcpConfig.mcpServers[name]
      fs.writeFileSync(mcpPath, JSON.stringify(mcpConfig, null, 2))
      console.log('[KiroSettings] Deleted MCP server:', name)
      return { success: true }
    } catch (error) {
      console.error('[KiroSettings] Failed to delete MCP server:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to delete MCP server'
      }
    }
  })

  // IPC: 删除 Steering 文件
  ipcMain.handle('delete-kiro-steering-file', async (_event, filename: string) => {
    try {
      const os = await import('os')
      const fs = await import('fs')
      const path = await import('path')
      const homeDir = os.homedir()
      const filePath = path.join(homeDir, '.kiro', 'steering', filename)

      if (!fs.existsSync(filePath)) {
        return { success: false, error: '文件不存在' }
      }

      fs.unlinkSync(filePath)
      console.log('[KiroSettings] Deleted steering file:', filePath)
      return { success: true }
    } catch (error) {
      console.error('[KiroSettings] Failed to delete steering file:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to delete file'
      }
    }
  })

  // ============ 机器码管理 IPC ============

  // IPC: 获取操作系统类型
  ipcMain.handle('machine-id:get-os-type', () => {
    return machineIdModule.getOSType()
  })

  // IPC: 获取当前机器码
  ipcMain.handle('machine-id:get-current', async () => {
    console.log('[MachineId] Getting current machine ID...')
    return await machineIdModule.getCurrentMachineId()
  })

  // IPC: 设置新机器码
  ipcMain.handle('machine-id:set', async (_event, newMachineId: string) => {
    console.log('[MachineId] Setting new machine ID:', newMachineId.substring(0, 8) + '...')
    const result = await machineIdModule.setMachineId(newMachineId)

    if (!result.success && result.requiresAdmin) {
      // 弹窗询问用户是否以管理员权限重启
      const shouldRestart = await machineIdModule.showAdminRequiredDialog()
      if (shouldRestart) {
        await machineIdModule.requestAdminRestart()
      }
    }

    return result
  })

  // IPC: 生成随机机器码
  ipcMain.handle('machine-id:generate-random', () => {
    return machineIdModule.generateRandomMachineId()
  })

  // IPC: 检查管理员权限
  ipcMain.handle('machine-id:check-admin', async () => {
    return await machineIdModule.checkAdminPrivilege()
  })

  // IPC: 请求管理员权限重启
  ipcMain.handle('machine-id:request-admin-restart', async () => {
    const shouldRestart = await machineIdModule.showAdminRequiredDialog()
    if (shouldRestart) {
      return await machineIdModule.requestAdminRestart()
    }
    return false
  })

  // IPC: 备份机器码到文件
  ipcMain.handle('machine-id:backup-to-file', async (_event, machineId: string) => {
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: '备份机器码',
      defaultPath: 'machine-id-backup.json',
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })

    if (result.canceled || !result.filePath) {
      return false
    }

    return await machineIdModule.backupMachineIdToFile(machineId, result.filePath)
  })

  // IPC: 从文件恢复机器码
  ipcMain.handle('machine-id:restore-from-file', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: '恢复机器码',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile']
    })

    if (result.canceled || !result.filePaths[0]) {
      return { success: false, error: '用户取消' }
    }

    return await machineIdModule.restoreMachineIdFromFile(result.filePaths[0])
  })

  // 更新协议处理函数以支持 Social Auth 回调
  const originalHandleProtocolUrl = handleProtocolUrl
  // @ts-ignore - 重新定义协议处理
  handleProtocolUrl = (url: string): void => {
    if (!url.startsWith(`${PROTOCOL_PREFIX}://`)) return

    try {
      const urlObj = new URL(url)

      // 处理 Social Auth 回调 (kiro://kiro.kiroAgent/authenticate-success)
      if (url.includes('authenticate-success') || url.includes('auth')) {
        const code = urlObj.searchParams.get('code')
        const state = urlObj.searchParams.get('state')
        const error = urlObj.searchParams.get('error')

        if (error) {
          console.log('[Login] Auth callback error:', error)
          if (mainWindow) {
            mainWindow.webContents.send('social-auth-callback', { error })
            mainWindow.focus()
          }
          return
        }

        if (code && state && mainWindow) {
          console.log('[Login] Auth callback received, code:', code.substring(0, 20) + '...')
          mainWindow.webContents.send('social-auth-callback', { code, state })
          mainWindow.focus()
        }
        return
      }

      // 调用原始处理函数处理其他协议
      originalHandleProtocolUrl(url)
    } catch (error) {
      console.error('Failed to parse protocol URL:', error)
    }
  }

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    } else if (mainWindow) {
      // macOS: 点击 Dock 图标时显示主窗口
      if (process.platform === 'darwin' && app.dock) {
        app.dock.show()
      }
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })

  // 加载并注册全局快捷键
  await loadShortcutSettings()
  registerShowWindowShortcut()
})

// Windows/Linux: 处理第二个实例和协议 URL
const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, commandLine) => {
    // Windows: 协议 URL 会作为命令行参数传入
    const url = commandLine.find((arg) => arg.startsWith(`${PROTOCOL_PREFIX}://`))
    if (url) {
      handleProtocolUrl(url)
    }

    // 聚焦主窗口
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
}

// macOS: 处理协议 URL
app.on('open-url', (_event, url) => {
  handleProtocolUrl(url)
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// 应用退出前注销 URI 协议处理器并保存数据
app.on('will-quit', async (event) => {
  // 防止重复处理
  if (isQuitting) return

  // 回收全部 hy2 桥 sing-box 子进程(同步 kill,不阻塞退出)
  shutdownProxyBridge()

  // 停止主进程池 token 刷新调度器
  stopMainPoolTokenRefresh()

  // 防止应用立即退出，先保存数据
  if (lastSavedData && store) {
    event.preventDefault()
    isQuitting = true

    // 设置超时，确保 3 秒后强制退出（防止关机阻塞）
    const forceQuitTimer = setTimeout(() => {
      console.log('[Exit] Force quit due to timeout')
      unregisterProtocol()
      app.exit(0)
    }, 3000)

    try {
      console.log('[Exit] Saving data before quit...')
      saveAccountData(lastSavedData as Record<string, unknown>)
      // 退出场景跳过节流，确保备份立即落盘
      await createBackup(lastSavedData)
      await flushBackupNow()
      // 强制落盘代理日志（异步节流中的尾巴数据）
      try {
        const { proxyLogStore } = await import('./proxy/logger')
        await proxyLogStore.flushSaveNow()
      } catch (err) {
        console.error('[Exit] Failed to flush proxy logs:', err)
      }
      // 释放共享的 TLS ModuleClient（worker pool + DLL）
      try {
        const { shutdownTlsClientPool } = await import('./registration/tlsClientPool')
        await shutdownTlsClientPool()
      } catch (err) {
        console.error('[Exit] Failed to shutdown TLS client pool:', err)
      }
      // 关闭 SQLite 账号库（WAL checkpoint）
      try {
        const { closeAccountDb } = await import('./accountDb')
        closeAccountDb()
      } catch (err) {
        console.error('[Exit] Failed to close account db:', err)
      }
      // 闲置账号库：退出前强制落盘备份并关闭（同主库机制）
      try {
        if (lastSavedIdleData) {
          await createIdleBackup(lastSavedIdleData)
          await flushIdleBackupNow()
        }
      } catch (err) {
        console.error('[Exit] Failed to flush idle backup:', err)
      }
      try {
        closeIdleAccountDb()
      } catch (err) {
        console.error('[Exit] Failed to close idle account db:', err)
      }
      console.log('[Exit] Data saved successfully')
    } catch (error) {
      console.error('[Exit] Failed to save data:', error)
    }

    clearTimeout(forceQuitTimer)
    unregisterProtocol()
    app.exit(0)
  } else {
    // 无待保存数据时也要释放闲置库（同步关闭，WAL 可自动恢复）
    try {
      closeIdleAccountDb()
    } catch {
      /* ignore */
    }
    unregisterProtocol()
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
