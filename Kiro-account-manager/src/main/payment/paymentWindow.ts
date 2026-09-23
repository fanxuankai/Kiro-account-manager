// 应用内 Stripe 支付窗口 —— 打开批量订阅拿到的支付链接，自动选国家(CN)、
// 选省份、拟人填写账单地址；卡号与 Pay 按钮留给人工（风控保守档）。
//
// 窗口骨架沿用 kiroPortal 模式（内存分区/导航留在应用内/尺寸裁剪），但
// 刻意不 import 它的内部函数：本模块独立维护，不影响官网后台的现有路径。
// 请求头与页面指纹复用 loginPool/fingerprint 的已导出通用函数；直连场景
// env 传 null（本机时区/语言，与出口 IP 天然一致）。
//
// 自动填策略（防御式，未经真机迭代过的选择器可能 miss）：
// - 新版 Checkout（guacamole）的卡/账单表单渲染在 js.stripe.com 的跨域
//   iframe 里，页面侧脚本被 same-origin 策略挡住够不着——由主进程枚举子
//   frame（WebFrameMain）定向探测与填写；classic 表单在顶层，完全不进
//   frame 分支，行为与历史版本一致；
// - 国家/省份优先按原生 select 处理（JS 设值 + dispatch），找不到再按
//   自定义下拉点击（点开 → 按文本点选项）；
// - 文本字段按 HTML autocomplete 语义属性定位（address-line1/postal-code 等），
//   兜底 name/placeholder；已有值的字段一律跳过不覆盖；
// - 任何一步 not-found 只记日志静默跳过——窗口本身就是完整可用的支付页，
//   自动填未命中时降级为纯手填，不阻塞支付。

import { BrowserWindow, app, screen, session as electronSession, shell } from 'electron'
import { applyWindowFingerprint, hardenSessionHeaders, resolveFingerprintEnv } from '../loginPool/fingerprint'
import { generateBillingAddress, isValidProvince, type BillingAddress } from './addressGen'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { clickWithTrail, sleep, randInt, PAY_FILL_JS } from './humanInput'

/** 一次性内存分区：关窗即弃，不与主窗口/官网后台共用任何会话状态 */
const PARTITION = 'payment-private'

/** 探测轮询间隔（秒级即可：页面加载与人工操作都不需要更快响应） */
const PROBE_INTERVAL_MS = 1200
/** 整窗探测寿命：链接约 15 分钟有效，30 分钟后停轮询（窗口保留人工用） */
const PROBE_LIFETIME_MS = 30 * 60 * 1000
/** 连续探测脚本异常达到该次数即停止自动化（页面结构不认识/被导航打断） */
const MAX_PROBE_ERRORS = 5

export type PaymentPhase = 'filling' | 'card-filled' | 'filled' | 'success' | 'expired' | 'closed' | 'error'

export interface PaymentUpdate {
  accountId: string
  email?: string
  phase: PaymentPhase
  detail?: string
  /** filled/success 附带本次生成的地址（预览与核对用） */
  address?: BillingAddress
}

export interface OpenPaymentOptions {
  url: string
  accountId: string
  email?: string
  /** 账单省份中文（如 "浙江省"），无效或缺失则随机省 */
  province?: string
  /** UI 预览过的地址（回传保证预览与实际填写一致）；缺省现场生成 */
  address?: BillingAddress
  /** 开窗即带的卡信息（粘贴解析后的内存值，不落盘）；表单出现后最先填入 */
  card?: CardInput
  /** 状态回调（由 index.ts 接到主窗口的 webContents） */
  notify: (update: PaymentUpdate) => void
}

/** 快捷填入的卡信息（内存值，不落盘） */
export interface CardInput {
  number: string
  expiry: string
  cvc: string
}

let paymentWindow: BrowserWindow | null = null
/** 排队中的卡信息：流水线卡阶段未到时先存，到点由流水线串行填入（杜绝并行打字） */
let pendingCard: CardInput | null = null
/** 本窗口流水线的卡阶段是否已过（过后 IPC 直填，之前入队） */
let cardStageDone = false
/** 探测循环锁定的新版页面表单 frame（IPC 直填卡复用；classic/未锁定为 null） */
let currentFillFrame: Electron.WebFrameMain | null = null

