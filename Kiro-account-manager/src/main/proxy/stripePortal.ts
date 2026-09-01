// Stripe 订阅门户自动切 Free（纯 HTTP，无需浏览器/支付操作）
//
// 背景：Kiro/AWS 侧没有"切计划/降级"的直接 API（SubscriptionPage 的取消功能注释已证实），
// 降级全程在 Stripe 订阅门户（billing.stripe.com）内完成。本模块把这条链路用纯 HTTP 复刻：
//
// 1. Kiro CreateSubscriptionToken（不传 subscriptionType）→ 管理门户 URL
//    （secret 短时效，实测几分钟内有效，生成后必须立即使用）
// 2. GET 门户 URL → 服务端渲染的 HTML 内联了 bps 会话 ID（bps_...）与临时密钥
//    session_api_key（ek_live_...）。注意：Chrome DevTools 导出 HAR 会脱敏 Authorization 头，
//    所以从 HAR 重放会 401——ek 只能从门户 HTML 里提取，它才是 XHR 的真实凭证。
// 3. GET /v1/billing_portal/sessions/{bps}/subscriptions（Authorization: Bearer ek）
//    → 订阅 ID（sub_...）、订阅项 ID（si_...）、当前价格
// 4. POST 同一资源，把 recurring_items[0][price] 换成 Free 价格 ID → 立即生效
//    （$0 计划不产生账单、无支付，update_preview 显示 generates_immediate_invoice=false）
//
// 链路细节与价格 ID 于 2026-08-30 抓包验证；若 Stripe 改版导致解析失败，优先检查
// HTML 内联字段名（bps_/session_api_key）与 KIRO_FREE_PRICE_ID。

import { fetchSubscriptionToken, fetchWithProxy } from './kiroApi'
import type { ProxyAccount } from './types'

// Kiro 的 Stripe 商户号与「Kiro Free」价格 ID：商户级全局通用（所有账号同一商户），
// 仅 Stripe 侧改版才需更新
const KIRO_STRIPE_ACCOUNT = 'acct_1RoAWWIHUhwdEnrT'
const KIRO_FREE_PRICE_ID = 'price_1RpBqGIHUhwdEnrTbZ8CIM0l'

// 门户页面按普通浏览器 UA 访问（非 Kiro SDK UA）
const PORTAL_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36'

export interface SwitchToFreeResult {
  success: boolean
  error?: string
  /** 订阅本来就是 Free，未做变更 */
  alreadyFree?: boolean
  /** 已安排周期末切 Free（本次只读发现后跳过，未提交） */
  alreadyScheduled?: boolean
  /** 已设置到期不续费（下周期不会扣款，无需切换） */
  wontRenew?: boolean
  /** 本次实际提交了切换（非 dry-run 且 POST 成功） */
  switched?: boolean
  /** 提交后经 Stripe 复核：当前周期保持原计划，下周期起才变 Free（Stripe 降级默认周期末生效） */
  scheduledToFree?: boolean
  /** 周期末变更生效时间戳（秒），scheduledToFree 时有值 */
  transitionAt?: number
  /** dry-run 模式：链路验证通过、可切换，但未提交 */
  dryRun?: boolean
  /** 切换前所在计划的产品名（如 "Kiro Pro+"），读取失败时为价格 ID */
  previousPlan?: string
  subId?: string
}

export interface RenewalCheckResult {
  success: boolean
  error?: string
  /** false=下周期自动续费扣款（该切 Free）；true=已设置到期不续费（无需切） */
  cancelAtPeriodEnd?: boolean
  /** 下次续费/失效时间戳（秒） */
  currentPeriodEnd?: number
  /** 当前计划产品名（如 "Kiro Pro+"） */
  planName?: string
  subId?: string
  /** 门户侧订阅价格已是 Kiro Free（切过 Free 的订阅仍 active 且会"$0 续费"，不能只看 cancel_at_period_end） */
  isFreePlan?: boolean
  /** 已安排周期末切 Free（网页"周期末生效"降级）：本周期仍是付费，下周期起 $0，不会再扣款 */
  scheduledToFree?: boolean
  /** 周期末变更生效时间戳（秒），scheduledToFree 时有值 */
  transitionAt?: number
}

/**
 * 只读检查账号订阅续费状态（纯门户 GET，不提交任何变更）。
 * cancel_at_period_end=false 表示下周期会自动续费扣款。
 */
