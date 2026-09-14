// 账单页：按账号展示 Stripe 订阅门户回写的账单快照（计划单价 / 计费周期 / 本周期与下期金额 / 扣款卡 / 最近发票）。
// 数据来源是「检查续费 / 切 Free」时的同一份门户响应（零额外请求），本页只读快照并提供
// 「检查账单」入口触发同一只读链路刷新；汇总卡与列表随筛选实时重算。
import { useState, useCallback, useRef, useMemo, memo } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useAccountsStore } from '@/store/accounts'
import { Button, Card, CardContent } from '../ui'
import {
  CheckSquare,
  Square,
  Minus,
  RefreshCw,
  Loader2,
  ExternalLink,
  CircleDollarSign,
  CalendarClock,
  AlarmClockCheck,
  HelpCircle
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/hooks/useTranslation'

type AccountType =
  ReturnType<typeof useAccountsStore.getState>['accounts'] extends Map<string, infer T> ? T : never

/** 批量检查中账号之间的随机间隔（100–150ms），与订阅管理页保持一致 */
const jitterDelay = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 100 + Math.random() * 50))

// ===== 计划归类（与账号筛选面板 / 订阅页徽章同一套口径） =====
type PlanKind = 'Pro' | 'Pro_Plus' | 'Pro_Max' | 'Power' | 'Free'

function planKindOf(acc: AccountType): PlanKind {
  const type = (acc.subscription?.type || '').toUpperCase()
  const title = (acc.subscription?.title || '').toUpperCase()
  const both = `${type} ${title}`
  if (both.includes('PRO_MAX') || both.includes('PRO MAX') || both.includes('PROMAX'))
    return 'Pro_Max'
  if (both.includes('PRO_PLUS') || both.includes('PRO+')) return 'Pro_Plus'
  if (both.includes('ENTERPRISE') || both.includes('POWER')) return 'Power'
  if (both.includes('PRO')) return 'Pro'
  return 'Free'
}

const PLAN_STYLES: Record<PlanKind, string> = {
  Pro_Max: 'bg-rose-500/15 text-rose-700 dark:text-rose-300',
  Pro_Plus: 'bg-purple-500/15 text-purple-700 dark:text-purple-300',
  Power: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  Pro: 'bg-blue-500/15 text-blue-700 dark:text-blue-300',
  Free: 'bg-muted text-muted-foreground'
}

const PLAN_LABELS: Record<PlanKind, string> = {
  Pro_Max: 'Pro Max',
  Pro_Plus: 'Pro+',
  Power: 'Power',
  Pro: 'Pro',
  Free: 'Free'
}

// ===== 下期状态（本地快照口径，与订阅页「续费」列一致） =====
type NextStatus = 'renew' | 'scheduled-free' | 'no-renew' | 'free' | 'unchecked'

function nextStatusOf(acc: AccountType): NextStatus {
  if (acc.subscription?.scheduledToFree) return 'scheduled-free'
  if (planKindOf(acc) === 'Free') return 'free'
  if (acc.subscription?.willRenew === true) return 'renew'
  if (acc.subscription?.willRenew === false) return 'no-renew'
  return 'unchecked'
}

// ===== 显示工具 =====
const formatMoney = (cents?: number, currency = 'usd'): string => {
  if (cents == null) return '-'
  const symbol = currency.toLowerCase() === 'usd' ? '$' : `${currency.toUpperCase()} `
  return `${symbol}${(cents / 100).toFixed(2)}`
}

const formatShortDate = (ms?: number): string => {
  if (!ms) return '-'
  return new Date(ms).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' })
}

