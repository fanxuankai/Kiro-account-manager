import { useAccountsStore } from '@/store/accounts'
import { useTranslation } from '@/hooks/useTranslation'
import { Progress } from '../ui'

/**
 * 手动批量刷新的悬浮进度卡（右下角，样式对齐 KiroLuker 的 AccountTaskProgress）：
 * 紧凑小卡——细进度条 + 一行 12px 文案，0.16s 淡入上滑，pointer-events 永远 none。
 * 定时器自动触发的刷新标记 silent，不弹卡（避免高频自动任务常驻遮挡页面内容）。
 */
export function TaskProgressWidget(): React.ReactNode {
  const refreshProgress = useAccountsStore((s) => s.refreshProgress)
  const { t } = useTranslation()
  const isEn = t('common.unknown') === 'Unknown'

  // 自动刷新静默：只在手动批量时显示
  const visible = refreshProgress !== null && refreshProgress.silent !== true
  const label = !refreshProgress
    ? ''
    : refreshProgress.kind === 'token'
      ? isEn
        ? 'Refreshing tokens'
        : '正在刷新 Token'
      : isEn
        ? 'Refreshing usage'
        : '正在刷新用量'

  return (
    <div
      role="status"
      className={
        'fixed bottom-6 right-6 z-[1100] flex items-center gap-2.5 ' +
        'rounded-[10px] border border-border bg-card px-3 py-2 ' +
        'shadow-md transition-[opacity,transform] duration-150 ease-in-out ' +
        (visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2')
      }
      style={{ pointerEvents: 'none' }}
    >
      <Progress
        value={
          refreshProgress && refreshProgress.total > 0
            ? (refreshProgress.done / refreshProgress.total) * 100
            : 0
        }
        className="h-[6px] w-[120px] flex-shrink-0"
        indicatorClassName="bg-primary"
      />
      <span className="text-xs text-muted-foreground whitespace-nowrap tabular-nums">
        {label}
        {refreshProgress ? ` ${refreshProgress.done}/${refreshProgress.total}` : ''}
      </span>
    </div>
  )
}
