import { memo, useState, useMemo, useCallback } from 'react'
import { useIdleAccountsStore } from '@/store/idleAccounts'
import { useAccountsStore } from '@/store/accounts'
import { useTranslation } from '@/hooks/useTranslation'
import { Badge, Button } from '../ui'
import type { Account, AccountTag, AccountGroup } from '@/types/account'
import {
  Check,
  Trash2,
  Edit,
  Info,
  AlertCircle,
  Archive,
  Clock,
  KeyRound,
  FolderOpen,
  Copy,
  Undo2
} from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  toRgba,
  generateRowGlowStyle,
  unauthorizedRowStyle,
  getSubscriptionColor,
  getStatusBadgeClass,
  StatusLabelsZh,
  StatusLabelsEn,
  formatTokenExpiry,
  tokenExpiryLevel,
  isBannedError
} from '../accounts/_helpers'

interface IdleListRowProps {
  account: Account
  tags: Map<string, AccountTag>
  groups: Map<string, AccountGroup>
  isSelected: boolean
  onEdit: () => void
  onShowDetail: () => void
  /** 移回账号管理（主库） */
  onRestore: () => void
}

// 闲置库紧凑列表行 — 视觉对齐 AccountListRow，但不含任何联网操作
function IdleListRowComponent({
  account,
  tags,
  groups,
  isSelected,
  onEdit,
  onShowDetail,
  onRestore
}: IdleListRowProps): React.ReactNode {
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

  const [emailCopied, setEmailCopied] = useState(false)

  // 封禁判定（归档时的快照标记）
  const isUnauthorized = isBannedError(account.lastError)

  // 标签（过滤掉闲置库中不存在的引用）
  const accountTags = useMemo(
    () => (account.tags || []).map(id => tags.get(id)).filter((t): t is AccountTag => !!t),
    [account.tags, tags]
  )
  const tagColors = useMemo(() => accountTags.map(t => t.color), [accountTags])

  // 分组（引用不存在时显示为未分组）
  const accountGroup = useMemo(() => {
    if (!account.groupId) return null
    return groups.get(account.groupId) || null
  }, [account.groupId, groups])

  // 显示名（昵称优先 + 隐私模式 mask）
  const displayName = useMemo(() => {
    if (account.nickname) return maskNickname(account.nickname)
    return maskEmail(account.email)
  }, [account.nickname, account.email, maskEmail, maskNickname])

  const maskedEmail = useMemo(() => maskEmail(account.email), [account.email, maskEmail])

  // Credits
  const formatUsage = (value: number): string => {
    if (usagePrecision) {
      return value.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })
    }
    return Math.floor(value).toLocaleString()
  }
  const percentUsed = account.usage.percentUsed * 100
  const isHighUsage = percentUsed > 80
  const isCritical = percentUsed > 100

  // 到期
  const daysRemaining = account.subscription.daysRemaining
  const isExpiringSoon = daysRemaining !== undefined && daysRemaining <= 7
  const isTokenExpiringSoon =
    account.credentials.expiresAt !== undefined &&
    account.credentials.expiresAt - Date.now() < 5 * 60 * 1000

  // 行外层样式：封禁红色 > 标签光晕
  const rowStyle = useMemo(() => {
    if (isUnauthorized) return unauthorizedRowStyle
    if (tagColors.length > 0) return generateRowGlowStyle(tagColors)
    return {}
  }, [isUnauthorized, tagColors])

  // === Handlers ===
  const handleDelete = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    if (!confirm(isEn ? `Delete account "${account.email}"?` : `确定删除账号 "${account.email}"？`)) return
    removeAccount(account.id)
  }, [account.id, account.email, isEn, removeAccount])

  const handleCopyEmail = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    const text = account.email || account.userId || ''
    if (text) {
      navigator.clipboard.writeText(text)
      setEmailCopied(true)
      setTimeout(() => setEmailCopied(false), 1500)
    }
  }, [account.email, account.userId])

  // ============ 渲染 ============

  return (
    <div
      className={cn(
        'group relative flex items-center gap-3 pl-3 pr-3 py-2.5 rounded-xl border bg-solid-card transition-all duration-300 cursor-pointer overflow-hidden',
        'hover:shadow-md',
        !isUnauthorized && tagColors.length === 0 && !isSelected && 'border-border'
      )}
      style={rowStyle}
      onClick={() => toggleSelection(account.id)}
    >
      {/* 选中态独立覆盖层 — 避免被多标签 rowStyle 的 backgroundImage 覆盖 */}
      {isSelected && !isUnauthorized && (
        <div className="absolute inset-0 pointer-events-none rounded-[inherit] ring-2 ring-inset ring-primary/60 bg-primary/[0.08] z-10" />
      )}

      {/* Checkbox */}
      <div
        className={cn(
          'flex-shrink-0 w-4 h-4 rounded border-2 flex items-center justify-center transition-colors cursor-pointer',
          isSelected
            ? 'bg-primary border-primary text-primary-foreground'
            : 'border-muted-foreground/30 hover:border-primary'
        )}
        onClick={(e) => { e.stopPropagation(); toggleSelection(account.id) }}
      >
        {isSelected && <Check className="h-3 w-3" />}
      </div>

      {/* === 邮箱列（固定 280px） === */}
      <div className="w-[280px] flex-shrink-0 flex flex-col gap-1 min-w-0">
        {/* 上行：邮箱/昵称 + 副邮箱 */}
        <div className="flex items-center gap-2 min-w-0">
          <h3
            className={cn(
              'font-semibold text-sm truncate cursor-pointer transition-colors min-w-0',
              emailCopied ? 'text-success' : 'text-foreground/90 hover:text-primary'
            )}
            title={`${displayName} (${isEn ? 'Click to copy' : '点击复制'})`}
            onClick={handleCopyEmail}
          >
            {emailCopied ? (isEn ? 'Copied!' : '已复制!') : displayName}
          </h3>
          {account.nickname && (
            <span className="text-xs text-muted-foreground truncate min-w-0" title={account.email}>
              {maskedEmail}
            </span>
          )}
        </div>

        {/* 下行：分组 + 标签 + 错误 + 复制 */}
        <div className="flex items-center gap-1.5 min-w-0 text-[10px] overflow-hidden">
          {accountGroup && (
            <span
              className="px-1.5 py-0.5 rounded flex items-center gap-1 flex-shrink-0"
              style={{ color: accountGroup.color, backgroundColor: accountGroup.color + '15' }}
            >
              <FolderOpen className="w-3 h-3" />
              {accountGroup.name}
            </span>
          )}
          {accountTags.slice(0, 4).map(tag => {
            const tagColor = toRgba(tag.color)
            return (
              <span
                key={tag.id}
                className="px-1.5 py-0.5 rounded-md font-medium flex-shrink-0 border"
                style={{
                  backgroundColor: tagColor.replace(/[\d.]+\)$/, '0.12)'),
                  color: tagColor,
                  borderColor: tagColor.replace(/[\d.]+\)$/, '0.30)')
                }}
              >
                {tag.name}
              </span>
            )
          })}
          {accountTags.length > 4 && (
            <span className="px-1.5 py-0.5 text-muted-foreground bg-muted rounded-sm flex-shrink-0">
              +{accountTags.length - 4}
            </span>
          )}

          {/* 错误信息（非封禁，因为封禁已用红色徽章显示） */}
          {account.lastError && !isUnauthorized && (
            <span className="text-destructive truncate flex-1 min-w-0 italic" title={account.lastError}>
              {account.lastError}
            </span>
          )}

          {/* 复制邮箱小图标 */}
          {!account.nickname && (
            <button
              type="button"
              onClick={handleCopyEmail}
              className="ml-auto text-muted-foreground/60 hover:text-primary transition-colors flex-shrink-0"
              title={isEn ? 'Copy email' : '复制邮箱'}
            >
              <Copy className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>

      {/* === 徽章固定列（紧贴邮箱列，每个徽章等宽确保跨行对齐） === */}
      <div className="flex-shrink-0 flex items-center gap-1.5">
        {/* 状态徽章（min-w 保持等宽） */}
        <div
          className={cn(
            'text-[10px] font-medium h-5 px-2 rounded-full flex items-center justify-center gap-1 min-w-[52px]',
            getStatusBadgeClass(account.status, isUnauthorized)
          )}
        >
          {isUnauthorized && <AlertCircle className="h-3 w-3" />}
          {isUnauthorized ? (
            <span
              className="cursor-pointer hover:underline"
              onClick={(e) => { e.stopPropagation(); onShowDetail() }}
            >
              {isEn ? 'Banned' : '已封禁'}
            </span>
          ) : (
            (isEn ? StatusLabelsEn : StatusLabelsZh)[account.status] || account.status
          )}
        </div>

        {/* 订阅徽章（归档快照，min-w 保持等宽） */}
        <Badge
          className={cn(
            'text-white text-[10px] h-5 px-2 border-0 min-w-[90px] flex items-center justify-center',
            getSubscriptionColor(account.subscription.type, account.subscription.title)
          )}
        >
          {account.subscription.title || account.subscription.type}
        </Badge>

        {/* IDP（固定宽度，所有账号视觉对齐） */}
        <Badge
          variant="outline"
          className="text-[10px] h-5 px-1.5 text-muted-foreground font-normal border-muted-foreground/30 bg-muted/30 min-w-[72px] flex items-center justify-center"
        >
          {account.idp}
        </Badge>

        {/* Token 剩余时间（归档快照：正常灰 / 半小时内橙 / 过期红） */}
        {account.credentials.expiresAt ? (() => {
          const level = tokenExpiryLevel(account.credentials.expiresAt)
          const leftText = formatTokenExpiry(account.credentials.expiresAt, isEn)
          return (
            <Badge
              variant="outline"
              className={cn(
                'text-[10px] h-5 px-1.5 font-normal min-w-[64px] flex items-center justify-center',
                level === 'expired' && 'border-red-500/40 text-red-600 dark:text-red-400 bg-red-500/10',
                level === 'soon' && 'border-amber-500/40 text-amber-700 dark:text-amber-300 bg-amber-500/10'
              )}
              title={isEn
                ? `Access token expires: ${new Date(account.credentials.expiresAt).toLocaleString()} (${leftText})`
                : `访问令牌到期：${new Date(account.credentials.expiresAt).toLocaleString()}（${leftText}）`}
            >
              {leftText}
            </Badge>
          )
        })() : null}

        {/* 用量已超额（快照） */}
        {isCritical && (
          <Badge
            variant="outline"
            className="text-[10px] h-5 px-1.5 font-medium border-red-500/40 text-red-600 dark:text-red-400 bg-red-500/10"
            title={isEn ? 'Usage exceeds plan quota (snapshot)' : '用量已超过套餐额度（快照）'}
          >
            {isEn ? 'Over' : '已超额'}
          </Badge>
        )}

        {/* 闲置徽章容器（固定宽度，与主列表 Active 容器对齐） */}
        <div className="w-[60px] flex items-center">
          <Badge className="h-5 px-2 bg-muted text-muted-foreground border-0 text-[10px] flex items-center justify-center w-full">
            <Archive className="h-2.5 w-2.5 mr-0.5" />
            {isEn ? 'Idle' : '闲置'}
          </Badge>
        </div>
      </div>

      {/* === 弹性间隔（吃剩余空间） === */}
      <div className="flex-1 min-w-0" />

      {/* === Credits 区（中右，快照） === */}
      <div className="flex-shrink-0 w-40 flex flex-col gap-0.5 px-2">
        <div className="flex items-center justify-between text-[10px]">
          <span className="text-muted-foreground">{isEn ? 'Usage' : '使用量'}</span>
          <span className={cn(
            'font-mono font-medium tabular-nums',
            isCritical ? 'text-destructive' : isHighUsage ? 'text-warning' : 'text-foreground'
          )}>
            {percentUsed.toFixed(usagePrecision ? 2 : 0)}%
            {isCritical && (
              <span className="ml-1 text-[9px] text-destructive font-semibold">
                +{(percentUsed - 100).toFixed(usagePrecision ? 2 : 0)}%
              </span>
            )}
          </span>
        </div>
        {(() => {
          if (isCritical) {
            const planRatioPct = (100 / percentUsed) * 100
            return (
              <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-foreground/10">
                <div className="absolute inset-y-0 left-0 bg-warning transition-all duration-300" style={{ width: `${planRatioPct}%` }} />
                <div className="absolute inset-y-0 right-0 bg-destructive transition-all duration-300" style={{ left: `${planRatioPct}%` }} />
              </div>
            )
          }
          return (
            <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-foreground/10">
              <div
                className={cn('absolute inset-y-0 left-0 transition-all duration-300', isHighUsage ? 'bg-warning' : 'bg-primary')}
                style={{ width: `${Math.min(percentUsed, 100)}%` }}
              />
            </div>
          )
        })()}
        <div className="flex justify-between text-[9px] text-muted-foreground pt-0.5">
          <span className={cn(isCritical && 'text-destructive font-semibold')}>
            {formatUsage(account.usage.current)}
            {isCritical && ` (+${formatUsage(account.usage.current - account.usage.limit)})`}
          </span>
          <span>/ {formatUsage(account.usage.limit)}</span>
        </div>
      </div>

      {/* === 时间信息区 === */}
      <div className="flex-shrink-0 hidden lg:flex flex-col leading-tight gap-0.5 text-[10px] text-muted-foreground w-28">
        <div className="flex items-center gap-1" title={isEn ? 'Subscription days left' : '订阅剩余天数'}>
          <Clock className="h-3 w-3" />
          <span className={isExpiringSoon ? 'text-warning font-medium' : ''}>
            {daysRemaining !== undefined ? (isEn ? `${daysRemaining}d` : `${daysRemaining}天`) : '-'}
          </span>
        </div>
        <div
          className="flex items-center gap-1"
          title={account.credentials.expiresAt
            ? new Date(account.credentials.expiresAt).toLocaleString(isEn ? 'en-US' : 'zh-CN')
            : (isEn ? 'Unknown' : '未知')
          }
        >
          <KeyRound className="h-3 w-3" />
          <span className={isTokenExpiringSoon ? 'text-destructive font-medium' : ''}>
            {account.credentials.expiresAt ? formatTokenExpiry(account.credentials.expiresAt, isEn) : '-'}
          </span>
        </div>
      </div>

      {/* === 操作区（hover 显示） === */}
      <div className="flex-shrink-0 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity duration-200 border-l border-border/40 pl-2 ml-1">
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7 hover:bg-primary/10 hover:text-primary"
          onClick={(e) => { e.stopPropagation(); onRestore() }}
          title={isEn ? 'Restore to Account Manager' : '移回账号管理'}
        >
          <Undo2 className="h-3.5 w-3.5" />
        </Button>

        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7 text-muted-foreground hover:text-foreground"
          onClick={(e) => { e.stopPropagation(); onShowDetail() }}
          title={isEn ? 'Details' : '详情'}
        >
          <Info className="h-3.5 w-3.5" />
        </Button>

        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7 text-muted-foreground hover:text-foreground"
          onClick={(e) => { e.stopPropagation(); onEdit() }}
          title={isEn ? 'Edit' : '编辑'}
        >
          <Edit className="h-3.5 w-3.5" />
        </Button>

        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7 hover:bg-destructive/10 hover:text-destructive"
          onClick={handleDelete}
          title={isEn ? 'Delete' : '删除'}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  )
}

export const IdleListRow = memo(IdleListRowComponent)
