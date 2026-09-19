import { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import { Button, Badge } from '../ui'
import { useIdleAccountsStore } from '@/store/idleAccounts'
import { useTranslation } from '@/hooks/useTranslation'
import { AccountFilterPanel } from '../accounts/AccountFilter'
import { toRgba } from '../accounts/_helpers'
import {
  Search,
  Plus,
  Upload,
  Download,
  Trash2,
  Tag,
  CheckSquare,
  Square,
  Eye,
  EyeOff,
  Filter,
  Check,
  X,
  Minus,
  LayoutGrid,
  List as ListIcon,
  Undo2
} from 'lucide-react'

export type IdleViewMode = 'grid' | 'list'

interface IdleToolbarProps {
  onAddAccount: () => void
  onImport: () => void
  onExport: () => void
  /** 批量移回账号管理（主库） */
  onRestore: () => void
  viewMode: IdleViewMode
  onViewModeChange: (mode: IdleViewMode) => void
  onManageTags: () => void
  isFilterExpanded: boolean
  onToggleFilter: () => void
}

// 闲置库工具栏：与账号管理工具栏视觉一致，去掉保活/刷新/检查/测活/代理绑定等联网入口，
// 新增「移回账号管理」批量操作
export function IdleToolbar({
  onAddAccount,
  onImport,
  onExport,
  onRestore,
  viewMode,
  onViewModeChange,
  onManageTags,
  isFilterExpanded,
  onToggleFilter
}: IdleToolbarProps): React.ReactNode {
  const {
    filter,
    setFilter,
    selectedIds,
    selectAll,
    deselectAll,
    removeAccounts,
    getFilteredAccounts,
    getStats,
    privacyMode,
    setPrivacyMode,
    tags,
    accounts,
    addTagToAccounts,
    removeTagFromAccounts,
  } = useIdleAccountsStore()

  const [showTagMenu, setShowTagMenu] = useState(false)

  const tagMenuRef = useRef<HTMLDivElement>(null)

  // 点击外部关闭菜单
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent): void => {
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
  const handleAddTag = (tagId: string): void => {
    if (selectedIds.size === 0) return
    addTagToAccounts(Array.from(selectedIds), tagId)
  }

  const handleRemoveTag = (tagId: string): void => {
    if (selectedIds.size === 0) return
    removeTagFromAccounts(Array.from(selectedIds), tagId)
  }

  const handleToggleTag = (tagId: string): void => {
    const { tagCounts, total } = getSelectedAccountsTagStatus()
    const count = tagCounts.get(tagId) || 0

    if (count === total) {
      handleRemoveTag(tagId)
    } else {
      handleAddTag(tagId)
    }
  }

  const { t } = useTranslation()
  const isEn = t('common.unknown') === 'Unknown'
  const stats = getStats()
  const filteredCount = getFilteredAccounts().length
  const selectedCount = selectedIds.size

  const handleSearch = (value: string): void => {
    setFilter({ ...filter, search: value || undefined })
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
            placeholder={isEn ? 'Search idle accounts...' : '搜索闲置账号...'}
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
            {isEn ? '' : '共 '}<span className="font-medium text-foreground">{stats.total}</span> {isEn ? 'idle accounts' : '个闲置账号'}
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
                    // tag.color 为 ARGB（#AARRGGBB），必须经 toRgba 转换
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
                <AccountFilterPanel useStore={useIdleAccountsStore} />
              </div>
            )}
          </div>

          <div className="w-px h-6 bg-border mx-1" />

          {/* 批量操作 — 移回账号管理 / 删除（纯图标 + tooltip，带选中计数） */}
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 hover:bg-primary/10 hover:text-primary"
            onClick={onRestore}
            disabled={selectedCount === 0}
            title={selectedCount > 0
              ? (isEn ? `Restore ${selectedCount} accounts to Account Manager` : `把选中的 ${selectedCount} 个账号移回账号管理（恢复保活）`)
              : (isEn ? 'Restore to Account Manager (select first)' : '移回账号管理（请先选中账号）')
            }
          >
            <Undo2 className="h-4 w-4" />
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
