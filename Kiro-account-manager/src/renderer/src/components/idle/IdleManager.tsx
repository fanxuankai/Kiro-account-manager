import { useState, useEffect } from 'react'
import { useIdleAccountsStore } from '@/store/idleAccounts'
import { useAccountsStore } from '@/store/accounts'
import { useTranslation } from '@/hooks/useTranslation'
import { IdleToolbar, type IdleViewMode } from './IdleToolbar'
import { IdleGrid } from './IdleGrid'
import { IdleList } from './IdleList'
import { IdleAddDialog } from './IdleAddDialog'
import { IdleEditDialog } from './IdleEditDialog'
import { GroupManageDialog, TagManageDialog, ExportDialog } from '../accounts'
import { parseImportContent } from '@/lib/importParse'
import type { Account } from '@/types/account'
import { Loader2, Warehouse } from 'lucide-react'

// 闲置账号库页面：存放不需要保活的账号（独立 SQLite 库，物理隔离）。
// 与账号管理界面视觉一致；移除一切联网操作，提供导入/导出与双向移动。
export function IdleManager(): React.ReactNode {
  const {
    isLoading,
    accounts,
    selectedIds,
    deselectAll,
    getSelectedAccounts,
    activeGroupTab,
    groups,
    importFromExportData,
    importAccounts,
    removeAccounts
  } = useIdleAccountsStore()

  const [showAddDialog, setShowAddDialog] = useState(false)
  const [editingAccount, setEditingAccount] = useState<Account | null>(null)
  const [showGroupDialog, setShowGroupDialog] = useState(false)
  const [showTagDialog, setShowTagDialog] = useState(false)
  const [showExportDialog, setShowExportDialog] = useState(false)
  const [isFilterExpanded, setIsFilterExpanded] = useState(false)
  // 视图模式：grid（卡片，默认）/ list（紧凑列表），持久化到 localStorage（idle_ 前缀，与主界面互不干扰）
  const [viewMode, setViewMode] = useState<IdleViewMode>(() => {
    const saved = localStorage.getItem('idle_viewMode')
    return saved === 'list' ? 'list' : 'grid'
  })
  useEffect(() => {
    localStorage.setItem('idle_viewMode', viewMode)
  }, [viewMode])

  // Esc 取消选中账号；有对话框打开时不抢按键
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (showAddDialog || editingAccount || showGroupDialog || showTagDialog || showExportDialog) return
      if (selectedIds.size > 0) {
        e.preventDefault()
        deselectAll()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [
    showAddDialog,
    editingAccount,
    showGroupDialog,
    showTagDialog,
    showExportDialog,
    selectedIds,
    deselectAll
  ])

  const { t } = useTranslation()
  const isEn = t('common.unknown') === 'Unknown'

  // 获取要导出的账号列表（选中优先，否则全部）
  const getExportAccounts = (): Account[] => {
    const accountList = Array.from(accounts.values())
    if (selectedIds.size > 0) {
      return accountList.filter(acc => selectedIds.has(acc.id))
    }
    return accountList
  }

  const handleExport = (): void => {
    setShowExportDialog(true)
  }

  // 文件导入（与账号管理共用解析逻辑；数据进闲置库）
  const handleImport = async (): Promise<void> => {
    const currentGroupId = (activeGroupTab !== 'all' && activeGroupTab !== 'ungrouped' && groups.has(activeGroupTab)) ? activeGroupTab : undefined
    const groupName = currentGroupId ? (groups.get(currentGroupId)?.name ?? (isEn ? 'Ungrouped' : '未分组')) : (isEn ? 'Ungrouped' : '未分组')
    const fileData = await window.api.importFromFile()

    if (!fileData) return

    const { content, format } = fileData

    try {
      const parsed = parseImportContent(content, format, currentGroupId)
      if (parsed.kind === 'invalid') {
        alert(parsed.message)
        return
      }
      if (parsed.kind === 'export') {
        const result = importFromExportData(parsed.data)
        const skippedInfo = result.errors.find(e => e.id === 'skipped')
        const skippedMsg = skippedInfo ? `，${skippedInfo.error}` : ''
        alert(`导入完成：成功 ${result.success} 个${skippedMsg}`)
        return
      }
      const result = importAccounts(parsed.items)
      const label = parsed.format === 'kami' ? '卡密导入完成' : '导入完成'
      alert(`${label}：成功 ${result.success} 个，失败 ${result.failed} 个（分组：${groupName}）`)
    } catch (e) {
      console.error('Idle import error:', e)
      alert('解析导入文件失败')
    }
  }

  // 单个账号移回账号管理
  const handleRestoreAccount = (account: Account): void => {
    const mainResult = useAccountsStore.getState().receiveAccounts([account])
    if (mainResult.success > 0) {
      removeAccounts([account.id])
    } else {
      const reason = mainResult.errors.find(e => e.id === 'skipped')?.error
      alert(isEn ? `Restore failed: ${reason ?? 'already exists'}` : `移回失败：${reason ?? '账号已存在'}`)
    }
  }

  // 批量移回账号管理：先按主库去重口径筛出可移回的账号，再搬运 + 从闲置库移除
  const handleBatchRestore = (): void => {
    if (selectedIds.size === 0) return
    const selected = getSelectedAccounts()
    if (selected.length === 0) return

    const mainStore = useAccountsStore.getState()
    const mainAccounts = mainStore.accounts
    const isDuplicateInMain = (acc: Account): boolean => {
      if (mainAccounts.has(acc.id)) return true
      for (const e of mainAccounts.values()) {
        if (acc.userId && e.userId === acc.userId) return true
        if (acc.email === e.email && acc.credentials?.provider === e.credentials?.provider) return true
      }
      return false
    }
    const restorable = selected.filter(acc => !isDuplicateInMain(acc))
    const skippedCount = selected.length - restorable.length

    if (restorable.length === 0) {
      alert(isEn ? 'All selected accounts already exist in Account Manager' : '选中的账号在账号管理中均已存在')
      return
    }
    if (!confirm(isEn ? `Restore ${restorable.length} accounts to Account Manager?` : `确定把 ${restorable.length} 个账号移回账号管理吗？（移回后恢复保活）`)) {
      return
    }

    const mainResult = mainStore.receiveAccounts(restorable)
    if (mainResult.success > 0) {
      // 只移除成功入库主库的账号；去重跳过的保留在闲置库
      removeAccounts(restorable.map(acc => acc.id))
      const skipNote = skippedCount > 0 ? (isEn ? `, ${skippedCount} skipped (already exist)` : `，跳过 ${skippedCount} 个已存在`) : ''
      alert(`${isEn ? 'Restored' : '已移回'} ${mainResult.success} ${isEn ? 'account(s)' : '个账号'}${skipNote}`)
    } else {
      alert(isEn ? 'Restore failed' : '移回失败')
    }
  }

  // 编辑账号
  const handleEditAccount = (account: Account): void => {
    setEditingAccount(account)
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-muted-foreground">加载闲置账号数据...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* 顶部工具栏 - 玻璃态（relative z-20 抬升 stacking context，确保下拉菜单浮在卡片之上） */}
      <header className="relative z-20 flex items-center justify-between gap-4 px-3 py-3 glass-toolbar">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-primary/10">
              <Warehouse className="h-5 w-5 text-primary" />
            </div>
            <div className="flex flex-col">
              <h1 className="text-lg font-semibold text-primary">{isEn ? 'Idle Accounts' : '闲置账号库'}</h1>
              <span className="text-[10px] text-muted-foreground">
                {isEn ? 'Offline vault — no keep-alive, never refreshed' : '离线凭据仓库 · 不保活 · 不刷新'}
              </span>
            </div>
          </div>
        </div>

        {/* 工具栏 */}
        <IdleToolbar
          onAddAccount={() => setShowAddDialog(true)}
          onImport={handleImport}
          onExport={handleExport}
          onRestore={handleBatchRestore}
          viewMode={viewMode}
          onViewModeChange={setViewMode}
          onManageGroups={() => setShowGroupDialog(true)}
          onManageTags={() => setShowTagDialog(true)}
          isFilterExpanded={isFilterExpanded}
          onToggleFilter={() => setIsFilterExpanded(!isFilterExpanded)}
        />
      </header>

      {/* 主内容区域 */}
      <div className="flex-1 overflow-hidden flex flex-col px-3 py-3 gap-3">
        {/* 账号列表（卡片 或 紧凑列表） */}
        <div className="flex-1 overflow-hidden">
          {viewMode === 'grid' ? (
            <IdleGrid
              onAddAccount={() => setShowAddDialog(true)}
              onEditAccount={handleEditAccount}
              onRestoreAccount={handleRestoreAccount}
            />
          ) : (
            <IdleList
              onAddAccount={() => setShowAddDialog(true)}
              onEditAccount={handleEditAccount}
              onRestoreAccount={handleRestoreAccount}
            />
          )}
        </div>
      </div>

      {/* 添加账号对话框（离线粘贴导入） */}
      <IdleAddDialog
        isOpen={showAddDialog}
        onClose={() => setShowAddDialog(false)}
      />

      {/* 编辑账号对话框 */}
      <IdleEditDialog
        open={!!editingAccount}
        onOpenChange={(open) => !open && setEditingAccount(null)}
        account={editingAccount}
      />

      {/* 分组管理对话框（闲置库独立分组） */}
      <GroupManageDialog
        isOpen={showGroupDialog}
        onClose={() => setShowGroupDialog(false)}
        useStore={useIdleAccountsStore}
      />

      {/* 标签管理对话框（闲置库独立标签） */}
      <TagManageDialog
        isOpen={showTagDialog}
        onClose={() => setShowTagDialog(false)}
        useStore={useIdleAccountsStore}
      />

      {/* 导出对话框 */}
      <ExportDialog
        open={showExportDialog}
        onClose={() => setShowExportDialog(false)}
        accounts={getExportAccounts()}
        selectedCount={selectedIds.size}
        useStore={useIdleAccountsStore}
      />
    </div>
  )
}
