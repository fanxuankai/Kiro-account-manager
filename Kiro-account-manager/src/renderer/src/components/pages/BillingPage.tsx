// 账单页：按账号展示 Stripe 订阅门户回写的账单快照（计划单价 / 计费周期 / 本周期与下期金额 / 扣款卡 / 最近发票）。
// 数据来源是「检查续费 / 切 Free」时的同一份门户响应（零额外请求），本页只读快照并提供
// 「检查账单」入口触发同一只读链路刷新；汇总卡与列表随筛选实时重算。
import { useState, useCallback, useEffect, useRef, useMemo, memo } from 'react'
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
  HelpCircle,
  Search,
  ChevronDown,
  FolderOpen,
  Users,
  Inbox,
  Filter
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

// 计划筛选 chip：配色与账号管理页 AccountFilter 的 SubscriptionOptions 完全一致
const PLAN_CHIP_OPTIONS: { value: PlanKind; label: string; color: string; activeColor: string }[] = [
  {
    value: 'Free',
    label: 'KIRO FREE',
    color: 'text-gray-500 border-gray-300',
    activeColor: 'bg-gray-500 text-white border-gray-500'
  },
  {
    value: 'Pro',
    label: 'KIRO PRO',
    color: 'text-blue-500 border-blue-300',
    activeColor: 'bg-blue-500 text-white border-blue-500'
  },
  {
    value: 'Pro_Plus',
    label: 'KIRO PRO+',
    color: 'text-purple-500 border-purple-300',
    activeColor: 'bg-purple-500 text-white border-purple-500'
  },
  {
    value: 'Pro_Max',
    label: 'KIRO PRO MAX',
    color: 'text-rose-500 border-rose-300',
    activeColor: 'bg-rose-500 text-white border-rose-500'
  },
  {
    value: 'Power',
    label: 'KIRO POWER',
    color: 'text-amber-500 border-amber-300',
    activeColor: 'bg-amber-500 text-white border-amber-500'
  }
]