const CHILD_WEB_PREFERENCES = {
  partition: PARTITION,
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true
}

function paymentWindowSize(): { width: number; height: number } {
  const { width: aw, height: ah } = screen.getPrimaryDisplay().workAreaSize
  return {
    width: Math.min(1400, Math.max(900, aw - 80)),
    height: Math.min(1100, Math.max(600, ah - 80))
  }
}

/** 导航留在应用内：http(s) 用同分区应用内子窗口承载（3DS/银行页不外泄到系统浏览器） */
function keepNavigationInApp(contents: Electron.WebContents): void {
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          ...paymentWindowSize(),
          autoHideMenuBar: true,
          webPreferences: { ...CHILD_WEB_PREFERENCES }
        }
      }
    }
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  contents.on('did-create-window', (child) => {
    keepNavigationInApp(child.webContents)
  })
}

// ─── 页面探测脚本 ───────────────────────────────────────────────────

/** 页面状态探测：地址表单可见性、国家/省当前值、各字段值、成功/过期判定。
 *  选择器依据 2026-09-19 真实支付页 DOM 校准（Chrome 另存为快照）：字段 id 形如
 *  billingName/billingAddressLine1（Stripe Checkout 稳定命名），autocomplete 带
 *  "billing " 前缀（如 "billing postal-code"）——id 优先、autocomplete 包含兜底；
 *  国家/省均为原生 select（#billingCountry / #billingAdministrativeArea）。 */
const PAY_PROBE_JS = `(() => {
  const vis = (el) => !!el && el.offsetParent !== null
  const field = (sels) => {
    for (const s of sels) {
      const el = document.querySelector(s)
      if (vis(el)) return { found: true, value: (el.value || '').trim() }
    }
    return { found: false, value: '' }
  }
  const selValue = (sel) => {
    if (!sel) return null
    const opt = (sel.selectedOptions || [])[0]
    return ((opt && opt.text) || sel.value || '').trim() || null
  }
  const f = {
    name: field(['#billingName', '#billingAddress-nameInput', 'input[autocomplete*="cc-name" i]', 'input[autocomplete="billing name"]', 'input[name="billingName"]']),
    line1: field(['#billingAddressLine1', '#billingAddress-addressLine1Input', 'input[autocomplete*="address-line1" i]', 'input[name="billingAddressLine1"]', 'input[name="addressLine1"]']),
    line2: field(['#billingAddress-addressLine2Input', 'input[autocomplete*="address-line2" i]', 'input[name="addressLine2"]']),
    city: field(['#billingLocality', '#billingAddress-localityInput', 'input[autocomplete*="address-level2" i]', 'input[name="billingLocality"]']),
    district: field(['#billingDependentLocality', 'input[autocomplete*="address-level3" i]', 'input[name="billingDependentLocality"]']),
    zip: field(['#billingPostalCode', '#billingAddress-postalCodeInput', 'input[autocomplete*="postal-code" i]', 'input[name="billingPostalCode"]'])
  }
  // 国家/省：真实页面为原生 select。省份 option 形如 value="浙江省"、
  // 文本"浙江省 — Zhejiang Sheng"（中英界面都是双语形态，拼音匹配天然命中）；
  // 新版 habanero iframe 的 id 是 billingAddress-countryInput / administrativeAreaInput
  // （2026-09-23 实测 dump 校准）
  const countrySelect = document.querySelector('#billingCountry, #billingAddress-countryInput, select[autocomplete*="country" i]')
  const provinceSelect = document.querySelector('#billingAdministrativeArea, #billingAddress-administrativeAreaInput, select[autocomplete*="address-level1" i]')
  const onStripe = /(^|\\.)stripe\\.com$/i.test(location.hostname)
  // 弯引号归一成直引号：真实失败文案是 "We couldn't load checkout"（U+2019），直配正则会漏
  const bodyText = ((document.body && document.body.textContent) || '').replace(/[\\u2018\\u2019]/g, "'").slice(0, 5000)
  return {
    url: location.href,
    variant: document.documentElement.getAttribute('data-checkout-variant') || '',
    form: f.line1.found || f.city.found || f.zip.found,
    country: {
      found: !!countrySelect && vis(countrySelect),
      isSelect: !!countrySelect,
      value: countrySelect ? selValue(countrySelect) : null
    },
    province: {
      found: !!provinceSelect && vis(provinceSelect),
      isSelect: !!provinceSelect,
      value: provinceSelect ? selValue(provinceSelect) : null,
      // 省下拉 option>1 才算渲染出省份列表（国家选 CN 后才填充，首项是占位符）
      options: provinceSelect ? provinceSelect.options.length : 0
    },
    fields: f,
    success: /success/i.test(location.href) ||
      (onStripe && /payment (is )?(complete|success)|thanks for your order|支付成功|付款成功/i.test(bodyText)),
    loadFailed: onStripe && /we couldn'?t load checkout|couldn'?t be loaded|something went wrong\. please try again/i.test(bodyText),
    expired: onStripe && (
      /\\/expired/.test(location.pathname) ||
      /no longer (valid|available)|session has expired|already (been )?completed|已过期|已失效/i.test(bodyText)
    )
  }
})`

