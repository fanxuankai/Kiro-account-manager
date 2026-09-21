// Google 号池执行引擎：逐号「打开 Kiro Google OAuth 授权窗口 → 人工登录 → 拦回调换 token」。
// 与 loginPool（GitHub）的差异：登录全程人工（不探测 DOM、不自动填表），程序只负责
// 开窗（代理 + 指纹装配）、拦 kiro:// 回调、换 token 交界面入库、回填池状态。
// 2FA 码由界面调 totpNow 本地算好给用户复制，不接触外部 2FA 网站。
//
// 注意：不注册 protocol.handle('kiro')——loginPool 的 runner 已全局接管该协议，
// 这里再注册会互相覆盖（Electron 协议 handler 全局唯一）。本引擎只靠窗口内
// 四路拦截（will-navigate / did-start-navigation / did-fail-load / setWindowOpenHandler）
// + manual-callback IPC 兜底，回调一律按 oauthState 匹配，两池并行互不误收。

import { BrowserWindow, app, session, type Session } from 'electron'
import { randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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
import { acquireKiroPoolExit } from '../proxy/kiroPool'
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
  /** 批次模式号间冷却秒数；'rand' = 每次随机 60–180s */
  batchIntervalSec?: number | 'rand'
  /** 勾选批次：只跑这些 id（须为未用状态）；缺省跑全部未用 */
  ids?: string[]
  proxy?: LoginPoolProxyOptions
}

export interface GooglePoolResultPayload {
  /** 本次授权结果的唯一 id（时间戳+条目）：渲染层据此去重，防实时事件与挂载重放并发重复入库 */
  resultId: string
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
  onBatch: (state: { active: boolean; paused: boolean; unused: number }) => void
  onResult: (payload: GooglePoolResultPayload) => void
}

/** 单号最多连试几个出口代理后放弃（每次尝试都经 ipify 真实探测，失败即弃） */
const PROXY_MAX_ATTEMPTS = 3
/** 授权窗口空闲超时：手动登录慢（密码 + 2FA + 可能的挑战页），
 *  每次页面导航续命——用户只要还在操作就不会被掐 */
