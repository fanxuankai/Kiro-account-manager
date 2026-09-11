import { useAccountsStore } from '@/store/accounts'
import { useTranslation } from '@/hooks/useTranslation'
import { Progress } from '../ui'

/**
 * 批量刷新的全局进度横条（标题栏正下方，所有页面可见）：
 * 一行细进度条 + 文案，空闲时不渲染、不占位。
 * 自动刷新（silent）同样显示，文案追加「自动」标记。
 */
export function TaskProgressWidget(): React.ReactNode {
  const refreshProgress = useAccountsStore((s) => s.refreshProgress)
  const { t } = useTranslation()
  const isEn = t('common.unknown') === 'Unknown'

  if (!refreshProgress) return null

  const label = refreshProgress.kind === 'token'
    ? isEn
      ? 'Refreshing tokens'
      : '正在刷新 Token'
    : isEn
      ? 'Refreshing usage'
      : '正在刷新用量'
  const suffix = refreshProgress.silent === true ? (isEn ? ' (auto)' : '（自动）') : ''

  return (
    <div
      role="status"
      className={
        'flex items-center justify-center gap-3 h-7 w-full flex-shrink-0 ' +
        'bg-card/80 border-b border-border/60 animate-in fade-in slide-in-from-top-1 duration-200'
      }
    >
      <Progress
        value={
          refreshProgress.total > 0
            ? (refreshProgress.done / refreshProgress.total) * 100
            : 0
        }
        className="h-[4px] w-40 flex-shrink-0"
        indicatorClassName="bg-primary"
      />
      <span className="text-xs text-muted-foreground whitespace-nowrap tabular-nums">
        {label} {refreshProgress.done}/{refreshProgress.total}{suffix}
      </span>
    </div>
  )
}
