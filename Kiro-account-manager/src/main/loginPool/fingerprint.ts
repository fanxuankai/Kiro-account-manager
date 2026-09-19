// 登录窗口浏览器指纹对齐
//
// GitHub 登录风控（DataDome）做上百信号的一致性校验，任何一处自相矛盾都是
// 自动化特征：UA 自称 Google Chrome 而 sec-ch-ua 品牌只有 Chromium、出口 IP
// 在海外而 Intl 时区还是本机、请求头 Accept-Language 与 navigator.language
// 对不上、WebRTC 枚举出代理背后的本机 IP——本模块把这些信号统一成
// 「与出口 IP 地理位置一致的普通 Chrome」：
//   - 请求头层（session）：UA / Accept-Language / sec-ch-ua 三件套 + 清 Electron 残留头
//   - 页面层（CDP Emulation）：navigator.language（setUserAgent 改不了 JS 侧）、
//     Intl 时区、client hints 元数据（品牌/完整版本/平台/CPU 架构）
//   - 权限形状：通知权限对齐真无痕 Chrome 的 denied（Electron 默认 granted）
//   - window.chrome：空对象补齐为真 Chrome 的 app/csi/loadTimes 形状
//   - WebRTC：禁非代理 UDP，防枚举真实 IP
// CDP 只用 Emulation/Page 的初始化脚本注入，不 enable Runtime/Debugger——那类域
// 会改 console 行为，留下可被页面检测的痕迹。

import { app, type BrowserWindow, type Session } from 'electron'
import { totalmem } from 'node:os'
import { fetch as undiciFetch } from 'undici'

/** UA 主版本取内置 Chromium 而不是写死：UA 声称的版本与引擎能力对不上本身就是破绽 */
const CHROME_MAJOR = process.versions.chrome.split('.')[0] || '134'

/** sec-ch-ua 的 GREASE 占位品牌随 Chromium 大版本轮换，必须与引擎真实值一致——
 *  Electron 38(Chromium 140)原生 userAgentData 报 "Not=A?Brand"（实测），升级 Electron 时需对照更新 */
const CHROME_GREASE = 'Not=A?Brand'

/** UA 平台段与 sec-ch-ua-platform 必须同源（process.platform），跨平台跑不穿帮 */
function platformToken(): string {
  if (process.platform === 'win32') return 'Windows NT 10.0; Win64; x64'
  if (process.platform === 'linux') return 'X11; Linux x86_64'
  return 'Macintosh; Intel Mac OS X 10_15_7'
}
function platformBrand(): string {
  if (process.platform === 'win32') return 'Windows'
  if (process.platform === 'linux') return 'Linux'
  return 'macOS'
}

export const CHROME_UA =
  `Mozilla/5.0 (${platformToken()}) AppleWebKit/537.36 (KHTML, like Gecko) ` +
  `Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`

/** 客户端提示要与 UA 对齐，两者矛盾反而更容易被判异常 */
const SEC_CH_UA = `"Chromium";v="${CHROME_MAJOR}", "${CHROME_GREASE}";v="24", "Google Chrome";v="${CHROME_MAJOR}"`

export interface FingerprintEnv {
  /** BCP 47 语言标签（页面 locale 与 navigator.language 用） */
  locale: string
  /** IANA 时区 */
  timezone: string
  /** 出口国家码（仅日志展示用） */
  country?: string
  /** 出口 IP（仅日志展示用） */
  exitIp?: string
  /** 环境来源：出口 geo 推导 / 直连本机 / geo 查不到时的回退 */
  source: 'exit-geo' | 'direct' | 'geo-fallback'
}

function localTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Etc/UTC'
  } catch {
    return 'Etc/UTC'
  }
}

function acceptLanguageFor(locale: string): string {
  return locale === 'zh-CN' ? 'zh-CN,zh;q=0.9,en;q=0.8' : 'en-US,en;q=0.9'
}

