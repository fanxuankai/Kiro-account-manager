import { useState, useEffect } from 'react'
import { useAccountsStore } from '@/store/accounts'
import { useTranslation } from '@/hooks/useTranslation'
import { AccountToolbar, type AccountViewMode } from './AccountToolbar'
import { AccountGrid } from './AccountGrid'
import { AccountList } from './AccountList'
import { AddAccountDialog } from './AddAccountDialog'
import { EditAccountDialog } from './EditAccountDialog'
import { TagManageDialog } from './TagManageDialog'
import { ExportDialog } from './ExportDialog'
import { ImportDialog, type ImportResult } from './ImportDialog'
import { Button } from '../ui'
import type { Account } from '@/types/account'
import { type ParsedImport } from '@/lib/importParse'
import { ArrowLeft, Loader2, Users } from 'lucide-react'

interface AccountManagerProps {
  onBack?: () => void
}

export function AccountManager({ onBack }: AccountManagerProps): React.ReactNode {
  const {
    isLoading,
    accounts,
    importFromExportData,
    importAccounts,
    selectedIds,
    deselectAll,
  } = useAccountsStore()

  const [showAddDialog, setShowAddDialog] = useState(false)
  // 快捷 GitHub 无痕登录：打开添加对话框后自动发起（关闭时复位）
  const [addDialogAutoGithub, setAddDialogAutoGithub] = useState(false)
  const [editingAccount, setEditingAccount] = useState<Account | null>(null)
  const [showTagDialog, setShowTagDialog] = useState(false)
  const [showExportDialog, setShowExportDialog] = useState(false)
  const [showImportDialog, setShowImportDialog] = useState(false)
  const [isFilterExpanded, setIsFilterExpanded] = useState(false)
  // 视图模式：grid（卡片，默认）/ list（紧凑列表），持久化到 localStorage
  const [viewMode, setViewMode] = useState<AccountViewMode>(() => {
    const saved = localStorage.getItem('accounts_viewMode')
    return saved === 'list' ? 'list' : 'grid'
  })
  useEffect(() => {
    localStorage.setItem('accounts_viewMode', viewMode)
  }, [viewMode])

  // Esc 取消选中账号；有对话框打开时不抢按键，让对话框自行处理关闭
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (showAddDialog || editingAccount || showTagDialog || showExportDialog || showImportDialog) return
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
    showTagDialog,
    showExportDialog,
    showImportDialog,
    selectedIds,
    deselectAll
  ])
  const { t } = useTranslation()
  const isEn = t('common.unknown') === 'Unknown'

  // 获取要导出的账号列表
  const getExportAccounts = () => {
    const accountList = Array.from(accounts.values())
    if (selectedIds.size > 0) {
      return accountList.filter(acc => selectedIds.has(acc.id))
    }
    return accountList
  }

  // 导出
  const handleExport = (): void => {
    setShowExportDialog(true)
  }

  // 导入：打开弹窗（粘贴 / 选文件双入口，格式自动识别）
  const handleImport = (): void => {
    setShowImportDialog(true)
  }

  // 执行导入弹窗解析结果的入库
  const handleParsedImport = (parsed: ParsedImport): ImportResult => {
    try {
      // invalid 在 ImportDialog 内已被拦截，这里兜底返回（同时满足类型收窄）
      if (parsed.kind === 'invalid') {
        return { ok: false, message: parsed.message }
      }
      if (parsed.kind === 'export') {
        const result = importFromExportData(parsed.data)
        const skippedInfo = result.errors.find(e => e.id === 'skipped')
        const skippedMsg = skippedInfo ? `，${skippedInfo.error}` : ''
        return { ok: result.success > 0, message: `导入完成：成功 ${result.success} 个${skippedMsg}` }
      }
      const result = importAccounts(parsed.items)
      const label = parsed.format === 'kami' ? '卡密导入完成' : parsed.format === 'oidc' ? 'OIDC 凭证导入完成' : '导入完成'
      return { ok: result.success > 0, message: `${label}：成功 ${result.success} 个，失败 ${result.failed} 个` }
    } catch (e) {
      console.error('Import error:', e)
      return { ok: false, message: '解析导入内容失败' }
    }
  }

  // 管理标签
  const handleManageTags = (): void => {
    setShowTagDialog(true)
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
          <p className="text-muted-foreground">加载账号数据...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* 顶部工具栏 - 玻璃态（relative z-20 抬升 stacking context，确保下拉菜单浮在卡片之上） */}
      <header className="relative z-20 flex items-center justify-between gap-4 px-3 py-3 glass-toolbar">
        <div className="flex items-center gap-4">
          {onBack && (
            <Button variant="ghost" size="icon" onClick={onBack}>
              <ArrowLeft className="h-5 w-5" />
            </Button>
          )}
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-primary/10">
              <Users className="h-5 w-5 text-primary" />
            </div>
            <h1 className="text-lg font-semibold text-primary">{isEn ? 'Accounts' : '账户管理'}</h1>
          </div>
        </div>
        
        {/* 工具栏 */}
        <AccountToolbar
          onAddAccount={() => setShowAddDialog(true)}
          onQuickGithubLogin={() => {
            setAddDialogAutoGithub(true)
            setShowAddDialog(true)
          }}
          onImport={handleImport}
          onExport={handleExport}
          viewMode={viewMode}
          onViewModeChange={setViewMode}
          onManageTags={handleManageTags}
          isFilterExpanded={isFilterExpanded}
          onToggleFilter={() => setIsFilterExpanded(!isFilterExpanded)}
        />
      </header>

      {/* 主内容区域 */}
      <div className="flex-1 overflow-hidden flex flex-col px-3 py-3 gap-3">
        {/* 账号列表（卡片 或 紧凑列表） */}
        <div className="flex-1 overflow-hidden">
          {viewMode === 'grid' ? (
            <AccountGrid
              onAddAccount={() => setShowAddDialog(true)}
              onEditAccount={handleEditAccount}
            />
          ) : (
            <AccountList
              onAddAccount={() => setShowAddDialog(true)}
              onEditAccount={handleEditAccount}
            />
          )}
        </div>
      </div>

      {/* 添加账号对话框 */}
      <AddAccountDialog
        isOpen={showAddDialog}
        autoGithubLogin={addDialogAutoGithub}
        onClose={() => {
          setShowAddDialog(false)
          setAddDialogAutoGithub(false)
        }}
      />

      {/* 编辑账号对话框 */}
      <EditAccountDialog
        open={!!editingAccount}
        onOpenChange={(open) => !open && setEditingAccount(null)}
        account={editingAccount}
      />

      {/* 标签管理对话框 */}
      <TagManageDialog
        isOpen={showTagDialog}
        onClose={() => setShowTagDialog(false)}
      />

      {/* 导出对话框 */}
      <ExportDialog
        open={showExportDialog}
        onClose={() => setShowExportDialog(false)}
        accounts={getExportAccounts()}
        selectedCount={selectedIds.size}
      />

      {/* 导入对话框 */}
      <ImportDialog
        open={showImportDialog}
        onClose={() => setShowImportDialog(false)}
        onImport={handleParsedImport}
      />
    </div>
  )
}
