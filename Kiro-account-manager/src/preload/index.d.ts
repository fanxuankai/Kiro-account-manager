import { ElectronAPI } from '@electron-toolkit/preload'

/** Stripe 订阅门户账单快照（金额为分，时间为毫秒；与主进程 stripePortal.BillingSnapshot 结构一致） */
interface StripeBillingSnapshot {
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

interface AccountData {
  accounts: Record<string, unknown>
  groups: Record<string, unknown>
  tags: Record<string, unknown>
  activeAccountId: string | null
  autoRefreshEnabled: boolean
  autoRefreshInterval: number
  autoRefreshConcurrency?: number
  autoRefreshSyncInfo?: boolean
  autoUsageRefreshEnabled?: boolean
  autoUsageRefreshInterval?: number
  statusCheckInterval: number
  privacyMode?: boolean
  usagePrecision?: boolean
  proxyEnabled?: boolean
  proxyUrl?: string
  autoSwitchEnabled?: boolean
  autoSwitchThreshold?: number
  autoSwitchInterval?: number
  switchTarget?: 'ide' | 'cli' | 'both'
  theme?: string
  darkMode?: boolean
  language?: 'auto' | 'en' | 'zh'
  // 机器码管理
  machineIdConfig?: {
    autoSwitchOnAccountChange: boolean
    bindMachineIdToAccount: boolean
    useBindedMachineId: boolean
  }
  currentMachineId?: string
  originalMachineId?: string | null
  originalBackupTime?: number | null
  accountMachineIds?: Record<string, string>
  machineIdHistory?: Array<{
    id: string
    machineId: string
    timestamp: number
    action: 'initial' | 'manual' | 'auto_switch' | 'restore' | 'bind'
    accountId?: string
    accountEmail?: string
  }>
  // 代理池
  proxyPool?: Record<string, unknown>
  proxyPoolConfig?: unknown
  proxyPoolCursor?: number
  /** 账号-代理绑定映射 */
  accountProxyBindings?: Record<string, string>
}

/** 闲置账号库数据（独立 SQLite 文件 kiro-idle-accounts.db，物理隔离） */
interface IdleAccountData {
  accounts: Record<string, unknown>
  groups: Record<string, unknown>
  tags: Record<string, unknown>
  privacyMode?: boolean
}

interface RefreshResult {
  success: boolean
  data?: {
    accessToken: string
    refreshToken?: string
    expiresIn: number
    /** Enterprise 账号刷新时主进程自动获取的真实 profileArn */
    profileArn?: string
  }
  error?: { message: string }
}

interface BonusData {
  code: string
  name: string
  current: number
  limit: number
  expiresAt?: string
}

interface ResourceDetail {
  resourceType?: string
  displayName?: string
  displayNamePlural?: string
  currency?: string
  unit?: string
  overageRate?: number
  overageCap?: number
  overageEnabled?: boolean
}

interface StatusResult {
  success: boolean
  data?: {
    status: string
    email?: string
    userId?: string
    idp?: string // 身份提供商：BuilderId, Google, Github 等
    userStatus?: string // 用户状态：Active 等
    featureFlags?: string[] // 特性开关
    subscriptionTitle?: string
    usage?: { 
      current: number
      limit: number
      percentUsed: number
      lastUpdated: number
      baseLimit?: number
      baseCurrent?: number
      freeTrialLimit?: number
      freeTrialCurrent?: number
      freeTrialExpiry?: string
      bonuses?: BonusData[]
      nextResetDate?: string
      resourceDetail?: ResourceDetail
    }
    subscription?: { 
      type: string
      title?: string
      rawType?: string
      expiresAt?: number
      daysRemaining?: number
      upgradeCapability?: string
      overageCapability?: string
      managementTarget?: string
    }
    // 如果 token 被刷新，返回新凭证
    newCredentials?: {
      accessToken: string
      refreshToken?: string
      expiresAt?: number
    }
  }
  error?: { message: string }
}

interface KiroApi {
  openExternal: (url: string, usePrivateMode?: boolean) => void
  getAppVersion: () => Promise<string>
  onAuthCallback: (callback: (data: { code: string; state: string }) => void) => () => void

  // 账号管理
  loadAccounts: () => Promise<AccountData | null>
  saveAccounts: (data: AccountData) => Promise<void>

  // 闲置账号库（不参与保活/刷新，与主库物理隔离）
  loadIdleAccounts: () => Promise<IdleAccountData | null>
  saveIdleAccounts: (data: IdleAccountData) => Promise<void>
  refreshAccountToken: (account: unknown) => Promise<RefreshResult>
  checkAccountStatus: (account: unknown) => Promise<StatusResult>
  