/** 原生 select 选项选择（React 兼容：input+change 双事件）。
 *  真实页面：#billingCountry 的 CN 项 value='CN'（文本"中国"）；
 *  #billingAdministrativeArea 的省份项 value='浙江省'（文本"浙江省 — Zhejiang Sheng"），
 *  address.provinceZh 恰为 option value，优先按 value 精确选中，文本包含匹配兜底。 */
const PAY_SELECT_JS = `(async (payload) => {
  const sel = document.querySelector(payload.sel)
    || document.querySelector('select[autocomplete*="' + payload.autoContains + '"]')
  if (!sel || sel.offsetParent === null) return { ok: false, error: 'no-select' }
  const words = (payload.matchWords || []).map((w) => String(w).toLowerCase())
  const opt = [...sel.options].find((o) => {
    if (payload.value && o.value === payload.value) return true
    const t = (o.text || '').toLowerCase()
    return words.some((w) => t.includes(w) || (o.value || '').toLowerCase() === w)
  })
  if (!opt) return { ok: false, error: 'no-option' }
  sel.value = opt.value
  sel.dispatchEvent(new Event('input', { bubbles: true }))
  sel.dispatchEvent(new Event('change', { bubbles: true }))
  return { ok: true, value: (opt.text || '').trim() }
})`

/** 真人节奏批量填表（见 humanInput.PAY_FILL_JS 的内核说明）——id 为真实页面实测命名：
 *  classic 为 billingName/billingAddressLine1 系列；新版 habanero iframe 为
 *  billingAddress-nameInput/addressLine1Input 系列（2026-09-23 实测 dump 校准） */
const FILL_RULES: Record<string, string[]> = {
  name: ['#billingName', '#billingAddress-nameInput', 'input[autocomplete*="cc-name" i]', 'input[autocomplete="billing name"]', 'input[name="billingName"]'],
  line1: ['#billingAddressLine1', '#billingAddress-addressLine1Input', 'input[autocomplete*="address-line1" i]', 'input[name="billingAddressLine1"]', 'input[name="addressLine1"]'],
  line2: ['#billingAddress-addressLine2Input', 'input[autocomplete*="address-line2" i]', 'input[name="addressLine2"]'],
  city: ['#billingLocality', '#billingAddress-localityInput', 'input[autocomplete*="address-level2" i]', 'input[name="billingLocality"]'],
  district: ['#billingDependentLocality', 'input[autocomplete*="address-level3" i]', 'input[name="billingDependentLocality"]'],
  zip: ['#billingPostalCode', '#billingAddress-postalCodeInput', 'input[autocomplete*="postal-code" i]', 'input[name="billingPostalCode"]'],
  cardNumber: ['#cardNumber', '#payment-numberInput', 'input[autocomplete="cc-number"]'],
  cardExpiry: ['#cardExpiry', '#payment-expiryInput', 'input[autocomplete="cc-exp"]'],
  cardCvc: ['#cardCvc', '#payment-cvcInput', 'input[autocomplete="cc-csc"]']
}

// ─── 新版页面结构记录 ────────────────────────────────────────────────