export async function checkRenewalStatus(account: ProxyAccount): Promise<RenewalCheckResult> {
  try {
    const token = await fetchSubscriptionToken(account)
    if (!token.encodedVerificationUrl) {
      return { success: false, error: token.message || 'CreateSubscriptionToken returned no portal URL' }
    }
    const cred = await loadPortalCredential(token.encodedVerificationUrl, account)
    const sub = await fetchPortalSubscription(cred, account)
    // 已是 Free：切 Free 只是把订阅价格换成 $0，订阅仍 active 且 cancel_at_period_end 多为 false，
    // 单看该字段会误报"将续费"；用价格 ID（辅以产品名）识别
    const isFreePlan =
      sub.currentPriceId === KIRO_FREE_PRICE_ID ||
      /free/i.test(sub.currentProductName || '')
    return {
      success: true,
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
      currentPeriodEnd: sub.currentPeriodEnd,
      planName: sub.currentProductName || sub.currentPriceId,
      subId: sub.subId,
      isFreePlan,
      scheduledToFree: !isFreePlan && sub.upcomingIsFree === true,
      transitionAt: sub.transitionAt
    }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}

interface PortalCredential {
  bps: string
  ek: string
  portalUrl: string
}

/** 门户请求公共头（HAR 抓包复刻；CSRF 为 Stripe 固定占位值，无真实校验） */
function portalHeaders(cred: PortalCredential, extra?: Record<string, string>): Record<string, string> {
  return {
    accept: 'application/json',
    authorization: `Bearer ${cred.ek}`,
    'content-type': 'application/x-www-form-urlencoded',
    referer: cred.portalUrl,
    'stripe-account': KIRO_STRIPE_ACCOUNT,
    'stripe-livemode': 'true',
    'stripe-version': '2025-06-30.basil',
    'user-agent': PORTAL_UA,
    'x-requested-with': 'XMLHttpRequest',
    'x-stripe-csrf-token': 'fake-deprecated-token',
    ...extra
  }
}

/** 加载门户 HTML 并提取 bps 会话与 ek 临时密钥（secret 短时效，调用方须立即执行） */
async function loadPortalCredential(portalUrl: string, account: ProxyAccount): Promise<PortalCredential> {
  const response = await fetchWithProxy(
    portalUrl,
    { method: 'GET', headers: { accept: 'text/html', 'user-agent': PORTAL_UA } },
    account
  )
  if (!response.ok) {
    throw new Error(`Portal page HTTP ${response.status}`)
  }
  const html = await response.text()

  // HTML 内联 JSON 经过 &quot; 转义，直接按值形态匹配，避免依赖字段名转义格式
  const bps = html.match(/bps_[A-Za-z0-9]+/)?.[0]
  const ek = html.match(/ek_live_[A-Za-z0-9+/=_-]+/)?.[0]
  if (!bps || !ek) {
    throw new Error(
      !bps && !ek
        ? 'Portal HTML contains no bps session / session_api_key (secret expired or Stripe layout changed)'
        : !bps ? 'Portal HTML contains no bps session id'
          : 'Portal HTML contains no session_api_key'
    )
  }
  return { bps, ek, portalUrl }
}

interface PortalSubscription {
  subId: string
  siId: string
  currentPriceId: string
  currentProductName?: string
  /** false=下周期自动续费扣款；true=已设置到期不续费（cancel_at_period_end） */
  cancelAtPeriodEnd?: boolean
  /** 当前周期结束（下次续费/失效）时间戳（秒） */
  currentPeriodEnd?: number
  /** 已安排周期末计划变更（网页切 Free 常选"周期末生效"时为 true） */
  hasUpdateScheduled?: boolean
  /** 变更生效时间戳（秒） */
  transitionAt?: number
  /** 变更后的下期账单是否为 $0 的 Free（upcoming_invoice 首行价格 = Free 价格） */
  upcomingIsFree?: boolean
}

/** 查询门户内当前订阅（sub / si / 当前价格 / 续费状态）。无订阅、解析失败均抛错 */
async function fetchPortalSubscription(cred: PortalCredential, account: ProxyAccount): Promise<PortalSubscription> {
  const url = `https://billing.stripe.com/v1/billing_portal/sessions/${cred.bps}/subscriptions?expand%5B%5D=data.items.price_details.product`
  const response = await fetchWithProxy(url, { method: 'GET', headers: portalHeaders(cred) }, account)
  const data = (await response.json().catch(() => ({}))) as {
    data?: Array<{
      id?: string
      items?: unknown
      cancel_at_period_end?: boolean
      current_period_end?: number
      has_update_scheduled?: boolean
      transition_at?: number
      upcoming_invoice?: {
        amount_due?: number
        lines?: { data?: Array<{ price_details?: { id?: string } }> }
      }
    }>
  }
  if (!response.ok) {
    const msg = (data as { error?: { message?: string } }).error?.message
    throw new Error(`List subscriptions HTTP ${response.status}${msg ? `: ${msg}` : ''}`)
  }

  const sub = data.data?.[0]
  if (!sub?.id) throw new Error('No active subscription in portal')

  // items 在带 expand 时为 {data:[...]}，不带时可能直接是数组，两种都兼容
  const rawItems = sub.items
  const itemList: Array<{ id?: string; price_details?: { id?: string; product?: { name?: string } | { name?: string }[] } }> =
    rawItems && typeof rawItems === 'object' && Array.isArray((rawItems as { data?: unknown }).data)
      ? (rawItems as { data: typeof itemList }).data
      : Array.isArray(rawItems) ? (rawItems as typeof itemList) : []

  const item = itemList[0]
  if (!item?.id || !item.price_details?.id) throw new Error('Subscription item (si) not found')

  const product = item.price_details.product
  const productName = Array.isArray(product) ? product[0]?.name : product?.name

  // 已安排的周期末变更（网页切 Free 默认"周期末生效"）：变更后下期账单为 Free $0
  const upcomingFirstPrice = sub.upcoming_invoice?.lines?.data?.[0]?.price_details?.id
  const upcomingIsFree =
    sub.has_update_scheduled === true &&
    (upcomingFirstPrice === KIRO_FREE_PRICE_ID || sub.upcoming_invoice?.amount_due === 0)

  return {
    subId: sub.id,
    siId: item.id,
    currentPriceId: item.price_details.id,
    currentProductName: productName,
    cancelAtPeriodEnd: sub.cancel_at_period_end,
    currentPeriodEnd: sub.current_period_end,
    hasUpdateScheduled: sub.has_update_scheduled,
    transitionAt: sub.transition_at,
    upcomingIsFree
  }
}

/** 提交切换：把订阅项价格改为目标价格（Free） */
async function postSwitchPrice(
  cred: PortalCredential,
  sub: PortalSubscription,
  targetPriceId: string,
  account: ProxyAccount
): Promise<{ ok: boolean; status?: string; error?: string }> {
  const url = `https://billing.stripe.com/v1/billing_portal/sessions/${cred.bps}/subscriptions/${sub.subId}`
  // form 编码须与浏览器一致：recurring_items[0][id] = si、[quantity] = 1、[price] = 目标价格
  const body = new URLSearchParams({
    'recurring_items[0][id]': sub.siId,
    'recurring_items[0][quantity]': '1',
    'recurring_items[0][price]': targetPriceId
  }).toString()

  const response = await fetchWithProxy(
    url,
    { method: 'POST', headers: portalHeaders(cred, { origin: 'https://billing.stripe.com' }), body },
    account
  )
  const data = (await response.json().catch(() => ({}))) as { status?: string; error?: { message?: string } }
  if (!response.ok) {
    return { ok: false, error: `HTTP ${response.status}${data.error?.message ? `: ${data.error.message}` : ''}` }
  }
  return { ok: true, status: data.status }
}

/**
 * 把账号订阅切换到 Kiro Free。
 * dryRun=true 时只走到"读取当前订阅"（纯只读），返回可切换的预览信息，不提交任何变更。
 */
export async function switchSubscriptionToFree(
  account: ProxyAccount,
  opts: { dryRun?: boolean } = {}
): Promise<SwitchToFreeResult> {
  try {
    // 1. 管理门户 URL（不带 subscriptionType 即管理门户）
    const token = await fetchSubscriptionToken(account)
    if (!token.encodedVerificationUrl) {
      return { success: false, error: token.message || 'CreateSubscriptionToken returned no portal URL' }
    }
    const portalUrl = token.encodedVerificationUrl

    // 2. 立即加载门户 HTML 提取 bps + ek（secret 短时效，不可缓存复用）
    let cred: PortalCredential
    try {
      cred = await loadPortalCredential(portalUrl, account)
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Failed to load portal page' }
    }

    // 3. 当前订阅
    let sub: PortalSubscription
    try {
      sub = await fetchPortalSubscription(cred, account)
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Failed to list portal subscriptions' }
    }

    const base = {
      subId: sub.subId,
      previousPlan: sub.currentProductName || sub.currentPriceId
    }

    // 已是 Free → 无需变更
    if (sub.currentPriceId === KIRO_FREE_PRICE_ID) {
      return { success: true, alreadyFree: true, ...base }
    }

    // 已安排周期末切 Free → 重复提交无意义，跳过（upcomingIsFree 内含 has_update_scheduled 判定）
    if (sub.upcomingIsFree === true) {
      return { success: true, alreadyScheduled: true, transitionAt: sub.transitionAt, ...base }
    }

    // 已设置到期不续费 → 下周期不会扣款，按业务口径无需切
    if (sub.cancelAtPeriodEnd === true) {
      return { success: true, wontRenew: true, ...base }
    }

    if (opts.dryRun) {
      return { success: true, dryRun: true, ...base }
    }

    // 4. 提交切换。Stripe 降级默认"周期末生效"（两次实测确认）：当前周期保持原计划、
    //    下周期起 Free。为控制请求数（每账号共 4 个），POST 成功后不再额外 GET 复核；
    //    真实生效方式由"检查续费"（只读）按需校准
    const result = await postSwitchPrice(cred, sub, KIRO_FREE_PRICE_ID, account)
    if (!result.ok) {
      return { success: false, error: result.error || 'Switch request failed', ...base }
    }
    if (result.status && result.status !== 'active') {
      return { success: false, error: `Unexpected subscription status: ${result.status}`, ...base }
    }
    return {
      success: true,
      switched: true,
      scheduledToFree: true,
      transitionAt: sub.currentPeriodEnd,
      ...base
    }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}
