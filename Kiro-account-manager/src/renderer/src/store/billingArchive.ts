// 账单存档共享工具：主库 / 闲置库删除账号时落档 + 过期清理 + 组装账单页"幽灵行"。
// 存档与账号生命周期解耦——账号删了，账单快照仍保留 60 天供按卡尾号回查。
import { v4 as uuidv4 } from 'uuid'
import type { Account, BillingArchiveEntry } from '../types/account'

/** 存档保留时长：60 天 */
export const BILLING_ARCHIVE_RETENTION_MS = 60 * 24 * 60 * 60 * 1000

/** 判断订阅快照里是否有值得存档的账单信息（从未检查过、无任何金额/卡信息的纯 Free 不存） */
export function hasBillingSnapshot(sub: Account['subscription'] | undefined): boolean {
  if (!sub) return false
  return (
    sub.renewalCheckedAt != null ||
    sub.planAmount != null ||
    sub.currentCycleAmount != null ||
    sub.nextInvoiceAmount != null ||
    sub.cardLast4 != null ||
    sub.latestInvoiceAt != null ||
    sub.wasPaid === true
  )
}

/** 从待删账号构造存档条目；无账单快照返回 null（不值得留） */
export function buildBillingArchiveEntry(acc: Account): BillingArchiveEntry | null {
  if (!hasBillingSnapshot(acc.subscription)) return null
  return {
    id: uuidv4(),
    accountId: acc.id,
    email: acc.email,
    nickname: acc.nickname,
    groupId: acc.groupId,
    tags: acc.tags ?? [],
    createdAt: acc.createdAt,
    deletedAt: Date.now(),
    subscription: { ...acc.subscription }
  }
}

/** 清理超过保留期的存档条目；无过期项时原样返回（避免无谓的新 Map 与落盘） */
export function pruneBillingArchive(
  archive: Map<string, BillingArchiveEntry>
): Map<string, BillingArchiveEntry> {
  const deadline = Date.now() - BILLING_ARCHIVE_RETENTION_MS
  let changed = false
  const next = new Map<string, BillingArchiveEntry>()
  for (const [id, entry] of archive) {
    if (entry.deletedAt < deadline) {
      changed = true
      continue
    }
    next.set(id, entry)
  }
  return changed ? next : archive
}

/** 把存档条目组装成账单页可渲染的"幽灵行"（伪 Account，credentials/usage 为空壳）：
 *  billingArchivedAt 标记驱动"已删"徽章与统计排除；isCheckable 因无 accessToken 天然为 false */
export function billingArchiveToRow(entry: BillingArchiveEntry): Account {
  return {
    id: entry.id,
    email: entry.email,
    nickname: entry.nickname,
    idp: 'BuilderId',
    credentials: { accessToken: '', csrfToken: '', expiresAt: 0 },
    subscription: entry.subscription,
    usage: { current: 0, limit: 0, percentUsed: 0, lastUpdated: 0 },
    groupId: entry.groupId,
    tags: entry.tags ?? [],
    status: 'unknown',
    isActive: false,
    createdAt: entry.createdAt ?? entry.deletedAt,
    lastUsedAt: entry.deletedAt,
    billingArchivedAt: entry.deletedAt
  }
}
