// 应用内 Stripe 支付窗口 —— 打开批量订阅拿到的支付链接，自动选国家(CN)、
// 选省份、拟人填写账单地址；卡号与 Pay 按钮留给人工（风控保守档）。
//
// 窗口骨架沿用 kiroPortal 模式（内存分区/导航留在应用内/尺寸裁剪），但
// 刻意不 import 它的内部函数：本模块独立维护，不影响官网后台的现有路径。
// 请求头与页面指纹复用 loginPool/fingerprint 的已导出通用函数；直连场景
// env 传 null（本机时区/语言，与出口 IP 天然一致）。
//
// 自动填策略（防御式，未经真机迭代过的选择器可能 miss）：
// - 国家/省份优先按原生 select 处理（JS 设值 + dispatch），找不到再按
//   自定义下拉点击（点开 → 按文本点选项）；
// - 文本字段按 HTML autocomplete 语义属性定位（address-line1/postal-code 等），
//   兜底 name/placeholder；已有值的字段一律跳过不覆盖；
// - 任何一步 not-found 只记日志静默跳过——窗口本身就是完整可用的支付页，
//   自动填未命中时降级为纯手填，不阻塞支付。

import { BrowserWindow, screen, session as electronSession, shell } from 'electron'
import { applyWindowFingerprint, hardenSessionHeaders, resolveFingerprintEnv } from '../loginPool/fingerprint'
import { generateBillingAddress, isValidProvince, type BillingAddress } from './addressGen'
import { clickWithTrail, sleep, randInt, PAY_FILL_JS } from './humanInput'

/** 一次性内存分区：关窗即弃，不与主窗口/官网后台共用任何会话状态 */
const PARTITION = 'payment-private'

/** 探测轮询间隔（秒级即可：页面加载与人工操作都不需要更快响应） */
const PROBE_INTERVAL_MS = 1200
/** 整窗探测寿命：链接约 15 分钟有效，30 分钟后停轮询（窗口保留人工用） */
const PROBE_LIFETIME_MS = 30 * 60 * 1000
/** 连续探测脚本异常达到该次数即停止自动化（页面结构不认识/被导航打断） */
const MAX_PROBE_ERRORS = 5

export type PaymentPhase = 'filling' | 'filled' | 'success' | 'expired' | 'closed' | 'error'

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
  /** 状态回调（由 index.ts 接到主窗口的 webContents） */
  notify: (update: PaymentUpdate) => void
}

