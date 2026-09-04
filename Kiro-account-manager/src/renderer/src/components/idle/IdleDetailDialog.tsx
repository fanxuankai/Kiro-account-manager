import { createPortal } from 'react-dom'
import { X, User, CreditCard, Key } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import type { Account } from '@/types/account'
import { cn } from '@/lib/utils'
import { useIdleAccountsStore } from '@/store/idleAccounts'
import { useAccountsStore } from '@/store/accounts'
import { useTranslation } from '@/hooks/useTranslation'
import { getDisplayName, getSubscriptionColor } from '../accounts/_helpers'

interface IdleDetailDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  account: Account | null
}

// 格式化日期
const formatDate = (date: unknown): string => {
  if (!date) return '-'
  try {
    if (typeof date === 'string') return date.split('T')[0]
    if (date instanceof Date) return date.toISOString().split('T')[0]
    return new Date(date as string | number).toISOString().split('T')[0]
  } catch {
    return String(date).split('T')[0]
  }
}

// 格式化完整日期时间
const formatDateTime = (date: unknown): string => {
  if (!date) return '-'
  try {
    const d = typeof date === 'string' ? new Date(date) : date instanceof Date ? date : new Date(date as number)
    return d.toLocaleString('zh-CN', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit'
    })
  } catch {
    return String(date)
  }
}

