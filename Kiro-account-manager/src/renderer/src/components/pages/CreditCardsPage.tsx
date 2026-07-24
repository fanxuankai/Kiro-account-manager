import { useState, useMemo } from 'react'
import {
  CreditCard as CreditCardIcon,
  Plus,
  Trash2,
  Edit2,
  Wallet,
  Building2,
  CalendarClock,
  AlertTriangle,
  Users,
  ChevronDown,
  X
} from 'lucide-react'
import {
  useCreditCardsStore,
  CARD_NETWORKS,
  CARD_STATUSES,
  availableCredit,
  utilization,
  usageStats,
  type CreditCard,
  type CardNetwork,
  type CardStatus
} from '@/store/creditCards'
import { useAccountsStore } from '@/store/accounts'
import { useTranslation } from '@/hooks/useTranslation'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Button,
  Input,
  Label,
  Badge,
  Select
} from '../ui'
import { cn } from '@/lib/utils'

/** 使用率颜色：<50% 绿，<80% 黄，>=80% 红 */
function utilColor(ratio: number): string {
  if (ratio >= 0.8) return 'bg-red-500'
  if (ratio >= 0.5) return 'bg-yellow-500'
  return 'bg-green-500'
}

function fmtMoney(v: number, currency: string): string {
  const n = Number(v) || 0
  return `${currency} ${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
}

/** 格式化使用记录时间：YYYY-MM-DD HH:mm */
function fmtDate(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

const EMPTY_CARD: Partial<CreditCard> = {
  network: 'visa',
  status: 'active',
  currency: 'CNY',
  creditLimit: 0,
  usedAmount: 0
}

export function CreditCardsPage(): React.ReactNode {
  const { t } = useTranslation()
  const isEn = t('common.unknown') === 'Unknown'
  const { cards, addCard, updateCard, removeCard, addUsage, removeUsage } = useCreditCardsStore()

  const [editing, setEditing] = useState<Partial<CreditCard> | null>(null)

  const cardList = useMemo(() => Array.from(cards.values()), [cards])

  // 汇总：按币种聚合总额度 / 已用（仅统计非注销卡）
  const summary = useMemo(() => {
    const byCurrency = new Map<string, { limit: number; used: number }>()
    for (const c of cardList) {
      if (c.status === 'closed') continue
      const agg = byCurrency.get(c.currency) || { limit: 0, used: 0 }
      agg.limit += c.creditLimit || 0
      agg.used += c.usedAmount || 0
      byCurrency.set(c.currency, agg)
    }
    return Array.from(byCurrency.entries())
  }, [cardList])

  const handleSave = (): void => {
    if (!editing || !editing.label || !editing.bank) return
    const data = {
      label: editing.label,
      bank: editing.bank,
      network: (editing.network || 'visa') as CardNetwork,
      last4: editing.last4?.trim() || undefined,
      holder: editing.holder?.trim() || undefined,
      expiry: editing.expiry?.trim() || undefined,
      currency: editing.currency || 'CNY',
      creditLimit: Number(editing.creditLimit) || 0,
      usedAmount: Number(editing.usedAmount) || 0,
      statementDay: editing.statementDay ? Number(editing.statementDay) : undefined,
      dueDay: editing.dueDay ? Number(editing.dueDay) : undefined,
      annualFee: editing.annualFee ? Number(editing.annualFee) : undefined,
      feeWaiverSwipes: editing.feeWaiverSwipes ? Number(editing.feeWaiverSwipes) : undefined,
      currentSwipes: editing.currentSwipes ? Number(editing.currentSwipes) : undefined,
      status: (editing.status || 'active') as CardStatus,
      note: editing.note?.trim() || undefined
    }
    if (editing.id) {
      updateCard(editing.id, data)
    } else {
      addCard(data)
    }
    setEditing(null)
  }

  return (
    <div className="flex-1 p-6 space-y-6 overflow-auto">
      {/* Header */}
      <div className="page-hero p-6">
        <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-br from-emerald-500/20 to-transparent rounded-full blur-2xl" />
        <div className="absolute bottom-0 left-0 w-24 h-24 bg-gradient-to-tr from-emerald-500/20 to-transparent rounded-full blur-2xl" />
        <div className="relative flex items-center gap-4">
          <div className="p-3 rounded-xl bg-emerald-500 shadow-lg shadow-emerald-500/25">
            <CreditCardIcon className="h-6 w-6 text-white" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-emerald-600 dark:text-emerald-400">
              {isEn ? 'Credit Cards' : '信用卡管理'}
            </h1>
            <p className="text-muted-foreground">
              {isEn
                ? 'Track credit limits, usage, statement/due dates and annual-fee waiver progress. Only the last 4 digits are stored.'
                : '维护信用卡额度、已用/可用、账单/还款日与年费减免进度。出于安全仅保存卡号后四位。'}
            </p>
          </div>
        </div>
      </div>

      {/* 币种汇总 */}
      {summary.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {summary.map(([cur, agg]) => {
            const ratio = agg.limit > 0 ? Math.min(1, agg.used / agg.limit) : 0
            return (
              <Card key={cur}>
                <CardContent className="p-4">
                  <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
                    <Wallet className="h-4 w-4" />
                    {isEn ? `Total (${cur})` : `合计（${cur}）`}
                  </div>
                  <div className="text-lg font-semibold">
                    {fmtMoney(agg.limit - agg.used, cur)}
                    <span className="text-xs text-muted-foreground font-normal">
                      {' '}
                      / {fmtMoney(agg.limit, cur)} {isEn ? 'available' : '可用'}
                    </span>
                  </div>
                  <div className="mt-2 h-1.5 rounded-full bg-muted overflow-hidden">
                    <div
                      className={cn('h-full rounded-full', utilColor(ratio))}
                      style={{ width: `${ratio * 100}%` }}
                    />
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}

      {/* 卡片列表 */}
      <Card>
        <CardHeader className="pb-3 flex flex-row items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <CreditCardIcon className="h-4 w-4 text-primary" />
            {isEn ? `Cards (${cardList.length})` : `信用卡 (${cardList.length})`}
          </CardTitle>
          <Button size="sm" onClick={() => setEditing({ ...EMPTY_CARD })}>
            <Plus className="h-4 w-4 mr-1" />
            {isEn ? 'Add Card' : '添加信用卡'}
          </Button>
        </CardHeader>
        <CardContent>
          {cardList.length === 0 ? (
            <div className="py-12 text-center text-muted-foreground">
              <CreditCardIcon className="h-12 w-12 mx-auto mb-3 opacity-30" />
              <p className="text-sm">{isEn ? 'No cards yet.' : '还没有信用卡'}</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              {cardList.map((c) => (
                <CardRow
                  key={c.id}
                  card={c}
                  isEn={isEn}
                  onEdit={() => setEditing({ ...c })}
                  onDelete={() => {
                    if (confirm(isEn ? `Delete card "${c.label}"?` : `删除信用卡"${c.label}"？`)) {
                      removeCard(c.id)
                    }
                  }}
                  onAddUsage={(account) => addUsage(c.id, account)}
                  onRemoveUsage={(usageId) => removeUsage(c.id, usageId)}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {editing && (
        <CardEditor
          editing={editing}
          isEn={isEn}
          onChange={setEditing}
          onCancel={() => setEditing(null)}
          onSave={handleSave}
        />
      )}
    </div>
  )
}

// ==================== 单张卡片行 ====================

function CardRow({
  card,
  isEn,
  onEdit,
  onDelete,
  onAddUsage,
  onRemoveUsage
}: {
  card: CreditCard
  isEn: boolean
  onEdit: () => void
  onDelete: () => void
  onAddUsage: (account: { id: string; email: string }) => void
  onRemoveUsage: (usageId: string) => void
}): React.ReactNode {
  const ratio = utilization(card)
  const avail = availableCredit(card)
  const stats = usageStats(card)

  // 使用记录展开 + 账号选择
  const accounts = useAccountsStore((s) => s.accounts)
  const [expanded, setExpanded] = useState(false)
  const [picking, setPicking] = useState(false)
  const [pickedId, setPickedId] = useState('')
  // 记账模式：从现有账号下拉选 / 手动输入邮箱（已删账号补录用）
  const [manualMode, setManualMode] = useState(false)
  const [manualEmail, setManualEmail] = useState('')

  // 账号下拉选项：label 用 nickname || email
  const accountOptions = useMemo(
    () =>
      Array.from(accounts.values()).map((a) => ({
        value: a.id,
        label: a.nickname || a.email,
        description: a.nickname ? a.email : undefined
      })),
    [accounts]
  )

  // 明细按时间倒序（最近的在前）
  const sortedUsages = useMemo(
    () => [...(card.usages || [])].sort((a, b) => b.at - a.at),
    [card.usages]
  )

  // 无现有账号时自动切到手动输入模式
  const hasAccounts = accountOptions.length > 0
  const effectiveManual = manualMode || !hasAccounts

  const handleAddUsage = (): void => {
    if (effectiveManual) {
      const email = manualEmail.trim()
      if (!email) return
      // 手动补录：无 accountId，仅存邮箱
      onAddUsage({ id: '', email })
    } else {
      const acc = accounts.get(pickedId)
      if (!acc) return
      onAddUsage({ id: acc.id, email: acc.email })
    }
    setPickedId('')
    setManualEmail('')
    setPicking(false)
    setExpanded(true)
  }
  const netOpt = CARD_NETWORKS.find((n) => n.value === card.network)
  const netLabel = netOpt ? (isEn ? netOpt.labelEn : netOpt.label) : card.network
  const statusOpt = CARD_STATUSES.find((s) => s.value === card.status)
  const statusLabel = statusOpt ? (isEn ? statusOpt.labelEn : statusOpt.label) : card.status
  const statusColor =
    card.status === 'active'
      ? 'text-green-600 border-green-200'
      : card.status === 'frozen'
        ? 'text-yellow-600 border-yellow-200'
        : 'text-muted-foreground border-border'

  // 年费减免进度
  const waiverText =
    card.feeWaiverSwipes && card.feeWaiverSwipes > 0
      ? `${card.currentSwipes || 0}/${card.feeWaiverSwipes}`
      : null

  return (
    <div
      className={cn(
        'p-4 rounded-lg border',
        card.status === 'closed' ? 'bg-muted/30 opacity-70' : 'bg-card'
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-sm truncate">{card.label}</span>
            <Badge variant="outline" className="text-[10px]">
              {netLabel}
            </Badge>
            <Badge variant="outline" className={cn('text-[10px]', statusColor)}>
              {statusLabel}
            </Badge>
          </div>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground mt-0.5">
            <Building2 className="h-3 w-3" />
            <span className="truncate">{card.bank}</span>
            {card.last4 && <span className="font-mono">•••• {card.last4}</span>}
            {card.expiry && <span className="font-mono">{card.expiry}</span>}
          </div>
        </div>
        <div className="flex gap-1 shrink-0">
          <Button size="sm" variant="ghost" onClick={onEdit}>
            <Edit2 className="h-3.5 w-3.5" />
          </Button>
          <Button size="sm" variant="ghost" className="text-destructive" onClick={onDelete}>
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* 额度使用 */}
      <div className="mt-3">
        <div className="flex justify-between text-xs mb-1">
          <span className="text-muted-foreground">{isEn ? 'Available' : '可用额度'}</span>
          <span className="font-medium">{fmtMoney(avail, card.currency)}</span>
        </div>
        <div className="h-2 rounded-full bg-muted overflow-hidden">
          <div
            className={cn('h-full rounded-full transition-all', utilColor(ratio))}
            style={{ width: `${ratio * 100}%` }}
          />
        </div>
        <div className="flex justify-between text-[11px] text-muted-foreground mt-1">
          <span>
            {isEn ? 'Used' : '已用'} {fmtMoney(card.usedAmount, card.currency)}
          </span>
          <span>
            {isEn ? 'Limit' : '额度'} {fmtMoney(card.creditLimit, card.currency)} ·{' '}
            {(ratio * 100).toFixed(0)}%
          </span>
        </div>
      </div>

      {/* 账单/还款/年费 */}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground mt-2">
        {card.statementDay && (
          <span className="flex items-center gap-1">
            <CalendarClock className="h-3 w-3" />
            {isEn ? 'Statement' : '账单日'} {card.statementDay}
          </span>
        )}
        {card.dueDay && (
          <span className="flex items-center gap-1">
            <CalendarClock className="h-3 w-3" />
            {isEn ? 'Due' : '还款日'} {card.dueDay}
          </span>
        )}
        {typeof card.annualFee === 'number' && card.annualFee > 0 && (
          <span className="flex items-center gap-1">
            {isEn ? 'Annual fee' : '年费'} {fmtMoney(card.annualFee, card.currency)}
            {waiverText && (
              <span className="text-primary">
                ({isEn ? 'waiver' : '减免'} {waiverText})
              </span>
            )}
          </span>
        )}
      </div>

      {ratio >= 0.8 && card.status === 'active' && (
        <div className="flex items-center gap-1 text-[11px] text-red-500 mt-2">
          <AlertTriangle className="h-3 w-3" />
          {isEn ? 'High utilization' : '使用率偏高'}
        </div>
      )}

      {/* 使用记录 */}
      <div className="mt-3 border-t pt-2">
        <div className="flex items-center justify-between">
          <button
            onClick={() => setExpanded((v) => !v)}
            className="flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
            disabled={stats.count === 0}
          >
            <Users className="h-3 w-3" />
            {stats.count === 0
              ? isEn
                ? 'Not used yet'
                : '未记录使用'
              : isEn
                ? `Used ${stats.count} time${stats.count > 1 ? 's' : ''} · ${stats.accounts} account${stats.accounts > 1 ? 's' : ''}`
                : `已用 ${stats.count} 次 · ${stats.accounts} 个账号`}
            {stats.count > 0 && (
              <ChevronDown
                className={cn('h-3 w-3 transition-transform', expanded && 'rotate-180')}
              />
            )}
          </button>
          <button
            onClick={() => setPicking((v) => !v)}
            className="flex items-center gap-1 text-[11px] text-primary hover:underline"
          >
            <Plus className="h-3 w-3" />
            {isEn ? 'Log usage' : '记一笔'}
          </button>
        </div>

        {/* 记一笔：账号选择 / 手动输入邮箱 */}
        {picking && (
          <div className="mt-2 space-y-1.5">
            <div className="flex items-center gap-2">
              <div className="flex-1 min-w-0">
                {effectiveManual ? (
                  <Input
                    value={manualEmail}
                    onChange={(e) => setManualEmail(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleAddUsage()
                    }}
                    placeholder={isEn ? 'Enter account email' : '输入账号邮箱'}
                    className="h-9"
                  />
                ) : (
                  <Select
                    value={pickedId}
                    options={accountOptions}
                    onChange={setPickedId}
                    placeholder={isEn ? 'Select account' : '选择账号'}
                  />
                )}
              </div>
              <Button
                size="sm"
                onClick={handleAddUsage}
                disabled={effectiveManual ? !manualEmail.trim() : !pickedId}
              >
                {isEn ? 'Add' : '添加'}
              </Button>
            </div>
            {/* 模式切换：仅当有现有账号时才显示（无账号时强制手动） */}
            {hasAccounts && (
              <button
                onClick={() => {
                  setManualMode((v) => !v)
                  setPickedId('')
                  setManualEmail('')
                }}
                className="text-[11px] text-muted-foreground hover:text-primary transition-colors"
              >
                {effectiveManual
                  ? isEn
                    ? '← Pick from existing accounts'
                    : '← 从现有账号选择'
                  : isEn
                    ? 'Account deleted? Enter email manually →'
                    : '账号已删除？手动输入邮箱 →'}
              </button>
            )}
          </div>
        )}

        {/* 使用明细 */}
        {expanded && stats.count > 0 && (
          <div className="mt-2 space-y-1">
            {sortedUsages.map((u) => {
              // accountId 存在但账号已不在 store 中 = 账号已删除
              const deleted = !u.accountId || !accounts.has(u.accountId)
              return (
                <div
                  key={u.id}
                  className="flex items-center justify-between gap-2 text-[11px] py-1 px-2 rounded bg-muted/40"
                >
                  <span className="flex items-center gap-1.5 truncate min-w-0">
                    <span className="truncate">{u.accountEmail}</span>
                    {deleted && (
                      <Badge variant="outline" className="text-[9px] shrink-0 opacity-70">
                        {isEn ? 'deleted' : '已删除'}
                      </Badge>
                    )}
                  </span>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-muted-foreground font-mono">{fmtDate(u.at)}</span>
                    <button
                      onClick={() => onRemoveUsage(u.id)}
                      className="text-muted-foreground hover:text-destructive transition-colors"
                      title={isEn ? 'Remove' : '删除'}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {card.note && (
        <p className="text-[11px] text-muted-foreground mt-2 border-t pt-2">{card.note}</p>
      )}
    </div>
  )
}

// ==================== 编辑表单 ====================

function CardEditor({
  editing,
  isEn,
  onChange,
  onCancel,
  onSave
}: {
  editing: Partial<CreditCard>
  isEn: boolean
  onChange: (v: Partial<CreditCard>) => void
  onCancel: () => void
  onSave: () => void
}): React.ReactNode {
  const set = (patch: Partial<CreditCard>): void => onChange({ ...editing, ...patch })
  // 数字输入：空串→undefined，否则转 number
  const num = (s: string): number | undefined => (s === '' ? undefined : Number(s))

  return (
    <Card className="border-primary/40 shadow-lg">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">
          {editing.id ? (isEn ? 'Edit Card' : '编辑信用卡') : isEn ? 'New Card' : '新建信用卡'}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* 基本信息 */}
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label className="text-xs">{isEn ? 'Label *' : '备注名 *'}</Label>
            <Input
              value={editing.label || ''}
              onChange={(e) => set({ label: e.target.value })}
              placeholder={isEn ? 'e.g. CMB Classic' : '例如：招行经典白'}
              className="h-8"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{isEn ? 'Bank *' : '发卡行 *'}</Label>
            <Input
              value={editing.bank || ''}
              onChange={(e) => set({ bank: e.target.value })}
              placeholder={isEn ? 'e.g. CMB' : '例如：招商银行'}
              className="h-8"
            />
          </div>
        </div>

        <div className="space-y-1">
          <Label className="text-xs">{isEn ? 'Network' : '卡组织'}</Label>
          <div className="flex flex-wrap gap-1.5">
            {CARD_NETWORKS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => set({ network: opt.value })}
                className={cn(
                  'px-3 py-1.5 rounded-md border text-xs transition-colors',
                  editing.network === opt.value
                    ? 'border-primary bg-primary/10 text-primary font-medium'
                    : 'border-border hover:border-primary/50'
                )}
              >
                {isEn ? opt.labelEn : opt.label}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <div className="space-y-1">
            <Label className="text-xs">{isEn ? 'Last 4 digits' : '卡号后四位'}</Label>
            <Input
              value={editing.last4 || ''}
              maxLength={4}
              onChange={(e) => set({ last4: e.target.value.replace(/\D/g, '') })}
              placeholder="1234"
              className="h-8 font-mono"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{isEn ? 'Expiry (MM/YY)' : '有效期 (MM/YY)'}</Label>
            <Input
              value={editing.expiry || ''}
              onChange={(e) => set({ expiry: e.target.value })}
              placeholder="12/28"
              className="h-8 font-mono"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{isEn ? 'Holder' : '持卡人'}</Label>
            <Input
              value={editing.holder || ''}
              onChange={(e) => set({ holder: e.target.value })}
              placeholder={isEn ? 'Name' : '姓名'}
              className="h-8"
            />
          </div>
        </div>

        {/* 额度 */}
        <div className="grid grid-cols-3 gap-3">
          <div className="space-y-1">
            <Label className="text-xs">{isEn ? 'Currency' : '币种'}</Label>
            <Input
              value={editing.currency || ''}
              onChange={(e) => set({ currency: e.target.value.toUpperCase() })}
              placeholder="CNY"
              className="h-8"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{isEn ? 'Credit limit' : '信用额度'}</Label>
            <Input
              type="number"
              value={editing.creditLimit ?? ''}
              onChange={(e) => set({ creditLimit: num(e.target.value) })}
              placeholder="50000"
              className="h-8"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{isEn ? 'Used amount' : '已用额度'}</Label>
            <Input
              type="number"
              value={editing.usedAmount ?? ''}
              onChange={(e) => set({ usedAmount: num(e.target.value) })}
              placeholder="0"
              className="h-8"
            />
          </div>
        </div>

        {/* 账单周期 */}
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label className="text-xs">{isEn ? 'Statement day (1-31)' : '账单日 (1-31)'}</Label>
            <Input
              type="number"
              min={1}
              max={31}
              value={editing.statementDay ?? ''}
              onChange={(e) => set({ statementDay: num(e.target.value) })}
              placeholder="5"
              className="h-8"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{isEn ? 'Due day (1-31)' : '还款日 (1-31)'}</Label>
            <Input
              type="number"
              min={1}
              max={31}
              value={editing.dueDay ?? ''}
              onChange={(e) => set({ dueDay: num(e.target.value) })}
              placeholder="25"
              className="h-8"
            />
          </div>
        </div>

        {/* 年费 */}
        <div className="grid grid-cols-3 gap-3">
          <div className="space-y-1">
            <Label className="text-xs">{isEn ? 'Annual fee' : '年费'}</Label>
            <Input
              type="number"
              value={editing.annualFee ?? ''}
              onChange={(e) => set({ annualFee: num(e.target.value) })}
              placeholder="0"
              className="h-8"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{isEn ? 'Waiver swipes' : '免年费刷卡数'}</Label>
            <Input
              type="number"
              value={editing.feeWaiverSwipes ?? ''}
              onChange={(e) => set({ feeWaiverSwipes: num(e.target.value) })}
              placeholder="6"
              className="h-8"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{isEn ? 'Current swipes' : '本期已刷'}</Label>
            <Input
              type="number"
              value={editing.currentSwipes ?? ''}
              onChange={(e) => set({ currentSwipes: num(e.target.value) })}
              placeholder="0"
              className="h-8"
            />
          </div>
        </div>

        {/* 状态 */}
        <div className="space-y-1">
          <Label className="text-xs">{isEn ? 'Status' : '状态'}</Label>
          <div className="flex flex-wrap gap-1.5">
            {CARD_STATUSES.map((opt) => (
              <button
                key={opt.value}
                onClick={() => set({ status: opt.value })}
                className={cn(
                  'px-3 py-1.5 rounded-md border text-xs transition-colors',
                  editing.status === opt.value
                    ? 'border-primary bg-primary/10 text-primary font-medium'
                    : 'border-border hover:border-primary/50'
                )}
              >
                {isEn ? opt.labelEn : opt.label}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-1">
          <Label className="text-xs">{isEn ? 'Note' : '备注'}</Label>
          <textarea
            value={editing.note || ''}
            onChange={(e) => set({ note: e.target.value })}
            rows={2}
            className="w-full px-3 py-2 rounded-md border bg-background text-xs"
            placeholder={isEn ? 'Optional notes...' : '可选备注……'}
          />
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" size="sm" onClick={onCancel}>
            {isEn ? 'Cancel' : '取消'}
          </Button>
          <Button size="sm" onClick={onSave} disabled={!editing.label || !editing.bank}>
            {isEn ? 'Save' : '保存'}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
