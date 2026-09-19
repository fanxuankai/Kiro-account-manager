// Google 号池执行引擎：逐号「打开 Kiro Google OAuth 授权窗口 → 人工登录 → 拦回调换 token」。
// 与 loginPool（GitHub）的差异：登录全程人工（不探测 DOM、不自动填表），程序只负责
// 开窗（代理 + 指纹装配）、拦 kiro:// 回调、换 token 交界面入库、回填池状态。
// 2FA 码由界面调 totpNow 本地算好给用户复制，不接触外部 2FA 网站。
//
// 注意：不注册 protocol.handle('kiro')——loginPool 的 runner 已全局接管该协议，
// 这里再注册会互相覆盖（Electron 协议 handler 全局唯一）。本引擎只靠窗口内
// 四路拦截（will-navigate / did-start-navigation / did-fail-load / setWindowOpenHandler）
// + manual-callback IPC 兜底，回调一律按 oauthState 匹配，两池并行互不误收。

import { BrowserWindow, session, type Session } from 'electron'
import { randomBytes } from 'node:crypto'
import type { GooglePoolStore, GooglePoolEntry, GooglePoolEntryView } from './store'
import type {
  EntryProxySetup,
  LoginPoolProxyCandidate,
  LoginPoolProxyOptions
} from '../loginPool/runner'
import { totpNow } from '../loginPool/totp'
import { ChainProxyRelay } from '../registration/chainProxy'
import {
  acquireDynamicExit,
  getSharedDynamicSource,
  onDynamicSourceLog,
  resolveViaProxy
} from '../proxy/dynamicProxy'
import { maskProxyUrl, probeExitIp, proxyUrlHasCredentials } from '../proxy/proxyTools'
import { resolveProxyUrl } from '../proxy/proxyBridge'
import { injectProxySession } from '../loginPool/proxySession'
import {
  applyWindowFingerprint,
  describeFingerprint,
  hardenSessionHeaders,
  resolveFingerprintEnv
} from '../loginPool/fingerprint'

// ─── 依赖注入（由 main/index.ts 接线时提供，复用现有 Kiro OAuth 代码路径）───

export interface GooglePoolDeps {
  /** 构建 Kiro Google 登录 URL（PKCE），与 start-social-login 的 Google 分支同源逻辑 */
  buildGoogleLoginUrl: () => { url: string; codeVerifier: string; oauthState: string }
  /** 用授权码换 token，与 exchange-social-token 同源逻辑 */
  exchangeSocialToken: (
    code: string,
    codeVerifier: string
  ) => Promise<
    | {
        success: true
        accessToken: string
        refreshToken: string
        profileArn?: string
        expiresIn?: number
      }
    | { success: false; error: string }
  >
}

/** 授权选项（代理池快照，授权发起时由渲染层传入；主进程只读不回写） */
export interface GoogleAuthorizeOptions {
  /** 自动填表（默认开）：拟人节奏填邮箱/密码，2FA 密钥版自动填 TOTP；
   *  验证码/手机验证等挑战与 OAuth 确认仍由人工处理 */
  autofill?: boolean
  proxy?: LoginPoolProxyOptions
}

export interface GooglePoolResultPayload {
  entryId: string
  email: string
  accessToken: string
  refreshToken: string
  profileArn?: string
  expiresIn?: number
}

export interface GooglePoolEvents {
  onEntry: (entry: GooglePoolEntryView) => void
  onLog: (line: { time: string; level: 'info' | 'ok' | 'err' | 'warn'; msg: string }) => void
  onResult: (payload: GooglePoolResultPayload) => void
}

/** 单号最多连试几个出口代理后放弃（每次尝试都经 ipify 真实探测，失败即弃） */
const PROXY_MAX_ATTEMPTS = 3
/** 授权窗口空闲超时：手动登录慢（密码 + 2FA + 可能的挑战页），
 *  每次页面导航续命——用户只要还在操作就不会被掐 */
