import { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import { Button, Badge } from '../ui'
import { useAccountsStore } from '@/store/accounts'
import { useTranslation } from '@/hooks/useTranslation'
import { AccountFilterPanel } from './AccountFilter'
import { toRgba } from './_helpers'
import { cn } from '@/lib/utils'
import {
  ACCOUNT_LIFECYCLE_LABELS,
  getLifecycleCounts,
  type AccountLifecycle
} from '@/lib/accountLifecycle'
import {
  Search,
  Plus,
  Upload,
  Download,
  Trash2,
  Tag,
  CheckSquare,
  Square,
  Loader2,
  Eye,
  EyeOff,
  Filter,
  Check,
  X,
  Minus,
  CircleDashed,
  Clock3,
  BadgeCheck,
  TriangleAlert,
  LayoutGrid,
  List as ListIcon,
  Activity,
  KeyRound,
} from 'lucide-react'

export type AccountViewMode = 'grid' | 'list'

interface AccountToolbarProps {
  onAddAccount: () => void
  /** 快捷入口：打开添加对话框并自动发起 GitHub 无痕在线登录 */
  onQuickGithubLogin: () => void
  onImport: () => void
  onExport: () => void
  viewMode: AccountViewMode
  onViewModeChange: (mode: AccountViewMode) => void
  onManageTags: () => void
  isFilterExpanded: boolean
  onToggleFilter: () => void
}

export function AccountToolbar({
  onAddAccount,
  onQuickGithubLogin,
  onImport,
  onExport,
  viewMode,
  onViewModeChange,
  onManageTags,
  isFilterExpanded,
  onToggleFilter
}: AccountToolbarProps): React.ReactNode {
  const {
    filter,
    setFilter,
    selectedIds,
    selectAll,
    deselectAll,
    removeAccounts,
    batchRefreshTokens,
    batchCheckStatus,
    getFilteredAccounts,
    getStats,
    privacyMode,
    setPrivacyMode,
    tags,
    accounts,
    addTagToAccounts,
    removeTagFromAccounts,
    activeLifecycleTab,
    setActiveLifecycleTab,
    refreshProgress
  } = useAccountsStore()

  const [isRefreshing, setIsRefreshing] = useState(false)
  const [isChecking, setIsChecking] = useState(false)
  const [showTagMenu, setShowTagMenu] = useState(false)

  const tagMenuRef = useRef<HTMLDivElement>(null)
  
  // 点击外部关闭菜单
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (tagMenuRef.current && !tagMenuRef.current.contains(e.target as Node)) {
        setShowTagMenu(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const selectedTagStatus = useMemo(() => {
    const selectedAccounts = Array.from(selectedIds).map(id => accounts.get(id)).filter(Boolean)
    const tagCounts = new Map<string, number>()
    selectedAccounts.forEach(acc => {
      if (acc?.tags) {
        acc.tags.forEach(tagId => {
          tagCounts.set(tagId, (tagCounts.get(tagId) || 0) + 1)
        })
      }
    })
    return { selectedAccounts, tagCounts, total: selectedAccounts.length }
  }, [selectedIds, accounts])

  const getSelectedAccountsTagStatus = useCallback(() => selectedTagStatus, [selectedTagStatus])

  // 处理标签操作
  const handleAddTag = (tagId: string) => {
    if (selectedIds.size === 0) return
    addTagToAccounts(Array.from(selectedIds), tagId)
  }
  
  const handleRemoveTag = (tagId: string) => {
    if (selectedIds.size === 0) return
    removeTagFromAccounts(Array.from(selectedIds), tagId)
  }
  
  const handleToggleTag = (tagId: string) => {
    const { tagCounts, total } = getSelectedAccountsTagStatus()
    const count = tagCounts.get(tagId) || 0
    
    if (count === total) {
      // 所有选中账户都有此标签，移除
      handleRemoveTag(tagId)
    } else {
      // 部分或无账户有此标签，添加
      handleAddTag(tagId)
    }
  }

  const { t } = useTranslation()
  const isEn = t('common.unknown') === 'Unknown'
  const stats = getStats()
  const filteredCount = getFilteredAccounts().length
  const selectedCount = selectedIds.size

  const deprecatedUsageThreshold = useAccountsStore((state) => state.deprecatedUsageThreshold)
  const deprecatedUsagePercentThreshold = useAccountsStore((state) => state.deprecatedUsagePercentThreshold)
  const lifecycleCounts = useMemo(() => getLifecycleCounts(accounts.values(), {
    deprecatedUsageThreshold,
    deprecatedUsagePercentThreshold
  }), [accounts, deprecatedUsageThreshold, deprecatedUsagePercentThreshold])

  const lifecycleTabs: Array<{ key: AccountLifecycle; icon: React.ReactNode; color: string }> = [
    { key: 'unused', icon: <CircleDashed className="h-3.5 w-3.5" />, color: 'text-slate-500' },
    { key: 'pendingPayment', icon: <Clock3 className="h-3.5 w-3.5" />, color: 'text-amber-600 dark:text-amber-400' },
    { key: 'subscribed', icon: <BadgeCheck className="h-3.5 w-3.5" />, color: 'text-emerald-600 dark:text-emerald-400' },
    { key: 'deprecated', icon: <TriangleAlert className="h-3.5 w-3.5" />, color: 'text-red-600 dark:text-red-400' }
  ]

  const handleSearch = (value: string): void => {
    setFilter({ ...filter, search: value || undefined })
  }

  const handleBatchRefresh = async (): Promise<void> => {
    if (selectedCount === 0) return
    setIsRefreshing(true)
    await batchRefreshTokens(Array.from(selectedIds))
    setIsRefreshing(false)
  }

  const handleBatchCheck = async (): Promise<void> => {
    if (selectedCount === 0) return
    setIsChecking(true)
    await batchCheckStatus(Array.from(selectedIds))
    setIsChecking(false)
  }

  const handleBatchDelete = (): void => {
    if (selectedCount === 0) return
    if (confirm(isEn ? `Delete ${selectedCount} selected accounts?` : `确定要删除选中的 ${selectedCount} 个账号吗？`)) {
      removeAccounts(Array.from(selectedIds))
    }
  }

  const handleToggleSelectAll = (): void => {
    if (selectedCount === filteredCount && filteredCount > 0) {
      deselectAll()
    } else {
      selectAll()
    }
  }

  return (
    <div className="space-y-3">
      {/* 搜索和主要操作 */}
      <div className="flex items-center gap-3">
        {/* 搜索框 */}
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            placeholder={isEn ? 'Search accounts...' : '搜索账号...'}
            className="w-full pl-9 pr-4 py-2 text-sm rounded-xl bg-[var(--glass-bg-subtle)] backdrop-blur-md border border-[var(--glass-border)] focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary/30 transition-all"
            value={filter.search ?? ''}
            onChange={(e) => handleSearch(e.target.value)}
          />
        </div>

        {/* 主要操作按钮 - 右对齐 */}
        <div className="flex items-center gap-2 ml-auto">
          {/* 视图切换 (卡片 / 列表) */}
          <div className="flex items-center rounded-xl border border-[var(--glass-border)] bg-[var(--glass-bg-subtle)] backdrop-blur-md overflow-hidden">
            <button
              type="button"
              onClick={() => onViewModeChange('grid')}
              title={isEn ? 'Grid view' : '卡片视图'}
              className={`flex items-center justify-center h-8 w-8 transition-colors ${
                viewMode === 'grid'
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-muted'
              }`}
            >
              <LayoutGrid className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => onViewModeChange('list')}
              title={isEn ? 'List view' : '列表视图'}
              className={`flex items-center justify-center h-8 w-8 transition-colors ${
                viewMode === 'list'
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-muted'
              }`}
            >
              <ListIcon className="h-4 w-4" />
            </button>
          </div>
          <Button onClick={onAddAccount}>
            <Plus className="h-4 w-4 mr-1" />
            {isEn ? 'Add' : '添加账号'}
          </Button>
          {/* 快捷：一键发起 GitHub 无痕在线登录 */}
          <Button
            variant="outline"
            onClick={onQuickGithubLogin}
            title={isEn ? 'Quick GitHub login (private/incognito mode)' : '一键 GitHub 无痕登录（在线添加账号）'}
          >
            <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4 mr-1">
              <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
            </svg>
            GitHub
          </Button>
          <Button variant="outline" onClick={onImport}>
            <Upload className="h-4 w-4 mr-1" />
            {isEn ? 'Import' : '导入'}
          </Button>
          <Button variant="outline" onClick={onExport}>
            <Download className="h-4 w-4 mr-1" />
            {isEn ? 'Export' : '导出'}
          </Button>
        </div>
      </div>

      {/* 统计和选择操作 */}
      <div className="flex items-center justify-between">
        {/* 左侧：统计信息 */}
        <div className="flex items-center gap-4 text-sm">
          <span className="text-muted-foreground">
            {isEn ? '' : '共 '}<span className="font-medium text-foreground">{stats.total}</span> {isEn ? 'accounts' : '个账号'}
            {filteredCount !== stats.total && (
              <span>{isEn ? ', ' : '，已筛选 '}<span className="font-medium text-foreground">{filteredCount}</span> {isEn ? 'filtered' : '个'}</span>
            )}
          </span>
          {stats.expiringSoonCount > 0 && (
            <Badge variant="destructive" className="gap-1">
              {stats.expiringSoonCount} {isEn ? 'expiring' : '个即将到期'}
            </Badge>
          )}
        </div>

        {/* 右侧：选择操作和管理 - 缩小间距 */}
        <div className="flex items-center gap-1">
          {/* 生命周期 Tab：四类账号互斥显示 */}
           <div className="flex items-center gap-1 rounded-xl border border-[var(--glass-border)] bg-[var(--glass-bg-subtle)] p-1">
             {lifecycleTabs.map(({ key, icon, color }) => {
               const isActive = activeLifecycleTab === key
               return (
                 <button
                   key={key}
                   type="button"
                   onClick={() => setActiveLifecycleTab(key)}
                   className={cn(
                     'flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs transition-colors',
                     isActive ? 'bg-primary text-primary-foreground shadow-sm' : `hover:bg-muted ${color}`
                   )}
                   title={ACCOUNT_LIFECYCLE_LABELS[isEn ? 'en' : 'zh'][key]}
                 >
                   {icon}
                   <span>{ACCOUNT_LIFECYCLE_LABELS[isEn ? 'en' : 'zh'][key]}</span>
                   <span className="tabular-nums opacity-80">{lifecycleCounts[key]}</span>
                 </button>
               )
             })}
           </div>

           {/* 标签下拉菜单 — 纯图标 + tooltip，选中时右上角小红点提示有可操作下拉 */}
          <div className="relative" ref={tagMenuRef}>
            <Button
              variant={showTagMenu ? "default" : "ghost"}
              size="icon"
              className="h-8 w-8 relative"
              onClick={() => {
                if (selectedCount > 0) {
                  setShowTagMenu(!showTagMenu)
                 } else {
                  onManageTags()
                }
              }}
              title={selectedCount > 0
                ? (isEn ? `Set tags for ${selectedCount} selected` : `批量设置 ${selectedCount} 个选中账号的标签`)
                : (isEn ? 'Manage tags' : '管理标签')
              }
            >
              <Tag className="h-4 w-4" />
              {selectedCount > 0 && (
                <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-primary" />
              )}
            </Button>
            
            {showTagMenu && selectedCount > 0 && (
              <div className="absolute left-0 top-full mt-2 z-50 min-w-[220px] bg-popover border rounded-lg shadow-lg p-2">
                <div className="absolute -top-2 left-4 w-4 h-4 bg-popover border-l border-t rotate-45" />
                <div className="text-xs text-muted-foreground px-2 py-1 mb-1">
                  {isEn ? `${selectedCount} selected (multi)` : `已选 ${selectedCount} 个账户（可多选）`}
                </div>
                <div className="border-t my-1" />
                
                {/* 标签列表 */}
                <div className="max-h-[300px] overflow-y-auto">
                  {Array.from(tags.values()).map(tag => {
                    const { tagCounts, total } = getSelectedAccountsTagStatus()
                    const count = tagCounts.get(tag.id) || 0
                    const isAll = count === total
                    const isPartial = count > 0 && count < total
                    // tag.color 为 ARGB（#AARRGGBB），直接进 CSS 会被当作 #RRGGBBAA 解析成高透明度；必须经 toRgba 转换
                    const tagColor = toRgba(tag.color || '#888888')

                    return (
                      <button
                        key={tag.id}
                        className="w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded hover:bg-muted text-left"
                        onClick={() => handleToggleTag(tag.id)}
                      >
                        <div
                          className="w-4 h-4 rounded border flex items-center justify-center shrink-0"
                          style={{
                            backgroundColor: isAll ? tagColor : 'transparent',
                            borderColor: tagColor
                          }}
                        >
                          {isAll && <Check className="h-3 w-3 text-white" />}
                          {isPartial && <Minus className="h-3 w-3" style={{ color: tagColor }} />}
                        </div>
                        <span className="truncate flex-1">{tag.name}</span>
                        {isPartial && (
                          <span className="text-xs text-muted-foreground">{count}/{total}</span>
                        )}
                      </button>
                    )
                  })}
                </div>
                
                {tags.size === 0 && (
                  <div className="text-sm text-muted-foreground px-2 py-2 text-center">
                    {isEn ? 'No tags' : '暂无标签'}
                  </div>
                )}
                
                <div className="border-t my-1" />
                <button
                  className="w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded hover:bg-muted text-primary"
                  onClick={() => {
                    setShowTagMenu(false)
                    onManageTags()
                  }}
                >
                  <Plus className="h-4 w-4" />
                  <span>{isEn ? 'Manage tags' : '管理标签'}</span>
                </button>
              </div>
            )}
          </div>
          <Button
            variant={privacyMode ? "default" : "ghost"}
            size="icon"
            className="h-8 w-8"
            onClick={() => setPrivacyMode(!privacyMode)}
            title={privacyMode ? (isEn ? 'Disable privacy mode' : '关闭隐私模式') : (isEn ? 'Enable privacy mode' : '开启隐私模式')}
          >
            {privacyMode ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </Button>
          {/* 筛选按钮与气泡 */}
          <div className="relative">
            <Button
              variant={isFilterExpanded ? "default" : "ghost"}
              size="icon"
              className="h-8 w-8"
              onClick={onToggleFilter}
              title={isEn ? 'Toggle advanced filter' : '展开/收起高级筛选'}
            >
              <Filter className="h-4 w-4" />
            </Button>
            {/* 筛选气泡面板 */}
            {isFilterExpanded && (
              <div className="absolute right-0 top-full mt-2 z-50 min-w-[600px] bg-popover border rounded-lg shadow-lg">
                {/* 气泡箭头 */}
                <div className="absolute -top-2 right-4 w-4 h-4 bg-popover border-l border-t rotate-45" />
                <AccountFilterPanel />
              </div>
            )}
          </div>

          <div className="w-px h-6 bg-border mx-1" />

          {/* 批量操作 — 纯图标 + tooltip（带选中计数）*/}
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={handleBatchCheck}
            disabled={isChecking || selectedCount === 0 || (!!refreshProgress && !refreshProgress.silent)}
            title={selectedCount > 0
              ? (isEn ? `Check ${selectedCount} accounts info (usage / subscription / banned)` : `检查选中 ${selectedCount} 个账号信息：刷新用量、订阅详情、封禁状态`)
              : (isEn ? 'Check accounts info (select first)' : '检查账户信息（请先选中账号）')
            }
          >
            {/* 与 batchRefresh 区分图标：Activity 代表"查看状态/活动" */}
            {isChecking ? <Loader2 className="h-4 w-4 animate-spin" /> : <Activity className="h-4 w-4" />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-destructive hover:text-destructive hover:bg-destructive/10"
            onClick={handleBatchDelete}
            disabled={selectedCount === 0}
            title={selectedCount > 0
              ? (isEn ? `Delete ${selectedCount} selected accounts` : `删除选中的 ${selectedCount} 个账号`)
              : (isEn ? 'Delete (select first)' : '删除选中账号（请先选中账号）')
            }
          >
            <Trash2 className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={handleBatchRefresh}
            disabled={isRefreshing || selectedCount === 0 || (!!refreshProgress && !refreshProgress.silent)}
            title={selectedCount > 0
              ? (isEn ? `Refresh ${selectedCount} access tokens` : `刷新选中 ${selectedCount} 个账号的访问令牌`)
              : (isEn ? 'Refresh Token (select first)' : '刷新 Token（请先选中账号）')
            }
          >
            {/* 与 batchCheck 区分图标：KeyRound 代表"刷新令牌"，与 AccountCard 单账号视图一致 */}
            {isRefreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
          </Button>

          <div className="w-px h-6 bg-border mx-1" />

          {/* 全选 / 取消全选 */}
          <Button
            variant="ghost"
            size="sm"
            onClick={handleToggleSelectAll}
            title={
              selectedCount === filteredCount && filteredCount > 0
                ? (isEn ? 'Deselect all' : '取消全选')
                : (isEn ? 'Select all' : '全选')
            }
          >
            {selectedCount === filteredCount && filteredCount > 0 ? (
              <CheckSquare className="h-4 w-4 mr-1" />
            ) : (
              <Square className="h-4 w-4 mr-1" />
            )}
            {selectedCount > 0 ? (isEn ? `${selectedCount} sel` : `已选 ${selectedCount}`) : (isEn ? 'All' : '全选')}
          </Button>

          {/* 清除选中（仅多选时显示，独立明确入口） */}
          {selectedCount > 0 && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
              onClick={() => deselectAll()}
              title={isEn ? `Clear ${selectedCount} selected` : `清除 ${selectedCount} 个选中`}
            >
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
