// 卡视图：按「扣款卡」聚合账单页三层数据（主库 / 闲置库 / 已删存档），
// 用卡名下各账号的最近发票时间近似支付时间，在两个时间窗口内推算额度与恢复状态。
// 近似口径：每账号只保留最近一张发票，窗口内同账号的多次支付会漏计（额度偏乐观），
// 判"还能不能用"以 >= 限额为准，宁可保守。
import { useMemo, useState, useEffect, useCallback } from 'react'
import {
  ChevronDown,
  CreditCard,
  CheckCircle2,
  TimerReset,
  ExternalLink,
  Search
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Account } from '@/types/account'
import {
  planKindOf,
  PLAN_LABELS,
  PLAN_STYLES,
  formatMoney,
  formatShortDate,
  type PlanKind
} from '@/components/billing/billingShared'

// ===== 额度窗口参数（如需调整改这里） =====
const WINDOW_24H_MS = 24 * 60 * 60 * 1000
const WINDOW_7D_MS = 7 * 24 * 60 * 60 * 1000
const LIMIT_24H = 2
const LIMIT_7D = 3

/** 冷却倒计时刷新粒度：分钟级足够（限额窗口是小时/天级） */
const TICK_MS = 60 * 1000

// 卡品牌识别色（无 logo，纯文本色即可）
const BRAND_COLORS: Record<string, string> = {
  visa: 'text-blue-600 dark:text-blue-400',
  mastercard: 'text-orange-600 dark:text-orange-400',
  amex: 'text-teal-600 dark:text-teal-400',
  unionpay: 'text-red-600 dark:text-red-400',
  jcb: 'text-emerald-600 dark:text-emerald-400',
  discover: 'text-amber-700 dark:text-amber-400'
}
const brandColor = (brand: string): string =>
  BRAND_COLORS[(brand || '').toLowerCase()] ?? 'text-muted-foreground'

interface CardRecord {
  email: string
  nickname?: string
  plan: PlanKind
  currency?: string
  invoiceAt?: number
  invoiceAmount?: number
  invoiceUrl?: string
  source: 'main' | 'idle' | 'deleted'
}

interface CardEntry {
  key: string // brand-last4
  brand: string
  last4: string
  expMonth?: number
  expYear?: number
  records: CardRecord[] // 按发票时间降序
  count24: number
  count7: number
  /** 现在还能再付几次（两个窗口的剩余取小，下限 0） */
  remaining: number
  /** 恢复到"能再付一次"的预计时间；null = 当前可用 */
  recoverAt: number | null
  blockedBy24: boolean
  blockedBy7: boolean
}

/** 聚合各账号的账单行到卡维度，并按时间窗口推算额度 */
function aggregateCards(rows: Account[], now: number): CardEntry[] {
  const map = new Map<string, CardEntry>()
  for (const acc of rows) {
    const s = acc.subscription ?? {}
    if (!s.cardLast4) continue
    const key = `${(s.cardBrand || '').toLowerCase()}-${s.cardLast4}`
    let e = map.get(key)
    if (!e) {
      e = {
        key,
        brand: s.cardBrand || '',
        last4: s.cardLast4,
        records: [],
        count24: 0,
        count7: 0,
        remaining: 0,
        recoverAt: null,
        blockedBy24: false,
        blockedBy7: false
      }
      map.set(key, e)
    }
    if (s.cardExpMonth != null && s.cardExpYear != null) {
      e.expMonth = s.cardExpMonth
      e.expYear = s.cardExpYear
    }
    e.records.push({
      email: acc.email,
      nickname: acc.nickname,
      plan: planKindOf(acc),
      currency: s.planCurrency,
      invoiceAt: s.latestInvoiceAt,
      invoiceAmount: s.latestInvoiceAmount,
      invoiceUrl: s.latestInvoiceUrl,
      source: acc.billingArchivedAt != null ? 'deleted' : acc.billingFromIdle ? 'idle' : 'main'
    })
  }

  for (const e of map.values()) {
    e.records.sort((a, b) => (b.invoiceAt ?? 0) - (a.invoiceAt ?? 0))
    const w24 = e.records
      .map((r) => r.invoiceAt)
      .filter((t): t is number => t != null && t >= now - WINDOW_24H_MS)
    const w7 = e.records
      .map((r) => r.invoiceAt)
      .filter((t): t is number => t != null && t >= now - WINDOW_7D_MS)
    e.count24 = w24.length
    e.count7 = w7.length
    e.blockedBy24 = e.count24 >= LIMIT_24H
    e.blockedBy7 = e.count7 >= LIMIT_7D
    e.remaining = Math.max(0, Math.min(LIMIT_24H - e.count24, LIMIT_7D - e.count7))
    // 恢复时间 = 被触发的窗口各自"最早一次支付滑出窗口"的时刻，取最晚（两个约束都要解除）
    const recovers: number[] = []
    if (e.blockedBy24) recovers.push(Math.min(...w24) + WINDOW_24H_MS)
    if (e.blockedBy7) recovers.push(Math.min(...w7) + WINDOW_7D_MS)
    e.recoverAt = recovers.length > 0 ? Math.max(...recovers) : null
  }
  return Array.from(map.values())
}