const IDLE_TIMEOUT_MS = 10 * 60_000
/** 用户关窗后等系统协议兜底回调的宽限（OAuth 完成页可能 self-close 后回调才到） */
const CLOSED_GRACE_MS = 10_000
/** 四路拦截命中后统一等回调结果的上限 */
const CALLBACK_WAIT_MS = 15_000

// ─── Google 登录页探测/填表脚本（选择器经真实页面存档校准：
//     邮箱页 input[name=identifier]+#identifierNext、密码页 input[name=Passwd]+#passwordNext）───

interface GooglePageDetect {
  url: string
  email: boolean
  pass: boolean
  totp: boolean
  captcha: boolean
  emailNext: boolean
  passNext: boolean
  totpNext: boolean
  error: string | null
}

const PROBE_GOOGLE_JS = `(() => {
  const vis = (el) => !!el && el.offsetParent !== null
  const q = (s) => document.querySelector(s)
  const emailEl = q('input[name="identifier"]')
  // 邮箱页有隐藏 honeypot（input[name=hiddenPassword]，aria-hidden）——只认可见密码框
  const passEl = [...document.querySelectorAll('input[type="password"]')].find(
    (el) => el.name !== 'hiddenPassword' && vis(el)
  )
  const totpEl = q('input[name="totpPin"]') || q('input#totpPin')
  const captchaEl = q('input[name="ca"]')
  let error = null
  const errEl = q('.o6cuMc, [role="alert"], [jsname="B34EJ"]')
  if (errEl && vis(errEl)) {
    const text = (errEl.textContent || '').trim().slice(0, 120)
    if (text) error = text
  }
  return {
    url: location.href,
    email: vis(emailEl), pass: !!passEl, totp: vis(totpEl), captcha: vis(captchaEl),
    emailNext: vis(q('#identifierNext')), passNext: vis(q('#passwordNext')), totpNext: vis(q('#totpNext')),
    error
  }
})()`

/** 单字段拟人输入（execCommand 原生编辑管线，事件 isTrusted=true，与 GitHub 号池同思路） */
const TYPE_FIELD_JS = `(async (sel, text) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const rand = (a, b) => Math.floor(a + Math.random() * (b - a))
  const el = document.querySelector(sel)
  if (!el || el.offsetParent === null) return { ok: false, error: 'no-input' }
  el.focus()
  el.scrollIntoView({ block: 'center' })
  try { el.setSelectionRange(el.value.length, el.value.length) } catch (e) {}
  for (const ch of text) {
    document.execCommand('insertText', false, ch)
    await sleep(rand(80, 200))
  }
  return { ok: true }
})`

/** 取可点元素视口中心坐标（容器选择器 → 内部真实按钮优先）；主进程用 sendInputEvent 点击 */
const CLICK_GOOGLE_JS = `((sel) => {
  const el = document.querySelector(sel)
  if (!el || el.offsetParent === null) return null
  const btn = el.querySelector('button, [role="button"]') || el
  const target = btn.offsetParent === null ? el : btn
  target.scrollIntoView({ block: 'center' })
  const rect = target.getBoundingClientRect()
  if (rect.width > 0 && rect.height > 0) {
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
  }
  return null
})`

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
function randInt(a: number, b: number): number {
  return Math.floor(a + Math.random() * (b - a))
}
function nowTime(): string {
  const d = new Date()
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, '0'))
    .join(':')
}

// ─── 执行器 ──────────────────────────────────────────────────────────

export class GooglePoolRunner {
  private store: GooglePoolStore
  private deps: GooglePoolDeps
  private events: GooglePoolEvents
  private opts: GoogleAuthorizeOptions = {}

  /** 是否有授权窗口在跑（同一时刻只允许一个，串行手动授权） */
  running = false

  /** 当前授权窗口（观察按钮置前用） */
  private win: BrowserWindow | null = null

  /** 出口代理轮换游标（round_robin / least_used / fastest 按序消费；random 不用） */
  private proxyCursor = 0

  private activeRun: {
    oauthState: string
    resolveCallback: (v: { code?: string; error?: string }) => void
    /** 兜底链路收到回调时置 callbackSeen，让主循环退出 */
    markSeen: () => void
  } | null = null