/** navigator.language(s) 必须是纯 BCP 47 标签——真 Chrome 是 ['zh-CN','zh']，
 *  带 q 值的 Accept-Language 串（zh;q=0.9）喂给 CDP/setUserAgent 会污染
 *  navigator.languages，是实测对齐时发现的破绽；q 值只留在 HTTP 头里 */
function navigatorLanguageFor(locale: string): string {
  return locale === 'zh-CN' ? 'zh-CN,zh' : 'en-US,en'
}

function localeForCountry(country: string): string {
  return country === 'CN' ? 'zh-CN' : 'en-US'
}

/** 时区串必须能被 Intl 接受，脏数据会把 CDP 命令打挂 */
function isValidTimezone(tz: string): boolean {
  if (!tz) return false
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz }).format(0)
    return true
  } catch {
    return false
  }
}

// ── 出口 IP 归属地查询 ────────────────────────────────────────────────

interface GeoResult {
  country: string
  timezone: string
}

/** ipwho.is → ipapi.co 依次尝试；从本机直连查数据库即可，与请求路径无关 */
async function lookupExitGeo(exitIp: string, timeoutMs = 5_000): Promise<GeoResult | null> {
  const attempts: Array<() => Promise<GeoResult | null>> = [
    async () => {
      const r = await undiciFetch(`https://ipwho.is/${encodeURIComponent(exitIp)}`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs)
      })
      if (!r.ok) return null
      const d = (await r.json()) as {
        success?: boolean
        country_code?: string
        timezone?: { id?: string }
      }
      if (!d.success || !d.country_code || !isValidTimezone(d.timezone?.id || '')) return null
      return { country: d.country_code.toUpperCase(), timezone: d.timezone!.id! }
    },
    async () => {
      const r = await undiciFetch(
        `https://get.geojs.io/v1/ip/geo/${encodeURIComponent(exitIp)}.json`,
        {
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(timeoutMs)
        }
      )
      if (!r.ok) return null
      const d = (await r.json()) as { country_code?: string; timezone?: string }
      if (!d.country_code || !isValidTimezone(d.timezone || '')) return null
      return { country: d.country_code.toUpperCase(), timezone: d.timezone! }
    }
  ]
  for (const attempt of attempts) {
    try {
      const hit = await attempt()
      if (hit) return hit
    } catch {
      /* 换下一个服务 */
    }
  }
  return null
}

/**
 * 解析该号应使用的指纹环境：
 * - 走出口代理：时区/语言跟随出口 IP 的归属地（geo 查不到则语言 en-US、
 *   时区退本机——海外出口配英文是相对最不矛盾的组合）；
 * - 直连：本机时区 + 应用语言（IP 与环境天然一致，无需伪装）。
 */
export async function resolveFingerprintEnv(exitIp: string | null): Promise<FingerprintEnv> {
  if (exitIp) {
    const geo = await lookupExitGeo(exitIp)
    if (geo) {
      return {
        source: 'exit-geo',
        locale: localeForCountry(geo.country),
        timezone: geo.timezone,
        country: geo.country,
        exitIp
      }
    }
    return { source: 'geo-fallback', locale: 'en-US', timezone: localTimezone(), exitIp }
  }
  return { source: 'direct', locale: app.getLocale() || 'en-US', timezone: localTimezone() }
}

/** 指纹对齐日志的统一描述：出口来源、伪装身份一目了然 */
export function describeFingerprint(env: FingerprintEnv): string {
  const where =
    env.source === 'direct'
      ? '直连（本机环境）'
      : env.source === 'geo-fallback'
        ? `出口 ${env.exitIp || '?'}（geo 未知，时区退本机）`
        : `出口 ${env.exitIp || '?'}（${env.country}）`
  return `${where} · 时区 ${env.timezone} · 语言 ${env.locale} · UA Chrome/${CHROME_MAJOR}（${platformBrand()}） · WebRTC 已禁`
}

// ── 应用到窗口 / 会话 ────────────────────────────────────────────────

