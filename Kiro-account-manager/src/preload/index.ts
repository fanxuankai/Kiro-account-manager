import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

/** Stripe 订阅门户账单快照（金额为分，时间为毫秒；与主进程 stripePortal.BillingSnapshot 结构一致） */
export interface StripeBillingSnapshot {
  planAmount?: number
  planCurrency?: string
  periodStart?: number
  periodEnd?: number
  currentCycleAmount?: number
  nextInvoiceAmount?: number
  nextInvoiceAt?: number
  cardBrand?: string
  cardLast4?: string
  cardExpMonth?: number
  cardExpYear?: number
  cardFunding?: string
  latestInvoiceAmount?: number
  latestInvoiceStatus?: string
  latestInvoiceAt?: number
  latestInvoiceUrl?: string
}

/** 号池条目视图（含明文凭据：表格「显示明文」开关用 + 打码展示位） */
export interface LoginPoolEntryView {
  id: string
  username: string
  state: 'unused' | 'running' | 'used' | 'failed' | 'wasted'
  step: number
  failReason?: string
  kiroEmail?: string
  exitIp?: string
  proxyMode?: 'api' | 'pool' | 'direct'
  addedAt: number
  takenAt?: number
  doneAt?: number
  password: string
  secret: string
  passwordMasked: string
  secretMasked: string
}

/** 号池批次选项（固定形态：程序填表/2FA/点 Sign in；Verify/Authorize/继续链接人点） */
export interface LoginPoolBatchOptions {
  intervalSec: number | 'rand'
  manualPolicy: 'wait' | 'skip'
  /** 授权自动化实验（默认关）：Authorize 先程序攻两次（轨迹点击/requestSubmit），失败回退人工 */
  autoAuthorize?: boolean
  /** 出口代理（代理池快照或提链 API 配置，批次/单跑时传入；主进程逐号消费，只读不回写） */
  proxy?: {
    enabled: boolean
    /** pool=静态代理池条目（默认）；api=动态提链接口（一次性端点，批量提取逐号消费） */
    mode?: 'pool' | 'api'
    entries: Array<{ url: string; usedCount: number; latencyMs?: number }>
    strategy: 'round_robin' | 'random' | 'least_used' | 'fastest'
    upstreamProxy?: string
    api?: { url: string; viaProxy?: string; batchSize?: number }
  }
}

/** 号池主进程 → 渲染事件 */
export type LoginPoolUpdate =
  | { kind: 'entry'; entry: LoginPoolEntryView }
  | { kind: 'log'; line: { time: string; level: 'info' | 'ok' | 'err' | 'warn'; msg: string } }
  | { kind: 'batch'; state: { running: boolean; paused: boolean; cooldownSec: number; unused: number } }
  | {
      kind: 'result'
      payload: {
        entryId: string
        username: string
        accessToken: string
        refreshToken: string
        profileArn?: string
        expiresIn?: number
      }
    }

/** Google 号池条目视图（含明文凭据：表格「显示明文」开关用 + 打码展示位） */
export interface GooglePoolEntryView {
  id: string
  email: string
  state: 'unused' | 'running' | 'used' | 'failed' | 'wasted'
  failReason?: string
  kiroEmail?: string
  exitIp?: string
  proxyMode?: 'api' | 'pool' | 'direct'
  /** base32 TOTP 密钥（辅助邮箱版卡密没有） */
  secret?: string
  /** 辅助邮箱（无 2FA 密钥版卡密；Google 验证挑战发码到这里） */
  recoveryEmail?: string
  /** 辅助邮箱凭据（卡密第 4 段，仅记录展示） */
  recoveryPassword?: string
  country?: string
  addedAt: number
  takenAt?: number
  doneAt?: number
  password: string
  passwordMasked: string
  secretMasked?: string
}

/** Google 号池授权时的出口代理选项（与号池 LoginPoolBatchOptions.proxy 同构） */
export interface GooglePoolProxyOptions {
  enabled: boolean
  mode?: 'pool' | 'api'
  entries: Array<{ url: string; usedCount: number; latencyMs?: number }>
  strategy: 'round_robin' | 'random' | 'least_used' | 'fastest'
  upstreamProxy?: string
  api?: { url: string; viaProxy?: string; batchSize?: number }
}

/** Google 号池主进程 → 渲染事件（无 batch 批次态——手动授权单窗口串行） */
export type GooglePoolUpdate =
  | { kind: 'entry'; entry: GooglePoolEntryView }
  | { kind: 'log'; line: { time: string; level: 'info' | 'ok' | 'err' | 'warn'; msg: string } }
  | {
      kind: 'result'
      payload: {
        entryId: string
        email: string
        accessToken: string
        refreshToken: string
        profileArn?: string
        expiresIn?: number
      }
    }