  constructor(store: GooglePoolStore, deps: GooglePoolDeps, events: GooglePoolEvents) {
    this.store = store
    this.deps = deps
    this.events = events
    // 全局提链池（与订阅取链接共用一份队列与记忆）的动态转发进号池 UI 日志（多播，不影响 loginPool 的订阅）
    onDynamicSourceLog((m) => this.log('info', `[提链] ${m}`))
  }

  private log(level: 'info' | 'ok' | 'err' | 'warn', msg: string): void {
    this.events.onLog({ time: nowTime(), level, msg })
  }
  private emitEntry(entry: GooglePoolEntry): void {
    this.events.onEntry(this.store.toView(entry))
  }

  /** 发起单号授权（已有窗口在跑则拒绝）；打开授权窗口等人工登录 */
  authorize(id: string, opts?: GoogleAuthorizeOptions): void {
    if (this.running) {
      this.log('warn', '已有授权窗口在执行，请先完成或关闭当前窗口')
      return
    }
    const entry = this.store.get(id)
    if (!entry || entry.state === 'running') return
    if (opts) this.opts = opts
    this.store.patch(id, { state: 'running', failReason: undefined, takenAt: Date.now() })
    const fresh = this.store.get(id)!
    this.emitEntry(fresh)
    this.running = true
    void (async () => {
      try {
        await this.runEntry(fresh)
      } finally {
        this.running = false
      }
    })()
  }

  /** 系统协议兜底：窗口内四路拦截漏掉、OS 把 kiro:// 转回本应用时，渲染进程转发到这里 */
  handleManualCallback(code: string, state: string): void {
    const run = this.activeRun
    if (run && state === run.oauthState) {
      this.log('info', '经系统协议兜底收到回调')
      run.markSeen()
      run.resolveCallback({ code })
    }
  }

  focusWindow(): void {
    if (this.win && !this.win.isDestroyed()) {
      if (this.win.isMinimized()) this.win.restore()
      this.win.show()
      this.win.focus()
    }
  }

  // ── 单号授权：窗口 + 回调等待 ──