/** session 层请求头兜底：任何子资源、popup 请求都带一致的 UA / 语言 / 客户端提示 */
export function hardenSessionHeaders(ses: Session, env: FingerprintEnv): void {
  const acceptLanguage = acceptLanguageFor(env.locale)
  // setUserAgent 第二参走 navigator.language(s)，用纯标签；q 值由下方拦截器写头
  ses.setUserAgent(CHROME_UA, navigatorLanguageFor(env.locale))
  // 真无痕 Chrome 的通知权限是 denied，Electron 默认 granted——实测差异，拉齐
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    if (permission === 'notifications') return callback(false)
    callback(true)
  })
  try {
    ses.setPermissionCheckHandler((_wc, _mediaType, permission) => permission !== 'notifications')
  } catch {
    /* 老版本 Electron 无此 API 时只影响 permissions.query 的同步回显 */
  }
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers: Record<string, string> = { ...details.requestHeaders }
    headers['User-Agent'] = CHROME_UA
    headers['Accept-Language'] = acceptLanguage
    headers['sec-ch-ua'] = SEC_CH_UA
    headers['sec-ch-ua-mobile'] = '?0'
    headers['sec-ch-ua-platform'] = `"${platformBrand()}"`
    // 兜底清掉一切残留 Electron 字样的头（默认 UA 等处的痕迹）
    for (const [name, value] of Object.entries(headers)) {
      if (typeof value === 'string' && value.includes('Electron')) delete headers[name]
    }
    callback({ requestHeaders: headers })
  })
}

/** CDP 命令竞速超时：极端挂起（不返回也不抛错）不能卡死批次——主循环的步骤超时在 loadURL 之后才开始计时 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`${label} 超时`)), ms)
    })
  ])
}

/** navigator.deviceMemory：真 Chrome 按物理内存向下取 2 的幂（36GB 机器实测报 32），
 *  Electron 写死 8——按同一算法用真机内存补齐 */
function deviceMemoryGB(): number {
  const gb = Math.floor(totalmem() / 1024 ** 3)
  return 2 ** Math.floor(Math.log2(Math.max(1, gb)))
}

/** 主世界初始化脚本（每个新文档的页面脚本之前执行）：补齐 UAO 之后暴露的
 *  Electron 痕迹——window.chrome 被 UAO 清空、deviceMemory 写死 8、
 *  getHighEntropyValues 不走覆盖元数据、Notification.permission 恒 granted。 */
function buildInitScript(fullVersion: string): string {
  const fullVersionList = [
    `{ brand: 'Chromium', version: '${fullVersion}' }`,
    `{ brand: '${CHROME_GREASE}', version: '24.0.0.0' }`,
    `{ brand: 'Google Chrome', version: '${fullVersion}' }`
  ].join(', ')
  return `;(function () {
  var FULL_VERSION_LIST = [${fullVersionList}]
  // 1) window.chrome：UAO 会清掉 Electron 原生的 app/csi/loadTimes 注入，补回真 Chrome 形状
  try {
    if (window.chrome && !window.chrome.app) {
      window.chrome.app = {
        isInstalled: false,
        InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
        RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
        getDetails: function () { return null },
        getIsInstalled: function () { return false },
        installState: function () { return 'not_installed' },
        runningState: function () { return 'running' }
      }
      window.chrome.csi = function () { return {} }
      window.chrome.loadTimes = function () { return {} }
    }
  } catch (e) { /* 页面环境异常时静默 */ }
  // 2) deviceMemory：按真机内存对齐（Electron 写死 8）
  try {
    Object.defineProperty(navigator, 'deviceMemory', {
      get: function () { return ${deviceMemoryGB()} }, configurable: true, enumerable: true
    })
  } catch (e) { /* 已被页面改写则不动 */ }
  // 3) getHighEntropyValues：Chromium 实现不走 UAO 的 userAgentMetadata（实测
  //    fullVersionList 仍报原生品牌表，与声称的 Google Chrome 矛盾），读取侧归一
  try {
    if (navigator.userAgentData && navigator.userAgentData.getHighEntropyValues) {
      var uad = navigator.userAgentData
      var orig = uad.getHighEntropyValues.bind(uad)
      uad.getHighEntropyValues = function (hints) {
        return orig(hints).then(function (out) {
          if (out && typeof out === 'object' && Array.isArray(hints)) {
            if (hints.indexOf('fullVersionList') >= 0) out.fullVersionList = FULL_VERSION_LIST.slice()
            if (hints.indexOf('brands') >= 0) out.brands = FULL_VERSION_LIST.slice()
          }
          return out
        })
      }
    }
  } catch (e) { /* 不支持则保持原样 */ }
  // 4) Notification.permission：Electron 恒 granted，真无痕 Chrome 是 default
  //    （permissions.query 的服务端状态无法在页面侧改写，属已知残余）
  try {
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      Object.defineProperty(Notification, 'permission', {
        get: function () { return 'default' }, configurable: true
      })
    }
  } catch (e) { /* 忽略 */ }
})()`
}