// Custom APIs for renderer
const api = {
  // 打开外部链接
  openExternal: (url: string, usePrivateMode?: boolean): void => {
    ipcRenderer.send('open-external', url, usePrivateMode)
  },

  // 获取应用版本
  getAppVersion: (): Promise<string> => {
    return ipcRenderer.invoke('get-app-version')
  },

  // 监听 OAuth 回调
  onAuthCallback: (callback: (data: { code: string; state: string }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { code: string; state: string }): void => {
      callback(data)
    }
    ipcRenderer.on('auth-callback', handler)
    return () => {
      ipcRenderer.removeListener('auth-callback', handler)
    }
  },

  // 账号管理 - 加载账号数据
  loadAccounts: (): Promise<unknown> => {
    return ipcRenderer.invoke('load-accounts')
  },

  // 账号管理 - 保存账号数据
  saveAccounts: (data: unknown): Promise<void> => {
    return ipcRenderer.invoke('save-accounts', data)
  },

  // 闲置账号库 - 加载闲置账号数据（独立库，物理隔离）
  loadIdleAccounts: (): Promise<unknown> => {
    return ipcRenderer.invoke('load-idle-accounts')
  },

  // 闲置账号库 - 保存闲置账号数据
  saveIdleAccounts: (data: unknown): Promise<void> => {
    return ipcRenderer.invoke('save-idle-accounts', data)
  },

  // 账号管理 - 刷新 Token
  refreshAccountToken: (account: unknown): Promise<unknown> => {
    return ipcRenderer.invoke('refresh-account-token', account)
  },

  // 账号管理 - 检查账号状态
  checkAccountStatus: (account: unknown): Promise<unknown> => {
    return ipcRenderer.invoke('check-account-status', account)
  },

  // 后台批量刷新账号（在主进程执行，不阻塞 UI）
  backgroundBatchRefresh: (accounts: Array<{
    id: string
    email: string
    idp?: string
    needsTokenRefresh?: boolean
    machineId?: string  // 账户绑定的设备 ID
    credentials: {
      refreshToken: string
      clientId?: string
      clientSecret?: string
      region?: string
      authMethod?: string
      accessToken?: string
      provider?: string
    }
  }>, concurrency?: number, syncInfo?: boolean): Promise<{ success: boolean; completed: number; successCount: number; failedCount: number }> => {
    return ipcRenderer.invoke('background-batch-refresh', accounts, concurrency, syncInfo)
  },

  // 监听后台刷新进度
  onBackgroundRefreshProgress: (callback: (data: { completed: number; total: number; success: number; failed: number }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { completed: number; total: number; success: number; failed: number }): void => {
      callback(data)
    }
    ipcRenderer.on('background-refresh-progress', handler)
    return () => {
      ipcRenderer.removeListener('background-refresh-progress', handler)
    }
  },

  // 监听后台刷新结果（单个账号）
  onBackgroundRefreshResult: (callback: (data: { id: string; success: boolean; data?: unknown; error?: string }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { id: string; success: boolean; data?: unknown; error?: string }): void => {
      callback(data)
    }
    ipcRenderer.on('background-refresh-result', handler)
    return () => {
      ipcRenderer.removeListener('background-refresh-result', handler)
    }
  },

  // 后台批量检查账号状态（不刷新 Token）
  backgroundBatchCheck: (accounts: Array<{
    id: string
    email: string
    credentials: {
      accessToken: string
      refreshToken?: string
      clientId?: string
      clientSecret?: string
      region?: string
      authMethod?: string
      provider?: string
    }
    idp?: string
  }>, concurrency?: number): Promise<{ success: boolean; completed: number; successCount: number; failedCount: number }> => {
    return ipcRenderer.invoke('background-batch-check', accounts, concurrency)
  },

  // 监听后台检查进度
  onBackgroundCheckProgress: (callback: (data: { completed: number; total: number; success: number; failed: number }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { completed: number; total: number; success: number; failed: number }): void => {
      callback(data)
    }
    ipcRenderer.on('background-check-progress', handler)
    return () => {
      ipcRenderer.removeListener('background-check-progress', handler)
    }
  },

  // 监听后台检查结果（单个账号）
  onBackgroundCheckResult: (callback: (data: { id: string; success: boolean; data?: unknown; error?: string }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { id: string; success: boolean; data?: unknown; error?: string }): void => {
      callback(data)
    }
    ipcRenderer.on('background-check-result', handler)
    return () => {
      ipcRenderer.removeListener('background-check-result', handler)
    }
  },

  // 文件操作 - 导出到文件
  exportToFile: (data: string, filename: string): Promise<boolean> => {
    return ipcRenderer.invoke('export-to-file', data, filename)
  },

  // 文件操作 - 从文件导入
  importFromFile: (): Promise<string | null> => {
    return ipcRenderer.invoke('import-from-file')
  },

  // 验证凭证并获取账号信息
  verifyAccountCredentials: (credentials: {
    refreshToken: string
    clientId: string
    clientSecret: string
    region?: string
    authMethod?: string  // 'IdC' 或 'social'
    provider?: string    // 'BuilderId', 'Github', 'Google'
  }): Promise<{
    success: boolean
    data?: {
      email: string
      userId: string
      accessToken: string
      refreshToken: string
      expiresIn?: number
      subscriptionType: string
      subscriptionTitle: string
      usage: { current: number; limit: number }
      daysRemaining?: number
      expiresAt?: number
    }
    error?: string
  }> => {
    return ipcRenderer.invoke('verify-account-credentials', credentials)
  },


  // 从 Kiro 本地配置导入凭证
  loadKiroCredentials: (): Promise<{
    success: boolean
    data?: {
      accessToken: string
      refreshToken: string
      clientId: string
      clientSecret: string
      region: string
      authMethod: string  // 'IdC' 或 'social'
      provider: string    // 'BuilderId', 'Github', 'Google'
    }
    error?: string
  }> => {
    return ipcRenderer.invoke('load-kiro-credentials')
  },

  // 从 AWS SSO Token (x-amz-sso_authn) 导入账号
  importFromSsoToken: (bearerToken: string, region?: string): Promise<{
    success: boolean
    data?: {
      accessToken: string
      refreshToken: string
      clientId: string
      clientSecret: string
      region: string
      expiresIn?: number
      email?: string
      userId?: string
      idp?: string
      status?: string
    }
    error?: { message: string }
  }> => {
    return ipcRenderer.invoke('import-from-sso-token', bearerToken, region || 'us-east-1')
  },

  // ============ 手动登录 API ============

  // 启动 Builder ID 手动登录
  startBuilderIdLogin: (region?: string): Promise<{
    success: boolean
    userCode?: string
    verificationUri?: string
    expiresIn?: number
    interval?: number
    error?: string
  }> => {
    return ipcRenderer.invoke('start-builder-id-login', region || 'us-east-1')
  },

  // 轮询 Builder ID 授权状态
  pollBuilderIdAuth: (region?: string): Promise<{
    success: boolean
    completed?: boolean
    status?: string
    accessToken?: string
    refreshToken?: string
    clientId?: string
    clientSecret?: string
    region?: string
    expiresIn?: number
    error?: string
  }> => {
    return ipcRenderer.invoke('poll-builder-id-auth', region || 'us-east-1')
  },

  // 取消 Builder ID 登录
  cancelBuilderIdLogin: (): Promise<{ success: boolean }> => {
    return ipcRenderer.invoke('cancel-builder-id-login')
  },

  // 启动 IAM Identity Center SSO 登录 (Authorization Code flow)
  startIamSsoLogin: (startUrl: string, region?: string): Promise<{
    success: boolean
    authorizeUrl?: string
    expiresIn?: number
    error?: string
  }> => {
    return ipcRenderer.invoke('start-iam-sso-login', startUrl, region || 'us-east-1')
  },

  // 轮询 IAM SSO 授权状态
  pollIamSsoAuth: (region?: string): Promise<{
    success: boolean
    completed?: boolean
    status?: string
    accessToken?: string
    refreshToken?: string
    clientId?: string
    clientSecret?: string
    region?: string
    expiresIn?: number
    error?: string
  }> => {
    return ipcRenderer.invoke('poll-iam-sso-auth', region || 'us-east-1')
  },

  // 完成 IAM SSO 登录 (用授权码换取 token)
  completeIamSsoLogin: (code: string): Promise<{
    success: boolean
    completed?: boolean
    accessToken?: string
    refreshToken?: string
    clientId?: string
    clientSecret?: string
    region?: string
    expiresIn?: number
    error?: string
  }> => {
    return ipcRenderer.invoke('complete-iam-sso-login', code)
  },

  // 取消 IAM SSO 登录
  cancelIamSsoLogin: (): Promise<{ success: boolean }> => {
    return ipcRenderer.invoke('cancel-iam-sso-login')
  },

  // 用无痕模式打开 https 页面（注册等快捷入口）
  openUrlPrivate: (url: string): Promise<{ success: boolean; error?: string }> => {
    return ipcRenderer.invoke('open-url-private', url)
  },

  // 启动 Social Auth 登录 (Google/GitHub)
  startSocialLogin: (provider: 'Google' | 'Github', usePrivateMode?: boolean): Promise<{
    success: boolean
    loginUrl?: string
    state?: string
    error?: string
  }> => {
    return ipcRenderer.invoke('start-social-login', provider, usePrivateMode)
  },

  // 交换 Social Auth token
  exchangeSocialToken: (code: string, state: string): Promise<{
    success: boolean
    accessToken?: string
    refreshToken?: string
    profileArn?: string
    expiresIn?: number
    authMethod?: string
    provider?: string
    error?: string
  }> => {
    return ipcRenderer.invoke('exchange-social-token', code, state)
  },

  // 取消 Social Auth 登录
  cancelSocialLogin: (): Promise<{ success: boolean }> => {
    return ipcRenderer.invoke('cancel-social-login')
  },

  // ─── 号池（GitHub 账密+2FA 批量激活 Kiro）───
  /** 全量快照：条目视图 + 批次状态 + 最近日志（页面重挂恢复用） */
  loginPoolList: (): Promise<{
    entries: LoginPoolEntryView[]
    batch: { running: boolean; paused: boolean; cooldownSec: number; unused: number }
    logs: Array<{ time: string; level: 'info' | 'ok' | 'err' | 'warn'; msg: string }>
  }> => {
    return ipcRenderer.invoke('login-pool:list')
  },
  loginPoolAddText: (text: string): Promise<{ added: number; updated: number; bad: string[] }> => {
    return ipcRenderer.invoke('login-pool:add-text', text)
  },
  loginPoolMarkWasted: (id: string): Promise<{ success: boolean }> => {
    return ipcRenderer.invoke('login-pool:mark-wasted', id)
  },
  /** 手动标记已用（账号已经其他途径入库，防重复激活） */
  loginPoolMarkUsed: (id: string): Promise<{ success: boolean }> => {
    return ipcRenderer.invoke('login-pool:mark-used', id)
  },
  loginPoolRestore: (id: string): Promise<{ success: boolean }> => {
    return ipcRenderer.invoke('login-pool:restore', id)
  },
  loginPoolRemove: (id: string): Promise<{ success: boolean }> => {
    return ipcRenderer.invoke('login-pool:remove', id)
  },
  loginPoolClearFinished: (): Promise<{ success: boolean }> => {
    return ipcRenderer.invoke('login-pool:clear-finished')
  },
  loginPoolRestoreAll: (): Promise<{ success: boolean }> => {
    return ipcRenderer.invoke('login-pool:restore-all')
  },
  /** 批量删除勾选条目（running 条目跳过不删），返回实际删除数 */
  loginPoolRemoveMany: (ids: string[]): Promise<{ success: boolean; removed: number }> => {
    return ipcRenderer.invoke('login-pool:remove-many', ids)
  },
  loginPoolStart: (opts: LoginPoolBatchOptions): Promise<{ success: boolean; error?: string }> => {
    return ipcRenderer.invoke('login-pool:start', opts)
  },
  loginPoolPause: (): Promise<{ success: boolean }> => {
    return ipcRenderer.invoke('login-pool:pause')
  },
  loginPoolRunOne: (id: string, opts?: LoginPoolBatchOptions): Promise<{ success: boolean; error?: string }> => {
    return ipcRenderer.invoke('login-pool:run-one', id, opts)
  },
  loginPoolFocusWindow: (): Promise<{ success: boolean }> => {
    return ipcRenderer.invoke('login-pool:focus-window')
  },
  loginPoolManualCallback: (code: string, state: string): Promise<{ success: boolean }> => {
    return ipcRenderer.invoke('login-pool:manual-callback', code, state)
  },
  loginPoolMarkStored: (id: string, kiroEmail: string): Promise<{ success: boolean }> => {
    return ipcRenderer.invoke('login-pool:mark-stored', id, kiroEmail)
  },
  onLoginPoolUpdate: (callback: (update: LoginPoolUpdate) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, update: LoginPoolUpdate): void => {
      callback(update)
    }
    ipcRenderer.on('login-pool-update', handler)
    return () => {
      ipcRenderer.removeListener('login-pool-update', handler)
    }
  },

  // ─── Google 号池（Gmail 卡密 · 手动授权激活 Kiro）───
  /** 全量快照：条目视图 + 授权窗口状态 + 最近日志（页面重挂恢复用） */
  googlePoolList: (): Promise<{
    entries: GooglePoolEntryView[]
    running: boolean
    logs: Array<{ time: string; level: 'info' | 'ok' | 'err' | 'warn'; msg: string }>
  }> => {
    return ipcRenderer.invoke('google-pool:list')
  },
  googlePoolAddText: (text: string): Promise<{ added: number; updated: number; bad: string[] }> => {
    return ipcRenderer.invoke('google-pool:add-text', text)
  },
  googlePoolMarkWasted: (id: string): Promise<{ success: boolean }> => {
    return ipcRenderer.invoke('google-pool:mark-wasted', id)
  },
  /** 手动标记已用（账号已经其他途径入库，防重复授权） */
  googlePoolMarkUsed: (id: string): Promise<{ success: boolean }> => {
    return ipcRenderer.invoke('google-pool:mark-used', id)
  },
  googlePoolRestore: (id: string): Promise<{ success: boolean }> => {
    return ipcRenderer.invoke('google-pool:restore', id)
  },
  googlePoolRemove: (id: string): Promise<{ success: boolean }> => {
    return ipcRenderer.invoke('google-pool:remove', id)
  },
  googlePoolRemoveMany: (ids: string[]): Promise<{ success: boolean; removed: number }> => {
    return ipcRenderer.invoke('google-pool:remove-many', ids)
  },
  googlePoolClearFinished: (): Promise<{ success: boolean }> => {
    return ipcRenderer.invoke('google-pool:clear-finished')
  },
  googlePoolRestoreAll: (): Promise<{ success: boolean }> => {
    return ipcRenderer.invoke('google-pool:restore-all')
  },
  /** 发起单号授权：主进程打开授权窗口；autofill=自动填邮箱/密码/2FA（默认开），挑战与授权确认人工 */
  googlePoolAuthorize: (
    id: string,
    opts?: { autofill?: boolean; proxy?: GooglePoolProxyOptions }
  ): Promise<{ success: boolean; error?: string }> => {
    return ipcRenderer.invoke('google-pool:authorize', id, opts)
  },
  googlePoolFocusWindow: (): Promise<{ success: boolean }> => {
    return ipcRenderer.invoke('google-pool:focus-window')
  },
  /** 本地算当前 6 位验证码（一键复制用；密钥不出主进程） */
  googlePoolTotp: (
    id: string
  ): Promise<{ success: boolean; code?: string; remainSec?: number; error?: string }> => {
    return ipcRenderer.invoke('google-pool:totp', id)
  },
  googlePoolManualCallback: (code: string, state: string): Promise<{ success: boolean }> => {
    return ipcRenderer.invoke('google-pool:manual-callback', code, state)
  },
  googlePoolMarkStored: (id: string, kiroEmail: string): Promise<{ success: boolean }> => {
    return ipcRenderer.invoke('google-pool:mark-stored', id, kiroEmail)
  },
  onGooglePoolUpdate: (callback: (update: GooglePoolUpdate) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, update: GooglePoolUpdate): void => {
      callback(update)
    }
    ipcRenderer.on('google-pool-update', handler)
    return () => {
      ipcRenderer.removeListener('google-pool-update', handler)
    }
  },

  // 监听 Social Auth 回调
  onSocialAuthCallback: (callback: (data: { code?: string; state?: string; error?: string }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { code?: string; state?: string; error?: string }): void => {
      callback(data)
    }
    ipcRenderer.on('social-auth-callback', handler)
    return () => {
      ipcRenderer.removeListener('social-auth-callback', handler)
    }
  },

  // 代理设置
  setProxy: (enabled: boolean, url: string): Promise<{ success: boolean; error?: string; normalizedUrl?: string }> => {
    return ipcRenderer.invoke('set-proxy', enabled, url)
  },

  // ============ 机器码管理 API ============

  // 获取操作系统类型
  machineIdGetOSType: (): Promise<'windows' | 'macos' | 'linux' | 'unknown'> => {
    return ipcRenderer.invoke('machine-id:get-os-type')
  },

  // 获取当前机器码
  machineIdGetCurrent: (): Promise<{
    success: boolean
    machineId?: string
    error?: string
    requiresAdmin?: boolean
  }> => {
    return ipcRenderer.invoke('machine-id:get-current')
  },

  // 设置新机器码
  machineIdSet: (newMachineId: string): Promise<{
    success: boolean
    machineId?: string
    error?: string
    requiresAdmin?: boolean
  }> => {
    return ipcRenderer.invoke('machine-id:set', newMachineId)
  },

  // 生成随机机器码
  machineIdGenerateRandom: (): Promise<string> => {
    return ipcRenderer.invoke('machine-id:generate-random')
  },

  // 检查管理员权限
  machineIdCheckAdmin: (): Promise<boolean> => {
    return ipcRenderer.invoke('machine-id:check-admin')
  },

  // 请求管理员权限重启
  machineIdRequestAdminRestart: (): Promise<boolean> => {
    return ipcRenderer.invoke('machine-id:request-admin-restart')
  },

  // 备份机器码到文件
  machineIdBackupToFile: (machineId: string): Promise<boolean> => {
    return ipcRenderer.invoke('machine-id:backup-to-file', machineId)
  },

  // 从文件恢复机器码
  machineIdRestoreFromFile: (): Promise<{
    success: boolean
    machineId?: string
    error?: string
  }> => {
    return ipcRenderer.invoke('machine-id:restore-from-file')
  },

  // ============ 自动更新 ============
  
  // 检查更新 (electron-updater)
  checkForUpdates: (): Promise<{
    hasUpdate: boolean
    version?: string
    releaseDate?: string
    message?: string
    error?: string
  }> => {
    return ipcRenderer.invoke('check-for-updates')
  },

  // 手动检查更新 (GitHub API, 用于 AboutPage)
  checkForUpdatesManual: (): Promise<{
    hasUpdate: boolean
    currentVersion?: string
    latestVersion?: string
    releaseNotes?: string
    releaseName?: string
    releaseUrl?: string
    publishedAt?: string
    assets?: Array<{
      name: string
      downloadUrl: string
      size: number
    }>
    error?: string
  }> => {
    return ipcRenderer.invoke('check-for-updates-manual')
  },

  // 下载更新
  downloadUpdate: (): Promise<{ success: boolean; error?: string }> => {
    return ipcRenderer.invoke('download-update')
  },

  // 安装更新并重启
  installUpdate: (): Promise<void> => {
    return ipcRenderer.invoke('install-update')
  },

  // 监听更新事件
  onUpdateChecking: (callback: () => void): (() => void) => {
    const handler = (): void => callback()
    ipcRenderer.on('update-checking', handler)
    return () => ipcRenderer.removeListener('update-checking', handler)
  },

  onUpdateAvailable: (callback: (info: { version: string; releaseDate?: string; releaseNotes?: string }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, info: { version: string; releaseDate?: string; releaseNotes?: string }): void => callback(info)
    ipcRenderer.on('update-available', handler)
    return () => ipcRenderer.removeListener('update-available', handler)
  },

  onUpdateNotAvailable: (callback: (info: { version: string }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, info: { version: string }): void => callback(info)
    ipcRenderer.on('update-not-available', handler)
    return () => ipcRenderer.removeListener('update-not-available', handler)
  },

  onUpdateDownloadProgress: (callback: (progress: { percent: number; bytesPerSecond: number; transferred: number; total: number }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: { percent: number; bytesPerSecond: number; transferred: number; total: number }): void => callback(progress)
    ipcRenderer.on('update-download-progress', handler)
    return () => ipcRenderer.removeListener('update-download-progress', handler)
  },

  onUpdateDownloaded: (callback: (info: { version: string; releaseDate?: string; releaseNotes?: string }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, info: { version: string; releaseDate?: string; releaseNotes?: string }): void => callback(info)
    ipcRenderer.on('update-downloaded', handler)
    return () => ipcRenderer.removeListener('update-downloaded', handler)
  },

  onUpdateError: (callback: (error: string) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, error: string): void => callback(error)
    ipcRenderer.on('update-error', handler)
    return () => ipcRenderer.removeListener('update-error', handler)
  },

  // 获取账户可用模型列表
  accountGetModels: (accessToken: string, region?: string, profileArn?: string, machineId?: string, provider?: string, authMethod?: string, accountId?: string): Promise<{ success: boolean; error?: string; models: Array<{ id: string; name: string; description: string; inputTypes?: string[]; maxInputTokens?: number | null; maxOutputTokens?: number | null; rateMultiplier?: number; rateUnit?: string }> }> => {
    return ipcRenderer.invoke('account-get-models', accessToken, region, profileArn, machineId, provider, authMethod, accountId)
  },

  // 获取可用订阅列表
  accountGetSubscriptions: (accessToken: string, region?: string, profileArn?: string, machineId?: string, provider?: string, authMethod?: string, accountId?: string): Promise<{ success: boolean; error?: string; plans: Array<{ name: string; qSubscriptionType: string; description: { title: string; billingInterval: string; featureHeader: string; features: string[] }; pricing: { amount: number; currency: string } }>; disclaimer?: string[]; credentials?: { accessToken: string; refreshToken?: string; expiresIn?: number } }> => {
    return ipcRenderer.invoke('account-get-subscriptions', accessToken, region, profileArn, machineId, provider, authMethod, accountId)
  },

  // 获取订阅管理/支付链接（dynamicProxy 传入时该请求经提链出口发出，见代理池页「动态提链源」）
  accountGetSubscriptionUrl: (accessToken: string, subscriptionType?: string, region?: string, profileArn?: string, machineId?: string, provider?: string, authMethod?: string, accountId?: string, dynamicProxy?: { url: string; viaProxy?: string; batchSize?: number }, exitProxyUrl?: string): Promise<{ success: boolean; error?: string; url?: string; status?: string; exitIp?: string }> => {
    return ipcRenderer.invoke('account-get-subscription-url', accessToken, subscriptionType, region, profileArn, machineId, provider, authMethod, accountId, dynamicProxy, exitProxyUrl)
  },

  // 设置用户超额偏好
  accountSetOverage: (accessToken: string, overageStatus: 'ENABLED' | 'DISABLED', region?: string, profileArn?: string, machineId?: string, provider?: string, authMethod?: string, accountId?: string): Promise<{ success: boolean; error?: string }> => {
    return ipcRenderer.invoke('account-set-overage', accessToken, overageStatus, region, profileArn, machineId, provider, authMethod, accountId)
  },

  // 在新窗口打开订阅链接
  openSubscriptionWindow: (url: string): Promise<{ success: boolean; error?: string }> => {
    return ipcRenderer.invoke('open-subscription-window', url)
  },

  // ============ 应用内支付（Stripe Checkout + 自动填账单地址） ============

  // 省份列表（账单地址生成用）
  paymentProvinces: (): Promise<string[]> => {
    return ipcRenderer.invoke('payment-provinces')
  },

  // 生成一条随机中国账单地址（UI 预览用；邮编与市/区真实对应）
  paymentGenerateAddress: (province?: string): Promise<{
    name: string
    zip: string
    city: string
    district: string
    street: string
    provinceZh: string
    provinceEn: string
  }> => {
    return ipcRenderer.invoke('payment-generate-address', province)
  },

  // 打开应用内支付窗口（自动选国家/省、填账单地址；卡号与 Pay 留人工）
  paymentOpen: (payload: {
    url: string
    accountId: string
    email?: string
    province?: string
    address?: {
      name: string
      zip: string
      city: string
      district: string
      street: string
      provinceZh: string
      provinceEn: string
    }
  }): Promise<{ success: boolean; error?: string }> => {
    return ipcRenderer.invoke('payment-open', payload)
  },

  // 支付窗口状态推送（filling/filled/success/expired/closed/error）
  onPaymentUpdate: (callback: (update: {
    accountId: string
    email?: string
    phase: 'filling' | 'filled' | 'success' | 'expired' | 'closed' | 'error'
    detail?: string
    address?: {
      name: string
      zip: string
      city: string
      district: string
      street: string
      provinceZh: string
      provinceEn: string
    }
  }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, update: {
      accountId: string
      email?: string
      phase: 'filling' | 'filled' | 'success' | 'expired' | 'closed' | 'error'
      detail?: string
      address?: {
        name: string
        zip: string
        city: string
        district: string
        street: string
        provinceZh: string
        provinceEn: string
      }
    }): void => {
      callback(update)
    }
    ipcRenderer.on('payment-update', handler)
    return () => {
      ipcRenderer.removeListener('payment-update', handler)
    }
  },

  // 以账号身份在应用内私密浏览器打开 Kiro 官网后台（免登录）
  accountOpenPortal: (accountId: string): Promise<{ success: boolean; error?: string }> => {
    return ipcRenderer.invoke('account-open-portal', accountId)
  },

  // 自动切订阅到 Free（dryRun=true 只读校验链路，不提交变更）
  accountSwitchPlanFree: (accessToken: string, region?: string, profileArn?: string, machineId?: string, provider?: string, authMethod?: string, accountId?: string, dryRun?: boolean): Promise<{ success: boolean; error?: string; alreadyFree?: boolean; alreadyScheduled?: boolean; wontRenew?: boolean; switched?: boolean; scheduledToFree?: boolean; transitionAt?: number; dryRun?: boolean; previousPlan?: string; subId?: string; billing?: StripeBillingSnapshot; credentials?: { accessToken: string; refreshToken?: string; expiresIn?: number } }> => {
    return ipcRenderer.invoke('account-switch-plan-free', accessToken, region, profileArn, machineId, provider, authMethod, accountId, dryRun)
  },

  // 只读检查订阅续费状态（cancelAtPeriodEnd=false 表示下周期会自动续费扣款）
  accountCheckRenewal: (accessToken: string, region?: string, profileArn?: string, machineId?: string, provider?: string, authMethod?: string, accountId?: string): Promise<{ success: boolean; error?: string; cancelAtPeriodEnd?: boolean; currentPeriodEnd?: number; planName?: string; subId?: string; isFreePlan?: boolean; scheduledToFree?: boolean; transitionAt?: number; billing?: StripeBillingSnapshot; credentials?: { accessToken: string; refreshToken?: string; expiresIn?: number } }> => {
    return ipcRenderer.invoke('account-check-renewal', accessToken, region, profileArn, machineId, provider, authMethod, accountId)
  },

  // 获取系统日志
  proxyGetLogs: (count?: number): Promise<Array<{ timestamp: string; level: string; category: string; message: string; data?: unknown }>> => {
    return ipcRenderer.invoke('proxy-get-logs', count)
  },

  // 清除系统日志
  proxyClearLogs: (): Promise<{ success: boolean }> => {
    return ipcRenderer.invoke('proxy-clear-logs')
  },

  // 获取系统日志数量
  proxyGetLogsCount: (): Promise<number> => {
    return ipcRenderer.invoke('proxy-get-logs-count')
  },

  // ============ Usage API 类型设置 ============

  // 获取 Usage API 类型
  getUsageApiType: (): Promise<'rest' | 'cbor'> => {
    return ipcRenderer.invoke('get-usage-api-type')
  },

  // 设置 Usage API 类型
  setUsageApiType: (type: 'rest' | 'cbor'): Promise<{ success: boolean; type: string }> => {
    return ipcRenderer.invoke('set-usage-api-type', type)
  },

  // 获取是否使用 K-Proxy 代理
  getUseKProxyForApi: (): Promise<boolean> => {
    return ipcRenderer.invoke('get-use-kproxy-for-api')
  },

  // 设置是否使用 K-Proxy 代理
  setUseKProxyForApi: (enabled: boolean): Promise<{ success: boolean; enabled: boolean }> => {
    return ipcRenderer.invoke('set-use-kproxy-for-api', enabled)
  },

  // ============ K-Proxy MITM 代理 ============

  // 初始化 K-Proxy
  kproxyInit: (): Promise<{ success: boolean; caInfo?: { certPath: string; fingerprint: string; validFrom: string; validTo: string }; error?: string }> => {
    return ipcRenderer.invoke('kproxy-init')
  },

  // 启动 K-Proxy
  kproxyStart: (config?: { port?: number; host?: string; mitmDomains?: string[]; deviceId?: string }): Promise<{ success: boolean; port?: number; error?: string }> => {
    return ipcRenderer.invoke('kproxy-start', config)
  },

  // 停止 K-Proxy
  kproxyStop: (): Promise<{ success: boolean; error?: string }> => {
    return ipcRenderer.invoke('kproxy-stop')
  },

  // 获取 K-Proxy 状态
  kproxyGetStatus: (): Promise<{ running: boolean; config: unknown; stats: unknown; caInfo: unknown }> => {
    return ipcRenderer.invoke('kproxy-get-status')
  },

  // 更新 K-Proxy 配置
  kproxyUpdateConfig: (config: { port?: number; host?: string; mitmDomains?: string[]; deviceId?: string; autoStart?: boolean; logRequests?: boolean }): Promise<{ success: boolean; config?: unknown; error?: string }> => {
    return ipcRenderer.invoke('kproxy-update-config', config)
  },

  // 设置当前设备 ID
  kproxySetDeviceId: (deviceId: string): Promise<{ success: boolean; error?: string }> => {
    return ipcRenderer.invoke('kproxy-set-device-id', deviceId)
  },

  // 生成新的设备 ID
  kproxyGenerateDeviceId: (): Promise<{ success: boolean; deviceId?: string }> => {
    return ipcRenderer.invoke('kproxy-generate-device-id')
  },

  // 添加设备 ID 映射
  kproxyAddDeviceMapping: (mapping: { accountId: string; deviceId: string; description?: string; createdAt: number }): Promise<{ success: boolean; error?: string }> => {
    return ipcRenderer.invoke('kproxy-add-device-mapping', mapping)
  },

  // 获取所有设备 ID 映射
  kproxyGetDeviceMappings: (): Promise<{ success: boolean; mappings: Array<{ accountId: string; deviceId: string; description?: string; createdAt: number; lastUsed?: number }> }> => {
    return ipcRenderer.invoke('kproxy-get-device-mappings')
  },

  // 切换到账号设备 ID
  kproxySwitchToAccount: (accountId: string): Promise<{ success: boolean; error?: string }> => {
    return ipcRenderer.invoke('kproxy-switch-to-account', accountId)
  },

  // 获取 CA 证书
  kproxyGetCaCert: (): Promise<{ success: boolean; certPem?: string; certPath?: string; fingerprint?: string; error?: string }> => {
    return ipcRenderer.invoke('kproxy-get-ca-cert')
  },

  // 导出 CA 证书
  kproxyExportCaCert: (exportPath?: string): Promise<{ success: boolean; path?: string; error?: string }> => {
    return ipcRenderer.invoke('kproxy-export-ca-cert', exportPath)
  },

  // 检查 CA 证书是否已安装
  kproxyCheckCaCertInstalled: (): Promise<{ success: boolean; installed: boolean; error?: string }> => {
    return ipcRenderer.invoke('kproxy-check-ca-cert-installed')
  },

  // ============ API Key 管理 ============
  
  // 获取所有 API Keys
  proxyGetApiKeys: (): Promise<{ success: boolean; apiKeys: Array<{ id: string; name: string; key: string; enabled: boolean; createdAt: number; lastUsedAt?: number; usage: { totalRequests: number; totalCredits: number; totalInputTokens: number; totalOutputTokens: number; daily: Record<string, { requests: number; credits: number; inputTokens: number; outputTokens: number }> } }>; error?: string }> => {
    return ipcRenderer.invoke('proxy-get-api-keys')
  },

  // 添加 API Key
  proxyAddApiKey: (apiKey: { name: string; key?: string; format?: 'sk' | 'simple' | 'token'; creditsLimit?: number }): Promise<{ success: boolean; apiKey?: { id: string; name: string; key: string; format?: 'sk' | 'simple' | 'token'; enabled: boolean; createdAt: number; creditsLimit?: number; usage: { totalRequests: number; totalCredits: number; totalInputTokens: number; totalOutputTokens: number; daily: Record<string, { requests: number; credits: number; inputTokens: number; outputTokens: number }> } }; error?: string }> => {
    return ipcRenderer.invoke('proxy-add-api-key', apiKey)
  },

  // 更新 API Key
  proxyUpdateApiKey: (id: string, updates: { name?: string; key?: string; enabled?: boolean; creditsLimit?: number | null }): Promise<{ success: boolean; apiKey?: { id: string; name: string; key: string; format?: 'sk' | 'simple' | 'token'; enabled: boolean; createdAt: number; creditsLimit?: number; usage: { totalRequests: number; totalCredits: number; totalInputTokens: number; totalOutputTokens: number; daily: Record<string, { requests: number; credits: number; inputTokens: number; outputTokens: number }> } }; error?: string }> => {
    return ipcRenderer.invoke('proxy-update-api-key', id, updates)
  },

  // 删除 API Key
  proxyDeleteApiKey: (id: string): Promise<{ success: boolean; error?: string }> => {
    return ipcRenderer.invoke('proxy-delete-api-key', id)
  },

  // 重置 API Key 用量统计
  proxyResetApiKeyUsage: (id: string): Promise<{ success: boolean; error?: string }> => {
    return ipcRenderer.invoke('proxy-reset-api-key-usage', id)
  },

  // 安装 CA 证书到系统信任存储
  kproxyInstallCaCert: (): Promise<{ success: boolean; message?: string; error?: string }> => {
    return ipcRenderer.invoke('kproxy-install-ca-cert')
  },

  // 卸载 CA 证书从系统信任存储
  kproxyUninstallCaCert: (): Promise<{ success: boolean; message?: string; error?: string }> => {
    return ipcRenderer.invoke('kproxy-uninstall-ca-cert')
  },

  // 重置 K-Proxy 统计
  kproxyResetStats: (): Promise<{ success: boolean }> => {
    return ipcRenderer.invoke('kproxy-reset-stats')
  },

  // 监听 K-Proxy 请求事件
  onKproxyRequest: (callback: (info: { timestamp: number; method: string; host: string; path: string; isMitm: boolean; deviceIdReplaced: boolean }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, info: { timestamp: number; method: string; host: string; path: string; isMitm: boolean; deviceIdReplaced: boolean }): void => {
      callback(info)
    }
    ipcRenderer.on('kproxy-request', handler)
    return () => {
      ipcRenderer.removeListener('kproxy-request', handler)
    }
  },

  // 监听 K-Proxy 响应事件
  onKproxyResponse: (callback: (info: { timestamp: number; host: string; statusCode: number; duration: number }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, info: { timestamp: number; host: string; statusCode: number; duration: number }): void => {
      callback(info)
    }
    ipcRenderer.on('kproxy-response', handler)
    return () => {
      ipcRenderer.removeListener('kproxy-response', handler)
    }
  },

  // 监听 K-Proxy 错误事件
  onKproxyError: (callback: (error: string) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, error: string): void => {
      callback(error)
    }
    ipcRenderer.on('kproxy-error', handler)
    return () => {
      ipcRenderer.removeListener('kproxy-error', handler)
    }
  },

  // 监听 K-Proxy 状态变化事件
  onKproxyStatusChange: (callback: (status: { running: boolean; port: number }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: { running: boolean; port: number }): void => {
      callback(status)
    }
    ipcRenderer.on('kproxy-status-change', handler)
    return () => {
      ipcRenderer.removeListener('kproxy-status-change', handler)
    }
  },

  // 监听 K-Proxy MITM 拦截事件
  onKproxyMitm: (callback: (info: { host: string; modified: boolean }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, info: { host: string; modified: boolean }): void => {
      callback(info)
    }
    ipcRenderer.on('kproxy-mitm', handler)
    return () => {
      ipcRenderer.removeListener('kproxy-mitm', handler)
    }
  },

  // ============ 自定义 titlebar API ============
  window: {
    minimize: (): void => ipcRenderer.send('window-minimize'),
    maximizeToggle: (): void => ipcRenderer.send('window-maximize-toggle'),
    close: (): void => ipcRenderer.send('window-close'),
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke('window-is-maximized'),
    getPlatform: (): Promise<NodeJS.Platform> => ipcRenderer.invoke('window-get-platform'),
    onMaximizeChange: (callback: (isMaximized: boolean) => void): (() => void) => {
      const handler = (_event: any, isMaximized: boolean): void => callback(isMaximized)
      ipcRenderer.on('window-maximize-changed', handler)
      return () => ipcRenderer.removeListener('window-maximize-changed', handler)
    }
  },

  // ============ 托盘相关 API ============

  // 获取显示主窗口快捷键
  getShowWindowShortcut: (): Promise<string> => ipcRenderer.invoke('get-show-window-shortcut'),

  // 设置显示主窗口快捷键
  setShowWindowShortcut: (shortcut: string): Promise<{ success: boolean; error?: string }> => 
    ipcRenderer.invoke('set-show-window-shortcut', shortcut),

  // 获取托盘设置
  getTraySettings: (): Promise<{
    enabled: boolean
    closeAction: 'ask' | 'minimize' | 'quit'
    showNotifications: boolean
    minimizeOnStart: boolean
  }> => {
    return ipcRenderer.invoke('get-tray-settings')
  },

  // 保存托盘设置
  saveTraySettings: (settings: {
    enabled?: boolean
    closeAction?: 'ask' | 'minimize' | 'quit'
    showNotifications?: boolean
    minimizeOnStart?: boolean
  }): Promise<{ success: boolean; error?: string }> => {
    return ipcRenderer.invoke('save-tray-settings', settings)
  },

  // 更新托盘当前账户信息
  updateTrayAccount: (account: {
    id: string
    email: string
    idp: string
    status: string
    subscription?: string
    usage?: {
      usedCredits: number
      totalCredits: number
      totalRequests: number
      successRequests: number
      failedRequests: number
    }
  } | null): void => {
    ipcRenderer.send('update-tray-account', account)
  },

  // 更新托盘账户列表
  updateTrayAccountList: (accounts: {
    id: string
    email: string
    idp: string
    status: string
  }[]): void => {
    ipcRenderer.send('update-tray-account-list', accounts)
  },

  // 刷新托盘菜单
  refreshTrayMenu: (): void => {
    ipcRenderer.send('refresh-tray-menu')
  },

  // 更新托盘语言
  updateTrayLanguage: (language: 'en' | 'zh'): void => {
    ipcRenderer.send('update-tray-language', language)
  },

  // 监听托盘刷新账户事件
  onTrayRefreshAccount: (callback: () => void): (() => void) => {
    const handler = (): void => {
      callback()
    }
    ipcRenderer.on('tray-refresh-account', handler)
    return () => {
      ipcRenderer.removeListener('tray-refresh-account', handler)
    }
  },

  // 监听托盘切换账户事件
  onTraySwitchAccount: (callback: () => void): (() => void) => {
    const handler = (): void => {
      callback()
    }
    ipcRenderer.on('tray-switch-account', handler)
    return () => {
      ipcRenderer.removeListener('tray-switch-account', handler)
    }
  },

  // 监听显示关闭确认对话框事件
  onShowCloseConfirmDialog: (callback: () => void): (() => void) => {
    const handler = (): void => {
      callback()
    }
    ipcRenderer.on('show-close-confirm-dialog', handler)
    return () => {
      ipcRenderer.removeListener('show-close-confirm-dialog', handler)
    }
  },

  // 发送关闭确认对话框响应
  sendCloseConfirmResponse: (action: 'minimize' | 'quit' | 'cancel', rememberChoice: boolean): void => {
    ipcRenderer.send('close-confirm-response', action, rememberChoice)
  },

  // ============ 注册功能 API ============

  // 启动自动注册
  registrationStartAuto: (config: {
    proxy?: string
    upstreamProxy?: string
    strictProxy?: boolean
    moEmailBaseURL?: string
    moEmailAPIKey?: string
    useOutlook?: boolean
    outlookData?: string
    useTempMailPlus?: boolean
    tempMailPlusEmail?: string
    tempMailPlusEpin?: string
    tempMailPlusDomain?: string
    useProton?: boolean
    protonEmail?: string
    useGptMail?: boolean
    gptMailBaseURL?: string
    gptMailInboxEmail?: string
    gptMailDomain?: string
    gptMailPrefix?: string
    gptMailPrivatePassword?: string
    useCfMail?: boolean
    cfMailBaseURL?: string
    cfMailAdminPassword?: string
    cfMailDomain?: string
    cfMailPrefix?: string
    password?: string
    fullName?: string
    taskId?: string
  }): Promise<{ success: boolean; result?: unknown; error?: string }> => {
    return ipcRenderer.invoke('registration-start-auto', config)
  },

  // CF 邮箱测试 · 第一步：建测试地址（不碰 AWS 注册接口）
  cfMailCreate: (config: {
    baseURL: string
    adminPassword: string
    domain: string
  }): Promise<{ ok: boolean; address?: string; error?: string }> => {
    return ipcRenderer.invoke('registration-cf-create', config)
  },

  // CF 邮箱测试 · 第二步：轮询查码（用户外部发件后调用；超时可手动填写兜底）
  cfMailPoll: (config: {
    baseURL: string
    adminPassword: string
    domain: string
  }, address: string, timeoutSec?: number): Promise<{ ok: boolean; receivedCode?: string; mailCount?: number; note?: string; error?: string }> => {
    return ipcRenderer.invoke('registration-cf-poll', config, address, timeoutSec)
  },

  // 手动模式 Phase1: 初始化 OIDC + 设备授权
  registrationManualPhase1: (config: {
    proxy?: string
    password?: string
    fullName?: string
  }): Promise<{ success: boolean; error?: string }> => {
    return ipcRenderer.invoke('registration-manual-phase1', config)
  },

  // 手动模式 Phase2: 设置邮箱 -> 发送 OTP
  registrationManualPhase2: (email: string, fullName?: string): Promise<{ success: boolean; error?: string }> => {
    return ipcRenderer.invoke('registration-manual-phase2', email, fullName)
  },

  // 手动模式 Phase3: 验证码 -> 完成
  registrationManualPhase3: (otp: string): Promise<{ success: boolean; result?: unknown; error?: string }> => {
    return ipcRenderer.invoke('registration-manual-phase3', otp)
  },

  // 取消注册
  registrationCancel: (): Promise<{ success: boolean }> => {
    return ipcRenderer.invoke('registration-cancel')
  },

  // ============ 代理池 API ============
  /**
   * 验活单个代理：使用 undici ProxyAgent 通过指定代理 URL 请求测试 URL
   * @returns latencyMs / externalIp（如果测试 URL 返回 IP）
   */
  proxyPoolValidate: (params: {
    url: string
    testUrl?: string
    timeoutMs?: number
    upstreamProxy?: string
  }): Promise<{ success: boolean; latencyMs?: number; externalIp?: string; error?: string }> => {
    return ipcRenderer.invoke('proxy-pool:validate', params)
  },

  /** 代理链分阶段诊断（用于定位"上游/目标/端到端"哪一层失败） */
  proxyPoolDiagnoseChain: (params: {
    targetUrl: string
    upstreamProxy: string
    testHost?: string
    testPort?: number
  }): Promise<{
    success: boolean
    error?: string
    diagnose?: {
      upstreamReachable: boolean
      upstreamError?: string
      upstreamRtMs?: number
      targetReachable: boolean
      targetError?: string
      targetRtMs?: number
      targetStatus?: number
      targetStatusText?: string
      targetBodySnippet?: string
      endToEndOk?: boolean
      endToEndError?: string
      endToEndRtMs?: number
    }
  }> => {
    return ipcRenderer.invoke('proxy-pool:diagnose-chain', params)
  },

  // ============ 诊断 API ============
  /**
   * 设置账号 → 代理 URL 绑定
   * @param accountId 账号 ID
   * @param proxyUrl 代理 URL；undefined 表示解绑
   */
  accountSetProxyBinding: (accountId: string, proxyUrl: string | undefined): Promise<{ success: boolean }> => {
    return ipcRenderer.invoke('account-set-proxy-binding', accountId, proxyUrl)
  },

  // 获取注册状态
  registrationStatus: (): Promise<{ inProgress: boolean }> => {
    return ipcRenderer.invoke('registration-status')
  },

  // Proton 邮箱：打开登录窗口（首次需手动登录，之后 session 持久化复用）
  protonOpenLogin: (proxy?: string): Promise<{ success: boolean; loggedIn: boolean; error?: string }> => {
    return ipcRenderer.invoke('proton-open-login', proxy)
  },

  // Proton 邮箱：查询登录态（不弹窗）
  protonLoginStatus: (proxy?: string): Promise<{ loggedIn: boolean }> => {
    return ipcRenderer.invoke('proton-login-status', proxy)
  },

  // Proton 邮箱：关闭窗口（保留登录态）
  protonClose: (): Promise<{ success: boolean }> => {
    return ipcRenderer.invoke('proton-close')
  },

  // 监听注册日志
  onRegistrationLog: (callback: (msg: string) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: string | { message: string; taskId?: string }): void => {
      const msg = typeof data === 'string' ? data : data.message
      callback(msg)
    }
    ipcRenderer.on('registration-log', handler)
    return () => {
      ipcRenderer.removeListener('registration-log', handler)
    }
  },

  /** 监听注册流程的实时 step 事件（用于批量任务的"当前步骤"可视化） */
  onRegistrationStep: (callback: (data: {
    taskId?: string
    event: {
      name:
        | 'init' | 'proxy-chain-ready' | 'tls-ready' | 'exit-ip'
        | 'oidc' | 'device' | 'email-created'
        | 'portal' | 'workflow-init' | 'submit-email'
        | 'signup' | 'send-otp' | 'waiting-otp' | 'otp-received'
        | 'create-identity' | 'set-password' | 'sso-workflow' | 'sso-token'
        | 'verify-alive' | 'done'
      ts: number
      email?: string
      exitIp?: string
      extra?: Record<string, unknown>
    }
  }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: Parameters<typeof callback>[0]): void => {
      callback(data)
    }
    ipcRenderer.on('registration-step', handler)
    return () => {
      ipcRenderer.removeListener('registration-step', handler)
    }
  },

  // 监听注册完成
  onRegistrationComplete: (callback: (result: {
    status: 'success' | 'failed'
    email: string
    password?: string
    error?: string
    clientId?: string
    clientSecret?: string
    refreshToken?: string
    accessToken?: string
    region?: string
    provider?: string
    verify?: Record<string, unknown>
  }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, result: {
      status: 'success' | 'failed'
      email: string
      password?: string
      error?: string
      clientId?: string
      clientSecret?: string
      refreshToken?: string
      accessToken?: string
      region?: string
      provider?: string
      verify?: Record<string, unknown>
    }): void => {
      callback(result)
    }
    ipcRenderer.on('registration-complete', handler)
    return () => {
      ipcRenderer.removeListener('registration-complete', handler)
    }
  }
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