/** 额度点阵：实心 = 已占用，满额红色，部分琥珀，空心 = 剩余 */
function QuotaDots({ used, limit }: { used: number; limit: number }): React.ReactNode {
  return (
    <span className="inline-flex items-center gap-1">
      {Array.from({ length: limit }, (_, i) => (
        <span
          key={i}
          className={cn(
            'h-2 w-2 rounded-full border transition-colors',
            i < used
              ? used >= limit
                ? 'bg-red-500 border-red-500'
                : 'bg-amber-500 border-amber-500'
              : 'border-muted-foreground/40'
          )}
        />
      ))}
    </span>
  )
}

/** 倒计时文案（分钟粒度向上取整） */
function formatCountdown(ms: number, isEn: boolean): string {
  const mins = Math.max(1, Math.ceil(ms / 60000))
  if (mins < 60) return isEn ? `${mins}m` : `${mins} 分钟`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return isEn ? `${hours}h ${mins % 60}m` : `${hours} 小时 ${mins % 60} 分`
  const days = Math.floor(hours / 24)
  return isEn ? `${days}d ${hours % 24}h` : `${days} 天 ${hours % 24} 小时`
}

/** 剩余次数文案徽章：可用（绿）或恢复倒计时（琥珀） */
function QuotaBadge({ card, now, isEn }: { card: CardEntry; now: number; isEn: boolean }): React.ReactNode {
  if (card.remaining > 0) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium bg-emerald-500/15 text-emerald-700 dark:text-emerald-300">
        <CheckCircle2 className="h-3 w-3" />
        {isEn ? `avail ×${card.remaining}` : `可用 ×${card.remaining}`}
      </span>
    )
  }
  const left = (card.recoverAt ?? 0) - now
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium bg-amber-500/15 text-amber-700 dark:text-amber-300">
      <TimerReset className="h-3 w-3" />
      {isEn ? `resets in ${formatCountdown(left, isEn)}` : `恢复 ${formatCountdown(left, isEn)}`}
    </span>
  )
}

const SOURCE_BADGES: Record<CardRecord['source'], { zh: string; en: string; cls: string }> = {
  main: { zh: '主库', en: 'main', cls: 'bg-muted text-muted-foreground' },
  idle: { zh: '闲置', en: 'idle', cls: 'bg-blue-500/15 text-blue-600 dark:text-blue-300' },
  deleted: { zh: '已删', en: 'deleted', cls: 'bg-muted text-muted-foreground border border-[var(--glass-border)]' }
}

