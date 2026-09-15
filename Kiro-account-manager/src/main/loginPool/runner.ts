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

import { BrowserWindow, protocol } from 'electron'
import { randomBytes } from 'node:crypto'
import type { LoginPoolStore, PoolEntry, PoolEntryView } from './store'
import { totpNow } from './totp'

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
    | { success: true; accessToken: string; refreshToken: string; profileArn?: string; expiresIn?: number }
    | { success: false; error: string }
  >
}

export interface BatchOptions {
  /** 号间冷却秒数；'rand' = 每次随机 30–120s */
  intervalSec: number | 'rand'
  /** 半自动：true 时只自动填表，Sign in/Verify/Authorize 人手点 */
  semiAuto: boolean
  /** 授权人工点：填表/2FA/Sign in/Verify 全自动，仅 Authorize 人手点。
   *  GitHub 对自动授权会话会用「正在重定向」安全页拦截（实测授权虽批准但
   *  跳转不走），人点 Authorize 则正常 302——默认开启，全自动前请先试水 */
  authorizeManual?: boolean
  /** 触发人机/设备验证：wait 等人工处理 / skip 标失败跳过 */
  manualPolicy: 'wait' | 'skip'
}

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
  onBatch: (state: { running: boolean; paused: boolean; cooldownSec: number; unused: number }) => void
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
const VERIFY_SELECTORS = ['button[type="submit"]', 'input[name="commit"]']
const AUTHORIZE_SELECTORS: Array<string | { text: string }> = [
  '#js-oauth-authorize-btn',
  'button[name="authorize"]',
  'input[name="authorize"]',
  { text: 'authorize' },
  { text: 'continue' },
  'button[type="submit"]',
  'input[type="submit"]'
]

/** dump 页面状态（授权链卡住时诊断：标题 + 正文摘要 + 可点元素清单） */
const DUMP_CLICKABLES_JS = `(() => {
  const btns = [...document.querySelectorAll('button, input[type="submit"], input[type="button"]')]
    .filter((b) => b.offsetParent !== null)
    .slice(0, 12)
    .map((b) => '<' + b.tagName.toLowerCase() + ' name="' + (b.name || '') + '" value="' + (b.value || '').slice(0, 30) + '">' + (b.textContent || '').trim().slice(0, 30) + '>')
    .join(' | ') || '(无)'
  const text = ((document.body && document.body.innerText) || '').replace(/\\s+/g, ' ').trim().slice(0, 200)
  return 'title="' + document.title + '" 正文="' + text + '" 按钮=[' + btns + ']'
})()`

const CHROME_MAJOR = process.versions.chrome.split('.')[0] || '134'
const CHROME_UA =
  `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ` +
  `Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`

const PROBE_INTERVAL_MS = 1000
const STEP_TIMEOUT_MS = 180_000

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
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':')
}

// ─── 执行器 ──────────────────────────────────────────────────────────

export class LoginPoolRunner {
  private store: LoginPoolStore
  private deps: LoginPoolDeps
  private events: LoginPoolEvents
  private opts: BatchOptions = { intervalSec: 60, semiAuto: false, manualPolicy: 'wait' }

  running = false
  paused = false