/** 收集页面结构（脱敏）：变体/标题/可见字段清单（无值）/表单区域 HTML（克隆清值） */
const PAY_DUMP_JS = `(() => {
  const vis = (el) => !!el && el.offsetParent !== null
  const fields = [...document.querySelectorAll('input:not([type=hidden]), select, textarea')]
    .filter(vis)
    .map((el) => ({
      tag: el.tagName.toLowerCase(),
      type: el.type || '',
      id: el.id || '',
      name: el.name || '',
      auto: el.getAttribute('autocomplete') || '',
      placeholder: el.placeholder || '',
      aria: el.getAttribute('aria-label') || ''
    }))
  // 表单区域：含地址/卡语义字段的最近 form，退而求其次取字段们的公共祖先
  const semantic = [...document.querySelectorAll('input[autocomplete], select[autocomplete]')]
  const scopeEl = semantic.length
    ? (semantic[0].closest('form') || semantic[0].closest('div[class*=Payment] i') || document.body)
    : document.body
  const clone = scopeEl.cloneNode(true)
  clone.querySelectorAll('script, style, noscript, iframe').forEach((n) => n.remove())
  clone.querySelectorAll('input, textarea').forEach((n) => n.removeAttribute('value'))
  return {
    meta: {
      variant: document.documentElement.getAttribute('data-checkout-variant') || '',
      title: document.title || '',
      host: location.host,
      pathname: location.pathname,
      fieldCount: fields.length
    },
    fields,
    html: clone.outerHTML.slice(0, 2_000_000)
  }
})`

/**
 * 落盘页面结构快照（userData/payment-dumps/），用于适配新版 Checkout。
 * 每个支付窗口最多 2 次，避免刷屏；URL 只记 host+path 不带支付 token。
 */
async function dumpPageStructure(win: BrowserWindow, reason: string, frame?: Electron.WebFrameMain | null): Promise<void> {
  try {
    const data = (await jsRunner(win, frame ?? null)(`(${PAY_DUMP_JS})()`)) as {
      meta: Record<string, unknown>
      fields: Array<Record<string, string>>
      html: string
    }
    const dir = join(app.getPath('userData'), 'payment-dumps')
    mkdirSync(dir, { recursive: true })
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    writeFileSync(
      join(dir, `page-${ts}.json`),
      JSON.stringify({ reason, ...data.meta, fields: data.fields }, null, 2)
    )
    writeFileSync(join(dir, `page-${ts}.html`), data.html)
    console.log(`[Payment] 已记录页面结构（${reason}，variant=${String(data.meta.variant) || '?'}，字段 ${data.fields.length} 个${frame ? '，子 frame' : ''}）`)
  } catch (e) {
    console.log('[Payment] 页面结构记录失败:', String(e).slice(0, 100))
  }
}

// ─── 子 frame 定向执行（新版 Checkout：表单在跨域 iframe 里） ──────────

/** 页面脚本执行器：frame 为空走顶层 webContents，否则定向到该子 frame。
 *  跨域 iframe 的内容页面侧 JS 被 same-origin 策略挡住，只有主进程能经
 *  WebFrameMain.executeJavaScript 定向执行——探测与全部填表动作共用。 */
function jsRunner(win: BrowserWindow, frame: Electron.WebFrameMain | null): (code: string) => Promise<unknown> {
  return frame
    ? (code) => frame.executeJavaScript(code, true)
    : (code) => win.webContents.executeJavaScript(code, true)
}

/** 枚举窗口内全部子 frame（含跨域 iframe），滤掉还没加载出 http(s) 地址的 */
function childFrames(win: BrowserWindow): Electron.WebFrameMain[] {
  const out: Electron.WebFrameMain[] = []
  try {
    const main = win.webContents.mainFrame
    for (const f of main.framesInSubtree) {
      try {
        if (f !== main && !f.isDestroyed() && /^https?:/i.test(f.url || '')) out.push(f)
      } catch { /* 帧树变动中，该帧跳过 */ }
    }
  } catch { /* 窗口临界销毁 */ }
  return out
}

/** 逐子 frame 探测，返回首个可见账单表单的 frame 及其探测结果（无则 null） */
async function probeChildFrames(win: BrowserWindow): Promise<{ frame: Electron.WebFrameMain; probe: ProbeResult } | null> {
  for (const frame of childFrames(win)) {
    try {
      const p = (await frame.executeJavaScript(`(${PAY_PROBE_JS})()`, true)) as ProbeResult
      if (p.form) return { frame, probe: p }
    } catch { /* 帧已失效，跳过 */ }
  }
  return null
}