/**
 * 窗口级指纹对齐（在 loadURL 业务页之前调用，保证第一个请求就带新指纹）。
 * 失败不抛错：返回 ok=false 及原因，退回 setUserAgent 的旧水平由调用方记日志。
 */
export async function applyWindowFingerprint(
  win: BrowserWindow,
  env: FingerprintEnv
): Promise<{ ok: boolean; error?: string }> {
  const contents = win.webContents
  try {
    // WebRTC 关非代理 UDP：防页面枚举出代理背后的本机 IP
    contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
    // WebContents.setUserAgent 无 acceptLanguages 参数，语言由 CDP 与 session 层负责
    contents.setUserAgent(CHROME_UA)
    await withTimeout(
      (async () => {
        // BrowserWindow 首次导航前没有 renderer/DevTools target，直接 sendCommand 会
        // 永久挂起（实测等任意时长也不就绪）——先导航本地空白文档把 renderer 拉起来。
        // about:blank 不发网络请求，不破坏「第一个业务请求走代理+新指纹」的次序
        await win.loadURL('about:blank')
        // CDP Emulation 层：页面 JS 读到的 navigator.language 与 Intl 时区一并改掉
        contents.debugger.attach('1.3')
        await contents.debugger.sendCommand('Emulation.setUserAgentOverride', {
          userAgent: CHROME_UA,
          // 这里同样只给纯标签：q 值会污染 navigator.languages（HTTP 头由 session 层改写）
          acceptLanguage: navigatorLanguageFor(env.locale),
          userAgentMetadata: {
            brands: [
              { brand: 'Chromium', version: CHROME_MAJOR },
              { brand: CHROME_GREASE, version: '24' },
              { brand: 'Google Chrome', version: CHROME_MAJOR }
            ],
            fullVersion: process.versions.chrome,
            platform: platformBrand(),
            platformVersion: '',
            architecture: process.arch === 'arm64' ? 'arm' : 'x86',
            model: '',
            mobile: false
          }
        })
        // 主世界初始化脚本：必须先 Page.enable，否则命令被接受但不执行（实测）
        await contents.debugger.sendCommand('Page.enable')
        await contents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
          source: buildInitScript(process.versions.chrome)
        })
        await contents.debugger.sendCommand('Emulation.setLocaleOverride', { locale: env.locale })
        await contents.debugger.sendCommand('Emulation.setTimezoneOverride', {
          timezoneId: env.timezone
        })
        // 带 attached debugger 销毁窗口有崩溃风险，关窗前先分离（close 时 contents 仍在）
        win.once('close', () => {
          try {
            contents.debugger.detach()
          } catch {
            /* 已分离或已销毁 */
          }
        })
      })(),
      8_000,
      '指纹对齐 CDP'
    )
    return { ok: true }
  } catch (e) {
    try {
      contents.setUserAgent(CHROME_UA)
    } catch {
      /* 窗口可能已销毁 */
    }
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