  /** 当前执行窗口（观察按钮置前用；人工等待时保持显示） */
  private win: BrowserWindow | null = null

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
      return new Response(KIRO_LANDING_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } })
    })
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
    this.log('info', `批次开始：间隔 ${opts.intervalSec === 'rand' ? '随机 30–120s' : opts.intervalSec + 's'}，模式=${opts.semiAuto ? '半自动（按钮人手点）' : '全自动'}，人工验证=${opts.manualPolicy === 'wait' ? '等待接管' : '跳过'}`)
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
      await this.runEntry(fresh)
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
      await this.runEntry(entry)
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
      this.log('ok', `批次完成：池内无未用账号（成功 ${this.store.listViews().filter((e) => e.state === 'used').length} · 失败 ${this.store.listViews().filter((e) => e.state === 'failed').length}）`)
    }
    this.running = false
    this.emitBatch()
  }

  // ── 单号执行：窗口 + 状态机 ──

  private async runEntry(entry: PoolEntry): Promise<void> {
    const partition = `loginpool-${Date.now()}-${randomBytes(3).toString('hex')}`
    const login = this.deps.buildGithubLoginUrl()

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

    const win = new BrowserWindow({
      width: 1080,
      height: 840,
      title: `Kiro 登录 · ${entry.username}`,
      autoHideMenuBar: true,
      webPreferences: {
        partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })
    this.win = win
    win.webContents.setUserAgent(CHROME_UA)

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
      this.log('err', `页面渲染进程异常退出：${details.reason}${details.exitCode !== undefined ? ` (code ${details.exitCode})` : ''}`)
    })

    // 各阶段动作去重标记（同页重复探测不重复填/点；半自动时只提醒一次）
    const filled = { credentials: false, otp: false }
    /** cookie 收割结果（KiroLuker 同款路径：授权后凭证种在 app.kiro.dev cookie，不依赖回调跳转） */
    let cookieCred: { accessToken: string; refreshToken: string; profileArn?: string } | null = null
    const notified = { signin: false, verify: false, authorize: false }
    const clickedOnce = { authorize: false }
    let authorizeDumped = false
    let authorizeStuckAt: number | null = null
    let authorizeReplays = 0
    let safeLinkClicks = 0
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
            this.log('warn', `${entry.username} 触发人工验证，窗口已前置，处理完成后自动继续（等待不计时）`)
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
            this.fail(entry, 'login-failed', `登录被拒：${detect.error}`)
            aborted = true
            break
          }
          if (this.opts.semiAuto) {
            if (!notified.signin) {
              notified.signin = true
              this.log('info', `${entry.username} 半自动模式：请在窗口中手动点 Sign in`)
              this.focusWindow()
            }
          } else {
            const clicked = await this.click(win, SIGNIN_SELECTORS)
            if (clicked) {
              this.store.patch(entry.id, { step: 3 })
              this.emitEntry(this.store.get(entry.id)!)
            }
          }
          continue
        }

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
              this.log('info', `${entry.username} 2FA 码已填（${t.code}，剩 ${Math.ceil(t.remainMs / 1000)}s）`)
            } else {
              this.log('warn', `${entry.username} 2FA 填入失败，下轮重试`)
            }
          }
          if (this.opts.semiAuto) {
            if (!notified.verify) {
              notified.verify = true
              this.log('info', `${entry.username} 半自动模式：请在窗口中手动点 Verify`)
              this.focusWindow()
            }
          } else {
            const clicked = await this.click(win, VERIFY_SELECTORS)
            if (clicked) {
              this.store.patch(entry.id, { step: 5 })
              this.emitEntry(this.store.get(entry.id)!)
            }
          }
          continue
        }

        // OAuth 授权页：点 Authorize（确认页场景）；已授权过的号无确认页，
        // GitHub 直接 302 → Kiro 中转 → kiro://——若跳转链中断页面会停在
        // authorize 空白态（无可点元素），此时重放登录 URL 自愈（GitHub 会话
        // 已在分区 cookie 里，重放不会再要账密/2FA）
        if (detect.authorize) {
          // GitHub「正在重定向」安全页：trusted 鼠标事件点击「继续」链接。
          // 不能用 loadURL 直航——丢失页面上下文会被 Cognito 判 access_denied；
          // trusted 点击与 Sign in/Verify 的自动点击同原理，页面侧无法区分人机
          if (detect.continueLink && safeLinkClicks < 2) {
            safeLinkClicks += 1
            this.log('info', `${entry.username} 点击授权跳转「继续」链接（第 ${safeLinkClicks} 次，trusted 事件）`)
            await this.click(win, [{ text: 'setup page' }, { text: 'continue' }])
            await sleep(randInt(1500, 2500))
            continue
          }
          if (this.opts.semiAuto) {
            if (!notified.authorize) {
              notified.authorize = true
              this.log('info', `${entry.username} 半自动模式：请在窗口中手动点 Authorize（若页面自动跳转则无需操作）`)
              this.focusWindow()
            }
          } else if (this.opts.authorizeManual) {
            // 授权人工点档：前置自动化全部完成，只等人在窗口里点 Authorize
            if (!notified.authorize) {
              notified.authorize = true
              this.log('info', `${entry.username} 请在窗口中手动点 Authorize（其余已全自动完成）`)
              this.focusWindow()
            }
            authorizeStuckAt = null
          } else if (!clickedOnce.authorize) {
            const clicked = await this.click(win, AUTHORIZE_SELECTORS)
            if (clicked) {
              clickedOnce.authorize = true
              authorizeStuckAt = null
              this.store.patch(entry.id, { step: 6 })
              this.emitEntry(this.store.get(entry.id)!)
            } else {
              // 授权完成后的「正在重定向」安全页：主动跟进带 code 的回调链接
              if (detect.redirectLink && authorizeReplays < 3) {
                authorizeReplays += 1
                authorizeStuckAt = null
                this.log('info', `${entry.username} 跟进授权重定向链接（第 ${authorizeReplays} 次）：${detect.redirectLink.slice(0, 100)}`)
                try {
                  await win.loadURL(detect.redirectLink)
                } catch {
                  /* 载入失败由后续探测兜 */
                }
                continue
              }
              if (!authorizeDumped) {
                // 卡住时 dump 页面真实状态（标题/正文/按钮）——不再盲猜 DOM
                authorizeDumped = true
                const dump = await this.dumpClickables(win)
                this.log('warn', `${entry.username} Authorize 按钮未匹配，页面状态：${dump}`)
              }
              if (!authorizeStuckAt) {
                authorizeStuckAt = Date.now()
              } else if (Date.now() - authorizeStuckAt > 20_000 && authorizeReplays < 2) {
                authorizeReplays += 1
                authorizeStuckAt = null
                authorizeDumped = false
                this.log('warn', `${entry.username} 授权链无进展，重放登录 URL 自愈（第 ${authorizeReplays} 次）`)
                try {
                  await win.loadURL(login.url)
                } catch {
                  /* 载入失败由后续探测兜 */
                }
              }
            }
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
          windowClosed ? '窗口已关闭且 15s 内未收到授权回调（若人工关闭属正常取消）' : '等待授权回调超时'
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

  private async fillCredentials(win: BrowserWindow, username: string, password: string): Promise<boolean> {
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

  /** dump 页面可点元素（Authorize 点击失败时记录，诊断选择器） */
  private async dumpClickables(win: BrowserWindow): Promise<string> {
    try {
      return (await win.webContents.executeJavaScript(DUMP_CLICKABLES_JS, true)) as string
    } catch {
      return '(页面跳转中，无法读取)'
    }
  }

  /** trusted 点击：拿元素视口坐标 → sendInputEvent 鼠标事件（OS 输入管线）。
   *  规则数组元素：字符串 = CSS 选择器；{ text } = 按按钮文本匹配 */
  private async click(win: BrowserWindow, selectors: Array<string | { text: string }>): Promise<boolean> {
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
}
