import { memo, useState, useMemo } from 'react'
import { Card, CardContent, Badge, Button } from '../ui'
import { useIdleAccountsStore } from '@/store/idleAccounts'
import { useAccountsStore } from '@/store/accounts'
import { useTranslation } from '@/hooks/useTranslation'
import type { Account, AccountTag, AccountGroup } from '@/types/account'
import {
  toRgba,
  generateGlowStyle,
  getSubscriptionColor,
  StatusLabelsZh,
  StatusLabelsEn,
  getDisplayName,
  formatTokenExpiry,
  formatDateSafe,
  isBannedError
} from '../accounts/_helpers'
import {
  Check,
  Trash2,
  Edit,
  Copy,
  Clock,
  Info,
  FolderOpen,
  Calendar,
  AlertCircle,
  KeyRound,
  AlertTriangle,
  Undo2
} from 'lucide-react'
import { cn } from '@/lib/utils'

interface IdleCardProps {
  account: Account
  tags: Map<string, AccountTag>
  groups: Map<string, AccountGroup>
  isSelected: boolean
  onSelect: () => void
  onEdit: () => void
  onShowDetail: () => void
  /** 移回账号管理（主库） */
  onRestore: () => void
}

// 闲置库卡片：与账号管理卡片视觉一致，但不含任何联网操作
// （不刷新 Token、不检查状态、不切账号、不管订阅、不绑代理）
export const IdleCard = memo(function IdleCard({
  account,
  tags,
  groups,
  isSelected,
  onSelect,
  onEdit,
  onShowDetail,
  onRestore
}: IdleCardProps) {
  const {
    removeAccount,
    toggleSelection,
    maskEmail,
    maskNickname
  } = useIdleAccountsStore()
  // 用量精度等全局设置沿用主库配置
  const usagePrecision = useAccountsStore((s) => s.usagePrecision)

  const { t } = useTranslation()
  const isEn = t('common.unknown') === 'Unknown'

  const handleDelete = (): void => {
    if (confirm(isEn ? `Delete account ${getDisplayName(account)}?` : `确定要删除账号 ${getDisplayName(account)} 吗？`)) {
      removeAccount(account.id)
    }
  }

  const [copied, setCopied] = useState(false)
  const [emailCopied, setEmailCopied] = useState(false)

  const handleCopyCredentials = (): void => {
    const credentials = {
      accessToken: account.credentials.accessToken,
      refreshToken: account.credentials.refreshToken,
      clientId: account.credentials.clientId,
      clientSecret: account.credentials.clientSecret
    }
    navigator.clipboard.writeText(JSON.stringify(credentials, null, 2))
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  // 过滤掉闲置库中不存在的标签引用（跨库移动残留）
  const accountTags = account.tags
    .map((id) => tags.get(id))
    .filter((t): t is AccountTag => t !== undefined)

  // 分组引用在闲置库中不存在时显示为未分组
  const accountGroup = account.groupId ? groups.get(account.groupId) : undefined

  // 生成光环样式
  const glowStyle = useMemo(() => {
    const tagColors = accountTags.map(t => t.color)
    return generateGlowStyle(tagColors)
  }, [accountTags])

  const isExpiringSoon = account.subscription.daysRemaining !== undefined &&
                         account.subscription.daysRemaining <= 7

  // percentUsed 是 0~1 的小数（如 0.85 = 85%），超 1 表示 >100%
  const isHighUsage = account.usage.percentUsed > 0.8
  const isCritical = account.usage.percentUsed > 1

  // 封禁状态仅为归档时的快照标记（只读展示）
  const isUnauthorized = isBannedError(account.lastError)

  // 格式化使用量数值
  const formatUsage = (value: number): string => {
    if (usagePrecision) {
      return value.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })
    }
    return Math.floor(value).toLocaleString()
  }

  // 最终样式：普通状态只显示标签光环；封禁快照显示红色样式
  const finalStyle: React.CSSProperties = isUnauthorized
    ? {
        backgroundColor: 'var(--card-unauthorized-bg)',
        borderColor: 'var(--card-unauthorized-border)',
        boxShadow: `
          0 0 0 1px var(--card-unauthorized-ring),
          0 4px 20px -2px var(--card-unauthorized-shadow),
          inset 0 0 20px var(--card-unauthorized-glow)
        `
      }
    : glowStyle

  return (
    <Card
      className={cn(
        'relative cursor-pointer h-full flex flex-col overflow-hidden bg-solid-card',
        !isUnauthorized && 'hover-lift',
        isUnauthorized && 'border-destructive/50',
        accountTags.length > 0 && !isUnauthorized && 'border-transparent'
      )}
      style={finalStyle}
      onClick={() => toggleSelection(account.id)}
    >
      {/* 选中态独立覆盖层 — 避免被标签光环的 inline style (box-shadow/background) 覆盖 */}
      {isSelected && !isUnauthorized && (
        <div className="absolute inset-0 pointer-events-none rounded-[inherit] ring-2 ring-inset ring-primary/60 bg-primary/[0.08] z-10" />
      )}

      <CardContent className="p-4 flex-1 flex flex-col gap-3 overflow-hidden">
        {/* Header: Checkbox, Email/Nickname, Group */}
        <div className="flex gap-3 items-start">
           {/* Checkbox */}
           <div
            className={cn(
              'w-5 h-5 rounded border-2 flex items-center justify-center transition-colors flex-shrink-0 mt-0.5 cursor-pointer',
              isSelected
                ? 'bg-primary border-primary text-primary-foreground'
                : 'border-muted-foreground/30 hover:border-primary'
            )}
            onClick={(e) => {
              e.stopPropagation()
              onSelect()
            }}
          >
            {isSelected && <Check className="h-3.5 w-3.5" />}
          </div>

           <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between gap-2">
                 <h3
                   className={cn(
                     "font-semibold text-sm truncate cursor-pointer transition-colors",
                     emailCopied ? "text-success" : "text-foreground/90 hover:text-primary"
                   )}
                   title={`${getDisplayName(account)} (${isEn ? 'Click to copy' : '点击复制'})`}
                   onClick={(e) => {
                     e.stopPropagation()
                     const text = account.email || account.userId || ''
                     if (text) {
                       navigator.clipboard.writeText(text)
                       setEmailCopied(true)
                       setTimeout(() => setEmailCopied(false), 1500)
                     }
                   }}
                 >{emailCopied ? (isEn ? 'Copied!' : '已复制!') : (account.email ? maskEmail(account.email) : getDisplayName(account))}</h3>
                 {/* Status Badge（归档时的快照） */}
                 <div className={cn(
                    "text-[10px] font-medium px-2 py-0.5 rounded-full flex items-center gap-1 flex-shrink-0",
                    isUnauthorized ? "text-destructive bg-destructive/10" :
                    account.status === 'active' ? "text-success bg-success/10" :
                    account.status === 'error' ? "text-destructive bg-destructive/10" :
                    account.status === 'expired' ? "text-warning bg-warning/10" :
                    "text-muted-foreground bg-muted"
                 )}>
                    {isUnauthorized && <AlertCircle className="h-3 w-3" />}
                    {isUnauthorized
                      ? (isEn ? 'Banned' : '已封禁')
                      : (isEn ? StatusLabelsEn : StatusLabelsZh)[account.status]}
                 </div>
              </div>
              <div className="flex items-center gap-2 mt-1">
                  {account.nickname && <span className="text-xs text-muted-foreground truncate">{maskNickname(account.nickname)}</span>}
                  {accountGroup && (
                    <span
                      className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground flex items-center gap-1"
                      style={{ color: accountGroup.color, backgroundColor: accountGroup.color + '15' }}
                    >
                      <FolderOpen className="w-3 h-3" /> {accountGroup.name}
                    </span>
                  )}
              </div>
           </div>
        </div>

        {/* Badges Row */}
        <div className="flex items-center gap-2 flex-wrap">
            <Badge
              className={cn(
                'text-white text-[10px] h-5 px-2 border-0',
                getSubscriptionColor(account.subscription.type, account.subscription.title)
              )}
              title={isEn ? 'Subscription snapshot when archived (offline)' : '归档时的订阅快照（离线）'}
            >
              {account.subscription.title || account.subscription.type}
            </Badge>
            <Badge variant="outline" className="text-[10px] h-5 px-2 text-muted-foreground font-normal border-muted-foreground/30 bg-muted/30">
                {account.idp}
            </Badge>
            {/* 用量已超额（本地快照） */}
            {isCritical && (
              <Badge
                variant="outline"
                className="text-[10px] h-5 px-1.5 font-medium border-red-500/40 text-red-600 dark:text-red-400 bg-red-500/10"
                title={isEn ? 'Usage exceeds plan quota (snapshot)' : '用量已超过套餐额度（快照）'}
              >
                {isEn ? 'Over Quota' : '已超额'}
              </Badge>
            )}
            {/* 闲置库标记 */}
            <Badge variant="outline" className="text-[10px] h-5 px-1.5 font-normal border-muted-foreground/30 text-muted-foreground bg-muted/30 ml-auto">
              {isEn ? 'Idle' : '闲置'}
            </Badge>
        </div>

        {/* Usage Section（归档时的快照） */}
        <div className="bg-muted/30 p-3 rounded-lg space-y-2 border border-border/50">
            <div className="flex justify-between items-end text-xs">
                <span className="text-muted-foreground font-medium">{isEn ? 'Usage (snapshot)' : '使用量（快照）'}</span>
                <span className={cn(
                  "font-mono font-medium tabular-nums",
                  isCritical ? "text-destructive" : isHighUsage ? "text-warning" : "text-foreground"
                )}>
                   {(account.usage.percentUsed * 100).toFixed(usagePrecision ? 2 : 0)}%
                   {isCritical && (
                     <span className="ml-1.5 text-[10px] text-red-600 font-semibold">
                       (+{((account.usage.percentUsed - 1) * 100).toFixed(usagePrecision ? 2 : 0)}% {isEn ? 'over' : '超'})
                     </span>
                   )}
                </span>
            </div>
            {(() => {
              const percent = account.usage.percentUsed
              if (isCritical) {
                const planRatioPct = (1 / percent) * 100
                return (
                  <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-foreground/10">
                    <div
                      className="absolute inset-y-0 left-0 bg-warning transition-all duration-300"
                      style={{ width: `${planRatioPct}%` }}
                    />
                    <div
                      className="absolute inset-y-0 right-0 bg-red-500 transition-all duration-300"
                      style={{ left: `${planRatioPct}%` }}
                    />
                  </div>
                )
              }
              return (
                <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-foreground/10">
                  <div
                    className={cn(
                      "absolute inset-y-0 left-0 transition-all duration-300",
                      isHighUsage ? "bg-warning" : "bg-primary"
                    )}
                    style={{ width: `${Math.min(percent * 100, 100)}%` }}
                  />
                </div>
              )
            })()}
            <div className="flex justify-between text-[10px] text-muted-foreground pt-0.5">
                <span className="flex items-center gap-1.5">
                  <span>{formatUsage(account.usage.current)} / {formatUsage(account.usage.limit)}</span>
                  {isCritical && (
                    <span className="text-red-600 font-semibold">
                      (+{formatUsage(account.usage.current - account.usage.limit)})
                    </span>
                  )}
                </span>
                {account.usage.nextResetDate && (
                  <span className="flex items-center gap-1">
                    <Calendar className="h-3 w-3" />
                    {formatDateSafe(account.usage.nextResetDate)} {isEn ? 'reset' : '重置'}
                  </span>
                )}
            </div>
        </div>

        {/* Detailed Quotas - Compact list（快照） */}
        <div className="space-y-1.5 min-h-0 overflow-y-auto pr-1 text-[10px] max-h-24">
           {account.usage.baseLimit !== undefined && account.usage.baseLimit > 0 && (
             <div className="flex items-center gap-2">
               <div className="w-1.5 h-1.5 rounded-full bg-primary flex-shrink-0" />
               <span className="text-muted-foreground">{isEn ? 'Base:' : '基础:'}</span>
               <span className="font-medium">{formatUsage(account.usage.baseCurrent ?? 0)}/{formatUsage(account.usage.baseLimit)}</span>
             </div>
           )}
           {account.usage.freeTrialLimit !== undefined && account.usage.freeTrialLimit > 0 && (
             <div className="flex items-center gap-2">
               <div className="w-1.5 h-1.5 rounded-full bg-warning flex-shrink-0" />
               <span className="text-muted-foreground">{isEn ? 'Trial:' : '试用:'}</span>
               <span className="font-medium">{formatUsage(account.usage.freeTrialCurrent ?? 0)}/{formatUsage(account.usage.freeTrialLimit)}</span>
             </div>
           )}
           {account.usage.bonuses?.map((bonus) => (
             <div key={bonus.code} className="flex items-center gap-2">
               <div className="w-1.5 h-1.5 rounded-full bg-success flex-shrink-0" />
               <span className="text-muted-foreground truncate max-w-[80px]" title={bonus.name}>{bonus.name}:</span>
               <span className="font-medium">{formatUsage(bonus.current)}/{formatUsage(bonus.limit)}</span>
             </div>
           ))}
        </div>

        {/* Tags */}
        {accountTags.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-auto pt-2">
            {accountTags.slice(0, 4).map((tag) => (
              <span
                key={tag.id}
                className="px-1.5 py-0.5 text-[10px] rounded-sm text-white font-medium shadow-sm"
                style={{ backgroundColor: toRgba(tag.color) }}
              >
                {tag.name}
              </span>
            ))}
             {accountTags.length > 4 && (
              <span className="px-1.5 py-0.5 text-[10px] text-muted-foreground bg-muted rounded-sm">
                +{accountTags.length - 4}
              </span>
            )}
          </div>
        )}

        {/* Footer Actions */}
        <div className="pt-3 border-t flex items-center justify-between mt-auto gap-2 shrink-0">
            {/* Left: Token expiry info（快照） */}
            <div className="text-[10px] text-muted-foreground flex flex-col leading-tight gap-0.5">
                <div className="flex items-center gap-1">
                   <Clock className="h-3 w-3" />
                   <span className={isExpiringSoon ? "text-warning font-medium" : ""}>
                      {account.subscription.daysRemaining !== undefined ? (isEn ? `${account.subscription.daysRemaining}d left` : `剩 ${account.subscription.daysRemaining} 天`) : '-'}
                   </span>
                </div>
                <div className="flex items-center gap-1" title={account.credentials.expiresAt ? new Date(account.credentials.expiresAt).toLocaleString(isEn ? 'en-US' : 'zh-CN') : (isEn ? 'Unknown' : '未知')}>
                   <KeyRound className="h-3 w-3" />
                   <span className={account.credentials.expiresAt && account.credentials.expiresAt - Date.now() < 5 * 60 * 1000 ? "text-red-500 font-medium" : ""}>
                      Token: {account.credentials.expiresAt ? formatTokenExpiry(account.credentials.expiresAt, isEn) : '-'}
                   </span>
                </div>
            </div>

            {/* Right: Actions */}
            <div className="flex items-center gap-0.5">
               <Button
                 size="icon"
                 variant="ghost"
                 className="h-7 w-7 hover:bg-primary/10 hover:text-primary transition-colors"
                 onClick={(e) => { e.stopPropagation(); onRestore() }}
                 title={isEn ? 'Restore to Account Manager' : '移回账号管理'}
               >
                  <Undo2 className="h-3.5 w-3.5" />
               </Button>

               <Button size="icon" variant="ghost" className={cn("h-7 w-7 text-muted-foreground hover:text-foreground", copied && "text-success")} onClick={(e) => { e.stopPropagation(); handleCopyCredentials() }} title={isEn ? 'Copy credentials' : '复制凭证'}>
                  {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
               </Button>

               <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground hover:text-foreground" onClick={(e) => { e.stopPropagation(); onShowDetail() }} title={isEn ? 'Details' : '详情'}>
                  <Info className="h-3.5 w-3.5" />
               </Button>

               <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground hover:text-foreground" onClick={(e) => { e.stopPropagation(); onEdit() }} title={isEn ? 'Edit' : '编辑'}>
                  <Edit className="h-3.5 w-3.5" />
               </Button>

               <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground hover:text-destructive transition-colors" onClick={(e) => { e.stopPropagation(); handleDelete() }} title={isEn ? 'Delete' : '删除'}>
                  <Trash2 className="h-3.5 w-3.5" />
               </Button>
            </div>
        </div>

        {/* Error Message (Non-banned) */}
        {account.lastError && !isUnauthorized && (
          <div className="bg-red-50 text-red-600 text-[10px] p-1.5 rounded flex items-center gap-1.5 truncate mt-1" title={account.lastError}>
             <AlertTriangle className="h-3 w-3 shrink-0" />
             <span className="truncate">{account.lastError}</span>
          </div>
        )}
      </CardContent>
    </Card>
  )
})
