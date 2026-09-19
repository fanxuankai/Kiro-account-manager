// 账号生命周期分类 —— 主账号管理页的生命周期视图按此纯函数分档。
//
// 口径与项目既有判定对齐（不引入新状态字段，纯推导）：
// - 付费中（订阅不是 Free 档）→ 已订阅；
// - Free 档且用过积分 / 曾付费后降级（wasPaid）→ 已废弃（付过、用完的池子）；
// - Free 档且挂着待付款标记（isPendingPayment：发过支付链接、未用积分）→ 待支付；
// - 其余 Free 档 → 未使用。

import type { AccountLifecycle } from '@/types/account'
import { isPendingPayment } from '@/components/accounts/_helpers'

/** 分类入参的最小结构（Account 及各筛选视图均可传入） */
export interface LifecycleAccount {
  usage?: { current?: number }
  subscription?: { type?: string; title?: string; paymentLinkAt?: number; wasPaid?: boolean }
}

/** Free 档判定：type/title 含 FREE，或两者皆空（尚未查询过订阅的账号按 Free 兜底） */
function isFreeTier(a: LifecycleAccount): boolean {
  const type = (a.subscription?.type || '').toUpperCase()
  const title = (a.subscription?.title || '').toUpperCase()
  return type.includes('FREE') || title.includes('FREE') || (!type && !title)
}

/** 单账号生命周期分档（每次调用即时推导，无缓存无副作用） */
export function classifyLifecycle(a: LifecycleAccount | null | undefined): AccountLifecycle {
  if (!a) return 'unused'
  if (!isFreeTier(a)) return 'subscribed'
  // Free 档：付过（wasPaid）或用过积分的都是"用完的"，归已废弃
  if (a.subscription?.wasPaid || (a.usage?.current ?? 0) > 0) return 'deprecated'
  return isPendingPayment(a) ? 'pendingPayment' : 'unused'
}

/** 生命周期各档的展示顺序 */
export const LIFECYCLE_ORDER: AccountLifecycle[] = ['unused', 'pendingPayment', 'subscribed', 'deprecated']

/** 各档中英文标签 */
export const LIFECYCLE_LABELS: Record<AccountLifecycle, { zh: string; en: string }> = {
  unused: { zh: '未使用', en: 'Unused' },
  pendingPayment: { zh: '待支付', en: 'Pending Pay' },
  subscribed: { zh: '已订阅', en: 'Subscribed' },
  deprecated: { zh: '已废弃', en: 'Deprecated' }
}

/** 批量统计各档数量（工具栏计数用） */
export function countLifecycle(accounts: Iterable<LifecycleAccount>): Record<AccountLifecycle, number> {
  const counts: Record<AccountLifecycle, number> = { unused: 0, pendingPayment: 0, subscribed: 0, deprecated: 0 }
  for (const a of accounts) counts[classifyLifecycle(a)]++
  return counts
}
