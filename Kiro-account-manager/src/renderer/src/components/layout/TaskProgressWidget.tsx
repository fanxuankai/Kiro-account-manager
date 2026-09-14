import { createPortal } from 'react-dom'
import { useAccountsStore } from '@/store/accounts'

/**
 * 批量刷新的全局进度悬浮球（fixed 定位右下角，所有页面可见）：
 * 80px 环形进度球（中心 n/N）+ 球下方一行小标签标注刷新类型与「自动」，
 * 脱离文档流不占布局空间，pointer-events-none 不拦截点击；空闲时不渲染。
 * 必须用 createPortal 挂到 body：应用根容器有 `.ambient-bg > * { position: relative }`，
 * 会把普通子元素的 fixed 覆盖成 relative（UpdateDialog/CloseConfirmDialog 同理走 portal）。
 */
export function TaskProgressWidget(): React.ReactNode {
  const refreshProgress = useAccountsStore((s) => s.refreshProgress)

  if (!refreshProgress) return null

  // 环形进度：80px 视窗、半径 34，stroke-dashoffset 按 1-进度收缩
  const R = 34
  const CIRC = 2 * Math.PI * R
  const pct = refreshProgress.total > 0 ? refreshProgress.done / refreshProgress.total : 0

  const kindLabel = refreshProgress.kind === 'token' ? '刷新 Token' : '刷新用量'
  const suffix = refreshProgress.silent === true ? ' · 自动' : ''

  return createPortal(
    <div
      role="status"
      className={
        'fixed bottom-6 right-6 z-50 flex flex-col items-center gap-1.5 ' +
        'animate-in fade-in slide-in-from-bottom-2 duration-200 pointer-events-none'
      }
    >
      {/* 环形进度球 */}
      <div className="relative flex h-20 w-20 items-center justify-center rounded-full bg-card/90 border border-border/60 shadow-lg backdrop-blur">
        <svg viewBox="0 0 80 80" className="h-20 w-20 -rotate-90">
          <circle cx="40" cy="40" r={R} fill="none" strokeWidth="5" className="stroke-border" />
          <circle
            cx="40"
            cy="40"
            r={R}
            fill="none"
            strokeWidth="5"
            strokeLinecap="round"
            className="stroke-primary transition-[stroke-dashoffset] duration-300"
            strokeDasharray={CIRC}
            strokeDashoffset={CIRC * (1 - pct)}
          />
        </svg>
        {/* 中心 n/N 进度数字 */}
        <span className="absolute text-sm font-medium text-muted-foreground tabular-nums">
          {refreshProgress.done}/{refreshProgress.total}
        </span>
      </div>
      {/* 类型标签：标注在刷新什么、是否自动触发 */}
      <span className="rounded-full bg-card/90 border border-border/60 backdrop-blur px-2.5 py-0.5 text-[10px] text-muted-foreground whitespace-nowrap">
        {kindLabel}{suffix}
      </span>
    </div>,
    document.body
  )
}