/** 探测循环锁定的表单 frame（IPC 直填卡复用）；已销毁则返回 null 走顶层 */
function liveFillFrame(): Electron.WebFrameMain | null {
  const f = currentFillFrame
  if (!f) return null
  try {
    return f.isDestroyed() ? null : f
  } catch {
    return null
  }
}

// ─── 状态机 ─────────────────────────────────────────────────────────

interface ProbeResult {
  url: string
  variant: string
  form: boolean
  country: { found: boolean; isSelect: boolean; value: string | null }
  province: { found: boolean; isSelect: boolean; value: string | null; options: number }
  fields: Record<string, { found: boolean; value: string }>
  success: boolean
  expired: boolean
  loadFailed: boolean
}

/**
 * 打开支付窗口并启动自动填状态机。
 * 已有支付窗时先关旧开新（同一时刻只服务一个账号）。
 */
export async function openPaymentWindow(opts: OpenPaymentOptions): Promise<void> {
  const { url, accountId, email, notify } = opts
  if (!/^https:\/\//i.test(url)) throw new Error('仅支持 https 支付链接')

  if (paymentWindow && !paymentWindow.isDestroyed()) {
    paymentWindow.destroy()
  }
  paymentWindow = null
  pendingCard = opts.card || null
  cardStageDone = false
  currentFillFrame = null

  const address =
    opts.address ||
    generateBillingAddress(
      opts.province && isValidProvince(opts.province) ? opts.province : undefined
    )

  // 会话：内存分区 + 强制直连（不读系统代理；TUN 层由用户的分流规则决定）
  const ses = electronSession.fromPartition(PARTITION)
  await ses.setProxy({ mode: 'direct' })
  const env = await resolveFingerprintEnv(null)
  hardenSessionHeaders(ses, env)

  const win = new BrowserWindow({
    ...paymentWindowSize(),
    title: email ? `支付 - ${email}` : '支付',
    autoHideMenuBar: true,
    webPreferences: { ...CHILD_WEB_PREFERENCES }
  })
  paymentWindow = win
  win.on('closed', () => {
    if (paymentWindow === win) paymentWindow = null
    notify({ accountId, email, phase: 'closed' })
  })
  keepNavigationInApp(win.webContents)

  // 指纹对齐会先导航 about:blank，之后再加载支付页
  const fp = await applyWindowFingerprint(win, env)
  if (!fp.ok) console.log('[Payment] 指纹对齐失败（回退 setUserAgent）:', fp.error)
  await win.loadURL(url, { userAgent: win.webContents.getUserAgent() })
  console.log(`[Payment] 窗口已打开 ${email || accountId} · 省=${address.provinceZh} · 指纹=${fp.ok ? 'ok' : 'fallback'}`)
  if (win.isMinimized()) win.restore()
  win.focus()

  void runFillLoop(win, opts, address, notify)
}

/** 自动填主循环：探测 → 选国家 → 选省 → 填文本 → 上报 filled；成功/过期即止 */
async function runFillLoop(
  win: BrowserWindow,
  opts: OpenPaymentOptions,
  address: BillingAddress,
  notify: (update: PaymentUpdate) => void
): Promise<void> {
  const { accountId, email } = opts
  const startedAt = Date.now()
  let probeErrors = 0
  let reportedFilling = false
  let reportedFilled = false
  let reportedSuccess = false
  let reportedExpired = false
  let lastSummary = ''
  let formMissStreak = 0
  let loadFailStreak = 0
  let reportedFrameFound = false
  let fillMissDumped = false
  let dumpBudget = 3
  const maybeDump = async (reason: string, frame?: Electron.WebFrameMain | null): Promise<void> => {
    if (dumpBudget <= 0) return
    dumpBudget -= 1
    await dumpPageStructure(win, reason, frame)
  }

  while (
    paymentWindow === win &&
    !win.isDestroyed() &&
    Date.now() - startedAt < PROBE_LIFETIME_MS &&
    !reportedSuccess &&
    !reportedExpired
  ) {
    let probe: ProbeResult | null = null
    try {
      probe = (await win.webContents.executeJavaScript(`(${PAY_PROBE_JS})()`, true)) as ProbeResult
      probeErrors = 0
    } catch (e) {
      probeErrors += 1
      console.log(`[Payment] 探测脚本异常 ${probeErrors}/${MAX_PROBE_ERRORS}:`, String(e).slice(0, 120))
      if (probeErrors >= MAX_PROBE_ERRORS) {
        console.log('[Payment] 连续异常，停止自动填（窗口保留人工使用）')
        return
      }
    }
    if (!probe) {
      await sleep(PROBE_INTERVAL_MS)
      continue
    }

    if (probe.success) {
      reportedSuccess = true
      console.log('[Payment] 探测到支付成功')
      notify({ accountId, email, phase: 'success', address })
      return
    }
    if (probe.expired) {
      reportedExpired = true
      console.log('[Payment] 探测到链接过期')
      notify({ accountId, email, phase: 'expired' })
      return
    }
    if (probe.loadFailed) {
      loadFailStreak += 1
      if (loadFailStreak === 3) {
        console.log('[Payment] 页面资源加载失败（疑似 js.stripe.com 等域直连不通）')
        // 退出前先落盘失败态快照（修时序：记录先于停止，失败现场不再丢失）
        await maybeDump('load-failed')
        notify({
          accountId,
          email,
          phase: 'error',
          detail: 'new-page-load-failed'
        })
        return
      }
    } else {
      loadFailStreak = 0
    }

    // 表单定位：classic 表单在顶层（probe 即驱动结果）；新版 Checkout 表单在
    // 跨域 iframe 里顶层探不到——主进程逐子 frame 探测接管。classic 页面
    // 永不进 frame 分支，探测与填写路径与历史版本完全一致。
    let fillFrame: Electron.WebFrameMain | null = null
    let drive = probe
    if (!probe.form && probe.variant && probe.variant !== 'classic') {
      const hit = await probeChildFrames(win)
      if (hit) {
        fillFrame = hit.frame
        drive = hit.probe
        currentFillFrame = fillFrame
        if (!reportedFrameFound) {
          reportedFrameFound = true
          let host = ''
          try { host = new URL(fillFrame.url).host } catch { /* url 读不到不碍事 */ }
          console.log(`[Payment] 表单位于子 frame（${host || '?'}），自动填定向该 frame`)
          await maybeDump('frame-found', fillFrame) // 新版表单真实结构，选择器校准依据
        }
      } else {
        currentFillFrame = null
      }
    } else {
      currentFillFrame = null
    }

    // 状态摘要变化才打日志（每秒轮询不打屏）；@frame 标记驱动来自子 frame
    const summary = `[${probe.variant || '?'}]${fillFrame ? '@frame' : ''} form=${drive.form} country=${drive.country.value || '?'} prov=${drive.province.value || '?'}(${drive.province.options}) ` +
      Object.entries(drive.fields).map(([k, v]) => `${k}=${v.found ? (v.value ? '✓' : '-') : 'x'}`).join(' ')
    if (summary !== lastSummary) {
      lastSummary = summary
      console.log(`[Payment] ${summary}`)
    }

    if (!drive.form) {
      formMissStreak += 1
      if (formMissStreak === 6) {
        // 页面已渲染但认不出账单表单——大概率新版 Checkout，落盘快照供适配
        await maybeDump(`form-unrecognized-${probe.variant || 'novariant'}`)
      }
      await sleep(PROBE_INTERVAL_MS + randInt(0, 300))
      continue
    }
    formMissStreak = 0

    if (!reportedFilling) {
      reportedFilling = true
      notify({ accountId, email, phase: 'filling', address })
      if (probe.variant && probe.variant !== 'classic') {
        await maybeDump(`variant-${probe.variant}`)
      }
    }

    // 卡阶段（页面从上到下：卡区在账单地址上方，且不依赖国家选择）——
    // 只走这一处，天然与地址串行；UI 后粘贴的卡由 IPC 入队在此消费
    if (!cardStageDone) {
      cardStageDone = true
      if (pendingCard) {
        const card = pendingCard
        pendingCard = null
        const r = await fillCardDetails(card, fillFrame)
        notify({ accountId, email, phase: 'card-filled' })
        if (r.results && r.results.filter((x) => !x.ok).length >= 2) {
          // 卡字段大面积定位失败——结构可能不符，落盘目标 frame 快照供适配
          await maybeDump('card-miss', fillFrame)
        }
      }
    }

    try {
      const countryOk = await ensureCountry(win, drive, fillFrame)
      if (!countryOk) {
        await sleep(PROBE_INTERVAL_MS)
        continue
      }
      const provinceOk = await ensureProvince(win, drive, address, fillFrame)
      if (!provinceOk) {
        await sleep(PROBE_INTERVAL_MS)
        continue
      }
      const fillResult = await fillTextFields(win, address, fillFrame)
      if (!fillMissDumped && fillResult && fillResult.filter((x) => !x.ok).length >= 2) {
        // 关键字段定位失败——结构可能改版，落盘快照供适配（每窗口只落一次）
        fillMissDumped = true
        await maybeDump('fill-miss', fillFrame)
      }
    } catch (e) {
      console.log('[Payment] 填写动作异常:', String(e).slice(0, 120))
    }

    if (!reportedFilled && (await allFieldsFilled(win, fillFrame))) {
      reportedFilled = true
      console.log('[Payment] 全部地址字段已填好')
      notify({ accountId, email, phase: 'filled', address })
    }

    await sleep(PROBE_INTERVAL_MS + randInt(100, 400))
  }
  if (Date.now() - startedAt >= PROBE_LIFETIME_MS) console.log('[Payment] 超过探测寿命，停止自动填')
}

/** 国家是否已是中国；不是则选择之。返回本轮结束后是否就绪 */
async function ensureCountry(
  win: BrowserWindow,
  probe: ProbeResult,
  frame: Electron.WebFrameMain | null
): Promise<boolean> {
  const run = jsRunner(win, frame)
  const current = (probe.country.value || '').toLowerCase()
  if (current.includes('china') || current.includes('中国') || current === 'cn') return true

  if (probe.country.isSelect) {
    const r = (await run(
      `(${PAY_SELECT_JS})(${JSON.stringify({
        sel: '#billingCountry, #billingAddress-countryInput',
        autoContains: 'country',
        value: 'CN',
        matchWords: ['china', '中国']
      })})`
    )) as { ok: boolean; error?: string }
    console.log('[Payment] 选国家 CN →', JSON.stringify(r))
    if (r.ok) {
      await sleep(randInt(600, 1000)) // 国家切换会重渲染省市字段
      return true
    }
    return false
  }
  // 自定义下拉兜底只在顶层（classic）用：坐标点击基于顶层文档定位，
  // 子 frame 内元素坐标需换算，新版页面这条路先不开（由 dump 校准后再说）
  if (!frame && (await clickWithTrail(win, [{ text: 'Country' }]))) {
    await sleep(randInt(400, 700))
    if (await clickWithTrail(win, [{ text: 'China' }])) {
      await sleep(randInt(600, 1000))
      return true
    }
  }
  return false
}

/** 省份是否已选中目标省；不是则选择之（address.provinceZh 即真实 option value） */
async function ensureProvince(
  win: BrowserWindow,
  probe: ProbeResult,
  address: BillingAddress,
  frame: Electron.WebFrameMain | null
): Promise<boolean> {
  const run = jsRunner(win, frame)
  // 已选中目标省则跳过（option 文本"浙江省 — Zhejiang Sheng"含拼音与中文双形态）
  const cur = probe.province.value || ''
  if (cur.includes(address.provinceZh) || cur.toLowerCase().includes(address.provinceEn.toLowerCase())) return true
  // 省份选项在国家选成 CN 后才异步填充（首项是"省/州"占位符），未就绪等下一轮
  const ready = (await run(
    `(() => { const s = document.querySelector('#billingAdministrativeArea, select[autocomplete*="address-level1" i]'); return !!s && s.options.length > 1 })()`
  ).catch(() => false)) as boolean
  if (!ready) {
    console.log('[Payment] 省份下拉未就绪（options<=1），等下一轮')
    return false
  }

  const r = (await run(
    `(${PAY_SELECT_JS})(${JSON.stringify({
      sel: '#billingAdministrativeArea, #billingAddress-administrativeAreaInput',
      autoContains: 'address-level1',
      value: address.provinceZh,
      matchWords: [address.provinceEn.toLowerCase(), address.provinceZh]
    })})`
  )) as { ok: boolean; error?: string; value?: string }
  console.log(`[Payment] 选省 ${address.provinceZh} →`, JSON.stringify(r))
  if (r.ok) {
    await sleep(randInt(300, 600)) // 省切换可能联动邮编前缀建议
    return true
  }
  // 自定义下拉兜底只在顶层（classic）用（同 ensureCountry 的坐标限制）
  if (!frame) {
    for (const trigger of [{ text: 'Province' }, { text: '省' }]) {
      if (await clickWithTrail(win, [trigger])) {
        await sleep(randInt(400, 700))
        if (await clickWithTrail(win, [{ text: address.provinceEn }])) {
          await sleep(randInt(300, 600))
          return true
        }
      }
    }
  }
  return false
}

/** 填写文本字段（空的才填）；返回各字段结果供主循环判读。
 *  新版 iframe（frame 非空）的落位按用户确认的格式：地址1 = 区（"Wuxing Qu"）、
 *  地址2 = 街道+门牌（"Yongxing Lu 65"），页面无独立区字段；
 *  classic 有独立区字段，保持「区走字段、街道进地址1」的历史填充不变。 */
async function fillTextFields(
  win: BrowserWindow,
  address: BillingAddress,
  frame: Electron.WebFrameMain | null
): Promise<Array<{ key: string; ok: boolean; skipped?: boolean; error?: string }> | null> {
  const fields = [
    { key: 'name', rules: FILL_RULES.name, value: address.name },
    { key: 'line1', rules: FILL_RULES.line1, value: frame ? address.district : address.street },
    ...(frame ? [{ key: 'line2', rules: FILL_RULES.line2, value: address.street }] : []),
    { key: 'city', rules: FILL_RULES.city, value: address.city },
    { key: 'district', rules: FILL_RULES.district, value: address.district },
    { key: 'zip', rules: FILL_RULES.zip, value: address.zip }
  ]
  const r = (await jsRunner(win, frame)(`(${PAY_FILL_JS})(${JSON.stringify({ fields })})`)
    .catch(() => null)) as Array<{ key: string; ok: boolean; skipped?: boolean; error?: string }> | null
  console.log('[Payment] 填文本字段 →', JSON.stringify(r))
  return r
}

/**
 * 快捷填入卡信息（用户粘贴解析后传入；仅内存使用不落盘）。
 * 窗口须已打开。有效期按 4 位 MMYY 逐字符输入，由页面自行格式化成 MM/YY。
 * 返回各字段填写结果供 UI 判读。
 */
export async function fillCardDetails(
  card: CardInput,
  frame?: Electron.WebFrameMain | null
): Promise<{ success: boolean; results?: Array<{ key: string; ok: boolean; skipped?: boolean; error?: string }>; error?: string }> {
  const win = paymentWindow
  if (!win || win.isDestroyed()) return { success: false, error: 'payment-window-not-open' }
  // IPC 直调（UI 粘贴）不带 frame：复用探测循环锁定的新版表单 frame，失效则走顶层
  const target = frame === undefined ? liveFillFrame() : frame
  const fields = [
    { key: 'cardNumber', rules: FILL_RULES.cardNumber, value: card.number },
    { key: 'cardExpiry', rules: FILL_RULES.cardExpiry, value: card.expiry },
    { key: 'cardCvc', rules: FILL_RULES.cardCvc, value: card.cvc }
  ]
  try {
    const results = (await jsRunner(win, target)(`(${PAY_FILL_JS})(${JSON.stringify({ fields })})`)) as Array<{ key: string; ok: boolean; skipped?: boolean; error?: string }>
    console.log('[Payment] 填卡信息 →', JSON.stringify(results))
    return { success: results.every((r) => r.ok), results }
  } catch (e) {
    console.log('[Payment] 填卡信息异常:', String(e).slice(0, 120))
    return { success: false, error: String(e).slice(0, 120) }
  }
}

/** 复核全部地址字段非空（filled 上报依据） */
async function allFieldsFilled(win: BrowserWindow, frame: Electron.WebFrameMain | null): Promise<boolean> {
  try {
    const probe = (await jsRunner(win, frame)(`(${PAY_PROBE_JS})()`)) as ProbeResult
    const keys = ['line1', 'city', 'zip', 'name']
    const required = keys.map((k) => probe.fields[k])
    return required.every((f) => f.found && f.value.length > 0)
  } catch {
    return false
  }
}
