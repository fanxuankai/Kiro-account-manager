import type { Account } from '@/types/account'

/** 主账号管理页的生命周期 Tab。 */
export type AccountLifecycle = 'unused' | 'pendingPayment' | 'subscribed' | 'deprecated'

export interface AccountLifecycleThresholds {
  /** 绝对用量阈值，按 AccountUsage.current 的原始单位计算。 */
  deprecatedUsageThreshold: number
  /** 百分比阈值，内部使用 0–1。 */
  deprecatedUsagePercentThreshold: number
}

export const DEFAULT_ACCOUNT_LIFECYCLE_THRESHOLDS: AccountLifecycleThresholds = {
  deprecatedUsageThreshold: 60,
  deprecatedUsagePercentThreshold: 0.1
}

/**
 * 统一读取账号用量百分比。
 *
 * 正常 API 数据使用 current / limit（0–1），但历史注册流程曾写入 0–100，
 * 因此额度有效时始终优先根据 current / limit 计算；额度无效时兼容两种存量格式。
 */
export function getAccountUsagePercent(account: Pick<Account, 'usage'>): number {
  const current = Number(account.usage?.current)
  const limit = Number(account.usage?.limit)
  if (Number.isFinite(current) && Number.isFinite(limit) && limit > 0) {
    return Math.max(0, current / limit)
  }

  const stored = Number(account.usage?.percentUsed)
  if (!Number.isFinite(stored) || stored < 0) return 0
  return stored > 1 ? stored / 100 : stored
}

function isFreeSubscription(account: Pick<Account, 'subscription'>): boolean {
  return (account.subscription?.type || '').trim().toLowerCase() === 'free'
}

function hasPaymentLink(account: Pick<Account, 'subscription'>): boolean {
  return Boolean(account.subscription?.paymentLink?.trim())
}

/**
 * 按业务优先级将账号归入唯一生命周期：
 * 已废弃 > 已订阅 > 未使用/待支付。
 */
export function classifyAccountLifecycle(
  account: Pick<Account, 'subscription' | 'usage'>,
  thresholds: AccountLifecycleThresholds = DEFAULT_ACCOUNT_LIFECYCLE_THRESHOLDS
): AccountLifecycle {
  const current = Number(account.usage?.current)
  const used = Number.isFinite(current) ? Math.max(0, current) : 0
  const percentUsed = getAccountUsagePercent(account)
  const usageThreshold = Math.max(0, Number(thresholds.deprecatedUsageThreshold) || 0)
  const percentThreshold = Math.max(0, Number(thresholds.deprecatedUsagePercentThreshold) || 0)
  const free = isFreeSubscription(account)

  // Free 账号只要产生过用量，就不再属于“未使用/待支付”。
  if (free && used > 0) return 'deprecated'
  if (used >= usageThreshold || percentUsed >= percentThreshold) return 'deprecated'

  if (!free) return 'subscribed'
  return hasPaymentLink(account) ? 'pendingPayment' : 'unused'
}

export function getLifecycleCounts(
  accounts: Iterable<Account>,
  thresholds: AccountLifecycleThresholds
): Record<AccountLifecycle, number> {
  const counts: Record<AccountLifecycle, number> = {
    unused: 0,
    pendingPayment: 0,
    subscribed: 0,
    deprecated: 0
  }

  for (const account of accounts) {
    counts[classifyAccountLifecycle(account, thresholds)]++
  }
  return counts
}

export const ACCOUNT_LIFECYCLE_LABELS = {
  zh: {
    unused: '未使用',
    pendingPayment: '待支付',
    subscribed: '已订阅',
    deprecated: '已废弃'
  },
  en: {
    unused: 'Unused',
    pendingPayment: 'Pending Pay',
    subscribed: 'Subscribed',
    deprecated: 'Deprecated'
  }
} as const
