import { useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useIdleAccountsStore } from '@/store/idleAccounts'
import { useTranslation } from '@/hooks/useTranslation'
import { IdleListRow } from './IdleListRow'
import { IdleDetailDialog } from './IdleDetailDialog'
import type { Account } from '@/types/account'
import { Plus } from 'lucide-react'

interface IdleListProps {
  onAddAccount: () => void
  onEditAccount: (account: Account) => void
  /** 单账号移回账号管理（主库） */
  onRestoreAccount: (account: Account) => void
}

// 列表行高度（紧凑型，对齐卡片视觉细节）
const ROW_HEIGHT = 72
// 行间距（为 active-glow-border 和 box-shadow 留呼吸空间）
const ROW_GAP = 10

export function IdleList({ onAddAccount, onEditAccount, onRestoreAccount }: IdleListProps): React.ReactNode {
  const parentRef = useRef<HTMLDivElement>(null)
  const [detailAccount, setDetailAccount] = useState<Account | null>(null)

  const {
    getFilteredAccounts,
    tags,
    groups,
    selectedIds
  } = useIdleAccountsStore()
  const { t } = useTranslation()
  const isEn = t('common.unknown') === 'Unknown'

  const accounts = getFilteredAccounts()

  // 虚拟列表（每项含一个行高 + 间距）
  const virtualizer = useVirtualizer({
    count: accounts.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT + ROW_GAP,
    overscan: 8
  })

  const items = virtualizer.getVirtualItems()

  return (
    <div
      ref={parentRef}
      className="h-full overflow-auto"
      style={{ contain: 'strict' }}
    >
      <div
        style={{
          height: `${virtualizer.getTotalSize() + 80}px`,
          width: '100%',
          position: 'relative'
        }}
      >
        {items.map((virtualRow) => {
          const account = accounts[virtualRow.index]
          if (!account) return null
          return (
            <div
              key={virtualRow.key}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: `${ROW_HEIGHT}px`,
                transform: `translateY(${virtualRow.start}px)`
              }}
            >
              <IdleListRow
                account={account}
                tags={tags}
                groups={groups}
                isSelected={selectedIds.has(account.id)}
                onEdit={() => onEditAccount(account)}
                onShowDetail={() => setDetailAccount(account)}
                onRestore={() => onRestoreAccount(account)}
              />
            </div>
          )
        })}

        {/* 列表底部「添加账号」按钮 */}
        {accounts.length > 0 && (
          <div
            style={{
              position: 'absolute',
              top: `${virtualizer.getTotalSize()}px`,
              left: 0,
              width: '100%'
            }}
          >
            <button
              type="button"
              onClick={onAddAccount}
              className="w-full flex items-center justify-center gap-2 py-3 border-2 border-dashed border-muted-foreground/20 rounded-lg text-muted-foreground hover:border-primary/50 hover:bg-primary/5 hover:text-primary transition-colors"
            >
              <Plus className="h-4 w-4" />
              <span className="text-sm">{isEn ? 'Add Account' : '添加账号'}</span>
            </button>
          </div>
        )}
      </div>

      {/* 空状态 */}
      {accounts.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="text-center">
            <p className="text-muted-foreground mb-4">{isEn ? 'No idle accounts yet' : '暂无闲置账号'}</p>
            <button
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90"
              onClick={onAddAccount}
            >
              <Plus className="h-4 w-4" />
              {isEn ? 'Add First Account' : '添加第一个账号'}
            </button>
          </div>
        </div>
      )}

      {/* 账号详情对话框（只读快照，无网络刷新） */}
      <IdleDetailDialog
        open={!!detailAccount}
        onOpenChange={(open) => !open && setDetailAccount(null)}
        account={detailAccount}
      />
    </div>
  )
}