// 闲置库账号详情：纯只读快照（无刷新数据、无模型拉取、无代理绑定等联网操作）
export function IdleDetailDialog({
  open,
  onOpenChange,
  account
}: IdleDetailDialogProps): React.ReactNode {
  const { maskEmail, maskNickname, privacyMode } = useIdleAccountsStore()
  const usagePrecision = useAccountsStore((s) => s.usagePrecision)
  const { t } = useTranslation()
  const isEn = t('common.unknown') === 'Unknown'

  if (!open || !account) return null

  const usage = account.usage
  const subscription = account.subscription
  const credentials = account.credentials

  // 格式化使用量数值
  const formatUsage = (value: number): string => {
    if (usagePrecision) {
      return value.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })
    }
    return Math.floor(value).toLocaleString()
  }

  // 计算奖励总计
  const bonusTotal = usage.bonuses?.reduce((sum, b) => sum + b.limit, 0) ?? 0
  const bonusUsed = usage.bonuses?.reduce((sum, b) => sum + b.current, 0) ?? 0

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={() => onOpenChange(false)} />

      <div className="relative glass-card-strong rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto m-4 animate-in zoom-in-95 duration-200">
        {/* 头部 */}
        <div className="sticky top-0 z-20 px-6 py-5 border-b border-white/30 dark:border-white/10 bg-gradient-to-br from-primary/[0.08] via-primary/[0.04] to-transparent backdrop-blur-xl flex items-center justify-between">
          <div className="flex items-center gap-4 min-w-0 flex-1">
            <div className="relative w-14 h-14 rounded-2xl bg-gradient-to-br from-[var(--gradient-from)] to-[var(--gradient-to)] flex items-center justify-center shadow-lg shadow-primary/30 shrink-0">
              <User className="h-7 w-7 text-white" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 mb-1.5">
                <span className="font-bold text-lg text-foreground truncate" title={account.email || getDisplayName(account)}>{account.email ? maskEmail(account.email) : getDisplayName(account)}</span>
                <Badge className={cn(getSubscriptionColor(subscription.type, subscription.title), "hover:opacity-90 text-white shadow-md flex-shrink-0 px-2.5")}>
                  {subscription.title || subscription.type}
                </Badge>
              </div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                 <span className="px-2 py-0.5 bg-background/70 backdrop-blur-sm rounded-md font-medium border border-border/50">{account.idp}</span>
                 <span className="opacity-50">·</span>
                 <span>{isEn ? 'Added ' : '添加于 '}{formatDate(account.createdAt)}</span>
              </div>
            </div>
          </div>
          <Button variant="ghost" size="icon" onClick={() => onOpenChange(false)} className="rounded-full hover:bg-red-500 hover:text-white transition-colors shrink-0">
            <X className="h-5 w-5" />
          </Button>
        </div>

        {/* 内容 */}
        <div className="p-6 space-y-8">
          {/* 数据为归档时快照的提示 */}
          <div className="text-xs text-muted-foreground bg-muted/50 border border-border/50 rounded-lg px-3 py-2">
            {isEn
              ? 'All data below is a snapshot taken when the account was archived / imported. Idle accounts are never refreshed automatically.'
              : '以下数据均为归档/导入时的快照，闲置账号不会自动刷新。'}
          </div>

          {/* 配额总览 */}
          <section className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="flex items-center gap-2 font-bold text-base text-foreground">
                <div className="p-1.5 rounded-lg bg-primary/10">
                  <CreditCard className="h-4 w-4 text-primary" />
                </div>
                {isEn ? 'Quota Overview' : '配额总览'}
              </h3>
            </div>

            <div className="bg-gradient-to-br from-primary/[0.04] via-transparent to-primary/[0.04] border border-primary/15 rounded-2xl p-5 space-y-5 shadow-sm">
               {/* 总使用量 */}
               <div>
                 <div className="flex items-end justify-between mb-3">
                   <div className="space-y-1">
                     <div className="text-xs text-muted-foreground font-semibold uppercase tracking-wider">{isEn ? 'Total Usage' : '总使用量'}</div>
                     <div className="flex items-baseline gap-1.5">
                       <span className="text-4xl font-bold tracking-tight bg-gradient-to-br from-[var(--gradient-from)] to-[var(--gradient-to)] bg-clip-text text-transparent">{formatUsage(usage.current)}</span>
                       <span className="text-lg text-muted-foreground font-medium">/ {formatUsage(usage.limit)}</span>
                     </div>
                   </div>
                   <div className={cn(
                     "text-sm font-bold px-3 py-1.5 rounded-full border shadow-sm",
                     usage.percentUsed > 0.9
                       ? "bg-destructive/10 text-destructive border-destructive/30"
                       : "bg-success/10 text-success border-success/30"
                   )}>
                     {(usage.percentUsed * 100).toFixed(usagePrecision ? 2 : 1)}% {isEn ? 'used' : '已使用'}
                   </div>
                 </div>
                 <Progress value={usage.percentUsed * 100} className="h-3 rounded-full" indicatorClassName={usage.percentUsed > 0.9 ? "bg-red-500" : "bg-primary"} />
               </div>

               <div className="grid grid-cols-3 gap-4 pt-2">
                 {/* 主配额 */}
                 <div className="p-4 bg-background/60 backdrop-blur-sm rounded-xl border border-primary/15 hover:border-primary/30 hover:bg-background/80 hover:shadow-md transition-all shadow-sm">
                   <div className="flex items-center gap-2 text-xs font-semibold text-primary mb-2">
                     <div className="w-2 h-2 rounded-full bg-primary shadow-sm shadow-primary/50" />
                     {isEn ? 'Base' : '主配额'}
                   </div>
                   <div className="text-xl font-bold tracking-tight">
                     {formatUsage(usage.baseCurrent ?? 0)} <span className="text-sm text-muted-foreground font-normal">/ {formatUsage(usage.baseLimit ?? 0)}</span>
                   </div>
                   <div className="text-xs text-muted-foreground mt-1 font-medium">
                     {formatDate(usage.nextResetDate)} {isEn ? 'reset' : '重置'}
                   </div>
                 </div>

                 {/* 免费试用 */}
                 <div className={cn("p-4 bg-background/60 backdrop-blur-sm rounded-xl border border-warning/15 hover:border-warning/30 hover:bg-background/80 hover:shadow-md transition-all shadow-sm", (usage.freeTrialLimit ?? 0) === 0 && "opacity-60 grayscale")}>
                   <div className="flex items-center gap-2 text-xs font-semibold text-warning mb-2">
                     <div className="w-2 h-2 rounded-full bg-warning shadow-sm shadow-warning/50" />
                     {isEn ? 'Trial' : '免费试用'}
                     {(usage.freeTrialLimit ?? 0) > 0 && <Badge variant="secondary" className="text-[10px] px-1 h-4 ml-auto">ACTIVE</Badge>}
                   </div>
                   <div className="text-xl font-bold tracking-tight">
                     {formatUsage(usage.freeTrialCurrent ?? 0)} <span className="text-sm text-muted-foreground font-normal">/ {formatUsage(usage.freeTrialLimit ?? 0)}</span>
                   </div>
                   <div className="text-xs text-muted-foreground mt-1 font-medium">
                     {usage.freeTrialExpiry ? `${formatDate(usage.freeTrialExpiry)} ${isEn ? 'expires' : '过期'}` : (isEn ? 'No trial' : '无试用额度')}
                   </div>
                 </div>

                 {/* 奖励总计 */}
                 <div className={cn("p-4 bg-background/60 backdrop-blur-sm rounded-xl border border-success/15 hover:border-success/30 hover:bg-background/80 hover:shadow-md transition-all shadow-sm", bonusTotal === 0 && "opacity-60 grayscale")}>
                   <div className="flex items-center gap-2 text-xs font-semibold text-success mb-2">
                     <div className="w-2 h-2 rounded-full bg-success shadow-sm shadow-success/50" />
                     {isEn ? 'Bonus' : '奖励总计'}
                   </div>
                   <div className="text-xl font-bold tracking-tight">
                     {formatUsage(bonusUsed)} <span className="text-sm text-muted-foreground font-normal">/ {formatUsage(bonusTotal)}</span>
                   </div>
                   <div className="text-xs text-muted-foreground mt-1 font-medium">
                     {isEn ? `${usage.bonuses?.length ?? 0} active` : `${usage.bonuses?.length ?? 0} 个生效奖励`}
                   </div>
                 </div>
               </div>
            </div>
          </section>

          {/* 奖励详情 */}
          {usage.bonuses && usage.bonuses.length > 0 && (
            <section className="space-y-3">
              <h3 className="font-bold text-sm text-muted-foreground uppercase tracking-wider pl-1">{isEn ? 'Active Bonuses' : '生效奖励明细'}</h3>
              <div className="grid grid-cols-1 gap-2">
                {usage.bonuses.map((bonus) => (
                  <div key={bonus.code} className="flex items-center justify-between p-4 bg-background border rounded-xl shadow-sm hover:shadow-md transition-shadow">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-sm">{bonus.name}</span>
                        <Badge variant="outline" className="text-[10px] h-5 px-1.5 text-green-600 border-green-200 bg-green-50">
                          ACTIVE
                        </Badge>
                      </div>
                      <div className="text-xs text-muted-foreground font-mono">
                        Code: {bonus.code} · {formatDateTime(bonus.expiresAt)} 过期
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-sm font-bold">{formatUsage(bonus.current)} <span className="text-muted-foreground font-normal">/ {formatUsage(bonus.limit)}</span></div>
                      <div className="text-[10px] text-blue-600 font-medium">
                         {isEn ? 'Used' : '已用'} {((bonus.current / bonus.limit) * 100).toFixed(usagePrecision ? 2 : 0)}%
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* 基本信息 & 订阅详情 - 并排布局 */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
             {/* 基本信息 */}
             <section className="space-y-3">
               <h3 className="flex items-center gap-2 font-bold text-base text-foreground">
                 <div className="p-1.5 rounded-lg bg-primary/10">
                   <User className="h-4 w-4 text-primary" />
                 </div>
                 {isEn ? 'Basic Info' : '基本信息'}
               </h3>
               <div className="bg-gradient-to-br from-primary/[0.04] to-transparent border border-primary/15 rounded-2xl p-5 space-y-4 shadow-sm">
                 <div className="space-y-1">
                   <label className="text-xs font-medium text-muted-foreground">{isEn ? 'Email/ID' : '邮箱/ID'}</label>
                   <div className="text-sm font-mono break-all select-all">{account.email ? maskEmail(account.email) : getDisplayName(account)}</div>
                 </div>
                 <div className="grid grid-cols-2 gap-4">
                   <div className="space-y-1 min-w-0">
                      <label className="text-xs font-medium text-muted-foreground">{isEn ? 'Nickname' : '账号别名'}</label>
                      <div className="text-sm font-medium truncate" title={account.nickname || '-'}>{maskNickname(account.nickname) || '-'}</div>
                   </div>
                   <div className="space-y-1">
                      <label className="text-xs font-medium text-muted-foreground">{isEn ? 'Provider' : '身份提供商'}</label>
                      <div className="text-sm font-medium">{account.idp}</div>
                   </div>
                 </div>
                 <div className="space-y-1">
                    <label className="text-xs font-medium text-muted-foreground">{isEn ? 'User ID' : '用户 ID'}</label>
                    <div className="text-xs font-mono break-all bg-primary/[0.06] px-3 py-2 rounded-lg border border-primary/15 select-all text-foreground/80">{privacyMode ? '********' : (account.userId || '-')}</div>
                 </div>
                 <div className="space-y-1">
                    <label className="text-xs font-medium text-muted-foreground">{isEn ? 'Archived At' : '入库时间'}</label>
                    <div className="text-xs font-mono text-foreground/80">{formatDateTime(account.createdAt)}</div>
                 </div>
               </div>
             </section>

             {/* 订阅详情 */}
             <section className="space-y-3">
               <h3 className="flex items-center gap-2 font-bold text-base text-foreground">
                 <div className="p-1.5 rounded-lg bg-primary/10">
                   <Key className="h-4 w-4 text-primary" />
                 </div>
                 {isEn ? 'Subscription' : '订阅详情'}
               </h3>
               <div className="bg-gradient-to-br from-primary/[0.04] to-transparent border border-primary/15 rounded-2xl p-5 text-sm space-y-3 shadow-sm">
                 <div className="flex justify-between items-center py-1 border-b border-primary/10 last:border-0">
                   <span className="text-muted-foreground text-xs">Region</span>
                   <Badge variant="outline" className="font-mono">{credentials.region || 'us-east-1'}</Badge>
                 </div>
                 <div className="flex justify-between items-center py-1 border-b border-primary/10 last:border-0">
                   <span className="text-muted-foreground text-xs">{isEn ? 'Token Expires' : 'Token 到期'}</span>
                   <span className="font-medium text-xs">{credentials.expiresAt ? formatDateTime(credentials.expiresAt) : '-'}</span>
                 </div>
                 <div className="flex justify-between items-center py-1 border-b border-primary/10 last:border-0">
                   <span className="text-muted-foreground text-xs">{isEn ? 'Plan Type' : '订阅类型'}</span>
                   <span className="font-mono text-xs" title={subscription.rawType}>{subscription.rawType || '-'}</span>
                 </div>
                 <div className="flex justify-between items-center py-1 border-b border-primary/10 last:border-0">
                   <span className="text-muted-foreground text-xs">{isEn ? 'Overage Rate' : '超额费率'}</span>
                   <span className="font-mono text-xs">
                     {usage.resourceDetail?.overageRate
                       ? `$${usage.resourceDetail.overageRate}/${usage.resourceDetail.unit || 'INV'}`
                       : '-'}
                   </span>
                 </div>
                 <div className="flex justify-between items-center py-1 border-b border-primary/10 last:border-0">
                   <span className="text-muted-foreground text-xs">{isEn ? 'Resource Type' : '资源类型'}</span>
                   <span className="font-mono text-xs">{usage.resourceDetail?.resourceType || '-'}</span>
                 </div>
                 <div className="flex justify-between items-center py-1">
                   <span className="text-muted-foreground text-xs">{isEn ? 'Upgradable' : '可升级'}</span>
                   <Badge variant="outline" className={cn("text-[10px] px-2 h-5 font-bold", subscription.upgradeCapability === 'UPGRADE_CAPABLE' ? "bg-success/10 text-success border-success/30" : "bg-muted text-muted-foreground border-border")}>
                      {subscription.upgradeCapability === 'UPGRADE_CAPABLE' ? 'YES' : 'NO'}
                   </Badge>
                 </div>
               </div>
             </section>
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}
