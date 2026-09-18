// 号池执行引擎：逐号驱动「Kiro GitHub OAuth 登录 → 激活入库」全链路。
//
// 设计要点（方案对齐记录见 vault: projects/kiro-account-manager）：
// - 每号一个应用内 BrowserWindow + 独立内存分区（不带 persist: 前缀，关窗即销毁），
//   会话永不串号、不残留——替代原「系统 Chrome 无痕窗口 + 插件」流程。
// - 填表走页面原生编辑管线（execCommand insertText，isTrusted=true）+ 真人节奏；
//   点击用 sendInputEvent（OS 输入管线，页面侧与真人无异）——插件时代被
//   DataDome flag 的是合成 DOM 事件，两者性质不同。
// - kiro:// 回调在窗口内拦截（will-navigate / did-start-navigation / did-fail-load /
//   setWindowOpenHandler 四路保险），不经系统协议；另留 manualCallback 兜底
//   （万一漏拦、OS 把协议转回本应用时由渲染进程转发）。
// - 半自动模式（semiAuto）：填表/2FA 自动，Sign in/Verify/Authorize 人手点，
//   状态机继续探测，人点完自然推进。
// - 人工验证策略：触发 DataDome/邮箱设备验证时，wait=窗口前置等人工过验证后
//   继续（等待期间重置超时）；skip=标记失败跳下一号。

import { BrowserWindow, protocol, session, type Session } from 'electron'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import type { LoginPoolStore, PoolEntry, PoolEntryView } from './store'
import { totpNow } from './totp'
import { ChainProxyRelay } from '../registration/chainProxy'
import {
  acquireDynamicExit,
  getSharedDynamicSource,
  onDynamicSourceLog,
  penalizeExitUse,
  resolveViaProxy
} from '../proxy/dynamicProxy'
import { maskProxyUrl, probeExitIp, proxyUrlHasCredentials } from '../proxy/proxyTools'
import { resolveProxyUrl } from '../proxy/hy2Bridge'
import { injectProxySession } from './proxySession'
import {
  applyWindowFingerprint,
  describeFingerprint,
  hardenSessionHeaders,
  resolveFingerprintEnv
} from './fingerprint'

/** 页面探测结果（PROBE_JS 的返回结构） */
interface PageDetect {
  url: string
  login: boolean
  pass: boolean
  otp: boolean
  authorize: boolean
  redirectLink: string | null
  continueLink: string | null
  captcha: boolean
  error: string | null
}

// ─── 依赖注入（由 main/index.ts 接线时提供，复用现有 Kiro OAuth 代码路径）──