export function BillingCardsView({ rows, isEn }: { rows: Account[]; isEn: boolean }): React.ReactNode {
  // 分钟级时钟：驱动冷却倒计时与额度窗口重算
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(t)
  }, [])

  const [keyword, setKeyword] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const cards = useMemo(() => aggregateCards(rows, now), [rows, now])

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    const list = kw
      ? cards.filter(
          (c) => c.last4.includes(keyword.trim()) || c.brand.toLowerCase().includes(kw)
        )
      : cards.slice()
    // 可用在前（剩余次数多者优先）；冷却按恢复时间升序（快好的在前）
    return list.sort((a, b) => {
      const aOk = a.remaining > 0
      const bOk = b.remaining > 0
      if (aOk !== bOk) return aOk ? -1 : 1
      if (aOk) return b.remaining - a.remaining || a.last4.localeCompare(b.last4)
      return (a.recoverAt ?? 0) - (b.recoverAt ?? 0) || a.last4.localeCompare(b.last4)
    })
  }, [cards, keyword])

  const summary = useMemo(() => {
    let usable = 0
    let cooldown = 0
    let soon = 0 // 2 小时内恢复
    for (const c of cards) {
      if (c.remaining > 0) usable++
      else {
        cooldown++
        if (c.recoverAt != null && c.recoverAt - now <= 2 * 60 * 60 * 1000) soon++
      }
    }
    return { total: cards.length, usable, cooldown, soon }
  }, [cards, now])

  const toggle = useCallback((key: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  return (
    <div className="space-y-3">
      {/* 汇总卡：卡维度的额度状态 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card label={isEn ? 'Cards tracked' : '在册卡数'} value={String(summary.total)} icon="credit" />
        <Card label={isEn ? 'Usable now' : '当前可用'} value={String(summary.usable)} icon="ok" accent="emerald" />
        <Card label={isEn ? 'In cooldown' : '冷却中'} value={String(summary.cooldown)} icon="timer" accent="amber" />
        <Card
          label={isEn ? 'Recovering soon' : '2 小时内恢复'}
          value={String(summary.soon)}
          icon="timer"
          accent="amber"
          hint={isEn ? 'check back soon' : '快又能用了'}
        />
      </div>

      {/* 搜索：尾号 / 品牌 */}
      <div className="relative max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <input
          type="text"
          placeholder={isEn ? 'Search card last4 / brand...' : '搜索卡尾号 / 品牌...'}
          className="w-full pl-9 pr-4 py-2 text-sm rounded-xl bg-[var(--glass-bg-subtle)] backdrop-blur-md border border-[var(--glass-border)] focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary/30 transition-all"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
      </div>

      {/* 卡列表（外层布局不滚动，本容器自带滚动高度；表头吸顶） */}
      <div className="rounded-xl border border-[var(--glass-border)] overflow-hidden">
        <div className="max-h-[65vh] overflow-y-auto">
        {/* 表头（额度只以点阵呈现，不标注参数） */}
        <div className="sticky top-0 z-10 flex items-center gap-3 py-2 px-3 text-xs text-muted-foreground border-b bg-popover">
          <span className="w-8" />
          <span className="w-44">{isEn ? 'Card' : '卡'}</span>
          <span className="w-16 text-center">{isEn ? 'Exp' : '有效期'}</span>
          <span className="w-16 text-center">{isEn ? 'Accounts' : '绑定'}</span>
          <span className="w-24 text-center">24h</span>
          <span className="w-28 text-center">{isEn ? '7d' : '7天'}</span>
          <span className="flex-1 text-center">{isEn ? 'Status' : '状态'}</span>
          <span className="w-6" />
        </div>
        {filtered.map((c) => {
          const open = expanded.has(c.key)
          return (
            <div key={c.key} className="border-b last:border-b-0">
              <button
                type="button"
                className="w-full flex items-center gap-3 py-2.5 px-3 text-xs text-left hover:bg-muted/40 transition-colors"
                onClick={() => toggle(c.key)}
              >
                <span className="w-8 flex justify-center">
                  <CreditCard className={cn('h-4 w-4', brandColor(c.brand))} />
                </span>
                <span className="w-44 truncate font-medium">
                  {(c.brand || 'card').toUpperCase()} •{c.last4}
                </span>
                <span className="w-16 text-center text-muted-foreground">
                  {c.expMonth ? `${c.expMonth}/${String(c.expYear).slice(-2)}` : '-'}
                </span>
                <span className="w-16 text-center text-muted-foreground">{c.records.length}</span>
                <span className="w-24 flex items-center justify-center" title={isEn ? 'last 24h' : '近 24 小时'}>
                  <QuotaDots used={c.count24} limit={LIMIT_24H} />
                </span>
                <span className="w-28 flex items-center justify-center" title={isEn ? 'last 7 days' : '近 7 天'}>
                  <QuotaDots used={c.count7} limit={LIMIT_7D} />
                </span>
                <span className="flex-1 flex justify-center">
                  <QuotaBadge card={c} now={now} isEn={isEn} />
                </span>
                <span className="w-6 flex justify-center">
                  <ChevronDown
                    className={cn(
                      'h-3.5 w-3.5 text-muted-foreground transition-transform',
                      open && 'rotate-180'
                    )}
                  />
                </span>
              </button>
              {open && (
                <div className="pb-2 px-3">
                  {c.recoverAt != null && (
                    <p className="text-[10px] text-amber-600 dark:text-amber-400 px-11 py-1">
                      {isEn
                        ? `Quota resets at ${new Date(c.recoverAt).toLocaleString()}`
                        : `预计 ${new Date(c.recoverAt).toLocaleString()} 恢复额度`}
                    </p>
                  )}
                  {c.records.map((r) => {
                    const badge = SOURCE_BADGES[r.source]
                    return (
                      <div
                        key={`${c.key}-${r.email}-${r.invoiceAt ?? 0}`}
                        className="flex items-center gap-3 py-1.5 px-11 text-[11px] hover:bg-muted/30 rounded"
                      >
                        <span className="w-56 truncate">{r.email}</span>
                        <span className={cn('px-1.5 py-0.5 rounded text-[9px] font-medium', badge.cls)}>
                          {isEn ? badge.en : badge.zh}
                        </span>
                        <span
                          className={cn(
                            'px-2 py-0.5 rounded text-[9px] font-medium',
                            PLAN_STYLES[r.plan]
                          )}
                        >
                          {PLAN_LABELS[r.plan]}
                        </span>
                        <span className="flex-1 text-muted-foreground">
                          {r.invoiceAt != null ? formatShortDate(r.invoiceAt) : '-'}
                        </span>
                        {(() => {
                          const url = r.invoiceUrl
                          if (!url) return <span className="text-muted-foreground">-</span>
                          return (
                            <button
                              className="inline-flex items-center gap-1 text-primary hover:underline"
                              onClick={() => window.api.openExternal(url)}
                              title={isEn ? 'Open Stripe invoice page' : '打开 Stripe 官方收据页'}
                            >
                              {formatMoney(r.invoiceAmount, r.currency)}
                              <ExternalLink className="h-3 w-3" />
                            </button>
                          )
                        })()}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
        {filtered.length === 0 && (
          <div className="py-10 text-center text-xs text-muted-foreground">
            {isEn ? 'No cards match' : '没有符合的卡'}
          </div>
        )}
        </div>
      </div>

      <p className="text-[10px] text-muted-foreground">
        {isEn
          ? 'Quota is estimated from recent billing timestamps of bound accounts. Only the latest invoice per account is kept, so estimates can be optimistic — treat actual results as final.'
          : '额度基于绑定账号的近期账单时间估算，仅供参考；每账号仅保留最近一笔记录，估算可能偏乐观，以实际结果为准。'}
      </p>
    </div>
  )
}

/** 汇总小卡（卡视图专用，与账单页汇总卡同款样式） */
function Card({
  label,
  value,
  icon,
  accent,
  hint
}: {
  label: string
  value: string
  icon: 'credit' | 'ok' | 'timer'
  accent?: 'emerald' | 'amber'
  hint?: string
}): React.ReactNode {
  const iconCls =
    icon === 'ok'
      ? 'h-4 w-4 text-emerald-500'
      : icon === 'timer'
        ? 'h-4 w-4 text-amber-500'
        : 'h-4 w-4 text-red-500'
  const valueCls =
    accent === 'emerald'
      ? 'text-emerald-600 dark:text-emerald-300'
      : accent === 'amber'
        ? 'text-amber-600 dark:text-amber-300'
        : ''
  return (
    <div className="rounded-xl border bg-card text-card-foreground shadow-sm">
      <div className="p-4">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {icon === 'credit' ? <CreditCard className={iconCls} /> : icon === 'ok' ? <CheckCircle2 className={iconCls} /> : <TimerReset className={iconCls} />}
          {label}
        </div>
        <div className={cn('mt-1 text-xl font-semibold', valueCls)}>{value}</div>
        {hint && <div className="text-[10px] text-muted-foreground mt-0.5">{hint}</div>}
      </div>
    </div>
  )
}
