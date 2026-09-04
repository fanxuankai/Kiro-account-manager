import { create } from 'zustand'
import { v4 as uuidv4 } from 'uuid'
import type {
  Account,
  AccountGroup,
  AccountTag,
  AccountFilter,
  AccountSort,
  AccountStatus,
  AccountStats,
  AccountExportData,
  AccountImportItem,
  BatchOperationResult
} from '../types/account'
import { isBannedAccountError } from './accounts'

// ============================================
// 闲置账号库 Store（与主账号库物理隔离）
// ============================================
// 存放不需要保活/刷新的账号，数据经独立 IPC（load/save-idle-accounts）
// 落在独立 SQLite 文件 kiro-idle-accounts.db，与主库零交集：
//  - 主进程 token 刷新调度器只读主库，闲置账号永不被刷新
//  - 不进代理账号池、托盘、首页统计、订阅页批量操作
// 本 store 无任何定时器与网络调用，是纯离线的凭据仓库。

// 生成随机 64 位十六进制设备 ID（与主 store 一致）
function generateRandomMachineId(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

// 持久化防抖（机制与主 store 相同：500ms 合并 + 5s 强制落盘）
const SAVE_DEBOUNCE_MS = 500
const SAVE_MAX_WAIT_MS = 5000
let saveDebounceTimer: ReturnType<typeof setTimeout> | null = null
let saveMaxWaitTimer: ReturnType<typeof setTimeout> | null = null
let saveInFlight: Promise<void> | null = null
let savePendingResolvers: Array<() => void> = []

// getFilteredAccounts / getStats 引用缓存（同主 store 机制）
let _filterCache: {
  accounts: unknown
  filter: unknown
  sort: unknown
  activeGroupTab: unknown
  output: Account[]
} | null = null

let _statsCache: {
  accounts: unknown
  output: AccountStats
} | null = null

export interface IdleAccountsState {
  appVersion: string
  accounts: Map<string, Account>
  groups: Map<string, AccountGroup>
  tags: Map<string, AccountTag>

  filter: AccountFilter
  /** 当前激活的分组 Tab：'all' | 'ungrouped' | <groupId>，互斥 */
  activeGroupTab: string
  sort: AccountSort
  selectedIds: Set<string>

  isLoading: boolean
  isSyncing: boolean

  // 隐私模式（独立于主库开关，持久化在闲置库）
  privacyMode: boolean
}

export interface IdleAccountsActions {
  // 账号 CRUD
  addAccount: (account: Omit<Account, 'id' | 'createdAt' | 'isActive'>) => string
  updateAccount: (id: string, updates: Partial<Account>) => void
  removeAccount: (id: string) => void
  removeAccounts: (ids: string[]) => BatchOperationResult
  /** 接收从另一库移动过来的完整账号（保留 id/创建时间/凭证等，按 id 与 邮箱+provider 去重） */
  receiveAccounts: (accounts: Account[]) => BatchOperationResult

  // 分组操作
  addGroup: (group: Omit<AccountGroup, 'id' | 'createdAt' | 'order'>) => string
  updateGroup: (id: string, updates: Partial<AccountGroup>) => void
  removeGroup: (id: string) => void
  moveAccountsToGroup: (accountIds: string[], groupId: string | undefined) => void

  // 标签操作
  addTag: (tag: Omit<AccountTag, 'id'>) => string
  updateTag: (id: string, updates: Partial<AccountTag>) => void
  removeTag: (id: string) => void
  addTagToAccounts: (accountIds: string[], tagId: string) => void
  removeTagFromAccounts: (accountIds: string[], tagId: string) => void

  // 筛选和排序
  setFilter: (filter: AccountFilter) => void
  clearFilter: () => void
  setActiveGroupTab: (tab: string) => void
  setSort: (sort: AccountSort) => void
  getFilteredAccounts: () => Account[]

  // 选择操作
  selectAccount: (id: string) => void
  deselectAccount: (id: string) => void
  selectAll: () => void
  deselectAll: () => void
  toggleSelection: (id: string) => void
  getSelectedAccounts: () => Account[]

  // 导入导出
  exportAccounts: (ids?: string[]) => AccountExportData
  importAccounts: (items: AccountImportItem[]) => BatchOperationResult
  importFromExportData: (data: AccountExportData) => BatchOperationResult

  // 状态（纯本地，无网络检查）
  updateAccountStatus: (id: string, status: AccountStatus, error?: string) => void

  // 统计
  getStats: () => AccountStats

  // 持久化
  loadFromStorage: () => Promise<void>
  saveToStorage: () => Promise<void>
  flushSaveImmediately: () => Promise<void>

  // 隐私模式
  setPrivacyMode: (enabled: boolean) => void
  maskEmail: (email: string) => string
  maskNickname: (nickname: string | undefined) => string
}

type IdleAccountsStore = IdleAccountsState & IdleAccountsActions

// 闲置库默认按入库时间倒序（最近移入/导入的排前面）
const defaultSort: AccountSort = { field: 'createdAt', order: 'desc' }

// 筛选/分组变化后把选中集裁剪到可见结果（同主 store 机制）
function pruneSelectionToVisible(selectedIds: Set<string>, visible: Account[]): Set<string> | null {
  if (selectedIds.size === 0) return null
  const visibleIds = new Set(visible.map((a) => a.id))
  const pruned = new Set(Array.from(selectedIds).filter((id) => visibleIds.has(id)))
  return pruned.size === selectedIds.size ? null : pruned
}

const defaultFilter: AccountFilter = {}

const loadActiveGroupTab = (): string => {
  try {
    return localStorage.getItem('idle_activeGroupTab') || 'all'
  } catch {
    return 'all'
  }
}

/** 防重复加载标记：App 启动加载一次后不再重复覆盖内存态 */
let idleLoadedOnce = false

export const useIdleAccountsStore = create<IdleAccountsStore>()((set, get) => ({
  appVersion: '1.0.0',
  accounts: new Map(),
  groups: new Map(),
  tags: new Map(),
  filter: defaultFilter,
  activeGroupTab: loadActiveGroupTab(),
  sort: defaultSort,
  selectedIds: new Set(),
  isLoading: false,
  isSyncing: false,
  privacyMode: false,

  // ==================== 账号 CRUD ====================

  addAccount: (accountData) => {
    const id = uuidv4()
    const now = Date.now()

    const machineId = accountData.machineId || generateRandomMachineId()

    const account: Account = {
      ...accountData,
      id,
      machineId,
      createdAt: now,
      lastUsedAt: now,
      isActive: false,
      tags: accountData.tags || []
    }

    set((state) => {
      const accounts = new Map(state.accounts)
      accounts.set(id, account)
      return { accounts }
    })

    get().saveToStorage()
    return id
  },

  updateAccount: (id, updates) => {
    set((state) => {
      const accounts = new Map(state.accounts)
      const account = accounts.get(id)
      if (account) {
        accounts.set(id, { ...account, ...updates })
      }
      return { accounts }
    })
    get().saveToStorage()
  },

  removeAccount: (id) => {
    set((state) => {
      const accounts = new Map(state.accounts)
      accounts.delete(id)

      const selectedIds = new Set(state.selectedIds)
      selectedIds.delete(id)

      return { accounts, selectedIds }
    })
    get().saveToStorage()
  },

  removeAccounts: (ids) => {
    const result: BatchOperationResult = { success: 0, failed: 0, errors: [] }

    set((state) => {
      const accounts = new Map(state.accounts)
      const selectedIds = new Set(state.selectedIds)

      for (const id of ids) {
        if (accounts.has(id)) {
          accounts.delete(id)
          selectedIds.delete(id)
          result.success++
        } else {
          result.failed++
          result.errors.push({ id, error: 'Account not found' })
        }
      }

      return { accounts, selectedIds }
    })

    get().saveToStorage()
    return result
  },

  receiveAccounts: (incoming) => {
    const result: BatchOperationResult = { success: 0, failed: 0, errors: [] }
    const existing = get().accounts

    // 去重：id 相同，或 邮箱+provider 相同（与 importFromExportData 口径一致）
    const isDuplicate = (acc: Account): boolean => {
      if (existing.has(acc.id)) return true
      for (const e of existing.values()) {
        if (acc.userId && e.userId === acc.userId) return true
        if (acc.email === e.email && acc.credentials?.provider === e.credentials?.provider) return true
      }
      return false
    }

    const toAdd: Account[] = []
    let skipped = 0
    for (const acc of incoming) {
      if (isDuplicate(acc)) {
        skipped++
        continue
      }
      // 'refreshing' 是主库进行中的瞬时状态，入库时归位为 unknown
      const status = acc.status === 'refreshing' ? 'unknown' : acc.status
      toAdd.push({ ...acc, isActive: false, status })
      result.success++
    }

    if (toAdd.length > 0) {
      set((state) => {
        const accounts = new Map(state.accounts)
        for (const acc of toAdd) accounts.set(acc.id, acc)
        return { accounts }
      })
      get().saveToStorage()
    }

    if (skipped > 0) {
      result.errors.push({ id: 'skipped', error: `跳过 ${skipped} 个已存在的账号` })
    }
    return result
  },

  // ==================== 分组操作 ====================

  addGroup: (groupData) => {
    const id = uuidv4()
    const { groups } = get()

    const group: AccountGroup = {
      ...groupData,
      id,
      order: groups.size,
      createdAt: Date.now()
    }

    set((state) => {
      const groups = new Map(state.groups)
      groups.set(id, group)
      return { groups }
    })

    get().saveToStorage()
    return id
  },

  updateGroup: (id, updates) => {
    set((state) => {
      const groups = new Map(state.groups)
      const group = groups.get(id)
      if (group) {
        groups.set(id, { ...group, ...updates })
      }
      return { groups }
    })
    get().saveToStorage()
  },

  removeGroup: (id) => {
    set((state) => {
      const groups = new Map(state.groups)
      groups.delete(id)

      // 移除账号的分组引用
      const accounts = new Map(state.accounts)
      for (const [accountId, account] of accounts) {
        if (account.groupId === id) {
          accounts.set(accountId, { ...account, groupId: undefined })
        }
      }

      return { groups, accounts }
    })
    get().saveToStorage()
  },

  moveAccountsToGroup: (accountIds, groupId) => {
    set((state) => {
      const accounts = new Map(state.accounts)
      for (const id of accountIds) {
        const account = accounts.get(id)
        if (account) {
          accounts.set(id, { ...account, groupId })
        }
      }
      return { accounts }
    })
    get().saveToStorage()
  },

  // ==================== 标签操作 ====================

  addTag: (tagData) => {
    const id = uuidv4()

    const tag: AccountTag = { ...tagData, id }

    set((state) => {
      const tags = new Map(state.tags)
      tags.set(id, tag)
      return { tags }
    })

    get().saveToStorage()
    return id
  },

  updateTag: (id, updates) => {
    set((state) => {
      const tags = new Map(state.tags)
      const tag = tags.get(id)
      if (tag) {
        tags.set(id, { ...tag, ...updates })
      }
      return { tags }
    })
    get().saveToStorage()
  },

  removeTag: (id) => {
    set((state) => {
      const tags = new Map(state.tags)
      tags.delete(id)

      // 移除账号的标签引用
      const accounts = new Map(state.accounts)
      for (const [accountId, account] of accounts) {
        if (account.tags.includes(id)) {
          accounts.set(accountId, {
            ...account,
            tags: account.tags.filter((t) => t !== id)
          })
        }
      }

      return { tags, accounts }
    })
    get().saveToStorage()
  },

  addTagToAccounts: (accountIds, tagId) => {
    set((state) => {
      const accounts = new Map(state.accounts)
      for (const id of accountIds) {
        const account = accounts.get(id)
        if (account && !account.tags.includes(tagId)) {
          accounts.set(id, { ...account, tags: [...account.tags, tagId] })
        }
      }
      return { accounts }
    })
    get().saveToStorage()
  },

  removeTagFromAccounts: (accountIds, tagId) => {
    set((state) => {
      const accounts = new Map(state.accounts)
      for (const id of accountIds) {
        const account = accounts.get(id)
        if (account) {
          accounts.set(id, {
            ...account,
            tags: account.tags.filter((t) => t !== tagId)
          })
        }
      }
      return { accounts }
    })
    get().saveToStorage()
  },

  // ==================== 筛选和排序 ====================

  setFilter: (filter) => {
    set({ filter })
    const pruned = pruneSelectionToVisible(get().selectedIds, get().getFilteredAccounts())
    if (pruned) set({ selectedIds: pruned })
  },

  clearFilter: () => {
    set({ filter: defaultFilter })
  },

  setActiveGroupTab: (tab) => {
    try { localStorage.setItem('idle_activeGroupTab', tab) } catch { /* no-op */ }
    set({ activeGroupTab: tab })
    const pruned = pruneSelectionToVisible(get().selectedIds, get().getFilteredAccounts())
    if (pruned) set({ selectedIds: pruned })
  },

  setSort: (sort) => {
    set({ sort })
  },

  getFilteredAccounts: () => {
    const { accounts, filter, sort, activeGroupTab } = get()

    if (
      _filterCache &&
      _filterCache.accounts === accounts &&
      _filterCache.filter === filter &&
      _filterCache.sort === sort &&
      _filterCache.activeGroupTab === activeGroupTab
    ) {
      return _filterCache.output
    }

    let result = Array.from(accounts.values())

    // 优先按分组 Tab 互斥过滤（与 filter.groupIds 独立）
    if (activeGroupTab === 'ungrouped') {
      result = result.filter((a) => !a.groupId)
    } else if (activeGroupTab !== 'all') {
      result = result.filter((a) => a.groupId === activeGroupTab)
    }

    // 应用筛选
    if (filter.search) {
      const search = filter.search.toLowerCase()
      result = result.filter(
        (a) =>
          a.email.toLowerCase().includes(search) ||
          a.nickname?.toLowerCase().includes(search)
      )
    }

    if (filter.subscriptionTypes?.length) {
      result = result.filter((a) => filter.subscriptionTypes!.includes(a.subscription.type))
    }

    if (filter.statuses?.length) {
      result = result.filter((a) => filter.statuses!.includes(a.status))
    }

    if (filter.idps?.length) {
      result = result.filter((a) => filter.idps!.includes(a.idp))
    }

    if (filter.groupIds?.length) {
      result = result.filter((a) => a.groupId && filter.groupIds!.includes(a.groupId))
    }

    if (filter.tagIds?.length) {
      result = result.filter((a) => filter.tagIds!.some((t) => a.tags.includes(t)))
    }

    if (filter.emailDomains?.length) {
      result = result.filter((a) => {
        const atIndex = a.email.lastIndexOf('@')
        if (atIndex < 0) return false
        const domain = a.email.slice(atIndex + 1).toLowerCase()
        return filter.emailDomains!.includes(domain)
      })
    }

    if (filter.usageMin !== undefined) {
      result = result.filter((a) => a.usage.percentUsed >= filter.usageMin!)
    }

    if (filter.usageMax !== undefined) {
      result = result.filter((a) => a.usage.percentUsed <= filter.usageMax!)
    }

    if (filter.daysRemainingMin !== undefined) {
      result = result.filter(
        (a) => a.subscription.daysRemaining !== undefined &&
               a.subscription.daysRemaining >= filter.daysRemainingMin!
      )
    }

    if (filter.daysRemainingMax !== undefined) {
      result = result.filter(
        (a) => a.subscription.daysRemaining !== undefined &&
               a.subscription.daysRemaining <= filter.daysRemainingMax!
      )
    }

    // 添加日期区间过滤
    if (filter.createdAtMin !== undefined) {
      result = result.filter((a) => a.createdAt >= filter.createdAtMin!)
    }

    if (filter.createdAtMax !== undefined) {
      result = result.filter((a) => a.createdAt <= filter.createdAtMax!)
    }

    // 封禁筛选
    if (filter.bannedOnly) {
      result = result.filter((a) => isBannedAccountError(a.lastError))
    }

    // 应用排序
    result.sort((a, b) => {
      let cmp = 0

      switch (sort.field) {
        case 'email':
          cmp = a.email.localeCompare(b.email)
          break
        case 'nickname':
          cmp = (a.nickname ?? '').localeCompare(b.nickname ?? '')
          break
        case 'subscription':
          cmp = a.subscription.type.localeCompare(b.subscription.type)
          break
        case 'usage':
          cmp = a.usage.percentUsed - b.usage.percentUsed
          break
        case 'daysRemaining':
          cmp = (a.subscription.daysRemaining ?? 999) - (b.subscription.daysRemaining ?? 999)
          break
        case 'lastUsedAt':
          cmp = a.lastUsedAt - b.lastUsedAt
          break
        case 'createdAt':
          cmp = a.createdAt - b.createdAt
          break
        case 'status':
          cmp = a.status.localeCompare(b.status)
          break
      }

      return sort.order === 'desc' ? -cmp : cmp
    })

    _filterCache = { accounts, filter, sort, activeGroupTab, output: result }
    return result
  },

  // ==================== 选择操作 ====================

  selectAccount: (id) => {
    set((state) => {
      const selectedIds = new Set(state.selectedIds)
      selectedIds.add(id)
      return { selectedIds }
    })
  },

  deselectAccount: (id) => {
    set((state) => {
      const selectedIds = new Set(state.selectedIds)
      selectedIds.delete(id)
      return { selectedIds }
    })
  },

  selectAll: () => {
    const filtered = get().getFilteredAccounts()
    set({ selectedIds: new Set(filtered.map((a) => a.id)) })
  },

  deselectAll: () => {
    set({ selectedIds: new Set() })
  },

  toggleSelection: (id) => {
    set((state) => {
      const selectedIds = new Set(state.selectedIds)
      if (selectedIds.has(id)) {
        selectedIds.delete(id)
      } else {
        selectedIds.add(id)
      }
      return { selectedIds }
    })
  },

  getSelectedAccounts: () => {
    const { accounts, selectedIds } = get()
    return Array.from(selectedIds)
      .map((id) => accounts.get(id))
      .filter((a): a is Account => a !== undefined)
  },

  // ==================== 导入导出 ====================

  exportAccounts: (ids) => {
    const { accounts, groups, tags, appVersion } = get()

    let exportAccounts: Account[]
    if (ids?.length) {
      exportAccounts = ids
        .map((id) => accounts.get(id))
        .filter((a): a is Account => a !== undefined)
    } else {
      exportAccounts = Array.from(accounts.values())
    }

    const data: AccountExportData = {
      version: appVersion,
      exportedAt: Date.now(),
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      accounts: exportAccounts.map(({ isActive, ...rest }) => rest),
      groups: Array.from(groups.values()),
      tags: Array.from(tags.values())
    }

    return data
  },

  importAccounts: (items) => {
    const result: BatchOperationResult = { success: 0, failed: 0, errors: [] }

    const validIdps = ['Google', 'Github', 'BuilderId'] as const
    const normalizeIdp = (idp?: string): 'Google' | 'Github' | 'BuilderId' => {
      if (!idp) return 'Google'
      const normalized = validIdps.find(v => v.toLowerCase() === idp.toLowerCase())
      return normalized || 'Google'
    }

    const newAccounts: Account[] = []
    for (const item of items) {
      try {
        const now = Date.now()
        const id = uuidv4()
        const machineId = generateRandomMachineId()

        const account: Account = {
          id,
          createdAt: now,
          isActive: false,
          machineId,
          email: item.email,
          password: item.password,
          nickname: item.nickname,
          idp: normalizeIdp(item.idp as string),
          credentials: {
            accessToken: item.accessToken || '',
            csrfToken: item.csrfToken || '',
            refreshToken: item.refreshToken,
            clientId: item.clientId,
            clientSecret: item.clientSecret,
            region: item.region || 'us-east-1',
            expiresAt: now + 3600 * 1000
          },
          subscription: {
            type: 'Free'
          },
          usage: {
            current: 0,
            limit: 25,
            percentUsed: 0,
            lastUpdated: now
          },
          groupId: item.groupId,
          tags: item.tags ?? [],
          status: 'unknown',
          lastUsedAt: now
        }
        newAccounts.push(account)
        result.success++
      } catch (error) {
        result.failed++
        result.errors.push({
          id: item.email,
          error: error instanceof Error ? error.message : 'Unknown error'
        })
      }
    }

    if (newAccounts.length > 0) {
      set((state) => {
        const accounts = new Map(state.accounts)
        for (const account of newAccounts) {
          accounts.set(account.id, account)
        }
        return { accounts }
      })
      get().saveToStorage()
    }

    return result
  },

  importFromExportData: (data) => {
    const result: BatchOperationResult = { success: 0, failed: 0, errors: [] }
    const { accounts: existingAccounts } = get()

    const isAccountExists = (email: string, userId?: string, provider?: string): boolean => {
      return Array.from(existingAccounts.values()).some(acc => {
        if (userId && acc.userId === userId) return true
        if (acc.email === email && acc.credentials.provider === provider) return true
        return false
      })
    }

    const seenEmails = new Set<string>()
    const seenUserIds = new Set<string>()
    const uniqueAccounts = data.accounts.filter(acc => {
      if (seenEmails.has(acc.email) || (acc.userId && seenUserIds.has(acc.userId))) {
        return false
      }
      seenEmails.add(acc.email)
      if (acc.userId) seenUserIds.add(acc.userId)
      return true
    })

    let skipped = 0
    const accountsToAdd: Account[] = []

    for (const accountData of uniqueAccounts) {
      if (isAccountExists(accountData.email, accountData.userId, accountData.credentials?.provider)) {
        skipped++
        continue
      }
      accountsToAdd.push({ ...accountData, isActive: false })
      result.success++
    }

    if (data.groups.length > 0 || data.tags.length > 0 || accountsToAdd.length > 0) {
      set((state) => {
        const groups = data.groups.length > 0 ? new Map(state.groups) : state.groups
        if (data.groups.length > 0) {
          for (const group of data.groups) groups.set(group.id, group)
        }
        const tags = data.tags.length > 0 ? new Map(state.tags) : state.tags
        if (data.tags.length > 0) {
          for (const tag of data.tags) tags.set(tag.id, tag)
        }
        const accounts = accountsToAdd.length > 0 ? new Map(state.accounts) : state.accounts
        if (accountsToAdd.length > 0) {
          for (const acc of accountsToAdd) accounts.set(acc.id, acc)
        }
        return { groups, tags, accounts }
      })
    }

    if (skipped > 0) {
      result.errors.push({
        id: 'skipped',
        error: `跳过 ${skipped} 个已存在的账号`
      })
    }

    get().saveToStorage()
    return result
  },

  // ==================== 状态管理（纯本地） ====================

  updateAccountStatus: (id, status, error) => {
    set((state) => {
      const accounts = new Map(state.accounts)
      const account = accounts.get(id)
      if (account) {
        accounts.set(id, {
          ...account,
          status,
          lastError: error
        })
      }
      return { accounts }
    })
    get().saveToStorage()
  },

  // ==================== 统计 ====================

  getStats: () => {
    const { accounts } = get()

    if (_statsCache && _statsCache.accounts === accounts) {
      return _statsCache.output
    }

    const accountList = Array.from(accounts.values())

    const stats: AccountStats = {
      total: accountList.length,
      byStatus: {
        active: 0,
        expired: 0,
        error: 0,
        refreshing: 0,
        unknown: 0
      },
      bySubscription: {
        Free: 0,
        Pro: 0,
        Pro_Plus: 0,
        Pro_Max: 0,
        Enterprise: 0,
        Teams: 0
      },
      byIdp: {
        Google: 0,
        Github: 0,
        BuilderId: 0,
        Enterprise: 0,
        AWSIdC: 0,
        Internal: 0,
        IAM_SSO: 0
      },
      activeCount: 0,
      expiringSoonCount: 0,
      bannedCount: 0
    }

    for (const account of accountList) {
      stats.byStatus[account.status]++
      stats.bySubscription[account.subscription.type]++
      stats.byIdp[account.idp]++

      if (account.subscription.daysRemaining !== undefined &&
          account.subscription.daysRemaining <= 7) {
        stats.expiringSoonCount++
      }
      if (isBannedAccountError(account.lastError)) {
        stats.bannedCount++
      }
    }

    _statsCache = { accounts, output: stats }
    return stats
  },

  // ==================== 持久化 ====================

  loadFromStorage: async () => {
    if (idleLoadedOnce) return
    idleLoadedOnce = true
    set({ isLoading: true })

    try {
      const appVersion = await window.api.getAppVersion()
      set({ appVersion })

      const data = await window.api.loadIdleAccounts() as {
        accounts?: Record<string, Account>
        groups?: Record<string, AccountGroup>
        tags?: Record<string, AccountTag>
        privacyMode?: boolean
      } | null

      if (data) {
        set({
          accounts: new Map(Object.entries(data.accounts ?? {}) as [string, Account][]),
          groups: new Map(Object.entries(data.groups ?? {}) as [string, AccountGroup][]),
          tags: new Map(Object.entries(data.tags ?? {}) as [string, AccountTag][]),
          privacyMode: data.privacyMode ?? false
        })
      }
    } catch (error) {
      console.error('Failed to load idle accounts:', error)
    } finally {
      set({ isLoading: false })
    }
  },

  saveToStorage: async () => {
    return new Promise<void>((resolve) => {
      savePendingResolvers.push(resolve)
      const flushNow = async (): Promise<void> => {
        if (saveDebounceTimer) { clearTimeout(saveDebounceTimer); saveDebounceTimer = null }
        if (saveMaxWaitTimer) { clearTimeout(saveMaxWaitTimer); saveMaxWaitTimer = null }
        const resolvers = savePendingResolvers
        savePendingResolvers = []
        await get().flushSaveImmediately()
        for (const r of resolvers) r()
      }
      if (saveDebounceTimer) clearTimeout(saveDebounceTimer)
      saveDebounceTimer = setTimeout(flushNow, SAVE_DEBOUNCE_MS)
      if (!saveMaxWaitTimer) {
        saveMaxWaitTimer = setTimeout(flushNow, SAVE_MAX_WAIT_MS)
      }
    })
  },

  flushSaveImmediately: async () => {
    if (saveDebounceTimer) { clearTimeout(saveDebounceTimer); saveDebounceTimer = null }
    if (saveMaxWaitTimer) { clearTimeout(saveMaxWaitTimer); saveMaxWaitTimer = null }
    const pending = savePendingResolvers
    savePendingResolvers = []
    if (saveInFlight) {
      const inflight = saveInFlight
      void inflight.then(() => { for (const r of pending) r() })
      return inflight
    }

    const { accounts, groups, tags, privacyMode } = get()

    set({ isSyncing: true })

    saveInFlight = (async () => {
      try {
        await window.api.saveIdleAccounts({
          accounts: Object.fromEntries(accounts),
          groups: Object.fromEntries(groups),
          tags: Object.fromEntries(tags),
          privacyMode
        })
      } catch (error) {
        console.error('Failed to save idle accounts:', error)
      } finally {
        set({ isSyncing: false })
        saveInFlight = null
        for (const r of pending) r()
      }
    })()

    return saveInFlight
  },

  // ==================== 隐私模式 ====================

  setPrivacyMode: (enabled) => {
    set({ privacyMode: enabled })
    get().saveToStorage()
  },

  maskEmail: (email) => {
    if (!get().privacyMode || !email) return email
    const hash = email.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0)
    const maskedName = `user${(hash % 100000).toString().padStart(5, '0')}`
    return `${maskedName}@***.com`
  },

  maskNickname: (nickname) => {
    if (!get().privacyMode || !nickname) return nickname || ''
    const hash = nickname.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0)
    return `用户${(hash % 100000).toString().padStart(5, '0')}`
  }
}))