  // 后台批量刷新（主进程执行，不阻塞 UI）
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
  }>, concurrency?: number, syncInfo?: boolean) => Promise<{ success: boolean; completed: number; successCount: number; failedCount: number }>
  onBackgroundRefreshProgress: (callback: (data: { completed: number; total: number; success: number; failed: number }) => void) => () => void
  onBackgroundRefreshResult: (callback: (data: { id: string; success: boolean; data?: unknown; error?: string }) => void) => () => void
  
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
  }>, concurrency?: number) => Promise<{ success: boolean; completed: number; successCount: number; failedCount: number }>
  onBackgroundCheckProgress: (callback: (data: { completed: number; total: number; success: number; failed: number }) => void) => () => void
  onBackgroundCheckResult: (callback: (data: { id: string; success: boolean; data?: unknown; error?: string }) => void) => () => void
  
  // 文件操作
  exportToFile: (data: string, filename: string) => Promise<boolean>
  importFromFile: () => Promise<{ content: string; format: string } | null>

  // 验证凭证并获取账号信息
  verifyAccountCredentials: (credentials: {
    refreshToken: string
    clientId: string
    clientSecret: string
    region?: string
    authMethod?: string  // 'IdC' 或 'social'
    provider?: string    // 'BuilderId', 'Github', 'Google'
  }) => Promise<{
    success: boolean
    data?: {
      email: string
      userId: string
      accessToken: string
      refreshToken: string
      expiresIn?: number
      subscriptionType: string
      subscriptionTitle: string
      subscription?: {
        rawType?: string
        managementTarget?: string
        upgradeCapability?: string
        overageCapability?: string
      }
      usage: { 
        current: number
        limit: number
        baseLimit?: number
        baseCurrent?: number
        freeTrialLimit?: number
        freeTrialCurrent?: number
        freeTrialExpiry?: string
        bonuses?: Array<{ code: string; name: string; current: number; limit: number; expiresAt?: string }>
        nextResetDate?: string
        resourceDetail?: {
          displayName?: string
          displayNamePlural?: string
          resourceType?: string
          currency?: string
          unit?: string
          overageRate?: number
          overageCap?: number
          overageEnabled?: boolean
        }
      }
      daysRemaining?: number
      expiresAt?: number
      profileArn?: string
    }
    error?: string
  }>


  // 从 Kiro 本地配置导入凭证
  loadKiroCredentials: () => Promise<{
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
  }>

  // 从 AWS SSO Token (x-amz-sso_authn) 导入账号
  importFromSsoToken: (bearerToken: string, region?: string) => Promise<{
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
      subscriptionType?: string
      subscriptionTitle?: string
      subscription?: {
        managementTarget?: string
        upgradeCapability?: string
        overageCapability?: string
      }
      usage?: {
        current: number
        limit: number
        baseLimit?: number
        baseCurrent?: number
        freeTrialLimit?: number
        freeTrialCurrent?: number
        freeTrialExpiry?: string
        bonuses?: Array<{ code: string; name: string; current: number; limit: number; expiresAt?: string }>
        nextResetDate?: string
        resourceDetail?: {
          displayName?: string
          displayNamePlural?: string
          resourceType?: string
          currency?: string
          unit?: string
          overageRate?: number
          overageCap?: number
          overageEnabled?: boolean
        }
      }
      daysRemaining?: number
    }
    error?: { message: string }
  }>

  // ============ 手动登录 API ============

  // 启动 Builder ID 手动登录
  startBuilderIdLogin: (region?: string) => Promise<{
    success: boolean
    userCode?: string
    verificationUri?: string
    expiresIn?: number
    interval?: number
    error?: string
  }>

  // 轮询 Builder ID 授权状态
  pollBuilderIdAuth: (region?: string) => Promise<{
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
  }>

  // 取消 Builder ID 登录
  cancelBuilderIdLogin: () => Promise<{ success: boolean }>

  // 启动 IAM Identity Center SSO 登录 (Authorization Code flow)
  startIamSsoLogin: (startUrl: string, region?: string) => Promise<{
    success: boolean
    authorizeUrl?: string
    expiresIn?: number
    error?: string
  }>

  // 轮询 IAM SSO 授权状态
  pollIamSsoAuth: (region?: string) => Promise<{
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
  }>

  // 取消 IAM SSO 登录
  cancelIamSsoLogin: () => Promise<{ success: boolean }>

  // 用无痕模式打开 https 页面（注册等快捷入口）
  openUrlPrivate: (url: string) => Promise<{ success: boolean; error?: string }>

  // 启动 Social Auth 登录 (Google/GitHub)
  startSocialLogin: (provider: 'Google' | 'Github', usePrivateMode?: boolean) => Promise<{
    success: boolean
    loginUrl?: string
    state?: string
    error?: string
  }>

  // 交换 Social Auth token
  exchangeSocialToken: (code: string, state: string) => Promise<{
    success: boolean
    accessToken?: string
    refreshToken?: string
    profileArn?: string
    expiresIn?: number
    authMethod?: string
    provider?: string
    error?: string
  }>

  // 取消 Social Auth 登录
  cancelSocialLogin: () => Promise<{ success: boolean }>

  // ─── 号池（GitHub 账密+2FA 批量激活 Kiro）───
  /** 全量快照：条目视图 + 批次状态 + 最近日志（页面重挂恢复用） */
  loginPoolList: () => Promise<{
    entries: {
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
    }[]
    batch: { running: boolean; paused: boolean; cooldownSec: number; unused: number }
    logs: Array<{ time: string; level: 'info' | 'ok' | 'err' | 'warn'; msg: string }>
  }>
  loginPoolAddText: (text: string) => Promise<{ added: number; updated: number; bad: string[] }>
  loginPoolMarkWasted: (id: string) => Promise<{ success: boolean }>
  /** 手动标记已用（账号已经其他途径入库，防重复激活） */
  loginPoolMarkUsed: (id: string) => Promise<{ success: boolean }>
  loginPoolRestore: (id: string) => Promise<{ success: boolean }>
  loginPoolRemove: (id: string) => Promise<{ success: boolean }>
  loginPoolClearFinished: () => Promise<{ success: boolean }>
  loginPoolRestoreAll: () => Promise<{ success: boolean }>
  /** 批量删除勾选条目（running 条目跳过不删），返回实际删除数 */
  loginPoolRemoveMany: (ids: string[]) => Promise<{ success: boolean; removed: number }>
  loginPoolStart: (opts: {
    intervalSec: number | 'rand'
    manualPolicy: 'wait' | 'skip'
    /** 授权自动化实验（默认关）：Authorize 先程序攻两次（轨迹点击/requestSubmit），失败回退人工 */
    autoAuthorize?: boolean
    /** 出口代理（代理池快照或提链源配置，主进程逐号消费，只读不回写） */
    proxy?: {
      enabled: boolean
      mode?: 'pool' | 'api'
      entries: Array<{ url: string; usedCount: number; latencyMs?: number }>
      strategy: 'round_robin' | 'random' | 'least_used' | 'fastest'
      upstreamProxy?: string
      api?: { url: string; viaProxy?: string; batchSize?: number }
    }
  }) => Promise<{ success: boolean; error?: string }>
  loginPoolPause: () => Promise<{ success: boolean }>
  loginPoolRunOne: (id: string, opts?: {
    intervalSec: number | 'rand'
    manualPolicy: 'wait' | 'skip'
    /** 授权自动化实验（默认关）：Authorize 先程序攻两次（轨迹点击/requestSubmit），失败回退人工 */
    autoAuthorize?: boolean
    /** 出口代理（代理池快照或提链源配置，主进程逐号消费，只读不回写） */
    proxy?: {
      enabled: boolean
      mode?: 'pool' | 'api'
      entries: Array<{ url: string; usedCount: number; latencyMs?: number }>
      strategy: 'round_robin' | 'random' | 'least_used' | 'fastest'
      upstreamProxy?: string
      api?: { url: string; viaProxy?: string; batchSize?: number }
    }
  }) => Promise<{ success: boolean; error?: string }>
  loginPoolFocusWindow: () => Promise<{ success: boolean }>
  loginPoolManualCallback: (code: string, state: string) => Promise<{ success: boolean }>
  loginPoolMarkStored: (id: string, kiroEmail: string) => Promise<{ success: boolean }>
  onLoginPoolUpdate: (callback: (update: {
    kind: 'entry'
    entry: {
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
  } | {
    kind: 'log'
    line: { time: string; level: 'info' | 'ok' | 'err' | 'warn'; msg: string }
  } | {
    kind: 'batch'
    state: { running: boolean; paused: boolean; cooldownSec: number; unused: number }
  } | {
    kind: 'result'
    payload: {
      entryId: string
      username: string
      accessToken: string
      refreshToken: string
      profileArn?: string
      expiresIn?: number
    }
  }) => void) => () => void

  // ─── Google 号池（Gmail 卡密 · 手动授权激活 Kiro）───
  /** 全量快照：条目视图 + 授权窗口状态 + 最近日志（页面重挂恢复用） */
  googlePoolList: () => Promise<{
    entries: {
      id: string
      email: string
      state: 'unused' | 'running' | 'used' | 'failed' | 'wasted'
      failReason?: string
      kiroEmail?: string
      exitIp?: string
      proxyMode?: 'api' | 'pool' | 'direct'
      secret?: string
      recoveryEmail?: string
      recoveryPassword?: string
      country?: string
      addedAt: number
      takenAt?: number
      doneAt?: number
      password: string
      passwordMasked: string
      secretMasked?: string
    }[]
    running: boolean
    batch: { active: boolean; paused: boolean; unused: number }
    logs: Array<{ time: string; level: 'info' | 'ok' | 'err' | 'warn'; msg: string }>
    pending: Array<{
      resultId: string
      entryId: string
      email: string
      accessToken: string
      refreshToken: string
      profileArn?: string
      expiresIn?: number
    }>
  }>
  /** 消费完一条入库结果后回执清除（按 resultId，无论入库成败） */
  googlePoolAckResult: (resultId: string) => Promise<{ success: boolean }>
  googlePoolAddText: (text: string) => Promise<{ added: number; updated: number; bad: string[] }>
  googlePoolMarkWasted: (id: string) => Promise<{ success: boolean }>
  /** 手动标记已用（账号已经其他途径入库，防重复授权） */
  googlePoolMarkUsed: (id: string) => Promise<{ success: boolean }>
  googlePoolRestore: (id: string) => Promise<{ success: boolean }>
  googlePoolRemove: (id: string) => Promise<{ success: boolean }>
  googlePoolRemoveMany: (ids: string[]) => Promise<{ success: boolean; removed: number }>
  googlePoolClearFinished: () => Promise<{ success: boolean }>
  googlePoolRestoreAll: () => Promise<{ success: boolean }>
  /** 发起单号授权：主进程打开授权窗口；autofill=自动填邮箱/密码/2FA（默认开），挑战与授权确认人工 */
  googlePoolAuthorize: (id: string, opts?: {
    autofill?: boolean
    proxy?: {
      enabled: boolean
      mode?: 'pool' | 'api'
      entries: Array<{ url: string; usedCount: number; latencyMs?: number }>
      strategy: 'round_robin' | 'random' | 'least_used' | 'fastest'
      upstreamProxy?: string
      api?: { url: string; viaProxy?: string; batchSize?: number }
    }
  }) => Promise<{ success: boolean; error?: string }>
  googlePoolFocusWindow: () => Promise<{ success: boolean }>
  /** 批次：串行授权全部未用号（传 ids 则只跑勾选的，挂机模式，无解挑战超时跳号） */
  googlePoolStartBatch: (opts?: {
    autofill?: boolean
    batchIntervalSec?: number | 'rand'
    ids?: string[]
    proxy?: {
      enabled: boolean
      mode?: 'pool' | 'api'
      entries: Array<{ url: string; usedCount: number; latencyMs?: number }>
      strategy: 'round_robin' | 'random' | 'least_used' | 'fastest'
      upstreamProxy?: string
      api?: { url: string; viaProxy?: string; batchSize?: number }
    }
  }) => Promise<{ success: boolean }>
  googlePoolPauseBatch: () => Promise<{ success: boolean }>
  googlePoolResumeBatch: () => Promise<{ success: boolean }>
  /** 本地算当前 6 位验证码（一键复制用；密钥不出主进程） */
  googlePoolTotp: (id: string) => Promise<{
    success: boolean
    code?: string
    remainSec?: number
    error?: string
  }>
  googlePoolManualCallback: (code: string, state: string) => Promise<{ success: boolean }>
  googlePoolMarkStored: (id: string, kiroEmail: string) => Promise<{ success: boolean }>
  onGooglePoolUpdate: (callback: (update: {
    kind: 'entry'
    entry: {
      id: string
      email: string
      state: 'unused' | 'running' | 'used' | 'failed' | 'wasted'
      failReason?: string
      kiroEmail?: string
      exitIp?: string
      proxyMode?: 'api' | 'pool' | 'direct'
      secret?: string
      recoveryEmail?: string
      recoveryPassword?: string
      country?: string
      addedAt: number
      takenAt?: number
      doneAt?: number
      password: string
      passwordMasked: string
      secretMasked?: string
    }
  } | {
    kind: 'log'
    line: { time: string; level: 'info' | 'ok' | 'err' | 'warn'; msg: string }
  } | {
    kind: 'batch'
    state: { active: boolean; paused: boolean; unused: number }
  } | {
    kind: 'result'
    payload: {
      resultId: string
      entryId: string
      email: string
      accessToken: string
      refreshToken: string
      profileArn?: string
      expiresIn?: number
    }
  }) => void) => () => void

  // 监听 Social Auth 回调
  onSocialAuthCallback: (callback: (data: { code?: string; state?: string; error?: string }) => void) => () => void

  // 代理设置
  setProxy: (enabled: boolean, url: string) => Promise<{ success: boolean; error?: string; normalizedUrl?: string }>

  // ============ 机器码管理 API ============

  // 获取操作系统类型
  machineIdGetOSType: () => Promise<'windows' | 'macos' | 'linux' | 'unknown'>

  // 获取当前机器码
  machineIdGetCurrent: () => Promise<{
    success: boolean
    machineId?: string
    error?: string
    requiresAdmin?: boolean
  }>

  // 设置新机器码
  machineIdSet: (newMachineId: string) => Promise<{
    success: boolean
    machineId?: string
    error?: string
    requiresAdmin?: boolean
  }>

  // 生成随机机器码
  machineIdGenerateRandom: () => Promise<string>

  // 检查管理员权限
  machineIdCheckAdmin: () => Promise<boolean>

  // 请求管理员权限重启
  machineIdRequestAdminRestart: () => Promise<boolean>

  // 备份机器码到文件
  machineIdBackupToFile: (machineId: string) => Promise<boolean>

  // 从文件恢复机器码
  machineIdRestoreFromFile: () => Promise<{
    success: boolean
    machineId?: string
    error?: string
  }>

  // ============ 自动更新 API ============

  // 检查更新 (electron-updater)
  checkForUpdates: () => Promise<{
    hasUpdate: boolean
    version?: string
    releaseDate?: string
    message?: string
    error?: string
  }>

  // 手动检查更新 (GitHub API, 用于 AboutPage)
  checkForUpdatesManual: () => Promise<{
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
  }>

  // 下载更新
  downloadUpdate: () => Promise<{ success: boolean; error?: string }>

  // 安装更新并重启
  installUpdate: () => Promise<void>

  // 监听更新事件
  onUpdateChecking: (callback: () => void) => () => void
  onUpdateAvailable: (callback: (info: { version: string; releaseDate?: string; releaseNotes?: string }) => void) => () => void
  onUpdateNotAvailable: (callback: (info: { version: string }) => void) => () => void
  onUpdateDownloadProgress: (callback: (progress: { percent: number; bytesPerSecond: number; transferred: number; total: number }) => void) => () => void
  onUpdateDownloaded: (callback: (info: { version: string; releaseDate?: string; releaseNotes?: string }) => void) => () => void
  onUpdateError: (callback: (error: string) => void) => () => void

  // 获取账户可用模型列表
  accountGetModels: (accessToken: string, region?: string, profileArn?: string, machineId?: string, provider?: string, authMethod?: string, accountId?: string) => Promise<{ success: boolean; error?: string; models: Array<{ id: string; name: string; description: string; inputTypes?: string[]; maxInputTokens?: number | null; maxOutputTokens?: number | null; rateMultiplier?: number; rateUnit?: string }> }>

  // 获取可用订阅列表
  accountGetSubscriptions: (accessToken: string, region?: string, profileArn?: string, machineId?: string, provider?: string, authMethod?: string, accountId?: string) => Promise<{ success: boolean; error?: string; plans: Array<{ name: string; qSubscriptionType: string; description: { title: string; billingInterval: string; featureHeader: string; features: string[] }; pricing: { amount: number; currency: string } }>; disclaimer?: string[]; credentials?: { accessToken: string; refreshToken?: string; expiresIn?: number } }>

  // 获取订阅管理/支付链接（dynamicProxy 传入时该请求经提链出口发出，见代理池页「动态提链源」）
  accountGetSubscriptionUrl: (accessToken: string, subscriptionType?: string, region?: string, profileArn?: string, machineId?: string, provider?: string, authMethod?: string, accountId?: string, dynamicProxy?: { url: string; viaProxy?: string; batchSize?: number }, exitProxyUrl?: string) => Promise<{ success: boolean; error?: string; url?: string; status?: string; exitIp?: string }>

  // 设置用户超额偏好
  accountSetOverage: (accessToken: string, overageStatus: 'ENABLED' | 'DISABLED', region?: string, profileArn?: string, machineId?: string, provider?: string, authMethod?: string, accountId?: string) => Promise<{ success: boolean; error?: string }>

  // 在新窗口打开订阅链接
  openSubscriptionWindow: (url: string) => Promise<{ success: boolean; error?: string }>

  // ============ 应用内支付（Stripe Checkout + 自动填账单地址） ============

  // 省份列表（账单地址生成用）
  paymentProvinces: () => Promise<string[]>

  // 生成一条随机中国账单地址（UI 预览用；邮编与市/区真实对应）
  paymentGenerateAddress: (province?: string) => Promise<{
    name: string
    zip: string
    city: string
    district: string
    street: string
    provinceZh: string
    provinceEn: string
  }>

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
  }) => Promise<{ success: boolean; error?: string }>

  // 快捷填入卡信息（粘贴解析后传入；内存直填支付窗口，不落盘）
  paymentFillCard: (card: { number: string; expiry: string; cvc: string }) => Promise<{ success: boolean; error?: string; results?: Array<{ key: string; ok: boolean; skipped?: boolean; error?: string }> }>

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
  }) => void) => () => void

  // 以账号身份在应用内私密浏览器打开 Kiro 官网后台（免登录）
  accountOpenPortal: (accountId: string) => Promise<{ success: boolean; error?: string }>

  // 自动切订阅到 Free（dryRun=true 只读校验链路，不提交变更）
  accountSwitchPlanFree: (accessToken: string, region?: string, profileArn?: string, machineId?: string, provider?: string, authMethod?: string, accountId?: string, dryRun?: boolean) => Promise<{ success: boolean; error?: string; alreadyFree?: boolean; alreadyScheduled?: boolean; wontRenew?: boolean; switched?: boolean; scheduledToFree?: boolean; transitionAt?: number; dryRun?: boolean; previousPlan?: string; subId?: string; billing?: StripeBillingSnapshot; credentials?: { accessToken: string; refreshToken?: string; expiresIn?: number } }>

  // 只读检查订阅续费状态（cancelAtPeriodEnd=false 表示下周期会自动续费扣款）
  accountCheckRenewal: (accessToken: string, region?: string, profileArn?: string, machineId?: string, provider?: string, authMethod?: string, accountId?: string) => Promise<{ success: boolean; error?: string; cancelAtPeriodEnd?: boolean; currentPeriodEnd?: number; planName?: string; subId?: string; isFreePlan?: boolean; scheduledToFree?: boolean; transitionAt?: number; billing?: StripeBillingSnapshot; credentials?: { accessToken: string; refreshToken?: string; expiresIn?: number } }>

  // 获取系统日志
  proxyGetLogs: (count?: number) => Promise<Array<{ timestamp: string; level: string; category: string; message: string; data?: unknown }>>

  // 清除系统日志
  proxyClearLogs: () => Promise<{ success: boolean }>

  // 获取系统日志数量
  proxyGetLogsCount: () => Promise<number>

  // ============ Usage API 类型设置 ============

  // 获取 Usage API 类型
  getUsageApiType: () => Promise<'rest' | 'cbor'>

  // 设置 Usage API 类型
  setUsageApiType: (type: 'rest' | 'cbor') => Promise<{ success: boolean; type: string }>

  // 获取是否使用 K-Proxy 代理
  getUseKProxyForApi: () => Promise<boolean>

  // 设置是否使用 K-Proxy 代理
  setUseKProxyForApi: (enabled: boolean) => Promise<{ success: boolean; enabled: boolean }>

  // ============ K-Proxy MITM 代理 ============

  // 初始化 K-Proxy
  kproxyInit: () => Promise<{ success: boolean; caInfo?: { certPath: string; fingerprint: string; validFrom: string; validTo: string }; error?: string }>

  // 启动 K-Proxy
  kproxyStart: (config?: { port?: number; host?: string; mitmDomains?: string[]; deviceId?: string }) => Promise<{ success: boolean; port?: number; error?: string }>

  // 停止 K-Proxy
  kproxyStop: () => Promise<{ success: boolean; error?: string }>

  // 获取 K-Proxy 状态
  kproxyGetStatus: () => Promise<{ running: boolean; config: unknown; stats: unknown; caInfo: unknown }>

  // 更新 K-Proxy 配置
  kproxyUpdateConfig: (config: { port?: number; host?: string; mitmDomains?: string[]; deviceId?: string; autoStart?: boolean; logRequests?: boolean }) => Promise<{ success: boolean; config?: unknown; error?: string }>

  // 设置当前设备 ID
  kproxySetDeviceId: (deviceId: string) => Promise<{ success: boolean; error?: string }>

  // 生成新的设备 ID
  kproxyGenerateDeviceId: () => Promise<{ success: boolean; deviceId?: string }>

  // 添加设备 ID 映射
  kproxyAddDeviceMapping: (mapping: { accountId: string; deviceId: string; description?: string; createdAt: number }) => Promise<{ success: boolean; error?: string }>

  // 获取所有设备 ID 映射
  kproxyGetDeviceMappings: () => Promise<{ success: boolean; mappings: Array<{ accountId: string; deviceId: string; description?: string; createdAt: number; lastUsed?: number }> }>

  // 切换到账号设备 ID
  kproxySwitchToAccount: (accountId: string) => Promise<{ success: boolean; error?: string }>

  // 获取 CA 证书
  kproxyGetCaCert: () => Promise<{ success: boolean; certPem?: string; certPath?: string; fingerprint?: string; error?: string }>

  // 导出 CA 证书
  kproxyExportCaCert: (exportPath?: string) => Promise<{ success: boolean; path?: string; error?: string }>

  // 检查 CA 证书是否已安装
  kproxyCheckCaCertInstalled: () => Promise<{ success: boolean; installed: boolean; error?: string }>

  // ============ API Key 管理 ============
  
  // 获取所有 API Keys
  proxyGetApiKeys: () => Promise<{ success: boolean; apiKeys: Array<{ id: string; name: string; key: string; enabled: boolean; createdAt: number; lastUsedAt?: number; usage: { totalRequests: number; totalCredits: number; totalInputTokens: number; totalOutputTokens: number; daily: Record<string, { requests: number; credits: number; inputTokens: number; outputTokens: number }> } }>; error?: string }>

  // 添加 API Key
  proxyAddApiKey: (apiKey: { name: string; key?: string; format?: 'sk' | 'simple' | 'token'; creditsLimit?: number }) => Promise<{ success: boolean; apiKey?: { id: string; name: string; key: string; format?: 'sk' | 'simple' | 'token'; enabled: boolean; createdAt: number; creditsLimit?: number; usage: { totalRequests: number; totalCredits: number; totalInputTokens: number; totalOutputTokens: number; daily: Record<string, { requests: number; credits: number; inputTokens: number; outputTokens: number }> } }; error?: string }>

  // 更新 API Key
  proxyUpdateApiKey: (id: string, updates: { name?: string; key?: string; enabled?: boolean; creditsLimit?: number | null }) => Promise<{ success: boolean; apiKey?: { id: string; name: string; key: string; format?: 'sk' | 'simple' | 'token'; enabled: boolean; createdAt: number; creditsLimit?: number; usage: { totalRequests: number; totalCredits: number; totalInputTokens: number; totalOutputTokens: number; daily: Record<string, { requests: number; credits: number; inputTokens: number; outputTokens: number }> } }; error?: string }>

  // 删除 API Key
  proxyDeleteApiKey: (id: string) => Promise<{ success: boolean; error?: string }>

  // 重置 API Key 用量统计
  proxyResetApiKeyUsage: (id: string) => Promise<{ success: boolean; error?: string }>

  // 安装 CA 证书到系统信任存储
  kproxyInstallCaCert: () => Promise<{ success: boolean; message?: string; error?: string }>

  // 卸载 CA 证书从系统信任存储
  kproxyUninstallCaCert: () => Promise<{ success: boolean; message?: string; error?: string }>

  // 重置 K-Proxy 统计
  kproxyResetStats: () => Promise<{ success: boolean }>

  // 监听 K-Proxy 请求事件
  onKproxyRequest: (callback: (info: { timestamp: number; method: string; host: string; path: string; isMitm: boolean; deviceIdReplaced: boolean }) => void) => () => void

  // 监听 K-Proxy 响应事件
  onKproxyResponse: (callback: (info: { timestamp: number; host: string; statusCode: number; duration: number }) => void) => () => void

  // 监听 K-Proxy 错误事件
  onKproxyError: (callback: (error: string) => void) => () => void

  // 监听 K-Proxy 状态变化事件
  onKproxyStatusChange: (callback: (status: { running: boolean; port: number }) => void) => () => void

  // 监听 K-Proxy MITM 拦截事件
  onKproxyMitm: (callback: (info: { host: string; modified: boolean }) => void) => () => void

  // ============ 自定义 titlebar API ============
  window: {
    minimize: () => void
    maximizeToggle: () => void
    close: () => void
    isMaximized: () => Promise<boolean>
    getPlatform: () => Promise<NodeJS.Platform>
    onMaximizeChange: (callback: (isMaximized: boolean) => void) => () => void
  }

  // ============ 托盘相关 API ============

  // 获取托盘设置
  getShowWindowShortcut: () => Promise<string>
  setShowWindowShortcut: (shortcut: string) => Promise<{ success: boolean; error?: string }>
  getTraySettings: () => Promise<{
    enabled: boolean
    closeAction: 'ask' | 'minimize' | 'quit'
    showNotifications: boolean
    minimizeOnStart: boolean
  }>

  // 保存托盘设置
  saveTraySettings: (settings: {
    enabled?: boolean
    closeAction?: 'ask' | 'minimize' | 'quit'
    showNotifications?: boolean
    minimizeOnStart?: boolean
  }) => Promise<{ success: boolean; error?: string }>

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
  } | null) => void

  // 更新托盘账户列表
  updateTrayAccountList: (accounts: {
    id: string
    email: string
    idp: string
    status: string
  }[]) => void

  // 刷新托盘菜单
  refreshTrayMenu: () => void

  // 更新托盘语言
  updateTrayLanguage: (language: 'en' | 'zh') => void

  // 监听托盘刷新账户事件
  onTrayRefreshAccount: (callback: () => void) => () => void

  // 监听托盘切换账户事件
  onTraySwitchAccount: (callback: () => void) => () => void

  // 监听显示关闭确认对话框事件
  onShowCloseConfirmDialog: (callback: () => void) => () => void

  // 发送关闭确认对话框响应
  sendCloseConfirmResponse: (action: 'minimize' | 'quit' | 'cancel', rememberChoice: boolean) => void

  // ============ 注册功能 API ============

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
  }) => Promise<{ success: boolean; result?: unknown; error?: string }>

  /** CF 邮箱测试 · 第一步：建测试地址（不碰 AWS 注册接口） */
  cfMailCreate: (config: {
    baseURL: string
    adminPassword: string
    domain: string
  }) => Promise<{ ok: boolean; address?: string; error?: string }>

  /** CF 邮箱测试 · 第二步：轮询查码（超时可手动填写兜底） */
  cfMailPoll: (config: {
    baseURL: string
    adminPassword: string
    domain: string
  }, address: string, timeoutSec?: number) => Promise<{ ok: boolean; receivedCode?: string; mailCount?: number; note?: string; error?: string }>

  registrationManualPhase1: (config: {
    proxy?: string
    password?: string
    fullName?: string
  }) => Promise<{ success: boolean; error?: string }>

  registrationManualPhase2: (email: string, fullName?: string) => Promise<{ success: boolean; error?: string }>

  registrationManualPhase3: (otp: string) => Promise<{ success: boolean; result?: unknown; error?: string }>

  registrationCancel: () => Promise<{ success: boolean }>

  registrationStatus: () => Promise<{ inProgress: boolean }>

  protonOpenLogin: (proxy?: string) => Promise<{ success: boolean; loggedIn: boolean; error?: string }>

  protonLoginStatus: (proxy?: string) => Promise<{ loggedIn: boolean }>

  protonClose: () => Promise<{ success: boolean }>

  // 代理池验活
  proxyPoolValidate: (params: {
    url: string
    testUrl?: string
    timeoutMs?: number
    upstreamProxy?: string
  }) => Promise<{ success: boolean; latencyMs?: number; externalIp?: string; error?: string }>

  /** Kiro IP 池服务全链路测试：查 IP → 上锁 → 探测出口 → 解锁（消耗服务端一次锁计数） */
  proxyPoolTestKiroPool: (cfg: {
    apiBase: string
    username: string
    password: string
  }) => Promise<{
    success: boolean
    error?: string
    exitIp?: string
    latencyMs?: number
    lockCount?: number
    lockThreshold?: number
    warnings?: string[]
  }>

  proxyPoolDiagnoseChain: (params: {
    targetUrl: string
    upstreamProxy: string
    testHost?: string
    testPort?: number
  }) => Promise<{
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
  }>

  // 账号-代理绑定
  accountSetProxyBinding: (accountId: string, proxyUrl: string | undefined) => Promise<{ success: boolean }>

  onRegistrationLog: (callback: (msg: string) => void) => () => void

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
  }) => void) => () => void

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
  }) => void) => () => void
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: KiroApi
  }
}
