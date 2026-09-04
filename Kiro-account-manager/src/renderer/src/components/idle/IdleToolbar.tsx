import { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import { Button, Badge } from '../ui'
import { useIdleAccountsStore } from '@/store/idleAccounts'
import { useTranslation } from '@/hooks/useTranslation'
import { AccountFilterPanel } from '../accounts/AccountFilter'
import { toRgba } from '../accounts/_helpers'
import { cn } from '@/lib/utils'
import {
  Search,
  Plus,
  Upload,
  Download,
  Trash2,
  Tag,
  FolderPlus,
  CheckSquare,
  Square,
  Eye,
  EyeOff,
  Filter,
  ChevronDown,
  Check,
  X,
  Minus,
  LayoutGrid,
  List as ListIcon,
  Users,
  Inbox,
  ArrowRightLeft,
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
  onManageGroups: () => void
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
  onManageGroups,
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
    groups,
    tags,
    accounts,
    moveAccountsToGroup,
    addTagToAccounts,
    removeTagFromAccounts,
    activeGroupTab,
    setActiveGroupTab
  } = useIdleAccountsStore()

  const [showGroupMenu, setShowGroupMenu] = useState(false)
  const [showTagMenu, setShowTagMenu] = useState(false)

  const groupMenuRef = useRef<HTMLDivElement>(null)
  const tagMenuRef = useRef<HTMLDivElement>(null)

  // 点击外部关闭菜单
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent): void => {
      if (groupMenuRef.current && !groupMenuRef.current.contains(e.target as Node)) {
        setShowGroupMenu(false)
      }
      if (tagMenuRef.current && !tagMenuRef.current.contains(e.target as Node)) {
        setShowTagMenu(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  // 获取选中账户的分组状态（useMemo 缓存，避免每次渲染重算 O(N)）
  const selectedGroupStatus = useMemo(() => {
    const selectedAccounts = Array.from(selectedIds).map(id => accounts.get(id)).filter(Boolean)
    const groupCounts = new Map<string | undefined, number>()
    selectedAccounts.forEach(acc => {
      if (acc) {
        const gid = acc.groupId
        groupCounts.set(gid, (groupCounts.get(gid) || 0) + 1)
      }
    })
    return { selectedAccounts, groupCounts }
  }, [selectedIds, accounts])

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

  // 兼容入口：保持与主工具栏一致的调用签名
  const getSelectedAccountsGroupStatus = useCallback(() => selectedGroupStatus, [selectedGroupStatus])
  const getSelectedAccountsTagStatus = useCallback(() => selectedTagStatus, [selectedTagStatus])

  // 处理分组操作
  const handleMoveToGroup = (groupId: string | undefined): void => {
    if (selectedIds.size === 0) return
    moveAccountsToGroup(Array.from(selectedIds), groupId)
    setShowGroupMenu(false)
  }

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

  // 分组 Tab 计数（全部 / 未分组 / 各分组）
  const tabCounts = useMemo(() => {
    const all = accounts.size
    let ungrouped = 0
    const byGroup = new Map<string, number>()
    for (const acc of accounts.values()) {
      if (!acc.groupId) {
        ungrouped++
      } else {
        byGroup.set(acc.groupId, (byGroup.get(acc.groupId) || 0) + 1)
      }
    }
    return { all, ungrouped, byGroup }
  }, [accounts])

  // 用户分组按 order 升序
  const sortedGroups = useMemo(
    () => Array.from(groups.values()).sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
    [groups]
  )

  // 当前激活 Tab 的展示信息（用于按钮文字 + 颜色圆点）
  const activeTabInfo = useMemo(() => {
    if (activeGroupTab === 'all') {
      return {
        label: isEn ? 'All' : '全部',
        color: undefined as string | undefined,
        icon: <Users className="h-4 w-4 mr-1.5" />,
        count: tabCounts.all
      }
    }
    if (activeGroupTab === 'ungrouped') {
      return {
        label: isEn ? 'Ungrouped' : '未分组',
        color: undefined as string | undefined,
        icon: <Inbox className="h-4 w-4 mr-1.5" />,
        count: tabCounts.ungrouped
      }
    }
    const g = groups.get(activeGroupTab)
    if (g) {
      return {
        label: g.name,
        color: g.color ? toRgba(g.color) : undefined,
        icon: <FolderPlus className="h-4 w-4 mr-1.5" />,
        count: tabCounts.byGroup.get(g.id) || 0
      }
    }
    // 兜底：activeGroupTab 是失效的 groupId（分组被删了）→ 回退到全部
    return {
      label: isEn ? 'All' : '全部',
      color: undefined as string | undefined,
      icon: <Users className="h-4 w-4 mr-1.5" />,
      count: tabCounts.all
    }
  }, [activeGroupTab, groups, tabCounts, isEn])

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
          {/* 分组按钮 — 切换视图 + 批量移动 + 管理 三合一 */}
          <div className="relative" ref={groupMenuRef}>
            <Button
              variant={showGroupMenu ? "default" : "ghost"}
              size="sm"
              onClick={() => {
                setShowGroupMenu(!showGroupMenu)
                setShowTagMenu(false)
              }}
              title={isEn ? 'Switch group view / Manage' : '切换分组视图 / 管理'}
            >
              {activeTabInfo.color ? (
                <span
                  className="w-2.5 h-2.5 rounded-full mr-1.5 flex-shrink-0"
                  style={{ backgroundColor: activeTabInfo.color }}
                />
              ) : (
                activeTabInfo.icon
              )}
              <span className="truncate max-w-[100px]">{activeTabInfo.label}</span>
              <Badge variant="secondary" className="ml-1.5 h-4 px-1 text-[10px] tabular-nums">
                {activeTabInfo.count}
              </Badge>
              <ChevronDown className="h-3 w-3 ml-1" />
            </Button>

            {showGroupMenu && (() => {
              const { groupCounts: selGroupCounts, selectedAccounts: selAccs } = selectedCount > 0
                ? getSelectedAccountsGroupStatus()
                : { groupCounts: new Map<string | undefined, number>(), selectedAccounts: [] as unknown[] }
              const renderTile = (
                key: string,
                isActive: boolean,
                onSwitch: () => void,
                icon: React.ReactNode,
                label: string,
                count: number,
                accentColor?: string,
                moveAction?: { selCount: number; isAllInGroup: boolean; onMove: () => void }
              ): React.ReactNode => (
                <div
                  key={key}
                  className={cn(
                    'group relative rounded-md transition-colors',
                    isActive ? '' : 'hover:bg-muted'
                  )}
                  style={isActive && accentColor ? {
                    backgroundColor: accentColor.replace(/[\d.]+\)$/, '0.12)')
                  } : isActive ? {
                    backgroundColor: 'var(--color-primary)',
                    opacity: 0.92
                  } : undefined}
                >
                  <button
                    className={cn(
                      'w-full flex items-center gap-1.5 px-2 py-1.5 text-sm rounded-md text-left',
                      isActive && !accentColor && 'text-primary-foreground'
                    )}
                    style={isActive && accentColor ? { color: accentColor } : undefined}
                    onClick={onSwitch}
                  >
                    {icon}
                    <span className="truncate flex-1 text-xs font-medium">{label}</span>
                    <span className={cn(
                      'text-[10px] tabular-nums',
                      isActive ? (accentColor ? '' : 'text-primary-foreground/80') : 'text-muted-foreground'
                    )}>
                      {count}
                    </span>
                    {isActive && <Check className="h-3 w-3 ml-0.5" />}
                  </button>
                  {/* 行尾批量移动快捷按钮 — 仅选中账户时显示 */}
                  {moveAction && (
                    <button
                      className={cn(
                        'absolute right-1 top-1/2 -translate-y-1/2 h-5 w-5 rounded flex items-center justify-center transition-all',
                        'opacity-0 group-hover:opacity-100',
                        moveAction.isAllInGroup
                          ? 'bg-success/15 text-success'
                          : 'bg-background/80 text-muted-foreground hover:text-primary hover:bg-primary/10 shadow-sm'
                      )}
                      onClick={(e) => { e.stopPropagation(); moveAction.onMove() }}
                      title={moveAction.isAllInGroup
                        ? (isEn ? 'All selected already in this group' : '所有选中账户已在该组')
                        : (isEn ? `Move ${moveAction.selCount} selected here` : `移动选中 ${moveAction.selCount} 个账户到此`)
                      }
                    >
                      {moveAction.isAllInGroup ? <Check className="h-3 w-3" /> : <ArrowRightLeft className="h-3 w-3" />}
                    </button>
                  )}
                </div>
              )

              return (
                <div className="absolute left-0 top-full mt-2 z-50 w-[320px] max-h-[80vh] overflow-y-auto bg-popover border rounded-lg shadow-lg p-2">
                  <div className="absolute -top-2 left-4 w-4 h-4 bg-popover border-l border-t rotate-45" />

                  {/* === 区头：标题 + 选中提示 === */}
                  <div className="flex items-center justify-between px-2 py-1 mb-1">
                    <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                      {isEn ? 'Groups' : '分组'}
                    </span>
                    {selectedCount > 0 && (
                      <span className="flex items-center gap-1 text-[10px] text-primary">
                        <ArrowRightLeft className="h-3 w-3" />
                        {isEn ? `${selectedCount} selected` : `已选 ${selectedCount}`}
                      </span>
                    )}
                  </div>

                  {/* === 2 列网格 === */}
                  <div className="grid grid-cols-2 gap-1">
                    {/* 全部 */}
                    {renderTile(
                      'all',
                      activeGroupTab === 'all',
                      () => { setActiveGroupTab('all'); setShowGroupMenu(false) },
                      <Users className="h-3.5 w-3.5 flex-shrink-0" />,
                      isEn ? 'All' : '全部',
                      tabCounts.all
                    )}
                    {/* 未分组 — 选中时可"移除分组" */}
                    {renderTile(
                      'ungrouped',
                      activeGroupTab === 'ungrouped',
                      () => { setActiveGroupTab('ungrouped'); setShowGroupMenu(false) },
                      <Inbox className="h-3.5 w-3.5 flex-shrink-0" />,
                      isEn ? 'Ungrouped' : '未分组',
                      tabCounts.ungrouped,
                      undefined,
                      selectedCount > 0 ? {
                        selCount: selectedCount,
                        isAllInGroup: (selGroupCounts.get(undefined) || 0) === selAccs.length,
                        onMove: () => handleMoveToGroup(undefined)
                      } : undefined
                    )}
                    {/* 用户分组 */}
                    {sortedGroups.map(group => {
                      const color = group.color ? toRgba(group.color) : undefined
                      const isActive = activeGroupTab === group.id
                      const count = tabCounts.byGroup.get(group.id) || 0
                      const selCountInGroup = selGroupCounts.get(group.id) || 0
                      const isAllInGroup = selCountInGroup === selAccs.length && selAccs.length > 0
                      return renderTile(
                        group.id,
                        isActive,
                        () => { setActiveGroupTab(group.id); setShowGroupMenu(false) },
                        <span
                          className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                          style={{ backgroundColor: color || 'var(--color-muted-foreground)' }}
                        />,
                        group.name,
                        count,
                        color,
                        selectedCount > 0 ? {
                          selCount: selectedCount,
                          isAllInGroup,
                          onMove: () => handleMoveToGroup(group.id)
                        } : undefined
                      )
                    })}
                  </div>

                  {/* === 管理分组 === */}
                  <div className="border-t my-2" />
                  <button
                    className="w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded hover:bg-muted text-primary"
                    onClick={() => { setShowGroupMenu(false); onManageGroups() }}
                  >
                    <FolderPlus className="h-3.5 w-3.5" />
                    <span>{isEn ? 'Manage groups' : '管理分组'}</span>
                  </button>

                  {/* === 选中提示（hover 行尾按钮即可移动） === */}
                  {selectedCount > 0 && (
                    <div className="text-[10px] text-muted-foreground px-2 pt-1 pb-0.5 italic">
                      {isEn
                        ? 'Tip: hover a tile and click ⇄ to move selected accounts here'
                        : '提示：将鼠标悬停到分组上，点击右侧 ⇄ 按钮即可批量移动选中账户'}
                    </div>
                  )}
                </div>
              )
            })()}
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
                  setShowGroupMenu(false)
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