export interface LoginPoolDeps {
  /** 构建 Kiro GitHub 登录 URL（PKCE），与 start-social-login 同源逻辑 */
  buildGithubLoginUrl: () => { url: string; codeVerifier: string; oauthState: string }
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

export interface BatchOptions {
  /** 号间冷却秒数；'rand' = 每次随机 30–120s */
  intervalSec: number | 'rand'
  /** 触发人机/设备验证：wait 等人工处理 / skip 标失败跳过 */
  manualPolicy: 'wait' | 'skip'
  /**
   * 授权自动化实验（默认关）：Authorize 按钮先程序攻两次——
   * 第 1 次完整输入仿真（预轨迹+按压序列），第 2 次 form.requestSubmit（表单层与真人一致）；
   * 两次都没过自动回退人工点击，不影响原流程。失败可能加重该号的授权风控，用不心疼的号试。
   */
  autoAuthorize?: boolean
  /** 出口代理（代理池快照，批次启动时由渲染层传入；主进程逐号消费，只读不回写） */
  proxy?: LoginPoolProxyOptions
}

/** 出口代理候选：渲染层从代理池筛出的 可用+启用 条目 */
export interface LoginPoolProxyCandidate {
  url: string
  usedCount: number
  latencyMs?: number
}

export type LoginPoolProxyStrategy = 'round_robin' | 'random' | 'least_used' | 'fastest'

/** 号池出口代理选项：开启后每个登录窗口取独立出口，取不到则该号失败，绝不直连 */
export interface LoginPoolProxyOptions {
  enabled: boolean
  /** pool=静态代理池条目（默认）；api=动态提链接口（一次性端点，批量提取逐号消费） */
  mode?: 'pool' | 'api'
  entries: LoginPoolProxyCandidate[]
  strategy: LoginPoolProxyStrategy
  /** 上游中转代理（可选）：目标代理要求非大陆来源 IP 时串联代理链 */
  upstreamProxy?: string
  /** api 模式配置 */
  api?: {
    /** 提链接口地址（num 参数会被批量值覆盖） */
    url: string
    /** 本地可信中转；留空自动取系统代理 */
    viaProxy?: string
    /** 单次批量提取数量，默认 5 */
    batchSize?: number
  }
}

/** 单号出口代理装配结果：off=未启用 / ok=可用 / failed=该号失败跳过（绝不直连） */
export type EntryProxySetup =
  | { kind: 'off' }
  | {
      kind: 'ok'
      proxyRules: string
      exitIp: string
      latencyMs: number
      /** 出口来源标识（api=提链端点 URL / pool=代理池条目 URL），风控惩罚定位用 */
      sourceKey: string
      mode: 'api' | 'pool'
      /** 释放本地中继等资源；窗口关闭时调用 */
      release: () => Promise<void>
    }
  | { kind: 'failed'; error: string }

export interface ResultPayload {
  entryId: string
  username: string
  accessToken: string
  refreshToken: string
  profileArn?: string
  expiresIn?: number
}

export interface LoginPoolEvents {
  onEntry: (entry: PoolEntryView) => void
  onLog: (line: { time: string; level: 'info' | 'ok' | 'err' | 'warn'; msg: string }) => void
  onBatch: (state: {
    running: boolean
    paused: boolean
    cooldownSec: number
    unused: number
  }) => void
  onResult: (payload: ResultPayload) => void
}

// ─── 页面探测脚本（轻量 DOM 查询，返回 JSON）─────────────────────────

const PROBE_JS = `(() => {
  const vis = (el) => !!el && el.offsetParent !== null
  const q = (s) => document.querySelector(s)
  const loginEl = q('input#login_field') || q('input[name="login"]')
  const passEl = q('input#password') || q('input[type="password"]')
  const otpEl = q('input[name="app_otp"]') || q('input#app_totp') || q('input[autocomplete="one-time-code"]')
  const authBtn = q('#js-oauth-authorize-btn') || q('button[name="authorize"]') ||
    [...document.querySelectorAll('button')].find((b) => /^authorize/i.test((b.textContent || '').trim()) && vis(b))
  // 只认红色错误条（.flash-error = 表单级错误）；flash-warn 里 "another tab or
  // window / Reload to refresh" 是 GitHub 会话提示，登录页常态存在，不能当失败
  let error = null
  const flash = q('.flash-error')
  if (flash) {
    const text = (flash.textContent || '').trim().slice(0, 140)
    if (text && !/another tab or window|Reload to refresh/i.test(text)) error = text
  }
  const onAuthorizeUrl = !loginEl && !otpEl && location.pathname.startsWith('/login/oauth/authorize')
  // GitHub 授权完成后的「正在重定向」安全确认页：正文提示 being redirected，
  // 页面上有带 code 的回调链接（或 setup page 链接）——主动跟进它
  let redirectLink = null
  let continueLink = null
  if (onAuthorizeUrl) {
    const anchors = [...document.querySelectorAll('a[href]')]
    const links = anchors.map((a) => a.href)
    redirectLink =
      links.find((h) => /[?&]code=/.test(h)) ||
      links.find((h) => /kiro-prod|auth\.desktop\.kiro\.dev/.test(h)) ||
      null
    const cont = anchors.find(
      (a) => a.offsetParent !== null && /setup page|continue/i.test((a.textContent || '').trim())
    )
    if (cont) continueLink = cont.href
  }
  return {
    url: location.href,
    login: vis(loginEl), pass: vis(passEl), otp: vis(otpEl),
    authorize: vis(authBtn) || onAuthorizeUrl,
    redirectLink,
    continueLink,
    captcha: !!document.querySelector('iframe[src*="captcha" i], .octocaptcha-spinner'),
    error
  }
})()`

/** 真人节奏逐字符填表（execCommand 原生编辑管线，事件 isTrusted=true）。
 *  两种 payload：credentials（用户名+密码）/ otp（单框验证码）。 */
const HUMAN_TYPE_JS = `(async (payload) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const rand = (a, b) => Math.floor(a + Math.random() * (b - a))
  const humanType = async (el, text) => {
    el.focus()
    el.scrollIntoView({ block: 'center' })
    try { el.setSelectionRange(el.value.length, el.value.length) } catch (e) { /* 非 text input 忽略 */ }
    for (const ch of text) {
      document.execCommand('insertText', false, ch)
      await sleep(rand(80, 200))
    }
  }
  if (payload.kind === 'credentials') {
    const loginEl = document.querySelector('input#login_field') || document.querySelector('input[name="login"]')
    const passEl = document.querySelector('input#password') || document.querySelector('input[type="password"]')
    if (!loginEl || !passEl) return { ok: false, error: 'no-form' }
    await humanType(loginEl, payload.username)
    await sleep(rand(300, 1200))
    await humanType(passEl, payload.password)
    return { ok: true }
  }
  const otpEl = document.querySelector('input[name="app_otp"]') || document.querySelector('input#app_totp') || document.querySelector('input[autocomplete="one-time-code"]')
  if (!otpEl) return { ok: false, error: 'no-otp-input' }
  await humanType(otpEl, payload.code)
  return { ok: true }
})`

/** 取可点元素视口坐标（先 scrollIntoView 再取 rect 中心）。
 *  规则数组元素：字符串 = CSS 选择器；{ text } = 按可点元素文本/value 包含匹配
 *  （含 input[type=submit]：GitHub OAuth 授权页的 Authorize 是 input 按钮） */
const CLICK_RECT_JS = `((rulesJson) => {
  const rules = JSON.parse(rulesJson)
  const clickables = [...document.querySelectorAll('button, input[type="submit"], input[type="button"], a[href]')]
  for (const r of rules) {
    let el = null
    if (typeof r === 'string') {
      const cand = document.querySelector(r)
      if (cand && cand.offsetParent !== null) el = cand
    } else if (r && r.text) {
      const want = String(r.text).toLowerCase()
      el = clickables.find((b) => {
        const label = ((b.textContent || b.value || '') + '').trim().toLowerCase()
        return label.includes(want) && b.offsetParent !== null
      })
    }
    if (el) {
      el.scrollIntoView({ block: 'center' })
      const rect = el.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) {
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
      }
    }
  }
  return null
})`

const SIGNIN_SELECTORS = ['input[name="commit"]', 'button[type="submit"]']

/** OAuth 授权页的确认按钮。注意:不要加 button[type=submit] 之类宽兜底——
 *  Cancel 也是 submit 型按钮,2026-09-18 实测曾兜到它,GitHub 回 access_denied
 *  ("The user has denied your application access")。只允许 id/name/文本精确命中。 */
const AUTHORIZE_SELECTORS = [
  { text: 'Authorize kirodotdev' },
  '#js-oauth-authorize-btn',
  'button[name="authorize"]',
  'input[name="authorize"]',
  { text: 'Authorize' }
]

/** 点击前取目标元素快照(实验判读用):命中了哪个按钮、页面上有哪些候选 */
const AUTHORIZE_SNAPSHOT_JS = `(() => {
  const sels = ['#js-oauth-authorize-btn', 'button[name="authorize"]', 'input[name="authorize"]']
  const hit = sels.map((s) => document.querySelector(s)).find(Boolean)
  const buttons = [...document.querySelectorAll('button, input[type="submit"]')]
    .filter((b) => b.offsetParent !== null)
    .map((b) => ((b.tagName) + (b.name ? '[' + b.name + ']' : '') + ':' + ((b.textContent || b.value || '').trim().slice(0, 20))))
  return { hit: hit ? (hit.tagName + (hit.name ? '[' + hit.name + ']' : '') + ':' + (hit.textContent || hit.value || '').trim().slice(0, 30)) : null, buttons }
})`

const PROBE_INTERVAL_MS = 1000
const STEP_TIMEOUT_MS = 180_000
/** 单号最多连试几个出口代理后放弃（每次尝试都经 ipify 真实探测，失败即弃） */
const PROXY_MAX_ATTEMPTS = 3

/** 授权回调跳转的落点页（protocol.handle 接管 kiro:// 后渲染在登录窗口内） */
const KIRO_LANDING_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
body{font-family:-apple-system,system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0d1117;color:#e6edf3}
.box{text-align:center}.ok{font-size:48px}.h{font-size:18px;margin:12px 0 6px}.s{font-size:13px;color:#8b949e}
</style></head><body><div class="box"><div class="ok">✅</div><div class="h">授权成功</div><div class="s">正在验证入库，窗口即将自动关闭…</div></div></body></html>`

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

export class LoginPoolRunner {
  private store: LoginPoolStore
  private deps: LoginPoolDeps
  private events: LoginPoolEvents
  private opts: BatchOptions = { intervalSec: 60, manualPolicy: 'wait' }

  running = false
  paused = false

  /** 当前执行窗口（观察按钮置前用；人工等待时保持显示） */
  private win: BrowserWindow | null = null

  /** 出口代理轮换游标（round_robin / least_used / fastest 按序消费；random 不用） */
  private proxyCursor = 0

  /** 被风控拉黑的静态池代理（URL → 解禁时间戳）：GitHub 登录被拒时短期避让，不再轮到它 */
  private blockedProxies = new Map<string, number>()

  /** 本批次内已因反滥用失败重试过的条目（每号最多重试一次，防无限循环） */
  private abuseRetried = new Set<string>()

  constructor(store: LoginPoolStore, deps: LoginPoolDeps, events: LoginPoolEvents) {
    this.store = store
    this.deps = deps
    this.events = events
    // 应用内接管 kiro:// 导航：登录窗口里的授权跳转不经过 OS，不受系统层
    // 协议归属影响（Kiro IDE 同样注册了 kiro://，OS 可能把回调派给它导致
    // 跳转链「断掉」——KiroLuker 注释里描述的同款坑）。state 不匹配的调用
    // 一律忽略，落点统一渲染成功页。
    protocol.handle('kiro', (request) => {
      const run = this.activeRun
      if (run) run.dispatch(request.url)
      return new Response(KIRO_LANDING_HTML, {
        headers: { 'content-type': 'text/html; charset=utf-8' }
      })
    })
    // 全局提链池（与订阅取链接共用一份队列与记忆）的动态转发进号池 UI 日志
    onDynamicSourceLog((m) => this.log('info', `[提链] ${m}`))
  }

  private log(level: 'info' | 'ok' | 'err' | 'warn', msg: string): void {
    this.events.onLog({ time: nowTime(), level, msg })
  }
  private emitEntry(entry: PoolEntry): void {
    this.events.onEntry(this.store.toView(entry))
  }
  private emitBatch(cooldownSec = 0): void {
    this.events.onBatch({
      running: this.running,
      paused: this.paused,
      cooldownSec,
      unused: this.store.countUnused()
    })
  }

  // ── 批次控制 ──

  start(opts: BatchOptions): void {
    if (this.running) return
    this.opts = opts
    this.running = true
    this.paused = false
    if (opts.autoAuthorize) {
      this.realMouseOk = this.probeRealMouse()
      this.log(
        this.realMouseOk ? 'ok' : 'warn',
        this.realMouseOk
          ? '授权实验：系统级真鼠标可用（System Events 派发按压）'
          : '授权实验：系统级真鼠标不可用——需在「系统设置 → 隐私与安全性 → 辅助功能」添加本应用；本轮按压回退 Chromium 模拟事件'
      )
    }
    const proxyDesc = opts.proxy?.enabled
      ? opts.proxy.mode === 'api'
        ? `，出口代理=提链 API（批量 ${Math.min(20, Math.max(1, Math.round(opts.proxy.api?.batchSize ?? 5)))} 个/次）`
        : `，出口代理=池内 ${opts.proxy.entries.length} 条（${opts.proxy.strategy}${opts.proxy.upstreamProxy ? '，经上游中转' : ''}）`
      : ''
    this.log(
      'info',
      `批次开始：间隔 ${opts.intervalSec === 'rand' ? '随机 30–120s' : opts.intervalSec + 's'}，模式=填表/2FA/点 Sign in 自动，Verify/Authorize/继续链接人点，人工验证=${opts.manualPolicy === 'wait' ? '等待接管' : '跳过'}${proxyDesc}`
    )
    this.emitBatch()
    void this.runBatch()
  }

  pause(): void {
    if (!this.running) return
    this.paused = true
    this.log('info', '批次暂停：当前号跑完后不再取下一号')
    this.emitBatch()
  }

  resume(opts?: BatchOptions): void {
    if (!this.running) {
      this.start(opts ?? this.opts)
      return
    }
    if (this.paused) {
      this.paused = false
      if (opts) this.opts = opts
      this.log('info', '批次继续')
      this.emitBatch()
    }
  }

  /** 单跑一个号（批次运行中拒绝）；opts 传入则覆盖当前选项（semiAuto 等即时生效） */
  runOne(id: string, opts?: BatchOptions): void {
    if (this.running) {
      this.log('warn', '批次执行中，不能单跑')
      return
    }
    const entry = this.store.get(id)
    if (!entry || entry.state === 'running') return
    if (opts) this.opts = opts
    this.store.patch(id, { state: 'running', step: 0, failReason: undefined })
    const fresh = this.store.get(id)!
    this.emitEntry(fresh)
    this.running = true
    this.emitBatch()
    void (async () => {
      await this.runEntryWithAbuseRetry(fresh)
      this.running = false
      this.emitBatch()
    })()
  }

  /** 系统协议兜底：漏拦时 OS 把 kiro:// 转回本应用，渲染进程转发到这里 */
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

  private activeRun: {
    oauthState: string
    resolveCallback: (v: { code?: string; error?: string }) => void
    /** 兜底链路收到回调时置 callbackSeen，让主循环退出 */
    markSeen: () => void
    /** 解析并派发一条 kiro:// 回调 URL（protocol.handle 应用内接管用） */
    dispatch: (url: string) => void
  } | null = null

  // ── 批次循环 ──

  private async runBatch(): Promise<void> {
    while (this.running && !this.paused) {
      const entry = this.store.takeNext()
      if (!entry) break
      this.emitEntry(entry)
      this.log('info', `${entry.username} 开始执行`)
      await this.runEntryWithAbuseRetry(entry)
      if (!this.running) break
      if (this.paused) break
      // 号间冷却（防风控）：期间可暂停/继续，取消则直接结束
      const cd = this.opts.intervalSec === 'rand' ? randInt(30, 120) : this.opts.intervalSec
      let cancelled = false
      for (let left = cd; left > 0 && this.running && !this.paused; left--) {
        this.emitBatch(left)
        await sleep(1000)
      }
      if (!this.running || this.paused) cancelled = true
      if (cancelled) {
        this.log('info', '冷却中断，批次挂起')
        break
      }
    }
    if (this.store.countUnused() === 0 && !this.paused) {
      this.log(
        'ok',
        `批次完成：池内无未用账号（成功 ${this.store.listViews().filter((e) => e.state === 'used').length} · 失败 ${this.store.listViews().filter((e) => e.state === 'failed').length}）`
      )
    }
    this.running = false
    this.emitBatch()
  }

  // ── 出口代理装配 ──

  /** 按策略从剩余候选中挑一个：轮询按序前进；最少使用/最快优先先排序再按游标取 */
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

  /**
   * 为单个号装配出口代理：候选 → 每号独立 session 注入（保证逐号不同 IP）→
   * 按需起本地中继（Chromium proxyRules 挂不了账密；上游中转串联代理链）→
   * ipify 探测真实出口。探测失败换下一个候选，最多 PROXY_MAX_ATTEMPTS 个；
   * 全部失败返回 failed——该号标失败跳过，绝不回退直连暴露本机 IP。
   */
  private async setupEntryProxy(entry: PoolEntry): Promise<EntryProxySetup> {
    const cfg = this.opts.proxy
    if (!cfg?.enabled) return { kind: 'off' }
    if (cfg.mode === 'api') return this.setupEntryProxyFromApi(entry, cfg)
    let remaining = cfg.entries.filter((c) => !!c.url && !this.isProxyBlocked(c.url))
    if (!remaining.length) {
      return {
        kind: 'failed',
        error: '代理池无可用代理（需启用且验活为可用；或已被风控拉黑，稍后自动解禁）'
      }
    }
    const upstream = (cfg.upstreamProxy || '').trim()
    let lastError = ''
    for (let attempt = 1; attempt <= PROXY_MAX_ATTEMPTS; attempt++) {
      const candidate = this.pickProxyCandidate(cfg, remaining)
      if (!candidate) break
      remaining = remaining.filter((c) => c !== candidate)
      // hy2(Hysteria2)代理先转本地 socks5;起不来(内核缺失/节点坏)按"本条不可用"换下一条
      let targetUrl = injectProxySession(candidate.url)
      try {
        targetUrl = (await resolveProxyUrl(targetUrl)) || targetUrl
      } catch (err) {
        this.log(
          'warn',
          `${entry.username} hy2 代理桥启动失败（${maskProxyUrl(candidate.url)}）：${err instanceof Error ? err.message : String(err)}`
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
          // 无上游时把目标代理自身当 upstream（退化为直连代理 + CONNECT 认证）
          relay = new ChainProxyRelay(upstreamResolved || targetUrl, targetUrl, (m) => this.log('warn', m))
          proxyRules = await relay.start()
        } catch (err) {
          this.log(
            'warn',
            `${entry.username} 本地代理中继启动失败：${err instanceof Error ? err.message : String(err)}`
          )
          continue
        }
      }
      const probe = await probeExitIp(proxyRules)
      if (probe.ok && probe.ip && probe.ms !== undefined) {
        this.log(
          'ok',
          `${entry.username} 出口代理已接通：${probe.ip}（${probe.ms}ms，经 ${maskProxyUrl(candidate.url)}）`
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
      this.log(
        'warn',
        `${entry.username} 代理 ${maskProxyUrl(candidate.url)} 探测失败（${lastError}），换下一个`
      )
    }
    return {
      kind: 'failed',
      error: `出口代理不可用（${lastError || '无候选'}），该号已跳过，未直连`
    }
  }

  /**
   * 提链 API 模式：每个号从全局共享池消费一个一次性端点（同入口不同端口 = 不同出口），
   * 走共享的「端点→中继→探测→计次」出口路由；提链接口本身不可用则直接失败该号
   * （内部已重试，换端点无意义）。
   */
  private async setupEntryProxyFromApi(
    entry: PoolEntry,
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
        (level, msg) => this.log(level, `${entry.username} ${msg}`)
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
        error: `${err instanceof Error ? err.message : String(err)}，该号已跳过，未直连`
      }
    }
  }

  // ── 出口风控止损 ──

  /** 静态池代理是否在风控拉黑期内（过期条目顺手清理） */
  private isProxyBlocked(url: string): boolean {
    const until = this.blockedProxies.get(url) || 0
    if (until <= Date.now()) {
      if (until) this.blockedProxies.delete(url)
      return false
    }
    return true
  }

  /** GitHub 反滥用拒绝（"You can't perform that action at this time."）后的出口止损：
   *  api 出口补计一次 24h 用量（立即用满，本轮不再分配给任何号）；
   *  pool 条目拉黑 30 分钟；直连无出口可换，由重试前的冷却等待缓解。 */
  private penalizeEgress(proxy: EntryProxySetup): void {
    if (proxy.kind !== 'ok') return
    if (proxy.mode === 'api') {
      penalizeExitUse(proxy.exitIp)
      this.log('warn', `出口 ${proxy.exitIp} 被 GitHub 风控拒绝，已计满 24h 用量，本轮不再分配`)
    } else {
      this.blockedProxies.set(proxy.sourceKey, Date.now() + 30 * 60_000)
      this.log(
        'warn',
        `代理 ${maskProxyUrl(proxy.sourceKey)}（出口 ${proxy.exitIp}）被 GitHub 风控拒绝，拉黑 30 分钟`
      )
    }
  }

  /** 判定条目是否因 GitHub 反滥用被拒（可换出口重试的失败形态） */
  private isAbuseBlocked(entryId: string): boolean {
    const e = this.store.get(entryId)
    return !!e && e.state === 'failed' && /perform that action/i.test(e.failReason || '')
  }

  /** 反滥用失败的换出口重试：每号每批次最多一次；等待期可暂停/停止。
   *  该错误是 IP 级风控（账号本身不受影响），换出口重跑的成功率远高于直接标死。 */
  private async runEntryWithAbuseRetry(entry: PoolEntry): Promise<void> {
    await this.runEntry(entry)
    if (!this.running || this.paused) return
    if (this.abuseRetried.has(entry.id) || !this.isAbuseBlocked(entry.id)) return
    this.abuseRetried.add(entry.id)
    const direct = !this.store.get(entry.id)?.exitIp
    const waitSec = direct ? 180 : 60 + randInt(0, 30)
    this.log(
      'info',
      `${entry.username} 出口 IP 被 GitHub 风控拒绝（账号未受影响），${waitSec}s 后换出口重试`
    )
    for (let left = waitSec; left > 0 && this.running && !this.paused; left--) {
      this.emitBatch(left)
      await sleep(1000)
    }
    if (!this.running || this.paused) {
      this.log('info', '重试等待被中断，条目保持失败态（可手动恢复未用再跑）')
      return
    }
    this.store.patch(entry.id, { state: 'running', step: 0, failReason: undefined })
    this.emitEntry(this.store.get(entry.id)!)
    this.log('info', `${entry.username} 换出口重试开始`)
    await this.runEntry(entry)
    if (this.store.get(entry.id)?.state === 'used') this.abuseRetried.delete(entry.id)
  }

  // ── 单号执行：窗口 + 状态机 ──

  private async runEntry(entry: PoolEntry): Promise<void> {
    const partition = `loginpool-${Date.now()}-${randomBytes(3).toString('hex')}`
    const login = this.deps.buildGithubLoginUrl()

    // 出口代理在设 activeRun / 开窗之前装配：失败直接跳号，无需清理任何资源
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
      },
      dispatch: (url: string) => {
        if (callbackSeen) return
        try {
          const u = new URL(url)
          const code = u.searchParams.get('code')
          const state = u.searchParams.get('state')
          const error = u.searchParams.get('error')
          if (code && state === login.oauthState) {
            this.log('info', `${entry.username} 授权回调已由 protocol.handle 应用内拦截`)
            callbackSeen = true
            callbackResolve({ code })
          } else if (error) {
            this.log('warn', `${entry.username} 授权回调带错误：${error}`)
            callbackSeen = true
            callbackResolve({ error })
          }
        } catch {
          /* 非 URL 忽略 */
        }
      }
    }

    // 指纹环境先于开窗解析：时区/语言要跟出口 IP 的归属地一致（直连则用本机值）。
    // geo 查询最坏 5s×2 服务，相对整号数分钟的耗时可以接受
    const fp = await resolveFingerprintEnv(proxy.kind === 'ok' ? proxy.exitIp : null)

    // 先显式建会话再开窗：setProxy 必须在 loadURL 之前完成，保证 GitHub 页面
    // 第一个请求就走池出口；partition 名不带 persist: 前缀 = 内存会话不落盘，
    // 再显式禁 HTTP 缓存双保险（与 KiroLuker 的 browser-web partition 一致）
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
      title: `Kiro 登录 · ${entry.username}`,
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
      this.log('info', `${entry.username} 指纹已对齐：${describeFingerprint(fp)}`)
    } else {
      this.log('warn', `${entry.username} 页面级指纹对齐未生效（${fpApplied.error}），退回请求头级`)
    }

    const handleCallbackUrl = (url: string, from: string): void => {
      if (callbackSeen) return
      try {
        const u = new URL(url)
        const code = u.searchParams.get('code')
        const state = u.searchParams.get('state')
        const error = u.searchParams.get('error')
        this.log('info', `拦截到回调（${from}）`)
        if (code && state) {
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

    // 导航日志：每次页面跳转记录 URL（诊断「卡在某步」用）
    let lastLoggedUrl = ''
    const logNavigation = (url: string, tag: string): void => {
      if (!url || url === lastLoggedUrl) return
      lastLoggedUrl = url
      this.log('info', `页面${tag}：${url.slice(0, 120)}`)
    }
    win.webContents.on('did-navigate', (_e, url) => logNavigation(url, ''))
    win.webContents.on('did-navigate-in-page', (_e, url) => logNavigation(url, '(in-page)'))

    // kiro:// 四路拦截（302 主文档跳转在不同 Chromium 版本里走的回调不同）
    win.webContents.on('will-navigate', (event, url) => {
      if (url.startsWith('kiro://')) {
        event.preventDefault()
        handleCallbackUrl(url, 'will-navigate')
      }
    })
    win.webContents.on('did-start-navigation', (_e, url) => {
      if (url.startsWith('kiro://')) handleCallbackUrl(url, 'did-start-navigation')
    })
    win.webContents.on('did-fail-load', (_e, _code, desc, url) => {
      if (url && url.startsWith('kiro://')) handleCallbackUrl(url, `did-fail-load:${desc || ''}`)
    })
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('kiro://')) {
        handleCallbackUrl(url, 'window-open')
        return { action: 'deny' }
      }
      if (/^https?:\/\//i.test(url)) return { action: 'allow' }
      return { action: 'deny' }
    })

    let windowClosed = false
    win.on('close', () => {
      this.log('info', '登录窗口 close 事件（谁触发待查：用户/程序/页面）')
    })
    win.on('closed', () => {
      this.log('info', '登录窗口已关闭')
      windowClosed = true
      if (this.win === win) this.win = null
      // 不在这里 resolve 失败：授权完成页跳 kiro:// 时页面可能自行关闭，
      // 而系统协议兜底的回调稍后才到——由主循环后的统一等待兜住，
      // 等不到回调再按超时处理
    })
    win.webContents.on('render-process-gone', (_e, details) => {
      this.log(
        'err',
        `页面渲染进程异常退出：${details.reason}${details.exitCode !== undefined ? ` (code ${details.exitCode})` : ''}`
      )
    })

    // 各阶段动作去重标记（同页重复探测不重复填/点；半自动时只提醒一次）
    const filled = { credentials: false, otp: false }
    /** Sign in 只点一次（提交后表单在慢代理下仍会滞留数秒，重复点击徒增风控特征） */
    let signinClicked = false
    /** cookie 收割结果（KiroLuker 同款路径：授权后凭证种在 app.kiro.dev cookie，不依赖回调跳转） */
    let cookieCred: { accessToken: string; refreshToken: string; profileArn?: string } | null = null
    const notified = { signin: false, verify: false, authorize: false, safeLink: false }
    /** 授权实验：本号已用掉的程序攻招数（0=未攻, 2=已用完回退人工） */
    let authorizeAttempts = 0
    /** 上次授权动作时间戳（两招之间留冷却观察窗口） */
    let lastAuthorizeAt = 0
    /** 上次点安全页继续链接的时间戳（实验限频） */
    let lastSafeLinkAt = 0
    /** 安全页继续链接已程序点击次数（超限回退人工） */
    let safeLinkAttempts = 0
    let aborted = false
    let otpAttempts = 0

    try {
      this.store.patch(entry.id, { step: 0 })
      this.emitEntry(this.store.get(entry.id)!)
      await win.loadURL(login.url)

      let deadline = Date.now() + STEP_TIMEOUT_MS
      let attentionNotified = false

      // 状态机主循环：探测 → 分阶段动作 → 等回调
      while (!callbackSeen && !windowClosed && !aborted) {
        await sleep(PROBE_INTERVAL_MS)
        if (windowClosed) break
        if (Date.now() > deadline) {
          this.fail(entry, 'timeout', '整体超时（3 分钟无进展）')
          aborted = true
          break
        }

        // Cookie 收割：授权批准后 Kiro 凭证种在本会话 app.kiro.dev cookie——
        // 与回调跳转是否完成无关（GitHub 安全页拦截跳转时凭证可能已落地）
        try {
          const cookies = await win.webContents.session.cookies.get({ domain: 'app.kiro.dev' })
          const rt = cookies.find((c) => c.name === 'RefreshToken')?.value
          if (rt) {
            this.log('ok', `${entry.username} 检测到 Kiro 会话凭证（cookie 收割），直接入库`)
            cookieCred = {
              accessToken: cookies.find((c) => c.name === 'AccessToken')?.value || rt,
              refreshToken: rt,
              profileArn: cookies.find((c) => c.name === 'ProfileArn')?.value
            }
            callbackSeen = true
            break
          }
        } catch {
          /* 会话不可用时忽略，下轮再看 */
        }

        let detect: PageDetect
        try {
          detect = await this.probe(win)
        } catch {
          continue // 页面跳转中 executeJavaScript 可能失败，下轮再看
        }
        const url: string = detect.url || ''

        // 人工验证态：DataDome 整页 / GitHub 邮箱设备验证 / 页内 captcha
        const isManual =
          url.includes('captcha-delivery.com') ||
          url.includes('/account_verifications') ||
          (!detect.login && !detect.otp && !detect.authorize && detect.captcha)
        if (isManual) {
          if (this.opts.manualPolicy === 'skip') {
            this.fail(entry, 'manual-verify', '触发人机/设备验证（策略=跳过）')
            aborted = true
            break
          }
          // wait：窗口前置等人工，等待期不计时
          if (!attentionNotified) {
            attentionNotified = true
            this.log(
              'warn',
              `${entry.username} 触发人工验证，窗口已前置，处理完成后自动继续（等待不计时）`
            )
            this.focusWindow()
          }
          deadline = Date.now() + STEP_TIMEOUT_MS
          continue
        }
        if (attentionNotified) {
          attentionNotified = false
          this.log('info', `${entry.username} 人工验证已通过，继续`)
        }

        // 登录表单：填账密（一次性）→（半自动则等人点）→ 点 Sign in
        if (detect.login && detect.pass) {
          if (!filled.credentials) {
            const res = await this.fillCredentials(win, entry.username, entry.password)
            if (res) {
              filled.credentials = true
              this.store.patch(entry.id, { step: 2 })
              this.emitEntry(this.store.get(entry.id)!)
              this.log('info', `${entry.username} 账密已填（拟人节奏）`)
            } else {
              this.log('warn', `${entry.username} 填表失败，下轮重试`)
            }
          }
          if (detect.error) {
            const via = proxy.kind === 'ok' ? `（出口 ${proxy.exitIp}）` : '（直连）'
            this.fail(entry, 'login-failed', `登录被拒：${detect.error}${via}`)
            this.penalizeEgress(proxy)
            aborted = true
            break
          }
          // 固定形态：Sign in 由程序点（trusted 事件，实测 GitHub 接受）；
          // 每个登录页只点一次，点前留一段拟人停顿（输完密码到移鼠标的间隙）
          if (!signinClicked) {
            await sleep(randInt(800, 2000))
            const clicked = await this.click(win, SIGNIN_SELECTORS)
            if (clicked) {
              signinClicked = true
              this.store.patch(entry.id, { step: 3 })
              this.emitEntry(this.store.get(entry.id)!)
            }
          }
          continue
        }
        signinClicked = false // 登录表单不在了（已跳转/换页），下个登录页可重新点

        // 2FA 页：本地算 TOTP（窗口尾部等下周期）→ 填 → 点 Verify
        if (detect.otp) {
          if (detect.error && filled.otp) {
            // 已填过仍报错 → 码失效/密钥错（OTP 填错后表单保留，可重填一次）
            if (otpAttempts >= 2) {
              this.fail(entry, '2fa-invalid', `两步验证失败：${detect.error}`)
              aborted = true
              break
            }
            filled.otp = false
            this.log('warn', `${entry.username} 2FA 被拒（${detect.error}），重取码重填`)
          }
          if (!filled.otp) {
            let t = totpNow(entry.secret)
            if (t.remainMs < 4000) {
              await sleep(t.remainMs + 300)
              t = totpNow(entry.secret)
            }
            const ok = await this.fillOtp(win, t.code)
            if (ok) {
              filled.otp = true
              otpAttempts += 1
              this.store.patch(entry.id, { step: 4 })
              this.emitEntry(this.store.get(entry.id)!)
              this.log(
                'info',
                `${entry.username} 2FA 码已填（${t.code}，剩 ${Math.ceil(t.remainMs / 1000)}s）`
              )
            } else {
              this.log('warn', `${entry.username} 2FA 填入失败，下轮重试`)
            }
          }
          // 固定形态：Verify 由人点——提示一次并前置窗口，等待期间不计时
          if (!notified.verify) {
            notified.verify = true
            this.log('info', `${entry.username} 请在窗口中手动点 Verify`)
            this.focusWindow()
          }
          deadline = Date.now() + STEP_TIMEOUT_MS
          continue
        }

        // OAuth 授权环节：默认一切点击都由人完成（Authorize 按钮与
        // 安全页的「继续」链接），程序只提示并等待——等待期间不计时，
        // 绝不超时关窗；人点完后 cookie 收割 / 回调拦截通道自动接管完成。
        // 授权自动化实验开启时（autoAuthorize）：程序先攻两次（轨迹点击→requestSubmit），
        // 都没推动再回退人工提示
        if (detect.authorize) {
          deadline = Date.now() + STEP_TIMEOUT_MS
          if (detect.continueLink) {
            // GitHub「正在重定向」安全页：授权已批准。
            // 链接 href 是判读关键：带 code= 说明授权成功只差跳转（点了就该过）；
            // 带 error=access_denied 说明服务端拒了这次授权，点死也无用——直接回退人工/标失败
            if (this.opts.autoAuthorize && safeLinkAttempts < 2 && Date.now() - lastSafeLinkAt > 6000) {
              lastSafeLinkAt = Date.now()
              safeLinkAttempts++
              const denied = /error=|access_denied/i.test(detect.continueLink)
              this.log(
                'info',
                `${entry.username} 授权实验：带轨迹点击安全页继续链接${denied ? `（链接带 access_denied=${detect.continueLink.slice(0, 300)}）` : ''}`
              )
              await this.clickWithTrail(win, [{ text: 'setup page' }, { text: 'continue' }])
            } else if (!notified.safeLink && (!this.opts.autoAuthorize || safeLinkAttempts >= 2)) {
              notified.safeLink = true
              this.log(
                'info',
                `${entry.username} 授权已批准，请在窗口中点击 "visit this setup page" 链接完成跳转（链接：${detect.continueLink.slice(0, 120)}）`
              )
              this.focusWindow()
            }
          } else if (
            this.opts.autoAuthorize &&
            authorizeAttempts < 2 &&
            Date.now() - lastAuthorizeAt > 6000
          ) {
            // 实验：第 1 招完整输入仿真（带鼠标移动历史），第 2 招表单层 requestSubmit；
            // 每招之间留 6s 冷却观察页面是否已被推动（探测循环 1s 一轮自然会看到）
            authorizeAttempts++
            lastAuthorizeAt = Date.now()
            if (authorizeAttempts === 1) {
              // 点击前抓页面按钮快照:确认命中的是 Authorize 而不是 Cancel
              const snap = (await win.webContents.executeJavaScript(
                `(${AUTHORIZE_SNAPSHOT_JS})()`,
                true
              )) as { hit: string | null; buttons: string[] } | null
              this.log(
                'info',
                `${entry.username} 授权页按钮快照：命中=${snap?.hit || '无'} | 候选=${JSON.stringify(snap?.buttons || [])}`
              )
              this.log('info', `${entry.username} 授权实验①：阅读停顿+滚动浏览后带轨迹点击 Authorize`)
              await sleep(randInt(2500, 5000))
              // 模拟人读授权页:一两次小幅滚动(看页面下方内容)再回位
              const [vw, vh] = win.getContentSize()
              for (let w = 0; w < randInt(1, 2); w++) {
                win.webContents.sendInputEvent({
                  type: 'mouseWheel',
                  x: Math.round(vw / 2 + (Math.random() * 60 - 30)),
                  y: Math.round(vh / 2 + (Math.random() * 40 - 20)),
                  deltaY: randInt(120, 280),
                  wheelTicksY: 2,
                  wheelTicksX: 0,
                  deltaX: 0
                })
                await sleep(randInt(600, 1400))
              }
              await sleep(randInt(500, 1200))
              const clicked = await this.clickWithTrail(win, AUTHORIZE_SELECTORS)
              if (!clicked) this.log('warn', `${entry.username} 授权按钮未找到（页面形态变化？）`)
            } else {
              this.log('info', `${entry.username} 授权实验②：requestSubmit 表单层提交`)
              const submitted = await this.requestSubmitAuthorize(win)
              if (!submitted) this.log('warn', `${entry.username} 授权表单未找到/提交失败`)
            }
          } else if (!notified.authorize && (!this.opts.autoAuthorize || authorizeAttempts >= 2)) {
            notified.authorize = true
            const via = this.opts.autoAuthorize ? '（实验两招未推动，回退人工）' : ''
            this.log(
              'info',
              `${entry.username} 请在窗口中手动点 Authorize${via}（若页面自动跳转则无需操作）`
            )
            this.focusWindow()
          }
          continue
        }

        // 其余状态（加载中 / 中间跳转 / 授权后重定向）继续等
      }

      if (aborted) return

      // cookie 收割路径：凭证已到手，无需 code/token 交换，直接交界面入库
      if (cookieCred) {
        this.store.patch(entry.id, { step: 8, state: 'used', failReason: undefined })
        this.emitEntry(this.store.get(entry.id)!)
        this.log('ok', `${entry.username} cookie 凭证交给界面验证入库`)
        this.events.onResult({
          entryId: entry.id,
          username: entry.username,
          accessToken: cookieCred.accessToken,
          refreshToken: cookieCred.refreshToken,
          profileArn: cookieCred.profileArn
        })
        return
      }

      // 统一等待回调：窗口可能已被页面 self-close（OAuth 自定义协议常见行为），
      // 系统协议兜底可能稍后才到，最多等 15s；token 交换不依赖窗口存活
      const cb = await Promise.race([callbackPromise, sleep(15_000).then(() => null)])
      if (!cb) {
        this.fail(
          entry,
          'timeout',
          windowClosed
            ? '窗口已关闭且 15s 内未收到授权回调（若人工关闭属正常取消）'
            : '等待授权回调超时'
        )
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
      this.store.patch(entry.id, { step: 7 })
      this.emitEntry(this.store.get(entry.id)!)
      this.log('info', `${entry.username} 已拦截 kiro:// 回调，交换 token…`)
      const token = await this.deps.exchangeSocialToken(cb.code, login.codeVerifier)
      if (token.success) {
        this.store.patch(entry.id, { step: 8, state: 'used', failReason: undefined })
        this.emitEntry(this.store.get(entry.id)!)
        this.log('ok', `${entry.username} token 交换成功，交给界面验证入库`)
        this.events.onResult({
          entryId: entry.id,
          username: entry.username,
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
        // 留 1.2s 让页面收尾（半自动模式下用户可能还想看一眼），随后自动关窗
        setTimeout(() => {
          if (!win.isDestroyed()) win.close()
        }, 1200)
      }
    }
  }

  private fail(entry: PoolEntry, reason: string, msg: string): void {
    this.store.patch(entry.id, { state: 'failed', failReason: msg })
    this.emitEntry(this.store.get(entry.id)!)
    this.log('err', `${entry.username} 失败[${reason}]：${msg}`)
  }

  // ── 页面动作封装 ──

  private async probe(win: BrowserWindow): Promise<PageDetect> {
    return win.webContents.executeJavaScript(PROBE_JS, true)
  }

  private async fillCredentials(
    win: BrowserWindow,
    username: string,
    password: string
  ): Promise<boolean> {
    const res = (await win.webContents.executeJavaScript(
      `(${HUMAN_TYPE_JS})(${JSON.stringify({ kind: 'credentials', username, password })})`,
      true
    )) as { ok: boolean; error?: string }
    return res?.ok === true
  }

  private async fillOtp(win: BrowserWindow, code: string): Promise<boolean> {
    const res = (await win.webContents.executeJavaScript(
      `(${HUMAN_TYPE_JS})(${JSON.stringify({ kind: 'otp', code })})`,
      true
    )) as { ok: boolean; error?: string }
    return res?.ok === true
  }

  /** trusted 点击：拿元素视口坐标 → sendInputEvent 鼠标事件（OS 输入管线）。
   *  规则数组元素：字符串 = CSS 选择器；{ text } = 按按钮文本匹配 */
  private async click(
    win: BrowserWindow,
    selectors: Array<string | { text: string }>
  ): Promise<boolean> {
    const rect = (await win.webContents.executeJavaScript(
      `(${CLICK_RECT_JS})(${JSON.stringify(JSON.stringify(selectors))})`,
      true
    )) as { x: number; y: number } | null
    if (!rect) return false
    const x = Math.round(rect.x + (Math.random() * 6 - 3))
    const y = Math.round(rect.y + (Math.random() * 6 - 3))
    win.webContents.sendInputEvent({ type: 'mouseMove', x, y })
    await sleep(randInt(80, 220))
    win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
    await sleep(randInt(60, 140))
    win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
    return true
  }

  /**
   * 辅助功能权限探测（系统级真鼠标生效前提；批次启动时探一次缓存结果）
   */
  private probeRealMouse(): boolean {
    if (process.platform !== 'darwin') return false
    try {
      execFileSync(
        'osascript',
        ['-e', 'tell application "System Events" to get name of first process'],
        { timeout: 3000, stdio: 'ignore' }
      )
      return true
    } catch {
      return false
    }
  }

  /** 系统级真鼠标可用性缓存（批次 start 时探测） */
  private realMouseOk = false

  /**
   * 系统级真鼠标点击（macOS）：System Events 在屏幕坐标派发 AX click——不经过
   * Chromium 输入管线，浏览器侧与真人点击同源。需应用已获「辅助功能」权限；
   * 失败（未授权/非 mac）返回 false，调用方回退 sendInputEvent。
   */
  private async realMouseClick(win: BrowserWindow, pageX: number, pageY: number): Promise<boolean> {
    if (process.platform !== 'darwin' || !this.realMouseOk) return false
    try {
      const b = win.getContentBounds()
      const gx = Math.round(b.x + pageX)
      const gy = Math.round(b.y + pageY)
      execFileSync(
        'osascript',
        ['-e', `tell application "System Events" to click at {${gx}, ${gy}}`],
        { timeout: 3000, stdio: 'ignore' }
      )
      return true
    } catch {
      return false
    }
  }

  /**
   * 完整输入仿真点击（授权实验用）：比 click 多一段鼠标移动历史——
   * 从窗口随机位置到目标按钮的贝塞尔轨迹（15~24 个点），再按压。
   * 按压优先走系统级真鼠标（System Events），不可用回退 sendInputEvent。
   */
  private async clickWithTrail(
    win: BrowserWindow,
    selectors: Array<string | { text: string }>
  ): Promise<boolean> {
    const size = win.getContentSize()
    const rect = (await win.webContents.executeJavaScript(
      `(${CLICK_RECT_JS})(${JSON.stringify(JSON.stringify(selectors))})`,
      true
    )) as { x: number; y: number } | null
    if (!rect) return false

    // 目标点（按钮内随机偏移,避免每次都点正中心）
    const tx = rect.x + (Math.random() * 10 - 5)
    const ty = rect.y + (Math.random() * 10 - 5)
    // 轨迹起点：窗口内随机位置（避开边缘）
    const sx = randInt(40, Math.max(60, size[0] - 40))
    const sy = randInt(40, Math.max(60, size[1] - 40))
    // 二次贝塞尔控制点：起终点中点附近大偏移,轨迹带弧度不走直线
    const cx = (sx + tx) / 2 + (Math.random() * 200 - 100)
    const cy = (sy + ty) / 2 + (Math.random() * 160 - 80)

    const steps = randInt(15, 24)
    for (let i = 1; i <= steps; i++) {
      const t = i / steps
      // ease-out:先快后慢(人移向目标时的减速)
      const e = 1 - (1 - t) * (1 - t)
      const px = Math.round((1 - e) * (1 - e) * sx + 2 * (1 - e) * e * cx + e * e * tx + (Math.random() * 2 - 1))
      const py = Math.round((1 - e) * (1 - e) * sy + 2 * (1 - e) * e * cy + e * e * ty + (Math.random() * 2 - 1))
      win.webContents.sendInputEvent({ type: 'mouseMove', x: px, y: py })
      await sleep(randInt(12, 38))
    }
    // 移到位后的小停顿,再按压(人的节奏)
    await sleep(randInt(90, 260))
    if (await this.realMouseClick(win, tx, ty)) return true
    win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(tx), y: Math.round(ty), button: 'left', clickCount: 1 })
    await sleep(randInt(70, 150))
    win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(tx), y: Math.round(ty), button: 'left', clickCount: 1 })
    return true
  }

  /**
   * 表单层直攻（授权实验第 2 招）：form.requestSubmit(submit 按钮)——
   * 与真人点按钮在表单层面完全一致（submit 事件 + submitter 的 name/value 进 POST），
   * 完全跳过鼠标事件层。若 GitHub 检测的是鼠标行为而非表单来源，此路可通。
   */
  private async requestSubmitAuthorize(win: BrowserWindow): Promise<boolean> {
    return (await win.webContents.executeJavaScript(
      `(() => {
        // 只精确命中授权按钮,不用 submit 泛匹配(可能抓到 Cancel,见 AUTHORIZE_SELECTORS 注释)
        const btn = document.querySelector('#js-oauth-authorize-btn')
          || document.querySelector('button[name="authorize"]')
          || document.querySelector('input[name="authorize"]')
          || [...document.querySelectorAll('button, input[type="submit"]')].find((b) =>
              b.offsetParent !== null && /^authorize/i.test(((b.textContent || b.value || '') + '').trim()))
        const form = btn && btn.closest('form')
        if (!form) return false
        try { form.requestSubmit(btn || undefined); return true } catch { return false }
      })()`,
      true
    )) as boolean
  }
}