  private async runEntry(entry: GooglePoolEntry): Promise<void> {
    const partition = `googlepool-${Date.now()}-${randomBytes(3).toString('hex')}`
    const login = this.deps.buildGoogleLoginUrl()

    // 出口代理在设 activeRun / 开窗之前装配：失败直接终止，无需清理任何资源
    const proxy = await this.setupEntryProxy(entry)
    if (proxy.kind === 'failed') {
      this.fail(entry, 'no-proxy', proxy.error)
      return
    }
    let releaseProxy: (() => Promise<void>) | null = null
    let entrySession: Session | null = null
    if (proxy.kind === 'ok') releaseProxy = proxy.release
    // 出口归属落盘：此后这个号无论成败，都能一眼看出走的是哪个出口 IP/来源
    this.store.patch(entry.id, {
      exitIp: proxy.kind === 'ok' ? proxy.exitIp : undefined,
      proxyMode: proxy.kind === 'ok' ? proxy.mode : 'direct'
    })

    let callbackResolve!: (v: { code?: string; error?: string }) => void
    const callbackPromise = new Promise<{ code?: string; error?: string }>((resolve) => {
      callbackResolve = resolve
    })
    let callbackSeen = false
    this.activeRun = {
      oauthState: login.oauthState,
      resolveCallback: callbackResolve,
      markSeen: () => {
        callbackSeen = true
      }
    }

    // 指纹环境先于开窗解析：时区/语言要跟出口 IP 的归属地一致（直连则用本机值）
    const fp = await resolveFingerprintEnv(proxy.kind === 'ok' ? proxy.exitIp : null)

    // 先显式建会话再开窗：setProxy 必须在 loadURL 之前完成，保证 Google 页面
    // 第一个请求就走池出口；partition 名不带 persist: 前缀 = 内存会话不落盘
    const ses = session.fromPartition(partition, { cache: false })
    entrySession = ses
    if (proxy.kind === 'ok') {
      await ses.setProxy({
        mode: 'fixed_servers',
        proxyRules: proxy.proxyRules,
        proxyBypassRules: '<-loopback>'
      })
    }
    // 请求头级指纹兜底（子资源、popup 请求同样生效），须在 loadURL 之前挂好
    hardenSessionHeaders(ses, fp)

    const win = new BrowserWindow({
      width: 1080,
      height: 840,
      title: `Kiro 授权 · ${entry.email}`,
      autoHideMenuBar: true,
      webPreferences: {
        session: ses,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })
    this.win = win
    // 页面级指纹对齐（CDP：navigator.language、Intl 时区、client hints、WebRTC）。
    // 失败不阻断登录，退回请求头级的旧行为
    const fpApplied = await applyWindowFingerprint(win, fp)
    if (fpApplied.ok) {
      this.log('info', `${entry.email} 指纹已对齐：${describeFingerprint(fp)}`)
    } else {
      this.log('warn', `${entry.email} 页面级指纹对齐未生效（${fpApplied.error}），退回请求头级`)
    }

    const handleCallbackUrl = (url: string, from: string): void => {
      if (callbackSeen) return
      try {
        const u = new URL(url)
        const code = u.searchParams.get('code')
        const state = u.searchParams.get('state')
        const error = u.searchParams.get('error')
        this.log('info', `拦截到回调（${from}）`)
        // state 必须匹配本次授权（两池并行 / 窗口复用时防误收别人的回调）
        if (code && state === login.oauthState) {
          callbackSeen = true
          callbackResolve({ code })
        } else if (error) {
          callbackSeen = true
          callbackResolve({ error })
        }
      } catch {
        /* 非 URL 忽略 */
      }
    }

    // kiro:// 四路拦截（与本池单窗口 + oauthState 匹配配合足够；protocol.handle
    // 已被 loginPool 全局接管，这里不再注册，避免互相覆盖）
    win.webContents.on('will-navigate', (e, url) => {
      if (url.startsWith('kiro://')) {
        e.preventDefault()
        handleCallbackUrl(url, 'will-navigate')
      }
    })
    win.webContents.on('did-start-navigation', (_e, url) => {
      if (url.startsWith('kiro://')) handleCallbackUrl(url, 'did-start-navigation')
    })
    win.webContents.on('did-fail-load', (_e, errorCode, _desc, url) => {
      // 自定义协议加载失败是常态（Electron 不认 kiro://），回调参数已带上
      if (url && url.startsWith('kiro://') && errorCode !== -3) {
        handleCallbackUrl(url, 'did-fail-load')
      }
    })
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('kiro://')) {
        handleCallbackUrl(url, 'window-open')
        return { action: 'deny' }
      }
      return { action: 'allow' }
    })

    let windowClosed = false
    win.on('closed', () => {
      windowClosed = true
      if (this.win === win) this.win = null
      // 不在这里直接判失败：授权完成页可能 self-close，兜底回调稍后才到——
      // 由主循环后的统一宽限等待兜住
    })

    // 空闲超时：每次页面导航（用户在操作）续命
    let deadline = Date.now() + IDLE_TIMEOUT_MS
    win.webContents.on('did-navigate', () => {
      deadline = Date.now() + IDLE_TIMEOUT_MS
    })
    win.webContents.on('render-process-gone', (_e, details) => {
      this.log(
        'err',
        `页面渲染进程异常退出：${details.reason}${details.exitCode !== undefined ? ` (code ${details.exitCode})` : ''}`
      )
    })

    /** cookie 收割结果（授权后凭证种在 app.kiro.dev cookie，不依赖回调跳转） */
    let cookieCred: { accessToken: string; refreshToken: string; profileArn?: string } | null = null
    let aborted = false
    // 自动填表去重标记：同页重复探测不重复填/点
    const filled = { email: false, password: false }
    let otpFilled = false
    /** TOTP 填错重试上限（码错页面会清空重出，重填最多 2 次） */
    let otpAttempts = 0
    /** 人工提醒与错误日志去重 */
    let lastNotified = ''
    let lastErrorMsg = ''

    try {
      this.log(
        'info',
        `${entry.email} 授权窗口已打开${this.opts.autofill === false ? '，请在窗口中手动登录 Google' : '：自动填邮箱/密码' + (entry.secret ? '/2FA' : '') + '，验证码与授权确认请人工处理'}`
      )
      this.focusWindow()
      await win.loadURL(login.url)

      while (!callbackSeen && !windowClosed) {
        await sleep(1000)
        if (windowClosed) break
        if (Date.now() > deadline) {
          this.fail(entry, 'timeout', '授权窗口长时间无操作（10 分钟），已停止')
          aborted = true
          break
        }

        // Cookie 收割：授权批准后 Kiro 凭证种在本会话 app.kiro.dev cookie——
        // 与回调跳转是否完成无关（Google 授权页拦截跳转时凭证可能已落地）
        try {
          const cookies = await win.webContents.session.cookies.get({ domain: 'app.kiro.dev' })
          const rt = cookies.find((c) => c.name === 'RefreshToken')?.value
          if (rt) {
            this.log('ok', `${entry.email} 检测到 Kiro 会话凭证（cookie 收割），直接入库`)
            cookieCred = {
              accessToken: cookies.find((c) => c.name === 'AccessToken')?.value || rt,
              refreshToken: rt,
              profileArn: cookies.find((c) => c.name === 'ProfileArn')?.value
            }
            break
          }
        } catch {
          /* 会话不可用时忽略，下轮再看 */
        }

        // 自动填表状态机（仅 accounts.google.com 页面；挑战/确认页人工）
        if (this.opts.autofill !== false) {
          let detect: GooglePageDetect | null = null
          try {
            detect = (await win.webContents.executeJavaScript(PROBE_GOOGLE_JS, true)) as GooglePageDetect
          } catch {
            detect = null // 页面跳转中执行失败，下轮再看
          }
          if (detect && detect.url.includes('accounts.google.com')) {
            const notifyOnce = (key: string, level: 'warn' | 'info', msg: string): void => {
              if (lastNotified === key) return
              lastNotified = key
              this.log(level, msg)
              if (level === 'warn') this.focusWindow()
            }

            if (detect.error) {
              // 页面报错（密码错/找不到帐号/2FA 码错）：人工接管，等待期不计时
              if (detect.error !== lastErrorMsg) {
                lastErrorMsg = detect.error
                this.log('warn', `${entry.email} 页面报错：${detect.error}，请在窗口中人工处理`)
                this.focusWindow()
              }
              deadline = Date.now() + IDLE_TIMEOUT_MS
              // 2FA 码错会清空重出输入框——允许重填（受 otpAttempts 限制）
              if (detect.totp && otpAttempts >= 1) otpFilled = false
              continue
            }
            if (detect.error !== lastErrorMsg) lastErrorMsg = ''

            if (detect.captcha) {
              notifyOnce('captcha', 'warn', `${entry.email} 触发图形验证码，请在窗口中人工完成后自动继续（等待不计时）`)
              deadline = Date.now() + IDLE_TIMEOUT_MS
              continue
            }

            // 邮箱页：拟人填邮箱 → 点下一步
            if (detect.email && !filled.email) {
              const typed = await this.typeField(win, 'input[name="identifier"]', entry.email)
              if (typed) {
                await sleep(randInt(300, 900))
                await this.clickCenter(win, '#identifierNext')
                filled.email = true
                this.log('ok', `${entry.email} 已自动填写邮箱并提交`)
              }
              continue
            }

            // 密码页：拟人填密码 → 点下一步
            if (detect.pass && !filled.password) {
              const typed = await this.typeField(win, 'input[name="Passwd"]', entry.password)
              if (typed) {
                await sleep(randInt(300, 900))
                await this.clickCenter(win, '#passwordNext')
                filled.password = true
                this.log('ok', `${entry.email} 已自动填写密码并提交`)
              }
              continue
            }

            // 2FA 验证器页：密钥版本地算码填入；辅邮版转人工收码
            if (detect.totp && !otpFilled) {
              if (entry.secret) {
                if (otpAttempts >= 2) {
                  notifyOnce('otp-limit', 'warn', `${entry.email} 2FA 码多次未过，请人工处理`)
                  deadline = Date.now() + IDLE_TIMEOUT_MS
                  continue
                }
                otpAttempts += 1
                // 窗口尾期等下个周期再取码，避免码填完即过期
                let code = totpNow(entry.secret)
                if (code.remainMs < 4000) {
                  await sleep(code.remainMs + 300)
                  code = totpNow(entry.secret)
                }
                const typed = await this.typeField(win, 'input[name="totpPin"], input#totpPin', code.code)
                if (typed) {
                  await sleep(randInt(300, 900))
                  await this.clickCenter(win, '#totpNext')
                  otpFilled = true
                  this.log('ok', `${entry.email} 已自动填写 2FA 验证码并提交`)
                }
              } else {
                notifyOnce(
                  'totp-manual',
                  'warn',
                  `${entry.email} 需要 2FA 验证（辅助邮箱版）：请到辅助邮箱 ${entry.recoveryEmail || ''} 收码后填入窗口（等待不计时）`
                )
                deadline = Date.now() + IDLE_TIMEOUT_MS
              }
              continue
            }

            // 未知挑战页（/challenge/ 路径且无已识别输入框）：人工
            if (detect.url.includes('/challenge/') && !detect.email && !detect.pass && !detect.totp) {
              notifyOnce('challenge', 'warn', `${entry.email} 触发二次验证挑战（手机号等），需人工处理；无解挑战可直接关窗取消`)
              deadline = Date.now() + IDLE_TIMEOUT_MS
              continue
            }

            // OAuth 确认页（consent）：人工点继续（与 GitHub 号池授权页策略一致）
            if (detect.url.includes('/signin/oauth/consent')) {
              notifyOnce('consent', 'info', `${entry.email} 请在窗口中点「继续」完成授权确认`)
            }
          }
        }
      }

      if (aborted) return

      // cookie 收割路径：凭证已到手，无需 code/token 交换，直接交界面入库
      if (cookieCred) {
        this.store.patch(entry.id, { state: 'used', failReason: undefined })
        this.emitEntry(this.store.get(entry.id)!)
        this.events.onResult({
          entryId: entry.id,
          email: entry.email,
          accessToken: cookieCred.accessToken,
          refreshToken: cookieCred.refreshToken,
          profileArn: cookieCred.profileArn
        })
        return
      }

      // 统一等待回调：窗口可能已被页面 self-close（OAuth 自定义协议常见行为），
      // 系统协议兜底可能稍后才到；token 交换不依赖窗口存活
      const waitMs = windowClosed ? CLOSED_GRACE_MS : CALLBACK_WAIT_MS
      const cb = await Promise.race([callbackPromise, sleep(waitMs).then(() => null)])
      if (!cb) {
        if (windowClosed) {
          // 用户中途关窗 = 正常取消，拨回未用而不是标失败
          this.store.patch(entry.id, { state: 'unused', failReason: '窗口已关闭（可再次授权）' })
          this.emitEntry(this.store.get(entry.id)!)
          this.log('warn', `${entry.email} 授权窗口被关闭，条目已拨回未用`)
        } else {
          this.fail(entry, 'timeout', '等待授权回调超时')
        }
        return
      }
      if (cb.error) {
        this.fail(entry, 'callback-error', `授权回调错误：${cb.error}`)
        return
      }
      if (!cb.code) {
        this.fail(entry, 'callback-error', '回调缺少授权码')
        return
      }
      this.log('info', `${entry.email} 已拦截 kiro:// 回调，交换 token…`)
      const token = await this.deps.exchangeSocialToken(cb.code, login.codeVerifier)
      if (token.success) {
        this.store.patch(entry.id, { state: 'used', failReason: undefined })
        this.emitEntry(this.store.get(entry.id)!)
        this.log('ok', `${entry.email} token 交换成功，交给界面验证入库`)
        this.events.onResult({
          entryId: entry.id,
          email: entry.email,
          accessToken: token.accessToken,
          refreshToken: token.refreshToken,
          profileArn: token.profileArn,
          expiresIn: token.expiresIn
        })
      } else {
        this.fail(entry, 'exchange-failed', `token 交换失败：${token.error}`)
      }
    } catch (err) {
      this.fail(entry, 'unexpected', err instanceof Error ? err.message : String(err))
    } finally {
      this.activeRun = null
      this.win = null
      // 出口代理资源随窗口一起释放：中继停掉，会话掐断所有在途连接
      if (releaseProxy) void releaseProxy().catch(() => undefined)
      if (entrySession) void entrySession.closeAllConnections().catch(() => undefined)
      if (!win.isDestroyed()) {
        // 留 1.2s 让成功页收尾，随后自动关窗
        setTimeout(() => {
          if (!win.isDestroyed()) win.close()
        }, 1200)
      }
    }
  }

  private fail(entry: GooglePoolEntry, reason: string, msg: string): void {
    this.store.patch(entry.id, { state: 'failed', failReason: msg })
    this.emitEntry(this.store.get(entry.id)!)
    this.log('err', `${entry.email} 失败[${reason}]：${msg}`)
  }

  // ── 页面动作封装（自动填表用）──

  /** 拟人输入单个字段（execCommand 原生编辑管线，isTrusted=true） */
  private async typeField(win: BrowserWindow, selector: string, text: string): Promise<boolean> {
    try {
      const res = (await win.webContents.executeJavaScript(
        `(${TYPE_FIELD_JS})(${JSON.stringify(selector)}, ${JSON.stringify(text)})`,
        true
      )) as { ok: boolean; error?: string }
      return res?.ok === true
    } catch {
      return false
    }
  }

  /** 点击元素中心（容器选择器 → 内部按钮优先；sendInputEvent 走 OS 输入管线） */
  private async clickCenter(win: BrowserWindow, selector: string): Promise<boolean> {
    try {
      const rect = (await win.webContents.executeJavaScript(
        `(${CLICK_GOOGLE_JS})(${JSON.stringify(selector)})`,
        true
      )) as { x: number; y: number } | null
      if (!rect) return false
      const x = Math.round(rect.x)
      const y = Math.round(rect.y)
      win.webContents.sendInputEvent({ type: 'mouseMove', x, y })
      await sleep(randInt(60, 140))
      win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
      await sleep(randInt(60, 130))
      win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
      return true
    } catch {
      return false
    }
  }

  // ── 出口代理装配（逻辑对齐 loginPool；无风控拉黑回路——手动场景一号一装配）──

  private pickProxyCandidate(
    cfg: LoginPoolProxyOptions,
    remaining: LoginPoolProxyCandidate[]
  ): LoginPoolProxyCandidate | null {
    if (!remaining.length) return null
    if (cfg.strategy === 'random') return remaining[Math.floor(Math.random() * remaining.length)]
    let ordered = remaining
    if (cfg.strategy === 'least_used') {
      ordered = [...remaining].sort((a, b) => a.usedCount - b.usedCount)
    } else if (cfg.strategy === 'fastest') {
      ordered = [...remaining].sort((a, b) => (a.latencyMs ?? Infinity) - (b.latencyMs ?? Infinity))
    }
    const pick = ordered[this.proxyCursor % ordered.length]
    this.proxyCursor += 1
    return pick
  }

  /** 为单号装配出口代理：候选 → 独立 session 注入 → 按需起本地中继 →
   *  ipify 探测真实出口；探测失败换下一个候选，最多 PROXY_MAX_ATTEMPTS 个；
   *  全部失败返回 failed——绝不回退直连暴露本机 IP。 */
  private async setupEntryProxy(entry: GooglePoolEntry): Promise<EntryProxySetup> {
    const cfg = this.opts.proxy
    if (!cfg?.enabled) return { kind: 'off' }
    if (cfg.mode === 'api') return this.setupEntryProxyFromApi(entry, cfg)
    const remaining = cfg.entries.filter((c) => !!c.url)
    if (!remaining.length) {
      return {
        kind: 'failed',
        error: '代理池无可用代理（需在代理池页启用并验活为可用）'
      }
    }
    const upstream = (cfg.upstreamProxy || '').trim()
    let lastError = ''
    for (let attempt = 1; attempt <= PROXY_MAX_ATTEMPTS; attempt++) {
      const candidate = this.pickProxyCandidate(cfg, remaining)
      if (!candidate) break
      // hy2(Hysteria2)代理先转本地 socks5；起不来（内核缺失/节点坏）按"本条不可用"换下一条
      let targetUrl = injectProxySession(candidate.url)
      try {
        targetUrl = (await resolveProxyUrl(targetUrl)) || targetUrl
      } catch (err) {
        this.log(
          'warn',
          `${entry.email} hy2 代理桥启动失败（${maskProxyUrl(candidate.url)}）：${err instanceof Error ? err.message : String(err)}`
        )
        continue
      }
      // 带凭据或配了上游中转 → 本地中继；无凭据无上游的代理直接作为 proxyRules，零额外跳
      let relay: ChainProxyRelay | null = null
      let proxyRules = targetUrl
      if (upstream || proxyUrlHasCredentials(targetUrl)) {
        try {
          let upstreamResolved = upstream
          if (upstream) upstreamResolved = (await resolveProxyUrl(upstream)) || upstream
          relay = new ChainProxyRelay(upstreamResolved || targetUrl, targetUrl, (m) => this.log('warn', m))
          proxyRules = await relay.start()
        } catch (err) {
          this.log(
            'warn',
            `${entry.email} 本地代理中继启动失败：${err instanceof Error ? err.message : String(err)}`
          )
          continue
        }
      }
      const probe = await probeExitIp(proxyRules)
      if (probe.ok && probe.ip && probe.ms !== undefined) {
        this.log(
          'ok',
          `${entry.email} 出口代理已接通：${probe.ip}（${probe.ms}ms，经 ${maskProxyUrl(candidate.url)}）`
        )
        return {
          kind: 'ok',
          proxyRules,
          exitIp: probe.ip,
          latencyMs: probe.ms,
          sourceKey: candidate.url,
          mode: 'pool',
          release: async () => {
            if (relay) await relay.stop()
          }
        }
      }
      if (relay) await relay.stop()
      lastError = probe.error || '未知错误'
      this.log('warn', `${entry.email} 代理 ${maskProxyUrl(candidate.url)} 探测失败（${lastError}），换下一个`)
    }
    return {
      kind: 'failed',
      error: `出口代理不可用（${lastError || '无候选'}），未直连`
    }
  }

  /** 提链 API 模式：从全局共享池消费一个一次性端点（同入口不同端口 = 不同出口） */
  private async setupEntryProxyFromApi(
    entry: GooglePoolEntry,
    cfg: LoginPoolProxyOptions
  ): Promise<EntryProxySetup> {
    const resolved = {
      url: cfg.api?.url || '',
      viaProxy: resolveViaProxy(cfg.api?.viaProxy),
      batchSize: Math.min(20, Math.max(1, Math.round(cfg.api?.batchSize ?? 5)))
    }
    try {
      const route = await acquireDynamicExit(
        getSharedDynamicSource(resolved),
        resolved.viaProxy,
        (level, msg) => this.log(level, `${entry.email} ${msg}`)
      )
      return {
        kind: 'ok',
        proxyRules: route.proxyRules,
        exitIp: route.exitIp,
        latencyMs: route.latencyMs,
        sourceKey: route.endpointUrl,
        mode: 'api',
        release: route.release
      }
    } catch (err) {
      return {
        kind: 'failed',
        error: `${err instanceof Error ? err.message : String(err)}，未直连`
      }
    }
  }
}
