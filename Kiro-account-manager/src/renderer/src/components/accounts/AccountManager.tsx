import { useState, useEffect } from 'react'
import { useAccountsStore } from '@/store/accounts'
import { useIdleAccountsStore } from '@/store/idleAccounts'
import { useTranslation } from '@/hooks/useTranslation'
import { AccountToolbar, type AccountViewMode } from './AccountToolbar'
import { AccountGrid } from './AccountGrid'
import { AccountList } from './AccountList'
import { AddAccountDialog } from './AddAccountDialog'
import { EditAccountDialog } from './EditAccountDialog'
import { GroupManageDialog } from './GroupManageDialog'
import { TagManageDialog } from './TagManageDialog'
import { ExportDialog } from './ExportDialog'
import { ImportDialog, type ImportResult } from './ImportDialog'
import { Button } from '../ui'
import type { Account, AccountImportItem } from '@/types/account'
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
    addAccount,
    batchImportConcurrency,
    selectedIds,
    deselectAll,
    activeGroupTab,
    groups
  } = useAccountsStore()

  const [showAddDialog, setShowAddDialog] = useState(false)
  // 快捷 GitHub 无痕登录：打开添加对话框后自动发起（关闭时复位）
  const [addDialogAutoGithub, setAddDialogAutoGithub] = useState(false)
  // 快捷 Google 无痕登录：同 GitHub 快捷入口
  const [addDialogAutoGoogle, setAddDialogAutoGoogle] = useState(false)
  const [editingAccount, setEditingAccount] = useState<Account | null>(null)
  const [showGroupDialog, setShowGroupDialog] = useState(false)
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
      if (showAddDialog || editingAccount || showGroupDialog || showTagDialog || showExportDialog || showImportDialog) return
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
  // 凭证类（OIDC/卡密/行格式）走验证式导入——与「添加账号」同款：先在线验证拉全
  // 邮箱/订阅/用量再入库，保证数据完整；完整导出 JSON 仍为离线恢复。
  const handleParsedImport = async (
    parsed: ParsedImport,
    onProgress?: (done: number, total: number) => void
  ): Promise<ImportResult> => {
    // 导入归入"当前打开的分组"（activeGroupTab 为真实分组时），否则未分组
    const currentGroupId = (activeGroupTab !== 'all' && activeGroupTab !== 'ungrouped' && groups.has(activeGroupTab)) ? activeGroupTab : undefined
    const groupName = currentGroupId ? groups.get(currentGroupId)?.name ?? '未分组' : '未分组'
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

      // 检查账户是否已存在（同 userId 或 同邮箱+同 provider；与「添加账号」同口径）
      const isAccountExists = (email: string, userId: string, provider?: string): boolean => {
        return Array.from(accounts.values()).some(acc => {
          if (userId && acc.userId === userId) return true
          if (email && acc.email === email && acc.credentials.provider === provider) return true
          return false
        })
      }

      const importResult = { success: 0, failed: 0, skipped: 0, errors: [] as string[] }

      const importOne = async (cred: AccountImportItem): Promise<void> => {
        try {
          const credProvider = (cred.idp as string) || 'BuilderId'
          const credAuthMethod = (credProvider === 'BuilderId' || credProvider === 'Enterprise') ? 'IdC' : 'social'
          const result = await window.api.verifyAccountCredentials({
            refreshToken: cred.refreshToken,
            clientId: cred.clientId || '',
            clientSecret: cred.clientSecret || '',
            region: cred.region || 'us-east-1',
            authMethod: credAuthMethod,
            provider: credProvider
          })

          if (result.success && result.data) {
            const { email, userId } = result.data
            if (isAccountExists(email, userId, credProvider)) {
              importResult.skipped++
              importResult.errors.push(`${cred.email || email}: 已存在`)
              return
            }

            const idpMap: Record<string, 'BuilderId' | 'Enterprise' | 'Github' | 'Google'> = {
              'BuilderId': 'BuilderId',
              'Enterprise': 'Enterprise',
              'Github': 'Github',
              'Google': 'Google'
            }
            const now = Date.now()
            // 详细用量/订阅能力字段（preload 类型未细标，与「添加账号」同款断言取用）
            const usageData = result.data.usage as {
              current: number; limit: number
              baseLimit?: number; baseCurrent?: number
              freeTrialLimit?: number; freeTrialCurrent?: number; freeTrialExpiry?: string
              bonuses?: Account['usage']['bonuses']; nextResetDate?: string
              resourceDetail?: Account['usage']['resourceDetail']
            }
            const subData = (result.data as { subscription?: { managementTarget?: string; upgradeCapability?: string; overageCapability?: string } }).subscription
            addAccount({
              email,
              password: cred.password,
              userId,
              nickname: email ? email.split('@')[0] : undefined,
              idp: idpMap[credProvider] || 'BuilderId',
              groupId: currentGroupId,
              credentials: {
                accessToken: result.data.accessToken,
                csrfToken: '',
                refreshToken: result.data.refreshToken,
                clientId: cred.clientId || '',
                clientSecret: cred.clientSecret || '',
                region: cred.region || 'us-east-1',
                expiresAt: result.data.expiresIn ? now + result.data.expiresIn * 1000 : now + 3600 * 1000,
                authMethod: credAuthMethod as 'IdC' | 'social',
                provider: credProvider as 'BuilderId' | 'Enterprise' | 'Github' | 'Google',
                profileArn: result.data.profileArn
              },
              subscription: {
                type: result.data.subscriptionType as Account['subscription']['type'],
                title: result.data.subscriptionTitle,
                daysRemaining: result.data.daysRemaining,
                expiresAt: result.data.expiresAt,
                managementTarget: subData?.managementTarget,
                upgradeCapability: subData?.upgradeCapability,
                overageCapability: subData?.overageCapability
              },
              usage: {
                current: usageData.current,
                limit: usageData.limit,
                percentUsed: usageData.limit > 0
                  ? usageData.current / usageData.limit
                  : 0,
                lastUpdated: now,
                baseLimit: usageData.baseLimit,
                baseCurrent: usageData.baseCurrent,
                freeTrialLimit: usageData.freeTrialLimit,
                freeTrialCurrent: usageData.freeTrialCurrent,
                freeTrialExpiry: usageData.freeTrialExpiry,
                bonuses: usageData.bonuses,
                nextResetDate: usageData.nextResetDate,
                resourceDetail: usageData.resourceDetail
              },
              tags: [],
              status: 'active',
              lastUsedAt: now
            })
            importResult.success++
          } else {
            importResult.failed++
            const err = result.error as { message?: string } | string | undefined
            const errorMsg = typeof err === 'object' ? (err?.message || '验证失败') : (err || '验证失败')
            importResult.errors.push(`${cred.email || cred.refreshToken.slice(0, 10)}: ${errorMsg}`)
          }
        } catch (e) {
          importResult.failed++
          importResult.errors.push(`${cred.email}: ${e instanceof Error ? e.message : '导入失败'}`)
        }
      }

      // 并发控制与批间延迟：与「添加账号」批量导入一致，避免 API 限流
      const items = parsed.items
      let done = 0
      const BATCH_SIZE = batchImportConcurrency
      for (let i = 0; i < items.length; i += BATCH_SIZE) {
        const batch = items.slice(i, i + BATCH_SIZE)
        await Promise.allSettled(
          batch.map(cred => importOne(cred).finally(() => {
            done++
            onProgress?.(done, items.length)
          }))
        )
        if (i + BATCH_SIZE < items.length) {
          await new Promise(resolve => setTimeout(resolve, 100))
        }
      }

      const errSummary = importResult.errors.length
        ? `；明细：${importResult.errors.slice(0, 5).join('、')}${importResult.errors.length > 5 ? ` 等 ${importResult.errors.length} 条` : ''}`
        : ''
      const skippedMsg = importResult.skipped ? `，已存在跳过 ${importResult.skipped} 个` : ''
      return {
        ok: importResult.success > 0,
        message: `验证导入完成：成功 ${importResult.success} 个${skippedMsg}，失败 ${importResult.failed} 个（分组：${groupName}）${errSummary}`
      }
    } catch (e) {
      console.error('Import error:', e)
      return { ok: false, message: '解析导入内容失败' }
    }
  }

  // 管理分组
  const handleManageGroups = (): void => {
    setShowGroupDialog(true)
  }

  // 管理标签
  const handleManageTags = (): void => {
    setShowTagDialog(true)
  }

  // 批量移入闲置账号库：整账号搬运到独立 SQLite 库（物理隔离，不保活不刷新），
  // 主库移除（removeAccounts 会顺带清理账号的代理绑定）
  const handleArchive = (): void => {
    const main = useAccountsStore.getState()
    if (main.selectedIds.size === 0) return

    const selected = Array.from(main.selectedIds)
      .map(id => main.accounts.get(id))
      .filter((a): a is Account => a !== undefined)

    // 当前激活账号不允许归档：IDE 正在用它，归档会导致保活断开
    if (selected.some(a => a.id === main.activeAccountId)) {
      alert(isEn ? 'The active account cannot be archived. Switch to another account first.' : '当前激活账号不能移入闲置库，请先切换到其他账号')
      return
    }

    // 按闲置库去重口径预筛（id / 邮箱+provider）
    const idleStore = useIdleAccountsStore.getState()
    const idleAccounts = idleStore.accounts
    const isDuplicateInIdle = (acc: Account): boolean => {
      if (idleAccounts.has(acc.id)) return true
      for (const e of idleAccounts.values()) {
        if (acc.userId && e.userId === acc.userId) return true
        if (acc.email === e.email && acc.credentials?.provider === e.credentials?.provider) return true
      }
      return false
    }
    const archivable = selected.filter(acc => !isDuplicateInIdle(acc))
    const skippedCount = selected.length - archivable.length

    if (archivable.length === 0) {
      alert(isEn ? 'All selected accounts already exist in Idle Accounts' : '选中的账号在闲置库中均已存在')
      return
    }
    if (!confirm(isEn ? `Move ${archivable.length} accounts to Idle Accounts? (offline, no keep-alive)` : `确定把 ${archivable.length} 个账号移入闲置库吗？（闲置库不保活、不刷新 Token）`)) {
      return
    }

    const result = idleStore.receiveAccounts(archivable)
    if (result.success > 0) {
      main.removeAccounts(archivable.map(acc => acc.id))
      const skipNote = skippedCount > 0 ? (isEn ? `, ${skippedCount} skipped (already exist)` : `，跳过 ${skippedCount} 个已存在`) : ''
      alert(`${isEn ? 'Archived' : '已移入闲置库'} ${result.success} ${isEn ? 'account(s)' : '个账号'}${skipNote}`)
    } else {
      alert(isEn ? 'Archive failed' : '移入闲置库失败')
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
          onQuickGoogleLogin={() => {
            setAddDialogAutoGoogle(true)
            setShowAddDialog(true)
          }}
          onImport={handleImport}
          onExport={handleExport}
          onArchive={handleArchive}
          viewMode={viewMode}
          onViewModeChange={setViewMode}
          onManageGroups={handleManageGroups}
          onManageTags={handleManageTags}
          isFilterExpanded={isFilterExpanded}
          onToggleFilter={() => setIsFilterExpanded(!isFilterExpanded)}
          onCloseFilter={() => setIsFilterExpanded(false)}
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
        autoGoogleLogin={addDialogAutoGoogle}
        onClose={() => {
          setShowAddDialog(false)
          setAddDialogAutoGithub(false)
          setAddDialogAutoGoogle(false)
        }}
      />

      {/* 编辑账号对话框 */}
      <EditAccountDialog
        open={!!editingAccount}
        onOpenChange={(open) => !open && setEditingAccount(null)}
        account={editingAccount}
      />

      {/* 分组管理对话框 */}
      <GroupManageDialog
        isOpen={showGroupDialog}
        onClose={() => setShowGroupDialog(false)}
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