export function BillingPage(): React.ReactNode {
  const { accounts, groups, tags, updateAccount } = useAccountsStore()
  const { actualLanguage } = useTranslation()
  const isEn = actualLanguage === 'en'

  // ===== 页内筛选（不写入账号库的公共 filter，两页互不影响） =====
  const [groupIds, setGroupIds] = useState<Set<string>>(new Set())
  const [tagIds, setTagIds] = useState<Set<string>>(new Set())
  const [planFilter, setPlanFilter] = useState<Set<PlanKind>>(new Set())
  const [statusFilter, setStatusFilter] = useState<Set<NextStatus>>(new Set())
  const [keyword, setKeyword] = useState('')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [isChecking, setIsChecking] = useState(false)

  const toggleInSet = <T,>(set: Set<T>, value: T): Set<T> => {
    const next = new Set(set)
    if (next.has(value)) next.delete(value)
    else next.add(value)
    return next
  }

  // 数据集：付费账号（含已排期切 Free 的——本周期仍计费）+ 曾付费/有账单快照的账号；
  // 从未订阅的纯 Free 没有账单可言，排除
  const billingAccounts = useMemo(() => {
    const list: AccountType[] = []
    for (const acc of accounts.values()) {
      if (!acc) continue
      const kind = planKindOf(acc)
      const hasSnapshot =
        acc.subscription?.renewalCheckedAt != null || acc.subscription?.planAmount != null
      if (kind === 'Free' && !acc.subscription?.wasPaid && !hasSnapshot) continue
      list.push(acc)
    }
    return list
  }, [accounts])

  // 筛选 + 排序（下期金额降序，未检查垫底；同额按邮箱稳定排序）
  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    const out = billingAccounts.filter((acc) => {
      if (groupIds.size > 0 && (!acc.groupId || !groupIds.has(acc.groupId))) return false
      if (tagIds.size > 0 && !(acc.tags ?? []).some((t) => tagIds.has(t))) return false
      if (planFilter.size > 0 && !planFilter.has(planKindOf(acc))) return false
      if (statusFilter.size > 0 && !statusFilter.has(nextStatusOf(acc))) return false
      if (
        kw &&
        !(acc.email?.toLowerCase().includes(kw) || acc.nickname?.toLowerCase().includes(kw))
      )
        return false
      return true
    })
    const rank = (acc: AccountType): number => {
      const st = nextStatusOf(acc)
      // 未检查 / 已是 Free 的金额不可信，排序垫底；其余按金额降序
      if (st === 'unchecked' || st === 'free') return -1
      return acc.subscription?.nextInvoiceAmount ?? -1
    }
    return out.sort((a, b) => rank(b) - rank(a) || (a.email || '').localeCompare(b.email || ''))
  }, [billingAccounts, groupIds, tagIds, planFilter, statusFilter, keyword])

  // ===== 汇总卡（随筛选重算） =====
  const summary = useMemo(() => {
    let totalNext = 0
    let renewCount = 0
    let scheduledCount = 0
    let uncheckedCount = 0
    for (const acc of filtered) {
      const st = nextStatusOf(acc)
      if (st === 'renew') {
        renewCount++
        totalNext += acc.subscription?.nextInvoiceAmount ?? 0
      } else if (st === 'scheduled-free') {
        scheduledCount++
        // 已排期 Free：本周期已付，下期 $0，不计入将扣款
      } else if (st === 'unchecked') {
        uncheckedCount++
      }
    }
    return { totalNext, renewCount, scheduledCount, uncheckedCount }
  }, [filtered])

  // 可检查（= 会发起只读门户链路）的判定：纯 Free（从未付费）无账单可查，排除；
  // 已排期切 Free（scheduledToFree）本周期仍是付费、账单完整（含网页手动切的账号），必须允许拉取——
  // 否则这类账号永远无法补/刷快照（订阅页检查续费口径不含它们，那边不变）
  const isCheckable = useCallback((acc: AccountType): boolean => {
    if (planKindOf(acc) === 'Free') return false
    return !!acc.credentials?.accessToken
  }, [])

  // ===== 单账号检查（只读门户链路，回写续费状态 + 账单快照，逻辑与订阅页一致） =====
  const checkOne = useCallback(
    async (acc: AccountType): Promise<boolean> => {
      const r = await window.api.accountCheckRenewal(
        acc.credentials.accessToken,
        acc.credentials?.region,
        acc.profileArn,
        acc.machineId,
        acc.credentials?.provider || acc.idp,
        acc.credentials?.authMethod,
        acc.id
      )
      // 主进程可能顺带刷新了凭证：与旧 token 不同则持久化
      if (
        r.credentials?.accessToken &&
        r.credentials.accessToken !== acc.credentials?.accessToken
      ) {
        updateAccount(acc.id, {
          credentials: {
            ...acc.credentials,
            accessToken: r.credentials.accessToken,
            refreshToken: r.credentials.refreshToken ?? acc.credentials?.refreshToken,
            ...(r.credentials.expiresIn
              ? { expiresAt: Date.now() + r.credentials.expiresIn * 1000 }
              : {})
          } as AccountType['credentials']
        })
      }
      if (!r.success) {
        console.warn('[BillingPage] check failed for', acc.email, r.error)
        return false
      }
      if (r.isFreePlan) {
        updateAccount(acc.id, {
          subscription: {
            ...acc.subscription,
            type: 'Free',
            title: 'Kiro Free',
            willRenew: undefined,
            renewalCheckedAt: undefined,
            wasPaid: true,
            ...(r.currentPeriodEnd ? { expiresAt: r.currentPeriodEnd * 1000 } : {}),
            ...(r.billing ?? {})
          } as AccountType['subscription']
        })
      } else if (r.scheduledToFree) {
        updateAccount(acc.id, {
          subscription: {
            ...acc.subscription,
            willRenew: false,
            scheduledToFree: true,
            wasPaid: true,
            renewalCheckedAt: Date.now(),
            ...(r.transitionAt ? { expiresAt: r.transitionAt * 1000 } : {}),
            ...(r.billing ?? {})
          } as AccountType['subscription']
        })
      } else {
        updateAccount(acc.id, {
          subscription: {
            ...acc.subscription,
            willRenew: r.cancelAtPeriodEnd === false,
            scheduledToFree: false,
            renewalCheckedAt: Date.now(),
            ...(r.currentPeriodEnd ? { expiresAt: r.currentPeriodEnd * 1000 } : {}),
            ...(r.billing ?? {})
          } as AccountType['subscription']
        })
      }
      return true
    },
    [updateAccount]
  )

  /** 批量检查：目标 = 当前列表中可检查的账号（筛选 + 勾选共同生效），并发 2 */
  const handleBatchCheck = async (mode: 'selected' | 'all'): Promise<void> => {
    const targets = (
      mode === 'selected' ? filtered.filter((a) => selectedIds.has(a.id)) : filtered
    ).filter(isCheckable)
    if (targets.length === 0) {
      alert(isEn ? 'No checkable paid accounts in current view' : '当前视图中没有可检查的付费账号')
      return
    }
    if (
      !confirm(
        isEn
          ? `Fetch billing info for ${targets.length} account(s)? (read-only, no changes)`
          : `获取 ${targets.length} 个账号的账单信息？（只读，不做任何变更）`
      )
    )
      return

    setIsChecking(true)
    const fail: Array<{ email: string; error?: string }> = []
    try {
      let cursor = 0
      const worker = async (): Promise<void> => {
        while (cursor < targets.length) {
          const acc = targets[cursor++]
          if (!acc) continue
          await jitterDelay()
          const ok = await checkOne(acc)
          if (!ok) fail.push({ email: acc.email || acc.id })
        }
      }
      await Promise.all(Array.from({ length: Math.min(2, targets.length) }, () => worker()))
    } finally {
      setIsChecking(false)
    }
    if (fail.length > 0) {
      const detail = fail
        .slice(0, 5)
        .map((f) => `\n${f.email}`)
        .join('')
      alert(
        isEn
          ? `Checked: ${targets.length - fail.length} ok, ${fail.length} failed${detail}${fail.length > 5 ? '\n...' : ''}`
          : `已检查：${targets.length - fail.length} 成功，${fail.length} 失败${detail}${fail.length > 5 ? '\n...' : ''}`
      )
    }
  }

  const hasActiveFilters =
    groupIds.size > 0 ||
    tagIds.size > 0 ||
    planFilter.size > 0 ||
    statusFilter.size > 0 ||
    keyword.trim() !== ''
  const clearFilters = (): void => {
    setGroupIds(new Set())
    setTagIds(new Set())
    setPlanFilter(new Set())
    setStatusFilter(new Set())
    setKeyword('')
  }

  const toggleSelect = useCallback((id: string): void => {
    setSelectedIds((prev) => toggleInSet(prev, id))
  }, [])

  // 各筛选维度的计数（基于筛选前的账单数据集，chip 上显示总量参考）
  const planCounts = useMemo(() => {
    const counts = new Map<PlanKind, number>()
    for (const acc of billingAccounts)
      counts.set(planKindOf(acc), (counts.get(planKindOf(acc)) ?? 0) + 1)
    return counts
  }, [billingAccounts])
  const statusCounts = useMemo(() => {
    const counts = new Map<NextStatus, number>()
    for (const acc of billingAccounts)
      counts.set(nextStatusOf(acc), (counts.get(nextStatusOf(acc)) ?? 0) + 1)
    return counts
  }, [billingAccounts])

  return (
    <>
      <div className="space-y-4">
        {/* 汇总卡：随筛选实时重算 */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Card className="border-red-500/20">
            <CardContent className="p-4">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <CircleDollarSign className="h-4 w-4 text-red-500" />
                {isEn ? 'Next-cycle charges' : '下期总扣款'}
              </div>
              <div className="mt-1 text-xl font-semibold text-red-500">
                {formatMoney(summary.totalNext)}
              </div>
              <div className="text-[10px] text-muted-foreground mt-0.5">
                {isEn
                  ? `${summary.renewCount} account(s) will be charged`
                  : `${summary.renewCount} 个账号将扣款`}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <CalendarClock className="h-4 w-4 text-red-500" />
                {isEn ? 'Will renew' : '将续费'}
              </div>
              <div className="mt-1 text-xl font-semibold">{summary.renewCount}</div>
              <div className="text-[10px] text-muted-foreground mt-0.5">
                {isEn ? 'charged next cycle' : '下周期会扣款'}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <AlarmClockCheck className="h-4 w-4 text-teal-500" />
                {isEn ? 'Scheduled to Free' : '已排期 Free'}
              </div>
              <div className="mt-1 text-xl font-semibold text-teal-600 dark:text-teal-300">
                {summary.scheduledCount}
              </div>
              <div className="text-[10px] text-muted-foreground mt-0.5">
                {isEn ? '$0 from next cycle' : '下周期起 $0 不扣款'}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <HelpCircle className="h-4 w-4 text-muted-foreground" />
                {isEn ? 'Unchecked' : '未检查'}
              </div>
              <div className="mt-1 text-xl font-semibold">{summary.uncheckedCount}</div>
              <div className="text-[10px] text-muted-foreground mt-0.5">
                {isEn ? 'run check to fetch billing' : '点「检查账单」拉取'}
              </div>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardContent className="p-4 space-y-3">
            {/* 筛选器：账号维度（分组/标签）+ 账单维度（计划/下期状态）+ 搜索 */}
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
              {groups.size > 0 && (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground shrink-0">
                    {isEn ? 'Group:' : '分组:'}
                  </span>
                  <div className="flex flex-wrap gap-1">
                    {Array.from(groups.values()).map((g) => (
                      <button
                        key={g.id}
                        className={cn(
                          'px-2 py-0.5 text-xs rounded border transition-colors',
                          groupIds.has(g.id)
                            ? 'bg-primary text-primary-foreground border-primary'
                            : 'hover:bg-muted'
                        )}
                        onClick={() => setGroupIds((prev) => toggleInSet(prev, g.id))}
                      >
                        {g.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {tags.size > 0 && (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground shrink-0">
                    {isEn ? 'Tags:' : '标签:'}
                  </span>
                  <div className="flex flex-wrap gap-1">
                    {Array.from(tags.values()).map((t) => (
                      <button
                        key={t.id}
                        className={cn(
                          'px-2 py-0.5 text-xs rounded border transition-colors',
                          tagIds.has(t.id)
                            ? 'bg-primary text-primary-foreground border-primary'
                            : 'hover:bg-muted'
                        )}
                        onClick={() => setTagIds((prev) => toggleInSet(prev, t.id))}
                      >
                        {t.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground shrink-0">
                  {isEn ? 'Plan:' : '计划:'}
                </span>
                <div className="flex flex-wrap gap-1">
                  {(['Pro_Max', 'Pro_Plus', 'Power', 'Pro', 'Free'] as PlanKind[]).map((kind) => (
                    <button
                      key={kind}
                      className={cn(
                        'px-2 py-0.5 text-xs rounded border transition-colors',
                        planFilter.has(kind)
                          ? 'bg-primary text-primary-foreground border-primary'
                          : 'hover:bg-muted'
                      )}
                      onClick={() => setPlanFilter((prev) => toggleInSet(prev, kind))}
                    >
                      {PLAN_LABELS[kind]}({planCounts.get(kind) ?? 0})
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground shrink-0">
                  {isEn ? 'Next:' : '下期:'}
                </span>
                <div className="flex flex-wrap gap-1">
                  {(
                    [
                      ['renew', isEn ? 'Renew' : '将扣款'],
                      ['scheduled-free', isEn ? '→Free' : '已排期Free'],
                      ['no-renew', isEn ? "Won't renew" : '不续费'],
                      ['unchecked', isEn ? 'Unchecked' : '未检查'],
                      ['free', isEn ? 'Free' : '已降Free']
                    ] as Array<[NextStatus, string]>
                  ).map(([st, label]) => (
                    <button
                      key={st}
                      className={cn(
                        'px-2 py-0.5 text-xs rounded border transition-colors',
                        statusFilter.has(st)
                          ? 'bg-primary text-primary-foreground border-primary'
                          : 'hover:bg-muted'
                      )}
                      onClick={() => setStatusFilter((prev) => toggleInSet(prev, st))}
                    >
                      {label}({statusCounts.get(st) ?? 0})
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* 搜索 + 批量操作 */}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={keyword}
                  onChange={(e) => setKeyword(e.target.value)}
                  placeholder={isEn ? 'Search email / nickname…' : '搜索邮箱 / 昵称…'}
                  className="w-56 px-2.5 py-1.5 text-xs rounded-md border border-[var(--glass-border)] bg-[var(--glass-bg-subtle)] backdrop-blur-md focus:outline-none focus:ring-2 focus:ring-primary/40"
                />
                {hasActiveFilters && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 text-xs px-2"
                    onClick={clearFilters}
                  >
                    {isEn ? 'Clear' : '清除筛选'}
                  </Button>
                )}
                <span className="text-xs text-muted-foreground">
                  {isEn ? `${filtered.length} account(s)` : `共 ${filtered.length} 个账号`}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  disabled={isChecking || selectedIds.size === 0}
                  onClick={() => handleBatchCheck('selected')}
                >
                  {isChecking && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
                  {isEn ? `Check Selected (${selectedIds.size})` : `检查选中 (${selectedIds.size})`}
                </Button>
                <Button
                  size="sm"
                  className="h-7 text-xs"
                  disabled={isChecking}
                  onClick={() => handleBatchCheck('all')}
                  title={
                    isEn
                      ? 'Fetch billing info via Stripe portal (read-only)'
                      : '经 Stripe 门户只读拉取账单信息'
                  }
                >
                  {isChecking && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
                  {isEn ? 'Check All Billing' : '检查全部账单'}
                </Button>
              </div>
            </div>

            {/* 表头 */}
            <div className="flex items-center gap-3 py-2 px-3 text-xs text-muted-foreground border-b">
              <button
                onClick={() => {
                  const checkable = filtered.filter(isCheckable)
                  const allSelected =
                    checkable.length > 0 && checkable.every((a) => selectedIds.has(a.id))
                  setSelectedIds(allSelected ? new Set() : new Set(checkable.map((a) => a.id)))
                }}
              >
                {filtered.filter(isCheckable).length > 0 &&
                filtered.filter(isCheckable).every((a) => selectedIds.has(a.id)) ? (
                  <Minus className="h-3.5 w-3.5 text-primary" />
                ) : selectedIds.size > 0 ? (
                  <Minus className="h-3.5 w-3.5 text-primary" />
                ) : (
                  <Square className="h-3.5 w-3.5" />
                )}
              </button>
              <span className="w-8 text-center">#</span>
              <span className="flex-1">{isEn ? 'Email' : '邮箱'}</span>
              <span className="w-36 text-center">{isEn ? 'Plan' : '计划'}</span>
              <span className="w-32 text-center">{isEn ? 'Cycle' : '计费周期'}</span>
              <span className="w-20 text-center">{isEn ? 'This Cycle' : '本周期'}</span>
              <span className="w-36 text-center">{isEn ? 'Next Invoice' : '下期账单'}</span>
              <span className="w-28 text-center">{isEn ? 'Card' : '扣款卡'}</span>
              <span className="w-44 text-center">{isEn ? 'Latest Invoice' : '最近发票'}</span>
              <span className="w-10 text-center">{isEn ? 'Act' : '操作'}</span>
            </div>

            <BillingVirtualList
              rows={filtered}
              selectedIds={selectedIds}
              toggleSelect={toggleSelect}
              isCheckable={isCheckable}
              onCheck={checkOne}
              isEn={isEn}
            />

            <p className="text-[10px] text-muted-foreground">
              {isEn
                ? 'Billing snapshot is written back by "Check Renewal / Switch to Free" (same Stripe portal response, no extra requests). Unchecked rows show "-".'
                : '账单快照由「检查续费 / 切 Free」随 Stripe 门户同一响应回写（零额外请求）；未检查的行显示 "-"。'}
            </p>
          </CardContent>
        </Card>
      </div>
    </>
  )
}

// ===== 虚拟列表（与订阅页同款：<50 行直接渲染，超出走 useVirtualizer） =====

interface BillingRowData {
  acc: AccountType
  idx: number
}

interface BillingListProps {
  rows: AccountType[]
  selectedIds: Set<string>
  toggleSelect: (id: string) => void
  isCheckable: (acc: AccountType) => boolean
  onCheck: (acc: AccountType) => Promise<boolean>
  isEn: boolean
}

function BillingVirtualList({
  rows,
  selectedIds,
  toggleSelect,
  isCheckable,
  onCheck,
  isEn
}: BillingListProps): React.ReactNode {
  const parentRef = useRef<HTMLDivElement>(null)
  const ROW_HEIGHT = 44

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10
  })

  if (rows.length < 50) {
    return (
      <div ref={parentRef} className="max-h-[60vh] overflow-y-auto">
        {rows.map((acc, idx) => (
          <BillingRow
            key={acc.id}
            acc={acc}
            idx={idx}
            selected={selectedIds.has(acc.id)}
            onToggleSelect={toggleSelect}
            checkable={isCheckable(acc)}
            onCheck={onCheck}
            isEn={isEn}
          />
        ))}
        {rows.length === 0 && (
          <div className="py-10 text-center text-xs text-muted-foreground">
            {isEn ? 'No accounts match current filters' : '没有符合当前筛选的账号'}
          </div>
        )}
      </div>
    )
  }

  const items = virtualizer.getVirtualItems()
  return (
    <div ref={parentRef} className="h-[60vh] overflow-y-auto" style={{ contain: 'strict' }}>
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
        {items.map((virtualRow) => {
          const acc = rows[virtualRow.index]
          if (!acc) return null
          const data: BillingRowData = { acc, idx: virtualRow.index }
          return (
            <div
              key={virtualRow.key}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${virtualRow.start}px)`
              }}
            >
              <BillingRow
                acc={data.acc}
                idx={data.idx}
                selected={selectedIds.has(acc.id)}
                onToggleSelect={toggleSelect}
                checkable={isCheckable(acc)}
                onCheck={onCheck}
                isEn={isEn}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}

interface BillingRowProps {
  acc: AccountType
  idx: number
  selected: boolean
  onToggleSelect: (id: string) => void
  checkable: boolean
  onCheck: (acc: AccountType) => Promise<boolean>
  isEn: boolean
}

const BillingRow = memo(function BillingRow({
  acc,
  idx,
  selected,
  onToggleSelect,
  checkable,
  onCheck,
  isEn
}: BillingRowProps): React.ReactNode {
  const [isRefreshing, setIsRefreshing] = useState(false)
  const sub = acc.subscription ?? {}
  const kind = planKindOf(acc)
  const st = nextStatusOf(acc)
  const snapshotTitle = sub.renewalCheckedAt
    ? isEn
      ? `Updated: ${new Date(sub.renewalCheckedAt).toLocaleString()}`
      : `更新于：${new Date(sub.renewalCheckedAt).toLocaleString()}`
    : isEn
      ? 'Not checked yet'
      : '尚未检查'

  return (
    <div
      className={cn(
        'flex items-center gap-3 py-2 px-3 border-b last:border-b-0 hover:bg-muted/40 text-xs transition-colors',
        selected && 'bg-primary/5'
      )}
      title={snapshotTitle}
    >
      <button
        onClick={() => onToggleSelect(acc.id)}
        className="flex-shrink-0"
        disabled={!checkable}
      >
        {checkable ? (
          selected ? (
            <CheckSquare className="h-3.5 w-3.5 text-primary" />
          ) : (
            <Square className="h-3.5 w-3.5" />
          )
        ) : (
          <span className="inline-block w-3.5" />
        )}
      </button>
      <span className="w-8 text-center text-muted-foreground">{idx + 1}</span>
      <span className="flex-1 truncate">{acc.email}</span>
      <span className="w-36 text-center">
        <span
          className={cn(
            'inline-block px-2 py-0.5 rounded text-[10px] font-medium',
            PLAN_STYLES[kind]
          )}
        >
          {PLAN_LABELS[kind]}
        </span>
        {sub.planAmount != null && (
          <span className="ml-1 text-[10px] text-muted-foreground">
            {formatMoney(sub.planAmount, sub.planCurrency)}/{isEn ? 'mo' : '月'}
          </span>
        )}
      </span>
      <span className="w-32 text-center text-muted-foreground">
        {sub.periodStart || sub.periodEnd
          ? `${formatShortDate(sub.periodStart)} → ${formatShortDate(sub.periodEnd)}`
          : '-'}
      </span>
      <span className="w-20 text-center text-muted-foreground">
        {formatMoney(sub.currentCycleAmount, sub.planCurrency)}
      </span>
      <span className="w-36 text-center">
        {st === 'unchecked' ? (
          <span className="text-muted-foreground text-[10px]">?</span>
        ) : st === 'free' ? (
          <span className="text-muted-foreground text-[10px]">{isEn ? 'Free' : '已降Free'}</span>
        ) : st === 'scheduled-free' ? (
          <span className="text-teal-600 dark:text-teal-300 text-[10px] font-medium">
            {isEn
              ? `$0 @ ${formatShortDate(sub.nextInvoiceAt)}`
              : `$0 @ ${formatShortDate(sub.nextInvoiceAt)} 已排Free`}
          </span>
        ) : sub.nextInvoiceAmount != null ? (
          <span className="text-red-500 text-[10px] font-medium">
            {formatMoney(sub.nextInvoiceAmount, sub.planCurrency)} @{' '}
            {formatShortDate(sub.nextInvoiceAt)}
          </span>
        ) : (
          <span className="text-muted-foreground text-[10px]">-</span>
        )}
      </span>
      <span
        className="w-28 text-center text-muted-foreground"
        title={sub.cardExpMonth ? `${sub.cardExpMonth}/${sub.cardExpYear}` : undefined}
      >
        {sub.cardLast4 ? `${(sub.cardBrand || '').toUpperCase()} •${sub.cardLast4}` : '-'}
      </span>
      <span className="w-44 text-center">
        {(() => {
          // 闭包里 narrowing 会回退，先取出确定有值的链接
          const invoiceUrl = sub.latestInvoiceUrl
          if (!invoiceUrl) return <span className="text-muted-foreground text-[10px]">-</span>
          return (
            <button
              className="inline-flex items-center gap-1 text-[10px] text-primary hover:underline"
              onClick={() => window.api.openExternal(invoiceUrl)}
              title={isEn ? 'Open Stripe invoice page' : '打开 Stripe 官方收据页'}
            >
              {formatMoney(sub.latestInvoiceAmount, sub.planCurrency)} ·{' '}
              {formatShortDate(sub.latestInvoiceAt)}
              {sub.latestInvoiceStatus === 'paid' ? '' : ` · ${sub.latestInvoiceStatus || ''}`}
              <ExternalLink className="h-3 w-3" />
            </button>
          )
        })()}
      </span>
      <span className="w-10 flex justify-center">
        {checkable && (
          <button
            onClick={async () => {
              setIsRefreshing(true)
              try {
                await onCheck(acc)
              } finally {
                setIsRefreshing(false)
              }
            }}
            disabled={isRefreshing}
            className="px-1.5 py-1 rounded text-[10px] bg-muted text-muted-foreground hover:bg-muted/70 disabled:opacity-50"
            title={isEn ? 'Refresh billing info (read-only)' : '刷新账单信息（只读）'}
          >
            {isRefreshing ? (
              <Loader2 className="h-3 w-3 inline animate-spin" />
            ) : (
              <RefreshCw className="h-3 w-3 inline" />
            )}
          </button>
        )}
      </span>
    </div>
  )
})