let paymentWindow: BrowserWindow | null = null

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
    name: field(['#billingName', 'input[autocomplete="cc-name"]', 'input[name="billingName"]']),
    line1: field(['#billingAddressLine1', 'input[autocomplete*="address-line1" i]', 'input[name="billingAddressLine1"]']),
    city: field(['#billingLocality', 'input[autocomplete*="address-level2" i]', 'input[name="billingLocality"]']),
    district: field(['#billingDependentLocality', 'input[autocomplete*="address-level3" i]', 'input[name="billingDependentLocality"]']),
    zip: field(['#billingPostalCode', 'input[autocomplete*="postal-code" i]', 'input[name="billingPostalCode"]'])
  }
  // 国家/省：真实页面为原生 select。省份 option 形如 value="浙江省"、
  // 文本"浙江省 — Zhejiang Sheng"（中英界面都是双语形态，拼音匹配天然命中）
  const countrySelect = document.querySelector('#billingCountry, select[autocomplete*="country" i]')
  const provinceSelect = document.querySelector('#billingAdministrativeArea, select[autocomplete*="address-level1" i]')
  const onStripe = /(^|\\.)stripe\\.com$/i.test(location.hostname)
  const bodyText = (document.body && document.body.textContent || '').slice(0, 5000)
  return {
    url: location.href,
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

/** 真人节奏批量填表（见 humanInput.PAY_FILL_JS 的内核说明）——id 为真实页面实测命名 */
const FILL_RULES: Record<string, string[]> = {
  name: ['#billingName', 'input[autocomplete="cc-name"]', 'input[name="billingName"]'],
  line1: ['#billingAddressLine1', 'input[autocomplete*="address-line1" i]', 'input[name="billingAddressLine1"]'],
  city: ['#billingLocality', 'input[autocomplete*="address-level2" i]', 'input[name="billingLocality"]'],
  district: ['#billingDependentLocality', 'input[autocomplete*="address-level3" i]', 'input[name="billingDependentLocality"]'],
  zip: ['#billingPostalCode', 'input[autocomplete*="postal-code" i]', 'input[name="billingPostalCode"]']
}

// ─── 状态机 ─────────────────────────────────────────────────────────

interface ProbeResult {
  url: string
  form: boolean
  country: { found: boolean; isSelect: boolean; value: string | null }
  province: { found: boolean; isSelect: boolean; value: string | null; options: number }
  fields: Record<string, { found: boolean; value: string }>
  success: boolean
  expired: boolean
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

    // 状态摘要变化才打日志（每秒轮询不打屏）
    const summary = `form=${probe.form} country=${probe.country.value || '?'} prov=${probe.province.value || '?'}(${probe.province.options}) ` +
      Object.entries(probe.fields).map(([k, v]) => `${k}=${v.found ? (v.value ? '✓' : '-') : 'x'}`).join(' ')
    if (summary !== lastSummary) {
      lastSummary = summary
      console.log(`[Payment] ${summary}`)
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
    if (!probe.form) {
      await sleep(PROBE_INTERVAL_MS + randInt(0, 300))
      continue
    }

    if (!reportedFilling) {
      reportedFilling = true
      notify({ accountId, email, phase: 'filling', address })
    }

    try {
      const countryOk = await ensureCountry(win, probe)
      if (!countryOk) {
        await sleep(PROBE_INTERVAL_MS)
        continue
      }
      const provinceOk = await ensureProvince(win, address)
      if (!provinceOk) {
        await sleep(PROBE_INTERVAL_MS)
        continue
      }
      await fillTextFields(win, address)
    } catch (e) {
      console.log('[Payment] 填写动作异常:', String(e).slice(0, 120))
    }

    if (!reportedFilled && (await allFieldsFilled(win))) {
      reportedFilled = true
      console.log('[Payment] 全部地址字段已填好')
      notify({ accountId, email, phase: 'filled', address })
    }

    await sleep(PROBE_INTERVAL_MS + randInt(100, 400))
  }
  if (Date.now() - startedAt >= PROBE_LIFETIME_MS) console.log('[Payment] 超过探测寿命，停止自动填')
}

/** 国家是否已是中国；不是则选择之。返回本轮结束后是否就绪 */
async function ensureCountry(win: BrowserWindow, probe: ProbeResult): Promise<boolean> {
  const current = (probe.country.value || '').toLowerCase()
  if (current.includes('china') || current.includes('中国') || current === 'cn') return true

  if (probe.country.isSelect) {
    const r = (await win.webContents.executeJavaScript(
      `(${PAY_SELECT_JS})(${JSON.stringify({
        sel: '#billingCountry',
        autoContains: 'country',
        value: 'CN',
        matchWords: ['china', '中国']
      })})`,
      true
    )) as { ok: boolean; error?: string }
    console.log('[Payment] 选国家 CN →', JSON.stringify(r))
    if (r.ok) {
      await sleep(randInt(600, 1000)) // 国家切换会重渲染省市字段
      return true
    }
    return false
  }
  // 自定义下拉：点开触发器 → 点选项
  if (await clickWithTrail(win, [{ text: 'Country' }])) {
    await sleep(randInt(400, 700))
    if (await clickWithTrail(win, [{ text: 'China' }])) {
      await sleep(randInt(600, 1000))
      return true
    }
  }
  return false
}

/** 省份是否已选中目标省；不是则选择之（address.provinceZh 即真实 option value） */
async function ensureProvince(win: BrowserWindow, address: BillingAddress): Promise<boolean> {
  // 省份选项在国家选成 CN 后才异步填充（首项是"省/州"占位符），未就绪等下一轮
  const ready = (await win.webContents.executeJavaScript(
    `(() => { const s = document.querySelector('#billingAdministrativeArea'); return !!s && s.options.length > 1 })()`,
    true
  ).catch(() => false)) as boolean
  if (!ready) {
    console.log('[Payment] 省份下拉未就绪（options<=1），等下一轮')
    return false
  }

  const r = (await win.webContents.executeJavaScript(
    `(${PAY_SELECT_JS})(${JSON.stringify({
      sel: '#billingAdministrativeArea',
      autoContains: 'address-level1',
      value: address.provinceZh,
      matchWords: [address.provinceEn.toLowerCase(), address.provinceZh]
    })})`,
    true
  )) as { ok: boolean; error?: string; value?: string }
  console.log(`[Payment] 选省 ${address.provinceZh} →`, JSON.stringify(r))
  if (r.ok) {
    await sleep(randInt(300, 600)) // 省切换可能联动邮编前缀建议
    return true
  }
  // 自定义下拉兜底（触发器文本随语言变化，用 Province/省 两个词都试）
  for (const trigger of [{ text: 'Province' }, { text: '省' }]) {
    if (await clickWithTrail(win, [trigger])) {
      await sleep(randInt(400, 700))
      if (await clickWithTrail(win, [{ text: address.provinceEn }])) {
        await sleep(randInt(300, 600))
        return true
      }
    }
  }
  return false
}

/** 填写文本字段（空的才填） */
async function fillTextFields(win: BrowserWindow, address: BillingAddress): Promise<void> {
  const fields = [
    { key: 'name', rules: FILL_RULES.name, value: address.name },
    { key: 'line1', rules: FILL_RULES.line1, value: address.street },
    { key: 'city', rules: FILL_RULES.city, value: address.city },
    { key: 'district', rules: FILL_RULES.district, value: address.district },
    { key: 'zip', rules: FILL_RULES.zip, value: address.zip }
  ]
  const r = (await win.webContents
    .executeJavaScript(`(${PAY_FILL_JS})(${JSON.stringify({ fields })})`, true)
    .catch(() => null)) as Array<{ key: string; ok: boolean; skipped?: boolean; error?: string }> | null
  console.log('[Payment] 填文本字段 →', JSON.stringify(r))
}

/** 复核全部地址字段非空（filled 上报依据） */
async function allFieldsFilled(win: BrowserWindow): Promise<boolean> {
  try {
    const probe = (await win.webContents.executeJavaScript(`(${PAY_PROBE_JS})()`, true)) as ProbeResult
    const keys = ['line1', 'city', 'zip', 'name']
    const required = keys.map((k) => probe.fields[k])
    return required.every((f) => f.found && f.value.length > 0)
  } catch {
    return false
  }
}