const IDLE_TIMEOUT_MS = 10 * 60_000
/** 批次（挂机）模式超时：无人值守，无解挑战等不了人——缩短到 4 分钟跳下一个 */
const BATCH_IDLE_TIMEOUT_MS = 4 * 60_000
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
  /** 辅助邮箱确认挑战（kpe）：完整输入辅助邮箱地址即通过，无需收码 */
  recovery: boolean
  /** 挑战方式选择页：列出可选验证方式（含「确认您的辅助邮箱」） */
  selection: boolean
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
  const kpeEl = q('input[name="knowledgePreregisteredEmailResponse"]')
  const selEl = q('div[data-action="selectchallenge"]')
  const captchaEl = q('input[name="ca"]')
  let error = null
  const errEl = q('.o6cuMc, [role="alert"], [jsname="B34EJ"]')
  if (errEl && vis(errEl)) {
    const text = (errEl.textContent || '').trim().slice(0, 120)
    if (text) error = text
  }
  return {
    url: location.href,
    email: vis(emailEl), pass: !!passEl, totp: vis(totpEl), recovery: vis(kpeEl),
    selection: vis(selEl), captcha: vis(captchaEl),
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

/** 取可点元素视口中心坐标。规则数组：字符串=CSS 选择器（容器内部真实按钮优先）；
 *  { text } = 按可见可点元素（button/[role=button]/[role=link]，挑战选项是 role=link div）
 *  的文本包含匹配（如「下一步」「确认您的辅助邮箱」）。 */
const CLICK_GOOGLE_JS = `((rulesJson) => {
  const rules = JSON.parse(rulesJson)
  const vis = (el) => !!el && el.offsetParent !== null
  const clickables = [...document.querySelectorAll('button, [role="button"], [role="link"], input[type="submit"]')]
  for (const r of rules) {
    let el = null
    if (typeof r === 'string') {
      const c = document.querySelector(r)
      if (vis(c)) el = c
    } else if (r && r.text) {
      const want = String(r.text).toLowerCase()
      el = clickables.find((b) => {
        const label = ((b.textContent || b.value || '') + '').trim().toLowerCase()
        return label.includes(want) && vis(b)
      })
    }
    if (el) {
      const btn = el.querySelector('button, [role="button"]') || el
      const target = vis(btn) ? btn : el
      target.scrollIntoView({ block: 'center' })
      const rect = target.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) {
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
      }
    }
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

  /** 是否有授权窗口在跑（单号授权或批次中的当前号） */
  running = false
  /** 批次进行中（冷却间隙无窗口时也为 true） */
  batchActive = false
  paused = false

  /** 勾选批次的待跑队列（null = 全部未用模式） */
  private batchQueue: string[] | null = null

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
  private emitBatch(): void {
    this.events.onBatch({
      active: this.batchActive,
      paused: this.paused,
      unused: this.batchQueue ? this.batchQueue.length : this.store.countUnused()
    })
  }

  /** 发起单号授权（批次进行中或已有窗口在跑则拒绝）；打开授权窗口等人工/自动登录 */
  authorize(id: string, opts?: GoogleAuthorizeOptions): void {
    if (this.running || this.batchActive) {
      this.log('warn', '已有授权窗口/批次在执行，请先完成或暂停当前任务')
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

  /** 批次：串行授权全部未用号（或勾选的 ids），号间冷却（挂机模式——无人值守，超时缩短、失败跳号） */
  startBatch(opts?: GoogleAuthorizeOptions): void {
    if (this.batchActive || this.running) {
      this.log('warn', '已有批次/授权窗口在执行')
      return
    }
    // 勾选模式：只保留当前仍为未用的 id；空队列=没得跑
    this.batchQueue = opts?.ids ? opts.ids.filter((id) => this.store.get(id)?.state === 'unused') : null
    const total = this.batchQueue ? this.batchQueue.length : this.store.countUnused()
    if (total === 0) {
      this.log('warn', '没有可跑的未用账号')
      this.batchQueue = null
      return
    }
    if (opts) this.opts = opts
    this.batchActive = true
    this.paused = false
    this.log(
      'info',
      `批次开始：${this.batchQueue ? `勾选 ${total} 个` : `未用 ${total} 个`}，号间冷却 ${this.opts.batchIntervalSec === 'rand' ? '随机 60–180s' : (this.opts.batchIntervalSec ?? 60) + 's'}；无解挑战超时 4 分钟跳下一个`
    )
    this.emitBatch()
    void this.runBatch()
  }

  pauseBatch(): void {
    if (!this.batchActive || this.paused) return
    this.paused = true
    this.log('info', '批次暂停：当前号跑完后不再取下一号')
    this.emitBatch()
  }

  resumeBatch(): void {
    if (!this.batchActive || !this.paused) return
    this.paused = false
    this.log('info', '批次继续')
    this.emitBatch()
  }

  private async runBatch(): Promise<void> {
    while (this.batchActive && !this.paused) {
      // 勾选模式：按队列取（id 已非未用则跳过取下一个）；全部模式：取任意未用
      let entry: GooglePoolEntry | null = null
      if (this.batchQueue) {
        while (!entry && this.batchQueue!.length) {
          entry = this.store.takeNextById(this.batchQueue!.shift()!)
        }
      } else {
        entry = this.store.takeNextUnused()
      }
      if (!entry) break
      this.emitEntry(entry)
      const left = this.batchQueue ? this.batchQueue.length : this.store.countUnused()
      this.log('info', `${entry.email} 开始授权（还剩 ${left} 个待跑）`)
      this.running = true
      try {
        await this.runEntry(entry, true)
      } finally {
        this.running = false
      }
      this.emitBatch()
      if (!this.batchActive || this.paused) break
      // 队列已空：最后一个号跑完直接收尾，不再空等一轮冷却
      if ((this.batchQueue ? this.batchQueue.length : this.store.countUnused()) === 0) break
      const cd =
        this.opts.batchIntervalSec === 'rand'
          ? randInt(60, 180)
          : (this.opts.batchIntervalSec ?? 60)
      this.log('info', `冷却 ${cd}s 后取下一个号（可暂停）`)
      for (let left = cd; left > 0 && this.batchActive && !this.paused; left--) {
        await sleep(1000)
      }
    }
    if (!this.paused) {
      this.log('ok', '批次完成：队列已跑完')
    }
    this.batchActive = false
    this.paused = false
    this.batchQueue = null
    this.emitBatch()
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

  private async runEntry(entry: GooglePoolEntry, batchMode = false): Promise<void> {
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
    // CDP 页面级对齐必须保留（含直连）：除时区/语言外，更重要的是
    // Emulation.setUserAgentOverride 会把 Electron 内核的 UA/品牌（navigator.userAgentData、
    // UA-CH 头里的 "Electron"）洗成纯 Chrome——跳过它 Google 会直接出
    // 「此浏览器或应用可能不安全」拦截页（2026-09-20 实测）。
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

    // 空闲超时：每次页面导航（用户在操作）续命；批次模式缩短（无人值守）
    const idleTimeoutMs = batchMode ? BATCH_IDLE_TIMEOUT_MS : IDLE_TIMEOUT_MS
    let deadline = Date.now() + idleTimeoutMs
    win.webContents.on('did-navigate', () => {
      deadline = Date.now() + idleTimeoutMs
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
    const filled = { email: false, password: false, recovery: false }
    let otpFilled = false
    /** 授权确认页已程序点击（防重复点） */
    let consentClicked = false
    /** TOTP 填错重试上限（码错页面会清空重出，重填最多 2 次） */
    let otpAttempts = 0
    /** 挑战方式选择页：上次点击时间与日志去重——点击后观察期内不重点
     *  （页面慢跳转属正常，重复点击只会刷日志/误触；点击无效时观察期过了再重试） */
    let selectionClickAt = 0
    let selectionLogged = false
    /** 人工提醒与错误日志去重 */
    let lastNotified = ''
    let lastErrorMsg = ''
    /** 挑战页存档去重：同一 URL 只存一份 */
    let dumpedUrl = ''
    /** 最近一次表单提交时间：提交后的验证过渡页（无输入框、URL 仍含 /challenge/）
     *  不是新挑战——观察期内不报人工不存档，等跳转 */
    let lastSubmitAt = 0

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
          this.fail(
            entry,
            'timeout',
            `授权窗口长时间无操作（${batchMode ? '4 分钟（批次模式）' : '10 分钟'}），已停止`
          )
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
              deadline = Date.now() + idleTimeoutMs
              // 2FA 码错会清空重出输入框——允许重填（受 otpAttempts 限制）
              if (detect.totp && otpAttempts >= 1) otpFilled = false
              continue
            }
            if (detect.error !== lastErrorMsg) lastErrorMsg = ''

            if (detect.captcha) {
              notifyOnce('captcha', 'warn', `${entry.email} 触发图形验证码，请在窗口中人工完成后自动继续（等待不计时）`)
              if (detect.url !== dumpedUrl) {
                dumpedUrl = detect.url
                void this.dumpChallengePage(win, entry, detect.url)
              }
              deadline = Date.now() + idleTimeoutMs
              continue
            }

            // 邮箱页：拟人填邮箱 → 点下一步
            if (detect.email && !filled.email) {
              const typed = await this.typeField(win, 'input[name="identifier"]', entry.email)
              if (typed) {
                await sleep(randInt(300, 900))
                await this.clickCenter(win, ['#identifierNext', { text: '下一步' }, { text: 'next' }])
                filled.email = true
                lastSubmitAt = Date.now()
                this.log('ok', `${entry.email} 已自动填写邮箱并提交`)
              }
              continue
            }

            // 密码页：拟人填密码 → 点下一步
            if (detect.pass && !filled.password) {
              const typed = await this.typeField(win, 'input[name="Passwd"]', entry.password)
              if (typed) {
                await sleep(randInt(300, 900))
                await this.clickCenter(win, ['#passwordNext', { text: '下一步' }, { text: 'next' }])
                filled.password = true
                lastSubmitAt = Date.now()
                this.log('ok', `${entry.email} 已自动填写密码并提交`)
              }
              continue
            }

            // 2FA 验证器页：密钥版本地算码填入；辅邮版转人工收码
            if (detect.totp && !otpFilled) {
              if (entry.secret) {
                if (otpAttempts >= 2) {
                  notifyOnce('otp-limit', 'warn', `${entry.email} 2FA 码多次未过，请人工处理`)
                  deadline = Date.now() + idleTimeoutMs
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
                  await this.clickCenter(win, ['#totpNext', { text: '下一步' }, { text: 'next' }])
                  otpFilled = true
                  lastSubmitAt = Date.now()
                  this.log('ok', `${entry.email} 已自动填写 2FA 验证码并提交`)
                }
              } else {
                notifyOnce(
                  'totp-manual',
                  'warn',
                  `${entry.email} 需要 2FA 验证（辅助邮箱版）：请到辅助邮箱 ${entry.recoveryEmail || ''} 收码后填入窗口（等待不计时）`
                )
                deadline = Date.now() + idleTimeoutMs
              }
              continue
            }

            // 挑战方式选择页：自动选「确认您的辅助邮箱」（无需收码的那条路；
            // 输入卡密里有地址，选完进 kpe 输入页由下个分支自动填）
            if (detect.selection && entry.recoveryEmail) {
              if (Date.now() - selectionClickAt > 8_000) {
                selectionClickAt = Date.now()
                const clicked = await this.clickCenter(win, [
                  { text: '确认您的辅助邮箱' },
                  { text: 'confirm your recovery email' }
                ])
                if (clicked) {
                  if (!selectionLogged) {
                    selectionLogged = true
                    this.log('ok', `${entry.email} 已自动选择「确认您的辅助邮箱」验证方式`)
                  }
                  await sleep(randInt(500, 1200))
                }
              }
              continue
            }

            // 辅助邮箱确认挑战（kpe）：完整输入辅助邮箱地址即通过，无需收码——卡密里有，自动填
            if (detect.recovery && !filled.recovery) {
              if (entry.recoveryEmail) {
                const typed = await this.typeField(
                  win,
                  'input[name="knowledgePreregisteredEmailResponse"]',
                  entry.recoveryEmail
                )
                if (typed) {
                  await sleep(randInt(300, 900))
                  await this.clickCenter(win, [{ text: '下一步' }, { text: 'next' }])
                  filled.recovery = true
                  lastSubmitAt = Date.now()
                  this.log('ok', `${entry.email} 已自动填写辅助邮箱确认并提交`)
                }
              } else {
                notifyOnce('recovery-manual', 'warn', `${entry.email} 需要确认辅助邮箱但卡密未提供，请人工填写`)
                deadline = Date.now() + idleTimeoutMs
              }
              continue
            }

            // 未知挑战页（/challenge/ 路径且无已识别输入框）：人工 + 自动存档。
            // 提交后 10s 观察期内的过渡页不算（等跳转）
            if (
              detect.url.includes('/challenge/') &&
              !detect.email &&
              !detect.pass &&
              !detect.totp
            ) {
              if (Date.now() - lastSubmitAt < 10_000) continue
              notifyOnce('challenge', 'warn', `${entry.email} 触发二次验证挑战，需人工处理；无解挑战可直接关窗取消`)
              if (detect.url !== dumpedUrl) {
                dumpedUrl = detect.url
                void this.dumpChallengePage(win, entry, detect.url)
              }
              deadline = Date.now() + idleTimeoutMs
              continue
            }

            // OAuth 确认页：/signin/oauth/id（确认账号+继续按钮，最常见落点）或
            // /signin/oauth/consent（权限同意）。程序点「继续/允许」，点不到降人工并存档
            if (
              (detect.url.includes('/signin/oauth/id') ||
                detect.url.includes('/signin/oauth/consent')) &&
              !consentClicked
            ) {
              const clicked = await this.clickCenter(win, [
                { text: '继续' },
                { text: 'continue' },
                { text: '允许' },
                { text: 'allow' },
                { text: 'accept' },
                // 兜底：确认页的账号卡片本身可点（选此账号继续）
                { text: entry.email }
              ])
              if (clicked) {
                consentClicked = true
                lastSubmitAt = Date.now()
                this.log('ok', `${entry.email} 已自动点击授权确认`)
              } else {
                notifyOnce('consent', 'warn', `${entry.email} 授权确认页未能自动点击，请人工点「继续」`)
                if (detect.url !== dumpedUrl) {
                  dumpedUrl = detect.url
                  void this.dumpChallengePage(win, entry, detect.url)
                }
                deadline = Date.now() + idleTimeoutMs
              }
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
          resultId: `${Date.now()}-${entry.id}`,
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
          if (batchMode) {
            // 批次模式关窗标失败（回未用会被批次立刻重取，死循环）；单号模式属正常取消拨回未用
            this.fail(entry, 'window-closed', '授权窗口被关闭（批次模式标失败，可恢复后重跑）')
          } else {
            // 用户中途关窗 = 正常取消，拨回未用而不是标失败
            this.store.patch(entry.id, { state: 'unused', failReason: '窗口已关闭（可再次授权）' })
            this.emitEntry(this.store.get(entry.id)!)
            this.log('warn', `${entry.email} 授权窗口被关闭，条目已拨回未用`)
          }
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
          resultId: `${Date.now()}-${entry.id}`,
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

  /** 点击元素中心（规则：选择器或文本；sendInputEvent 走 OS 输入管线） */
  private async clickCenter(
    win: BrowserWindow,
    rules: Array<string | { text: string }>
  ): Promise<boolean> {
    try {
      const rect = (await win.webContents.executeJavaScript(
        `(${CLICK_GOOGLE_JS})(${JSON.stringify(JSON.stringify(rules))})`,
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

  /** 挑战页自动存档：窗口是 sandbox BrowserWindow 没法右键另存，遇到未知挑战
   *  （辅助邮箱确认、验证码等）把整页 HTML 落盘，供离线分析选择器做自动化 */
  private async dumpChallengePage(win: BrowserWindow, entry: GooglePoolEntry, url: string): Promise<void> {
    try {
      const html = (await win.webContents.executeJavaScript(
        'document.documentElement.outerHTML',
        true
      )) as string
      const dir = join(app.getPath('userData'), 'google-pool-challenges')
      mkdirSync(dir, { recursive: true })
      const file = join(
        dir,
        `${Date.now()}-${entry.email.replace(/[^a-zA-Z0-9]/g, '_')}.html`
      )
      writeFileSync(file, `<!-- url: ${url} -->\n${html}`)
      this.log('warn', `挑战页已存档（发我分析即可）：${file}`)
    } catch {
      /* 存档失败不影响主流程 */
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

  /** 动态出口 API 模式：extract-api=共享池一次性端点；kiro-pool=登录锁冻结出口 + 固定 socks5 入口 */
  private async setupEntryProxyFromApi(
    entry: GooglePoolEntry,
    cfg: LoginPoolProxyOptions
  ): Promise<EntryProxySetup> {
    if (cfg.api?.source === 'kiro-pool') {
      const kiro = cfg.api.kiroPool
      if (!kiro?.apiBase?.trim() || !kiro.username?.trim() || !kiro.password) {
        return { kind: 'failed', error: 'Kiro IP 池服务未配置完整（地址/账号/密码），未直连' }
      }
      try {
        const route = await acquireKiroPoolExit(kiro, (level, msg) =>
          this.log(level, `${entry.email} ${msg}`)
        )
        return {
          kind: 'ok',
          proxyRules: route.proxyRules,
          exitIp: route.exitIp,
          latencyMs: route.latencyMs,
          sourceKey: route.sourceKey,
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