// 解析 ARGB 颜色转换为 CSS rgba（标签 chip 激活色，与账号管理页同款）
function toRgba(argbColor: string): string {
  let alpha = 255
  let rgb = argbColor
  if (argbColor.length === 9 && argbColor.startsWith('#')) {
    alpha = parseInt(argbColor.slice(1, 3), 16)
    rgb = '#' + argbColor.slice(3)
  }
  const hex = rgb.startsWith('#') ? rgb.slice(1) : rgb
  const r = parseInt(hex.slice(0, 2), 16)
  const g = parseInt(hex.slice(2, 4), 16)
  const b = parseInt(hex.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha / 255})`
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
  const { accounts, groups, tags, updateAccount, sort } = useAccountsStore()
  const { actualLanguage } = useTranslation()
  const isEn = actualLanguage === 'en'

  // ===== 页内筛选（不写入账号库的公共 filter，两页互不影响；交互对齐账号管理页） =====
  const [activeGroupTab, setActiveGroupTab] = useState<'all' | 'ungrouped' | string>('all')
  const [showGroupMenu, setShowGroupMenu] = useState(false)
  const [tagIds, setTagIds] = useState<Set<string>>(new Set())
  const [planFilter, setPlanFilter] = useState<Set<PlanKind>>(new Set())
  const [statusFilter, setStatusFilter] = useState<Set<NextStatus>>(new Set())
  const [emailDomains, setEmailDomains] = useState<Set<string>>(new Set())
  const [showAllDomains, setShowAllDomains] = useState(false)
  const [keyword, setKeyword] = useState('')
  // 高级筛选气泡（账号管理页同款：漏斗按钮展开，维度在气泡内紧凑排布）
  const [showFilterPopover, setShowFilterPopover] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [isChecking, setIsChecking] = useState(false)
  const groupMenuRef = useRef<HTMLDivElement>(null)

  const toggleInSet = <T,>(set: Set<T>, value: T): Set<T> => {
    const next = new Set(set)
    if (next.has(value)) next.delete(value)
    else next.add(value)
    return next
  }

  // 点击外部收起分组下拉（与账号管理页同款交互）
  useEffect(() => {
    const onClick = (e: MouseEvent): void => {
      if (groupMenuRef.current && !groupMenuRef.current.contains(e.target as Node)) {
        setShowGroupMenu(false)
      }
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

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
      // 分组与账号管理页同款：顶部互斥单选（全部 / 未分组 / 具体分组）
      if (activeGroupTab === 'ungrouped' && acc.groupId) return false
      if (
        activeGroupTab !== 'all' &&
        activeGroupTab !== 'ungrouped' &&
        acc.groupId !== activeGroupTab
      )
        return false
      if (tagIds.size > 0 && !(acc.tags ?? []).some((t) => tagIds.has(t))) return false
      if (planFilter.size > 0 && !planFilter.has(planKindOf(acc))) return false
      if (statusFilter.size > 0 && !statusFilter.has(nextStatusOf(acc))) return false
      if (emailDomains.size > 0) {
        const domain = acc.email?.slice(acc.email.lastIndexOf('@') + 1).toLowerCase()
        if (!domain || !emailDomains.has(domain)) return false
      }
      if (
        kw &&
        !(
          acc.email?.toLowerCase().includes(kw) ||
          acc.nickname?.toLowerCase().includes(kw) ||
          // 卡尾号按原样数字匹配（无大小写），卡品牌走小写包含（如输入 visa / mastercard）
          acc.subscription?.cardLast4?.includes(keyword.trim()) ||
          acc.subscription?.cardBrand?.toLowerCase().includes(kw)
        )
      )
        return false
      return true
    })
    // 排序与账号管理页共用同一份 sort 设置（store），保证两页账号顺序一致
    const compare = (a: AccountType, b: AccountType): number => {
      switch (sort.field) {
        case 'email':
          return (a.email || '').localeCompare(b.email || '')
        case 'nickname':
          return (a.nickname ?? '').localeCompare(b.nickname ?? '')
        case 'subscription':
          return (a.subscription?.type || '').localeCompare(b.subscription?.type || '')
        case 'usage':
          return (a.usage?.percentUsed ?? 0) - (b.usage?.percentUsed ?? 0)
        case 'daysRemaining':
          return (a.subscription?.daysRemaining ?? 999) - (b.subscription?.daysRemaining ?? 999)
        case 'lastUsedAt':
          return (a.lastUsedAt ?? 0) - (b.lastUsedAt ?? 0)
        case 'createdAt':
          return (a.createdAt ?? 0) - (b.createdAt ?? 0)
        case 'status':
          return (a.status || '').localeCompare(b.status || '')
        default:
          return 0
      }
    }
    return out.sort((a, b) => (sort.order === 'desc' ? -compare(a, b) : compare(a, b)))
  }, [billingAccounts, activeGroupTab, tagIds, planFilter, statusFilter, emailDomains, keyword, sort])

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

  // 气泡维度是否有激活（不含分组 tab 与搜索词——两者有各自的入口与高亮）
  const filterChipsActive =
    tagIds.size > 0 || planFilter.size > 0 || statusFilter.size > 0 || emailDomains.size > 0
  const clearFilters = (): void => {
    setActiveGroupTab('all')
    setTagIds(new Set())
    setPlanFilter(new Set())
    setStatusFilter(new Set())
    setEmailDomains(new Set())
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

  // 分组 Tab 计数（全部 / 未分组 / 各分组），与账号管理页同口径
  const groupTabCounts = useMemo(() => {
    let ungrouped = 0
    const byGroup = new Map<string, number>()
    for (const acc of billingAccounts) {
      if (!acc.groupId) ungrouped++
      else byGroup.set(acc.groupId, (byGroup.get(acc.groupId) ?? 0) + 1)
    }
    return { all: billingAccounts.length, ungrouped, byGroup }
  }, [billingAccounts])
  const sortedGroups = useMemo(
    () => Array.from(groups.values()).sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
    [groups]
  )
  const activeGroup = activeGroupTab !== 'all' && activeGroupTab !== 'ungrouped' ? groups.get(activeGroupTab) : undefined

  // 邮箱域名后缀及数量（按数量降序），与账号管理页筛选面板同款
  const DOMAIN_DISPLAY_LIMIT = 16
  const domainCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const acc of billingAccounts) {
      const at = acc.email?.lastIndexOf('@')
      if (at == null || at < 0) continue
      const domain = acc.email.slice(at + 1).toLowerCase()
      if (!domain) continue
      counts.set(domain, (counts.get(domain) ?? 0) + 1)
    }
    return Array.from(counts.entries()).sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
    )
  }, [billingAccounts])
  // 折叠时也保证已选中的域名可见
  const visibleDomains = useMemo(() => {
    if (showAllDomains || domainCounts.length <= DOMAIN_DISPLAY_LIMIT) return domainCounts
    const top = domainCounts.slice(0, DOMAIN_DISPLAY_LIMIT)
    for (const entry of domainCounts.slice(DOMAIN_DISPLAY_LIMIT)) {
      if (emailDomains.has(entry[0])) top.push(entry)
    }
    return top
  }, [domainCounts, showAllDomains, emailDomains])

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
            {/* 工具栏：分组下拉（互斥单选，账号管理页同款）+ 搜索框 + 批量检查 */}
            <div className="flex flex-wrap items-center gap-3">
              <div ref={groupMenuRef} className="relative">
                <button
                  type="button"
                  onClick={() => setShowGroupMenu((v) => !v)}
                  className="flex items-center gap-1.5 h-9 px-3 text-sm rounded-xl border border-[var(--glass-border)] bg-[var(--glass-bg-subtle)] backdrop-blur-md hover:bg-muted/50 transition-colors"
                >
                  <FolderOpen className="h-4 w-4 text-muted-foreground" />
                  <span>
                    {activeGroup
                      ? activeGroup.name
                      : activeGroupTab === 'ungrouped'
                        ? isEn
                          ? 'Ungrouped'
                          : '未分组'
                        : isEn
                          ? 'All Groups'
                          : '全部分组'}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    (
                    {activeGroupTab === 'all'
                      ? groupTabCounts.all
                      : activeGroupTab === 'ungrouped'
                        ? groupTabCounts.ungrouped
                        : (groupTabCounts.byGroup.get(activeGroupTab) ?? 0)}
                    )
                  </span>
                  <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                </button>
                {showGroupMenu && (
                  <div className="absolute left-0 top-full mt-1 z-20 w-52 max-h-72 overflow-y-auto rounded-xl border border-[var(--glass-border)] bg-[var(--glass-bg)] backdrop-blur-md shadow-lg py-1">
                    <button
                      type="button"
                      className={cn(
                        'w-full flex items-center gap-2 px-3 py-2 text-sm transition-colors',
                        activeGroupTab === 'all'
                          ? 'text-primary font-medium'
                          : 'text-foreground hover:bg-muted/50'
                      )}
                      onClick={() => {
                        setActiveGroupTab('all')
                        setShowGroupMenu(false)
                      }}
                    >
                      <Users className="h-4 w-4" />
                      {isEn ? 'All' : '全部'} ({groupTabCounts.all})
                    </button>
                    <button
                      type="button"
                      className={cn(
                        'w-full flex items-center gap-2 px-3 py-2 text-sm transition-colors',
                        activeGroupTab === 'ungrouped'
                          ? 'text-primary font-medium'
                          : 'text-foreground hover:bg-muted/50'
                      )}
                      onClick={() => {
                        setActiveGroupTab('ungrouped')
                        setShowGroupMenu(false)
                      }}
                    >
                      <Inbox className="h-4 w-4" />
                      {isEn ? 'Ungrouped' : '未分组'} ({groupTabCounts.ungrouped})
                    </button>
                    {sortedGroups.map((g) => (
                      <button
                        key={g.id}
                        type="button"
                        className={cn(
                          'w-full flex items-center gap-2 px-3 py-2 text-sm transition-colors',
                          activeGroupTab === g.id
                            ? 'text-primary font-medium'
                            : 'text-foreground hover:bg-muted/50'
                        )}
                        onClick={() => {
                          setActiveGroupTab(g.id)
                          setShowGroupMenu(false)
                        }}
                      >
                        <span
                          className="h-2 w-2 rounded-full shrink-0"
                          style={{ backgroundColor: toRgba(g.color || '#5b8cff') }}
                        />
                        <span className="truncate">{g.name}</span>
                        <span className="text-xs text-muted-foreground ml-auto">
                          {groupTabCounts.byGroup.get(g.id) ?? 0}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* 搜索框（账号管理页同款样式） */}
              <div className="relative flex-1 min-w-[200px] max-w-md">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <input
                  type="text"
                  placeholder={isEn ? 'Search email / nickname / card last4...' : '搜索邮箱 / 昵称 / 卡尾号...'}
                  className="w-full pl-9 pr-4 py-2 text-sm rounded-xl bg-[var(--glass-bg-subtle)] backdrop-blur-md border border-[var(--glass-border)] focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary/30 transition-all"
                  value={keyword}
                  onChange={(e) => setKeyword(e.target.value)}
                />
              </div>

              <span className="text-xs text-muted-foreground">
                {isEn ? `${filtered.length} account(s)` : `共 ${filtered.length} 个账号`}
              </span>

              <div className="flex items-center gap-2 ml-auto">
                {/* 高级筛选气泡（账号管理页同款交互：漏斗按钮展开） */}
                <div className="relative">
                  <Button
                    variant={showFilterPopover ? 'default' : 'ghost'}
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => setShowFilterPopover((v) => !v)}
                    title={isEn ? 'Toggle advanced filter' : '展开/收起高级筛选'}
                  >
                    <Filter className="h-4 w-4" />
                  </Button>
                  {showFilterPopover && (
                    <div className="absolute right-0 top-full mt-2 z-50 min-w-[560px] bg-popover border rounded-lg shadow-lg">
                      {/* 气泡箭头 */}
                      <div className="absolute -top-2 right-4 w-4 h-4 bg-popover border-l border-t rotate-45" />
                      <div className="p-3 space-y-2">
                        {/* 清除筛选 */}
                        {filterChipsActive && (
                          <div className="flex justify-end">
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-6 text-xs px-2"
                              onClick={clearFilters}
                            >
                              {isEn ? 'Clear' : '清除筛选'}
                            </Button>
                          </div>
                        )}
                        {/* 第一行：计划（彩色 chip）+ 下期状态 */}
                        <div className="flex flex-wrap items-start gap-x-6 gap-y-2">
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-muted-foreground shrink-0">
                              {isEn ? 'Plan:' : '计划:'}
                            </span>
                            <div className="flex flex-wrap gap-1">
                              {PLAN_CHIP_OPTIONS.map((option) => {
                                const isActive = planFilter.has(option.value)
                                const count = planCounts.get(option.value)
                                return (
                                  <button
                                    key={option.value}
                                    className={cn(
                                      'px-2 py-0.5 text-xs rounded border transition-colors',
                                      isActive
                                        ? option.activeColor
                                        : `hover:bg-muted/50 ${option.color}`
                                    )}
                                    onClick={() => setPlanFilter((prev) => toggleInSet(prev, option.value))}
                                  >
                                    {option.label}({count})
                                  </button>
                                )
                              })}
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

                        {/* 第二行：标签（激活用标签自身颜色）+ 邮箱域名 */}
                        <div className="flex flex-wrap items-start gap-x-6 gap-y-2">
                          {tags.size > 0 && (
                            <div className="flex items-center gap-2">
                              <span className="text-xs text-muted-foreground shrink-0">
                                {isEn ? 'Tags:' : '标签:'}
                              </span>
                              <div className="flex flex-wrap gap-1">
                                {Array.from(tags.values()).map((t) => {
                                  const isActive = tagIds.has(t.id)
                                  return (
                                    <button
                                      key={t.id}
                                      className={cn(
                                        'px-2 py-0.5 text-xs rounded border transition-colors',
                                        isActive ? 'text-white border-transparent' : 'hover:bg-muted'
                                      )}
                                      style={isActive ? { backgroundColor: toRgba(t.color) } : undefined}
                                      onClick={() => setTagIds((prev) => toggleInSet(prev, t.id))}
                                    >
                                      {t.name}
                                    </button>
                                  )
                                })}
                              </div>
                            </div>
                          )}
                          {domainCounts.length > 0 && (
                            <div className="flex items-center gap-2">
                              <span className="text-xs text-muted-foreground shrink-0">
                                {isEn ? 'Domain:' : '域名:'}
                              </span>
                              <div className="flex flex-wrap gap-1">
                                {visibleDomains.map(([domain, count]) => (
                                  <button
                                    key={domain}
                                    className={cn(
                                      'px-2 py-0.5 text-xs rounded border transition-colors',
                                      emailDomains.has(domain)
                                        ? 'bg-primary text-primary-foreground border-primary'
                                        : 'hover:bg-muted'
                                    )}
                                    onClick={() => setEmailDomains((prev) => toggleInSet(prev, domain))}
                                  >
                                    @{domain}({count})
                                  </button>
                                ))}
                                {domainCounts.length > DOMAIN_DISPLAY_LIMIT && (
                                  <button
                                    className="px-2 py-0.5 text-xs rounded border hover:bg-muted text-muted-foreground transition-colors"
                                    onClick={() => setShowAllDomains(!showAllDomains)}
                                  >
                                    {showAllDomains
                                      ? isEn
                                        ? 'Less'
                                        : '收起'
                                      : `+${domainCounts.length - DOMAIN_DISPLAY_LIMIT}`}
                                  </button>
                                )}
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                </div>

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
