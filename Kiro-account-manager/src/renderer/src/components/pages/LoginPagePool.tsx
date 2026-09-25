// 号池：GitHub 账号（账密+2FA）批量自动激活 Kiro。
// 主进程 loginPool/ 模块为唯一数据源，本页面只持视图 + 批次控制；
// 激活成功（result 事件）→ verifyAccountCredentials → addAccount 入账号管理
// → loginPoolMarkStored 回填，与「添加账号」弹窗的 GitHub 登录完全同一条入库链路。

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { Button, Card, CardContent, CardHeader, Badge, Input, Label } from '../ui'
import {
  Play, Pause, Plus, RotateCcw, Ban, ExternalLink, CheckCircle2, Clock, Loader2,
  KeyRound, EyeOff, Eye, Search, ChevronRight, Terminal, Trash2, Undo2, X, ClipboardCopy,
  Settings2, Copy, Check, MoreHorizontal, AlertCircle, Globe, Shield, Sparkles
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAccountsStore } from '@/store/accounts'
import type { SubscriptionType } from '@/types/account'

// ─── 类型 ─────────────────────────────────────────────────────────────

interface PoolEntryView {
  id: string
  username: string
  state: 'unused' | 'running' | 'used' | 'failed' | 'wasted'
  step: number
  failReason?: string
  kiroEmail?: string
  /** 本次尝试实际使用的出口 IP（空 = 直连） */
  exitIp?: string
  /** 本次尝试的出口来源：api=提链 / pool=静态代理池 / direct=直连 */
  proxyMode?: 'api' | 'pool' | 'direct'
  addedAt: number
  takenAt?: number
  doneAt?: number
  password: string
  secret: string
  passwordMasked: string
  secretMasked: string
}

interface BatchState {
  running: boolean
  paused: boolean
  cooldownSec: number
  unused: number
}

interface LogLine {
  time: string
  level: 'info' | 'ok' | 'err' | 'warn'
  msg: string
}

/** 执行链路 8 步（与主进程 runner 的 step 推进一一对应） */
const STEPS = [
  { key: 'open', label: '打开登录页' },
  { key: 'fill', label: '填账号密码' },
  { key: 'signin', label: '点 Sign in' },
  { key: 'totp', label: '填 2FA 码' },
  { key: 'verify', label: '点 Verify' },
  { key: 'authorize', label: 'OAuth 授权' },
  { key: 'callback', label: '回调换 Token' },
  { key: 'store', label: '入库·关窗' }
] as const

// ─── 页面主组件 ───────────────────────────────────────────────────────

export function LoginPagePool(): React.ReactNode {
  const { accounts, addAccount, proxyPool, proxyPoolConfig } = useAccountsStore()

  const [entries, setEntries] = useState<PoolEntryView[]>([])
  const [batch, setBatch] = useState<BatchState>({ running: false, paused: false, cooldownSec: 0, unused: 0 })
  const [logs, setLogs] = useState<LogLine[]>([])
  const [showLogs, setShowLogs] = useState(false)
  const [logFilter, setLogFilter] = useState<'all' | 'err_warn' | 'ok'>('all')
  const [followEnd, setFollowEnd] = useState(true)
  const [addOpen, setAddOpen] = useState(false)
  const [filter, setFilter] = useState<'all' | PoolEntryView['state']>('all')
  const [query, setQuery] = useState('')
  const [showSettings, setShowSettings] = useState(false)

  // 批量勾选（running 行不可选）
  const [selected, setSelected] = useState<Set<string>>(new Set())

  // 凭据明文显示开关（默认打码；记忆在 localStorage）
  const [showSecrets, setShowSecrets] = useState((): boolean => localStorage.getItem('loginpool_show_secrets') === 'true')
  const toggleShowSecrets = (): void => {
    setShowSecrets((v) => {
      localStorage.setItem('loginpool_show_secrets', String(!v))
      return !v
    })
  }

  // 复制反馈状态
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const triggerCopy = useCallback((key: string, text: string): void => {
    if (!text) return
    navigator.clipboard.writeText(text)
    setCopiedKey(key)
    setTimeout(() => {
      setCopiedKey((prev) => (prev === key ? null : prev))
    }, 1500)
  }, [])

  // 导出未用：复制为「账号----密码----2FA密钥」
  const [exportedCount, setExportedCount] = useState(0)
  const unusedEntries = useMemo(() => entries.filter((e) => e.state === 'unused'), [entries])
  const handleExportUnused = useCallback((): void => {
    if (!unusedEntries.length) return
    const text = unusedEntries.map((e) => `${e.username}----${e.password}----${e.secret}`).join('\n')
    navigator.clipboard.writeText(text)
    setExportedCount(unusedEntries.length)
    setTimeout(() => setExportedCount(0), 1500)
  }, [unusedEntries])

  // 批次选项
  const [intervalSec, setIntervalSec] = useState<string>(() => localStorage.getItem('loginpool_interval') || '60')
  const [manualPolicy, setManualPolicy] = useState<'wait' | 'skip'>(() =>
    localStorage.getItem('loginpool_manual') === 'skip' ? 'skip' : 'wait'
  )
  const [autoAuthorize, setAutoAuthorize] = useState<boolean>(() =>
    localStorage.getItem('loginpool_auto_authorize') === 'true'
  )
  const updateAutoAuthorize = (v: boolean): void => {
    setAutoAuthorize(v)
    localStorage.setItem('loginpool_auto_authorize', String(v))
  }
  const updateIntervalSec = (v: string): void => {
    setIntervalSec(v)
    localStorage.setItem('loginpool_interval', v)
  }
  const updateManualPolicy = (v: 'wait' | 'skip'): void => {
    setManualPolicy(v)
    localStorage.setItem('loginpool_manual', v)
  }

  // 出口代理模式
  const [proxyMode, setProxyMode] = useState<'off' | 'pool' | 'api'>(
    () =>
      (localStorage.getItem('loginpool_proxymode') as 'off' | 'pool' | 'api' | null) ??
      (localStorage.getItem('loginpool_usepool') === 'true' ? 'pool' : 'off')
  )
  const updateProxyMode = (v: 'off' | 'pool' | 'api'): void => {
    setProxyMode(v)
    localStorage.setItem('loginpool_proxymode', v)
  }
  const usablePoolCount = useMemo(
    () => Array.from(proxyPool.values()).filter((p) => p.enabled && p.status === 'alive').length,
    [proxyPool]
  )

  const logRef = useRef<HTMLDivElement>(null)
  const pushLog = useCallback((line: LogLine) => {
    setLogs((prev) => [...prev.slice(-300), line])
  }, [])

  // 判重
  const isAccountExists = useCallback(
    (email: string, userId: string): boolean =>
      Array.from(accounts.values()).some(
        (acc) => (userId && acc.userId === userId) || (email && acc.email === email && acc.credentials.provider === 'Github')
      ),
    [accounts]
  )

  // 激活成功入库
  const handleResult = useCallback(
    async (payload: {
      entryId: string
      username: string
      accessToken: string
      refreshToken: string
      profileArn?: string
      expiresIn?: number
    }) => {
      try {
        const result = await window.api.verifyAccountCredentials({
          refreshToken: payload.refreshToken,
          clientId: '',
          clientSecret: '',
          region: 'us-east-1',
          authMethod: 'social',
          provider: 'Github'
        })
        if (result.success && result.data) {
          const { email, userId } = result.data
          if (isAccountExists(email || '', userId || '')) {
            pushLog({ time: nowTime(), level: 'warn', msg: `${payload.username} 已存在于账号管理（${email || userId}），跳过入库` })
            await window.api.loginPoolMarkStored(payload.entryId, email || userId)
            return
          }
          const now = Date.now()
          addAccount({
            email,
            userId,
            nickname: email ? email.split('@')[0] : undefined,
            idp: 'Github',
            groupId: undefined,
            credentials: {
              accessToken: result.data.accessToken,
              csrfToken: '',
              refreshToken: result.data.refreshToken,
              clientId: '',
              clientSecret: '',
              region: 'us-east-1',
              expiresAt: result.data.expiresIn ? now + result.data.expiresIn * 1000 : now + 3600 * 1000,
              authMethod: 'social',
              provider: 'Github',
              profileArn: result.data.profileArn
            },
            subscription: {
              type: result.data.subscriptionType as SubscriptionType,
              title: result.data.subscriptionTitle,
              rawType: result.data.subscription?.rawType,
              daysRemaining: result.data.daysRemaining,
              expiresAt: result.data.expiresAt,
              managementTarget: result.data.subscription?.managementTarget,
              upgradeCapability: result.data.subscription?.upgradeCapability,
              overageCapability: result.data.subscription?.overageCapability
            },
            usage: {
              current: result.data.usage.current,
              limit: result.data.usage.limit,
              percentUsed: result.data.usage.limit > 0 ? result.data.usage.current / result.data.usage.limit : 0,
              lastUpdated: now,
              baseLimit: result.data.usage.baseLimit,
              baseCurrent: result.data.usage.baseCurrent,
              freeTrialLimit: result.data.usage.freeTrialLimit,
              freeTrialCurrent: result.data.usage.freeTrialCurrent,
              freeTrialExpiry: result.data.usage.freeTrialExpiry,
              bonuses: result.data.usage.bonuses,
              nextResetDate: result.data.usage.nextResetDate,
              resourceDetail: result.data.usage.resourceDetail
            },
            tags: [],
            status: 'active',
            lastUsedAt: now
          })
          await window.api.loginPoolMarkStored(payload.entryId, email || userId)
          pushLog({ time: nowTime(), level: 'ok', msg: `${payload.username} 已入库账号管理（${email}）` })
        } else {
          pushLog({ time: nowTime(), level: 'err', msg: `${payload.username} 凭证验证失败：${result.error || '未知错误'}（token 已拿到，可稍后手动导入）` })
        }
      } catch (e) {
        pushLog({ time: nowTime(), level: 'err', msg: `${payload.username} 入库异常：${e instanceof Error ? e.message : String(e)}` })
      }
    },
    [addAccount, isAccountExists, pushLog]
  )

  const refreshList = useCallback((restoreLogs = false): void => {
    void window.api.loginPoolList().then((snap) => {
      setEntries(snap.entries)
      setBatch(snap.batch)
      if (restoreLogs) setLogs(snap.logs)
    })
  }, [])

  useEffect(() => {
    refreshList(true)
    const unsubscribe = window.api.onLoginPoolUpdate((update) => {
      if (update.kind === 'entry') {
        setEntries((prev) => {
          const next = prev.filter((e) => e.id !== update.entry.id)
          next.push(update.entry)
          return sortEntries(next)
        })
      } else if (update.kind === 'log') {
        setLogs((prev) => [...prev.slice(-300), update.line])
      } else if (update.kind === 'batch') {
        setBatch(update.state)
      } else if (update.kind === 'result') {
        void handleResult(update.payload)
      }
    })
    const unsubCallback = window.api.onSocialAuthCallback((data) => {
      if (data.code && data.state) {
        void window.api.loginPoolManualCallback(data.code, data.state)
      }
    })
    return () => {
      unsubscribe()
      unsubCallback()
    }
  }, [handleResult, refreshList])

  useEffect(() => {
    if (followEnd && showLogs) logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [logs, followEnd, showLogs])

  const handleLogScroll = (e: React.UIEvent<HTMLDivElement>): void => {
    const el = e.currentTarget
    setFollowEnd(el.scrollHeight - el.scrollTop - el.clientHeight < 30)
  }

  // 出口代理参数
  const buildProxyOpts = useCallback(() => {
    if (proxyMode === 'off') return undefined
    if (proxyMode === 'api') {
      const apiCommon = {
        url: (proxyPoolConfig.dynamicApiUrl || '').trim(),
        viaProxy: (proxyPoolConfig.dynamicViaProxy || '').trim(),
        batchSize: Math.min(20, Math.max(1, Number(proxyPoolConfig.dynamicBatchSize) || 5))
      }
      return {
        enabled: true,
        mode: 'api' as const,
        entries: [] as Array<{ url: string; usedCount: number; latencyMs?: number }>,
        strategy: proxyPoolConfig.strategy,
        api:
          (proxyPoolConfig.dynamicSourceType || 'extract-api') === 'kiro-pool'
            ? {
                source: 'kiro-pool' as const,
                ...apiCommon,
                kiroPool: {
                  apiBase: (proxyPoolConfig.kiroPoolApiBase || '').trim(),
                  username: (proxyPoolConfig.kiroPoolUsername || '').trim(),
                  password: proxyPoolConfig.kiroPoolPassword || ''
                }
              }
            : apiCommon
      }
    }
    const usable = Array.from(proxyPool.values()).filter((p) => p.enabled && p.status === 'alive')
    return {
      enabled: true,
      entries: usable.map((p) => ({ url: p.url, usedCount: p.usedCount || 0, latencyMs: p.latencyMs })),
      strategy: proxyPoolConfig.strategy,
      upstreamProxy: (proxyPoolConfig.upstreamProxy || '').trim() || undefined
    }
  }, [proxyMode, proxyPool, proxyPoolConfig])

  const currentOpts = useCallback(
    () => ({
      intervalSec: intervalSec === 'rand' ? ('rand' as const) : Number(intervalSec),
      manualPolicy,
      autoAuthorize,
      proxy: buildProxyOpts()
    }),
    [intervalSec, manualPolicy, autoAuthorize, buildProxyOpts]
  )

  const startOrResume = useCallback(() => {
    void window.api.loginPoolStart(currentOpts())
  }, [currentOpts])

  const current = entries.find((e) => e.state === 'running') || null
  const list = useMemo(() => {
    return entries.filter(
      (e) => (filter === 'all' || e.state === filter) && (!query || e.username.toLowerCase().includes(query.toLowerCase()))
    )
  }, [entries, filter, query])

  // 勾选操作
  const selectableIds = useMemo(() => list.filter((e) => e.state !== 'running').map((e) => e.id), [list])
  const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selected.has(id))
  const someSelected = selectableIds.some((id) => selected.has(id))

  const toggleSelect = (id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleSelectAll = (): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (allSelected) selectableIds.forEach((id) => next.delete(id))
      else selectableIds.forEach((id) => next.add(id))
      return next
    })
  }

  const handleRemoveSelected = (): void => {
    if (!selected.size) return
    if (!window.confirm(`确定删除所选 ${selected.size} 个条目？此操作不可恢复`)) return
    void window.api.loginPoolRemoveMany([...selected]).then(() => {
      setSelected(new Set())
      refreshList()
    })
  }

  const handleRestoreSelected = async (): Promise<void> => {
    if (!selected.size) return
    for (const id of selected) {
      await window.api.loginPoolRestore(id)
    }
    setSelected(new Set())
    refreshList()
  }

  const handleMarkWastedSelected = async (): Promise<void> => {
    if (!selected.size) return
    for (const id of selected) {
      await window.api.loginPoolMarkWasted(id)
    }
    setSelected(new Set())
    refreshList()
  }

  const handleExportSelected = (): void => {
    const selectedList = entries.filter((e) => selected.has(e.id))
    if (!selectedList.length) return
    const text = selectedList.map((e) => `${e.username}----${e.password}----${e.secret}`).join('\n')
    navigator.clipboard.writeText(text)
    triggerCopy('batch_export', text)
  }

  // 统计概览
  const summary = useMemo(
    () => ({
      total: entries.length,
      success: entries.filter((e) => e.state === 'used').length,
      failed: entries.filter((e) => e.state === 'failed').length,
      unused: unusedEntries.length,
      wasted: entries.filter((e) => e.state === 'wasted').length
    }),
    [entries, unusedEntries]
  )

  const chips: { key: 'all' | PoolEntryView['state']; label: string; count: number; activeCls: string; dotCls: string }[] = [
    { key: 'all', label: '全部', count: summary.total, activeCls: 'bg-primary text-primary-foreground border-primary', dotCls: 'bg-primary' },
    { key: 'unused', label: '未用', count: summary.unused, activeCls: 'bg-zinc-700 text-white border-zinc-700', dotCls: 'bg-zinc-400' },
    { key: 'used', label: '已入库', count: summary.success, activeCls: 'bg-emerald-600 text-white border-emerald-600', dotCls: 'bg-emerald-500' },
    { key: 'failed', label: '失败', count: summary.failed, activeCls: 'bg-red-600 text-white border-red-600', dotCls: 'bg-red-500' },
    { key: 'wasted', label: '作废', count: summary.wasted, activeCls: 'bg-amber-600 text-white border-amber-600', dotCls: 'bg-amber-500' }
  ]

  const batchIdle = !batch.running
  const batchRunningActive = batch.running && !batch.paused

  const filteredLogs = useMemo(() => {
    if (logFilter === 'err_warn') return logs.filter((l) => l.level === 'err' || l.level === 'warn')
    if (logFilter === 'ok') return logs.filter((l) => l.level === 'ok')
    return logs
  }, [logs, logFilter])

  return (
    <div className="h-full flex flex-col min-h-0 p-4 gap-3 bg-background/50">
      {/* ── 顶部栏：标头与核心操作 ── */}
      <div className="flex items-center justify-between gap-4 flex-wrap pb-1 border-b border-border/40">
        <div className="flex items-center gap-3">
          <div className="h-9 w-9 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center text-primary shadow-sm">
            <KeyRound className="h-5 w-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-bold tracking-tight">GitHub 号池</h2>
              <Badge variant="outline" className="text-[11px] font-mono font-medium py-0 px-1.5 h-5 bg-background">
                {summary.total} 号
              </Badge>
              {batchRunningActive && (
                <Badge className="bg-primary/15 text-primary border-primary/30 text-[11px] animate-pulse">
                  批次运行中 ({batch.unused} 待执行)
                </Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              GitHub 账号（账密 + 2FA）批量自动激活 Kiro，完成后直接进入账号管理
            </p>
          </div>
        </div>

        {/* 核心动作组 */}
        <div className="flex items-center gap-2">
          {batchRunningActive ? (
            <Button size="sm" variant="outline" className="h-8 shadow-sm" onClick={() => void window.api.loginPoolPause()}>
              <Pause className="h-3.5 w-3.5 mr-1" /> 暂停批次
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={summary.unused === 0 && batchIdle}
              className="h-8 shadow-sm font-medium gap-1.5"
              onClick={startOrResume}
            >
              <Play className="h-3.5 w-3.5 fill-current" />
              <span>{batch.paused ? '继续批次' : '开始批次'}</span>
              <span className="opacity-80 text-[11px] font-mono">({summary.unused})</span>
            </Button>
          )}

          <Button size="sm" variant="outline" className="h-8 shadow-sm gap-1.5" onClick={() => setAddOpen(true)}>
            <Plus className="h-3.5 w-3.5" /> 粘贴入池
          </Button>

          {/* 策略设置触发器 */}
          <Button
            size="sm"
            variant={showSettings ? 'secondary' : 'outline'}
            className={cn('h-8 shadow-sm gap-1.5 transition-all', showSettings && 'bg-muted border-border font-medium')}
            onClick={() => setShowSettings((v) => !v)}
            title="展开/收起执行策略与代理设置"
          >
            <Settings2 className="h-3.5 w-3.5" />
            <span>执行策略</span>
            {proxyMode !== 'off' && (
              <span className="h-2 w-2 rounded-full bg-primary ring-2 ring-primary/20" />
            )}
          </Button>
        </div>
      </div>

      {/* ── 策略设置折叠卡片 ── */}
      {showSettings && (
        <Card className="border border-border/60 bg-muted/30 shadow-xs animate-in fade-in-50 slide-in-from-top-1 duration-200">
          <CardContent className="p-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
              {/* 出口代理 */}
              <div className="space-y-1.5 bg-background/80 p-2.5 rounded-lg border border-border/50">
                <div className="flex items-center justify-between">
                  <Label className="text-[11px] text-muted-foreground font-medium flex items-center gap-1.5">
                    <Globe className="h-3.5 w-3.5 text-primary" /> 出口代理
                  </Label>
                  {proxyMode === 'pool' && (
                    <span className="text-[10px] text-muted-foreground">{usablePoolCount} 个可用节点</span>
                  )}
                </div>
                <select
                  value={proxyMode}
                  onChange={(e) => updateProxyMode(e.target.value as 'off' | 'pool' | 'api')}
                  disabled={batchRunningActive}
                  className="w-full h-8 rounded-md border border-input bg-background px-2 text-xs focus:ring-1 focus:ring-primary focus:outline-none"
                >
                  <option value="off">关闭 (直连发起)</option>
                  <option value="pool">代理池 {usablePoolCount > 0 ? `(${usablePoolCount} 可用)` : '(池空)'}</option>
                  <option value="api">
                    {(proxyPoolConfig.dynamicSourceType || 'extract-api') === 'kiro-pool' ? '动态 IP 池服务' : '提链 API 动态提取'}
                  </option>
                </select>
              </div>

              {/* 批次间隔 */}
              <div className="space-y-1.5 bg-background/80 p-2.5 rounded-lg border border-border/50">
                <Label className="text-[11px] text-muted-foreground font-medium flex items-center gap-1.5">
                  <Clock className="h-3.5 w-3.5 text-primary" /> 批次号间隔 (防风控)
                </Label>
                <select
                  value={intervalSec}
                  onChange={(e) => updateIntervalSec(e.target.value)}
                  disabled={batchRunningActive}
                  className="w-full h-8 rounded-md border border-input bg-background px-2 text-xs focus:ring-1 focus:ring-primary focus:outline-none"
                >
                  <option value="5">5 秒 (极速)</option>
                  <option value="15">15 秒</option>
                  <option value="30">30 秒</option>
                  <option value="60">60 秒 (推荐)</option>
                  <option value="120">120 秒</option>
                  <option value="rand">随机 30–120 秒</option>
                </select>
              </div>

              {/* 人工验证策略 */}
              <div className="space-y-1.5 bg-background/80 p-2.5 rounded-lg border border-border/50">
                <Label className="text-[11px] text-muted-foreground font-medium flex items-center gap-1.5">
                  <Shield className="h-3.5 w-3.5 text-primary" /> 人工挑战策略
                </Label>
                <select
                  value={manualPolicy}
                  onChange={(e) => updateManualPolicy(e.target.value as 'wait' | 'skip')}
                  disabled={batchRunningActive}
                  className="w-full h-8 rounded-md border border-input bg-background px-2 text-xs focus:ring-1 focus:ring-primary focus:outline-none"
                >
                  <option value="wait">暂停等待人工处理</option>
                  <option value="skip">标记失败跳过下一号</option>
                </select>
              </div>

              {/* 授权自动化实验 */}
              <div className="space-y-1.5 bg-background/80 p-2.5 rounded-lg border border-border/50">
                <Label className="text-[11px] text-muted-foreground font-medium flex items-center gap-1.5">
                  <Sparkles className="h-3.5 w-3.5 text-primary" /> 授权自动化 (实验)
                </Label>
                <select
                  value={autoAuthorize ? 'on' : 'off'}
                  onChange={(e) => updateAutoAuthorize(e.target.value === 'on')}
                  disabled={batchRunningActive}
                  className="w-full h-8 rounded-md border border-input bg-background px-2 text-xs focus:ring-1 focus:ring-primary focus:outline-none"
                >
                  <option value="off">关闭 (人工点击授权确认)</option>
                  <option value="on">实验 (程序拟人点击与提交)</option>
                </select>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── 当前执行卡片 ── */}
      {current && (
        <Card className="border-primary/40 bg-primary/[0.03] shadow-sm shrink-0">
          <CardContent className="p-3.5">
            <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
              <div className="flex items-center gap-2.5">
                <span className="relative flex h-2.5 w-2.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" />
                  <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-primary" />
                </span>
                <span className="text-sm font-mono font-bold text-foreground">{current.username}</span>
                <span className="text-xs text-muted-foreground">
                  {current.step < STEPS.length ? `正在进行: ${STEPS[Math.min(current.step, 7)].label}` : '授权完成，处理入库中'}
                </span>
                {current.exitIp && (
                  <Badge variant="outline" className="text-[10px] font-mono px-1.5 py-0 h-4 border-primary/30 text-primary">
                    出口: {current.exitIp} ({current.proxyMode === 'api' ? '提链' : current.proxyMode === 'pool' ? '代理池' : '直连'})
                  </Badge>
                )}
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" className="h-7 text-xs gap-1.5 shadow-xs" onClick={() => void window.api.loginPoolFocusWindow()}>
                  <ExternalLink className="h-3.5 w-3.5" /> 切换置顶窗口
                </Button>
              </div>
            </div>
            <StepBar step={current.step} />
          </CardContent>
        </Card>
      )}

      {/* ── 筛选栏与操作工具 ── */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-1.5 flex-wrap">
          {chips.map((c) => {
            const isSelected = filter === c.key
            return (
              <button
                key={c.key}
                onClick={() => setFilter(c.key)}
                className={cn(
                  'px-3 py-1 rounded-full text-xs font-medium border transition-all flex items-center gap-1.5',
                  isSelected
                    ? c.activeCls
                    : 'text-muted-foreground bg-card hover:bg-muted/70 border-border/60 hover:text-foreground'
                )}
              >
                <span className={cn('h-1.5 w-1.5 rounded-full', isSelected ? 'bg-white' : c.dotCls)} />
                <span>{c.label}</span>
                <span className={cn('text-[11px] opacity-75 font-mono', isSelected ? 'text-white' : 'text-muted-foreground')}>
                  {c.count}
                </span>
              </button>
            )
          })}
        </div>

        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索账号…"
              className="h-8 w-44 pl-8 text-xs bg-card"
            />
            {query && (
              <button onClick={() => setQuery('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                <X className="h-3 w-3" />
              </button>
            )}
          </div>

          <Button
            size="sm"
            variant="ghost"
            className="h-8 text-xs px-2.5 text-muted-foreground hover:text-foreground"
            title={showSecrets ? '密码与 2FA 当前明文显示，点击恢复打码' : '显示密码与 2FA 明文'}
            onClick={toggleShowSecrets}
          >
            {showSecrets ? <Eye className="h-3.5 w-3.5 mr-1" /> : <EyeOff className="h-3.5 w-3.5 mr-1 text-muted-foreground" />}
            {showSecrets ? '明文' : '打码'}
          </Button>

          <Button
            size="sm"
            variant="ghost"
            className="h-8 text-xs px-2.5 text-muted-foreground hover:text-foreground"
            title="把全部未用账号复制为「账号----密码----2FA密钥」文本"
            disabled={!unusedEntries.length}
            onClick={handleExportUnused}
          >
            <ClipboardCopy className="h-3.5 w-3.5 mr-1" />
            {exportedCount ? `已复制 ${exportedCount}` : `导出未用 (${unusedEntries.length})`}
          </Button>

          <Button
            size="sm"
            variant="ghost"
            className="h-8 text-xs px-2.5 text-muted-foreground hover:text-foreground"
            title="把已成功入库的条目移出列表（账号仍完整保留在账号管理）"
            onClick={() => { void window.api.loginPoolClearFinished().then(() => refreshList()) }}
          >
            <Trash2 className="h-3.5 w-3.5 mr-1" /> 清理已入库
          </Button>

          <Button
            size="sm"
            variant="ghost"
            className="h-8 text-xs px-2.5 text-muted-foreground hover:text-foreground"
            title="已入库/失败/作废全部拨回未用状态"
            onClick={() => { void window.api.loginPoolRestoreAll().then(() => refreshList()) }}
          >
            <Undo2 className="h-3.5 w-3.5 mr-1" /> 全部重置未用
          </Button>
        </div>
      </div>

      {/* ── 批量操作浮动条（勾选时激活） ── */}
      {selected.size > 0 && (
        <div className="bg-primary/10 border border-primary/30 text-primary-foreground px-3 py-2 rounded-lg flex items-center justify-between gap-3 text-xs shadow-sm animate-in fade-in-50 duration-150">
          <div className="flex items-center gap-2 text-foreground font-medium">
            <span className="flex h-5 w-5 rounded-full bg-primary text-primary-foreground items-center justify-center text-[11px] font-mono">
              {selected.size}
            </span>
            <span>已选中 {selected.size} 项</span>
          </div>

          <div className="flex items-center gap-1.5 flex-wrap">
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs bg-background hover:bg-muted text-foreground border-border"
              onClick={handleExportSelected}
            >
              <Copy className="h-3 w-3 mr-1" />
              {copiedKey === 'batch_export' ? '已复制卡密' : '导出勾选'}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs bg-background hover:bg-muted text-foreground border-border"
              onClick={() => { void handleRestoreSelected() }}
            >
              <Undo2 className="h-3 w-3 mr-1 text-sky-500" /> 恢复未用
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs bg-background hover:bg-muted text-foreground border-border"
              onClick={() => { void handleMarkWastedSelected() }}
            >
              <Ban className="h-3 w-3 mr-1 text-amber-500" /> 标记作废
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs bg-background hover:bg-destructive/10 text-destructive border-destructive/30"
              onClick={handleRemoveSelected}
            >
              <Trash2 className="h-3 w-3 mr-1" /> 删除所选
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => setSelected(new Set())}
            >
              取消
            </Button>
          </div>
        </div>
      )}

      {/* ── 数据表格 ── */}
      <Card className="flex-1 min-h-0 flex flex-col border-border/60 shadow-xs">
        <div className="flex-1 overflow-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0 z-10 bg-muted/80 backdrop-blur-md border-b border-border/60">
              <tr className="text-muted-foreground font-medium">
                <th className="text-left py-2 px-3 w-9">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 accent-primary rounded align-middle cursor-pointer"
                    checked={allSelected}
                    disabled={!selectableIds.length}
                    onChange={toggleSelectAll}
                    ref={(el) => {
                      if (el) el.indeterminate = someSelected && !allSelected
                    }}
                  />
                </th>
                <th className="text-left py-2 px-2 min-w-[150px]">GitHub 账号</th>
                <th className="text-left py-2 px-2 min-w-[110px]">密码</th>
                <th className="text-left py-2 px-2 min-w-[160px]">2FA 密钥</th>
                <th className="text-left py-2 px-2 w-20">状态</th>
                <th className="text-left py-2 px-2 w-48">执行进度</th>
                <th className="text-left py-2 px-2 min-w-[160px]">入库邮箱</th>
                <th className="text-left py-2 px-2 min-w-[160px]">原因/备注</th>
                <th className="text-right py-2 px-3 min-w-[130px]">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/40">
              {list.length === 0 && (
                <tr>
                  <td colSpan={9} className="py-14 text-center text-muted-foreground">
                    <div className="flex flex-col items-center justify-center gap-2">
                      <KeyRound className="h-8 w-8 text-muted-foreground/40" />
                      <p className="text-xs">
                        {entries.length === 0
                          ? '池是空的，点击上方「粘贴入池」，每行一条 账号----密码----2FA密钥'
                          : '没有找到匹配的账号记录'}
                      </p>
                    </div>
                  </td>
                </tr>
              )}
              {list.map((e) => {
                const isSelected = selected.has(e.id)
                const isRunning = e.state === 'running'

                return (
                  <tr
                    key={e.id}
                    className={cn(
                      'transition-colors hover:bg-muted/40',
                      isRunning && 'bg-primary/[0.04]',
                      isSelected && 'bg-primary/[0.06]'
                    )}
                  >
                    {/* 复选框 */}
                    <td className="py-2 px-3">
                      {isRunning ? (
                        <span className="block h-2 w-2 rounded-full bg-primary animate-pulse" />
                      ) : (
                        <input
                          type="checkbox"
                          className="h-3.5 w-3.5 accent-primary rounded align-middle cursor-pointer"
                          checked={isSelected}
                          onChange={() => toggleSelect(e.id)}
                        />
                      )}
                    </td>

                    {/* 账号 */}
                    <td className="py-2 px-2">
                      <div className="flex items-center gap-1.5 group max-w-[200px]">
                        <span className="font-mono text-foreground font-medium truncate select-all">{e.username}</span>
                        <button
                          type="button"
                          className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-foreground shrink-0"
                          title="复制账号"
                          onClick={() => triggerCopy(`user_${e.id}`, e.username)}
                        >
                          {copiedKey === `user_${e.id}` ? (
                            <Check className="h-3 w-3 text-emerald-500" />
                          ) : (
                            <Copy className="h-3 w-3" />
                          )}
                        </button>
                      </div>
                    </td>

                    {/* 密码 */}
                    <td className="py-2 px-2">
                      <div className="flex items-center gap-1.5 group">
                        <span
                          className={cn('font-mono truncate max-w-[120px]', !showSecrets && 'text-muted-foreground select-none')}
                          title={showSecrets ? e.password : '已打码，悬浮点右侧按钮复制'}
                        >
                          {showSecrets ? e.password : e.passwordMasked}
                        </span>
                        <button
                          type="button"
                          className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-foreground shrink-0"
                          title="复制密码"
                          onClick={() => triggerCopy(`pwd_${e.id}`, e.password)}
                        >
                          {copiedKey === `pwd_${e.id}` ? (
                            <Check className="h-3 w-3 text-emerald-500" />
                          ) : (
                            <Copy className="h-3 w-3" />
                          )}
                        </button>
                      </div>
                    </td>

                    {/* 2FA 密钥 */}
                    <td className="py-2 px-2">
                      <div className="flex items-center gap-1.5 group">
                        <span
                          className={cn('font-mono text-[11px] truncate max-w-[140px]', !showSecrets && 'text-muted-foreground select-none')}
                          title={e.secret}
                        >
                          {showSecrets ? e.secret : e.secretMasked}
                        </span>
                        <button
                          type="button"
                          className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-foreground shrink-0"
                          title="复制 2FA 密钥"
                          onClick={() => triggerCopy(`secret_${e.id}`, e.secret)}
                        >
                          {copiedKey === `secret_${e.id}` ? (
                            <Check className="h-3 w-3 text-emerald-500" />
                          ) : (
                            <Copy className="h-3 w-3" />
                          )}
                        </button>
                      </div>
                    </td>

                    {/* 状态 */}
                    <td className="py-2 px-2">
                      <StateBadge state={e.state} />
                    </td>

                    {/* 执行进度 */}
                    <td className="py-2 px-2">
                      {e.state === 'running' ? (
                        <StepBar step={e.step} compact />
                      ) : (
                        <span className="text-muted-foreground font-mono text-[11px]">
                          {e.state === 'used' ? (
                            <span className="text-emerald-600 dark:text-emerald-400 font-medium">✓ 8/8 完成</span>
                          ) : e.state === 'failed' ? (
                            <span className="text-red-500">中断于 {e.step}/8 ({STEPS[Math.min(e.step, 7)]?.label})</span>
                          ) : (
                            '—'
                          )}
                        </span>
                      )}
                    </td>

                    {/* 入库绑定邮箱 */}
                    <td className="py-2 px-2">
                      {e.kiroEmail ? (
                        <div className="flex items-center gap-1 group max-w-[170px]">
                          <span className="font-mono text-emerald-600 dark:text-emerald-400 truncate text-[11px]" title={e.kiroEmail}>
                            {e.kiroEmail}
                          </span>
                          <button
                            type="button"
                            className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-foreground shrink-0"
                            title="复制入库邮箱"
                            onClick={() => triggerCopy(`kiro_${e.id}`, e.kiroEmail!)}
                          >
                            {copiedKey === `kiro_${e.id}` ? (
                              <Check className="h-3 w-3 text-emerald-500" />
                            ) : (
                              <Copy className="h-3 w-3" />
                            )}
                          </button>
                        </div>
                      ) : (
                        <span className="text-muted-foreground/60">—</span>
                      )}
                    </td>

                    {/* 失败原因 */}
                    <td className="py-2 px-2">
                      {e.failReason ? (
                        <span className="text-red-500 font-mono text-[11px] truncate block max-w-[170px]" title={e.failReason}>
                          {e.failReason}
                        </span>
                      ) : (
                        <span className="text-muted-foreground/60">—</span>
                      )}
                    </td>

                    {/* 操作列 */}
                    <td className="py-2 px-3 text-right">
                      <div className="flex items-center justify-end gap-1">
                        {e.state === 'unused' && (
                          <Button
                            size="sm"
                            className="h-6 px-2.5 text-[11px] gap-1 shadow-xs"
                            disabled={batch.running}
                            title="单独执行此号激活"
                            onClick={() => void window.api.loginPoolRunOne(e.id, currentOpts())}
                          >
                            <Play className="h-3 w-3 fill-current" /> 单跑
                          </Button>
                        )}
                        {e.state === 'failed' && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-6 px-2.5 text-[11px] gap-1 border-primary/30 text-primary hover:bg-primary/10 shadow-xs"
                            disabled={batch.running}
                            title="重新发起此号激活"
                            onClick={() => void window.api.loginPoolRunOne(e.id, currentOpts())}
                          >
                            <RotateCcw className="h-3 w-3" /> 重试
                          </Button>
                        )}

                        {/* 更多动作菜单 */}
                        <ActionDropdown
                          entry={e}
                          onRefresh={refreshList}
                          onRemove={(id) => {
                            void window.api.loginPoolRemove(id).then(() => {
                              setEntries((prev) => prev.filter((x) => x.id !== id))
                              setSelected((prev) => {
                                const next = new Set(prev)
                                next.delete(id)
                                return next
                              })
                            })
                          }}
                        />
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        {/* 批次状态条 */}
        {(batch.running || batch.cooldownSec > 0) && (
          <div className="border-t border-border/60 px-4 py-2 flex items-center justify-between text-xs text-muted-foreground bg-muted/20 shrink-0">
            <div className="flex items-center gap-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
              {batchRunningActive ? (
                <span>批次执行中 · 剩余待执行 <strong className="text-foreground">{batch.unused}</strong></span>
              ) : batch.paused ? (
                <span>批次已暂停 · 当前号跑完后不再取下一号</span>
              ) : (
                <span>批次挂起中</span>
              )}
            </div>
            {batch.cooldownSec > 0 && (
              <span className="flex items-center gap-1 font-mono text-[11px] text-amber-600 dark:text-amber-400">
                <Clock className="h-3 w-3" /> 下一号冷却倒计时: {batch.cooldownSec}s
              </span>
            )}
          </div>
        )}
      </Card>

      {/* ── 执行日志面板 ── */}
      <Card className="shrink-0 border-border/60 shadow-xs overflow-hidden">
        <CardHeader
          className="py-2 px-3 border-b border-border/40 flex flex-row items-center justify-between cursor-pointer select-none bg-muted/30 hover:bg-muted/50 transition-colors"
          onClick={() => setShowLogs((v) => !v)}
        >
          <div className="flex items-center gap-2">
            <Terminal className="h-3.5 w-3.5 text-primary" />
            <span className="text-xs font-semibold">运行日志</span>
            <Badge variant="outline" className="text-[10px] h-4 px-1 font-mono">
              {logs.length}
            </Badge>
          </div>

          <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
            {showLogs && (
              <>
                {/* 级别过滤 */}
                <div className="flex items-center gap-1 bg-background border border-border/60 rounded p-0.5 text-[10px]">
                  <button
                    onClick={() => setLogFilter('all')}
                    className={cn('px-1.5 py-0.5 rounded', logFilter === 'all' && 'bg-primary text-primary-foreground font-medium')}
                  >
                    全部
                  </button>
                  <button
                    onClick={() => setLogFilter('err_warn')}
                    className={cn('px-1.5 py-0.5 rounded text-red-500', logFilter === 'err_warn' && 'bg-red-500 text-white font-medium')}
                  >
                    仅警错
                  </button>
                  <button
                    onClick={() => setLogFilter('ok')}
                    className={cn('px-1.5 py-0.5 rounded text-emerald-600', logFilter === 'ok' && 'bg-emerald-600 text-white font-medium')}
                  >
                    仅成功
                  </button>
                </div>

                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
                  title="复制当前日志"
                  onClick={() => {
                    const text = filteredLogs.map((l) => `[${l.time}] [${l.level}] ${l.msg}`).join('\n')
                    navigator.clipboard.writeText(text)
                    triggerCopy('all_logs', text)
                  }}
                >
                  <ClipboardCopy className="h-3 w-3 mr-1" />
                  {copiedKey === 'all_logs' ? '已复制' : '复制'}
                </Button>

                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
                  title="清空当前日志"
                  onClick={() => setLogs([])}
                >
                  <Trash2 className="h-3 w-3 mr-1" /> 清空
                </Button>
              </>
            )}
            <ChevronRight className={cn('h-4 w-4 text-muted-foreground transition-transform duration-200', showLogs && 'rotate-90')} />
          </div>
        </CardHeader>

        {showLogs && (
          <div className="relative bg-zinc-950">
            <div
              ref={logRef}
              onScroll={handleLogScroll}
              className="h-44 max-h-[320px] min-h-[140px] overflow-y-auto p-3 font-mono text-xs leading-5 space-y-0.5 text-zinc-300"
            >
              {filteredLogs.length === 0 ? (
                <div className="text-zinc-600 text-center py-6 text-xs">暂无相关日志</div>
              ) : (
                filteredLogs.map((l, i) => (
                  <div key={i} className="flex gap-2 items-start hover:bg-zinc-900/60 px-1 rounded">
                    <span className="text-zinc-600 shrink-0 select-none text-[11px]">{l.time}</span>
                    <span
                      className={cn(
                        'shrink-0 text-[10px] font-bold uppercase px-1 rounded select-none',
                        l.level === 'ok' && 'bg-emerald-950 text-emerald-400 border border-emerald-800/40',
                        l.level === 'err' && 'bg-red-950 text-red-400 border border-red-800/40',
                        l.level === 'warn' && 'bg-amber-950 text-amber-400 border border-amber-800/40',
                        l.level === 'info' && 'bg-zinc-900 text-zinc-400'
                      )}
                    >
                      {l.level}
                    </span>
                    <span
                      className={cn(
                        'break-all',
                        l.level === 'ok' && 'text-emerald-300',
                        l.level === 'err' && 'text-red-300',
                        l.level === 'warn' && 'text-amber-300',
                        l.level === 'info' && 'text-zinc-200'
                      )}
                    >
                      {l.msg}
                    </span>
                  </div>
                ))
              )}
            </div>

            {!followEnd && (
              <button
                type="button"
                onClick={() => {
                  const el = logRef.current
                  if (el) el.scrollTo({ top: el.scrollHeight })
                  setFollowEnd(true)
                }}
                className="absolute bottom-2 right-3 rounded-full border border-zinc-700 bg-zinc-800/90 backdrop-blur px-2.5 py-1 text-[11px] text-zinc-200 shadow hover:bg-zinc-700 transition-colors"
              >
                ↓ 滚动到底部
              </button>
            )}
          </div>
        )}
      </Card>

      {/* ── 入池弹窗 ── */}
      {addOpen && (
        <AddPoolDialog
          onClose={() => setAddOpen(false)}
          onDone={() => refreshList()}
          pushLog={pushLog}
        />
      )}
    </div>
  )
}

// ─── 行操作菜单下拉 ───────────────────────────────────────────────────

function ActionDropdown({
  entry,
  onRefresh,
  onRemove
}: {
  entry: PoolEntryView
  onRefresh: () => void
  onRemove: (id: string) => void
}): React.ReactNode {
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handleClickOutside = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [open])

  if (entry.state === 'running') return null

  return (
    <div className="relative inline-block" ref={menuRef}>
      <Button
        size="sm"
        variant="ghost"
        className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
        title="更多选项"
        onClick={() => setOpen((v) => !v)}
      >
        <MoreHorizontal className="h-3.5 w-3.5" />
      </Button>

      {open && (
        <div className="absolute right-0 top-full mt-1 w-32 rounded-lg border border-border bg-popover text-popover-foreground shadow-md p-1 z-30 animate-in fade-in-50 zoom-in-95 duration-100 text-xs">
          {entry.state !== 'used' && (
            <button
              className="w-full flex items-center gap-1.5 px-2 py-1.5 rounded-md hover:bg-muted text-emerald-600 dark:text-emerald-400 text-left transition-colors"
              onClick={() => {
                setOpen(false)
                void window.api.loginPoolMarkUsed(entry.id).then(onRefresh)
              }}
            >
              <CheckCircle2 className="h-3.5 w-3.5" />
              <span>标记已用</span>
            </button>
          )}

          <button
            className="w-full flex items-center gap-1.5 px-2 py-1.5 rounded-md hover:bg-muted text-sky-600 dark:text-sky-400 text-left transition-colors"
            onClick={() => {
              setOpen(false)
              void window.api.loginPoolRestore(entry.id).then(onRefresh)
            }}
          >
            <Undo2 className="h-3.5 w-3.5" />
            <span>恢复未用</span>
          </button>

          {entry.state !== 'wasted' && (
            <button
              className="w-full flex items-center gap-1.5 px-2 py-1.5 rounded-md hover:bg-muted text-amber-600 dark:text-amber-400 text-left transition-colors"
              onClick={() => {
                setOpen(false)
                void window.api.loginPoolMarkWasted(entry.id).then(onRefresh)
              }}
            >
              <Ban className="h-3.5 w-3.5" />
              <span>作废此号</span>
            </button>
          )}

          <div className="my-1 border-t border-border/50" />

          <button
            className="w-full flex items-center gap-1.5 px-2 py-1.5 rounded-md hover:bg-destructive/10 text-destructive text-left transition-colors"
            onClick={() => {
              setOpen(false)
              onRemove(entry.id)
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
            <span>删除记录</span>
          </button>
        </div>
      )}
    </div>
  )
}

// ─── 入池弹窗（带实时校验统计与排错交互） ──────────────────────────────

function AddPoolDialog({
  onClose,
  onDone,
  pushLog
}: {
  onClose: () => void
  onDone: () => void
  pushLog: (line: LogLine) => void
}): React.ReactNode {
  const [text, setText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<{ added: number; updated: number; bad: string[] } | null>(null)

  // 简易前端快速预检统计
  const previewStats = useMemo(() => {
    if (!text.trim()) return null
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    let validCount = 0
    let badCount = 0
    for (const l of lines) {
      const parts = l.split('----')
      if (parts.length === 3 && parts[0] && parts[1] && parts[2]) {
        validCount++
      } else {
        badCount++
      }
    }
    return { total: lines.length, validCount, badCount }
  }, [text])

  const submit = async (): Promise<void> => {
    if (!text.trim() || submitting) return
    setSubmitting(true)
    try {
      const r = await window.api.loginPoolAddText(text)
      setResult(r)
      pushLog({
        time: nowTime(),
        level: r.bad.length ? 'warn' : 'ok',
        msg: `入池：新增 ${r.added}、覆盖 ${r.updated}${r.bad.length ? `、非法 ${r.bad.length} 行` : ''}`
      })
      if (r.bad.length === 0) {
        onDone()
        setTimeout(onClose, 600)
      }
    } finally {
      setSubmitting(false)
    }
  }

  const keepOnlyBadLines = (): void => {
    if (!result?.bad.length) return
    setText(result.bad.join('\n'))
    setResult(null)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4 animate-in fade-in-50 duration-150" onClick={onClose}>
      <div className="w-full max-w-xl rounded-xl border border-border bg-card shadow-xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-border/60 px-4 py-3 bg-muted/30">
          <div className="flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-semibold">粘贴卡密入池 (GitHub)</h3>
          </div>
          <Button size="sm" variant="ghost" className="h-7 w-7 p-0 rounded-full" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="p-4 space-y-3">
          <div className="text-xs text-muted-foreground leading-5 bg-muted/40 p-2.5 rounded-lg border border-border/50">
            <p className="font-medium text-foreground mb-1">格式规范（每行一条，以严格 4 连字符 <code className="bg-background px-1 rounded border">----</code> 分隔）：</p>
            <div className="font-mono text-[11px] text-foreground">
              账号----密码----2FA密钥
            </div>
            <p className="mt-1 text-[11px]">2FA 密钥为 GitHub 两步验证的 base32 setup key，同账号重贴将覆盖凭据并保持原有状态。</p>
          </div>

          <textarea
            className="w-full h-48 rounded-lg border border-input bg-background p-3 font-mono text-xs resize-none focus:outline-none focus:ring-1 focus:ring-primary leading-relaxed"
            placeholder={'dev-rover-4821----MyP@ssw0rd----DHTJZSRCRXVW6DVV\notter-build-3177----AnotherPass----K7QP2XAMKR4W7DVV'}
            value={text}
            onChange={(e) => { setText(e.target.value); setResult(null) }}
            spellCheck={false}
            autoFocus
          />

          {/* 实时预检提示 */}
          {previewStats && !result && (
            <div className="flex items-center gap-3 text-xs text-muted-foreground px-1">
              <span>共识别 {previewStats.total} 行</span>
              {previewStats.validCount > 0 && <span className="text-primary">规范格式: {previewStats.validCount}</span>}
              {previewStats.badCount > 0 && <span className="text-amber-500">格式异常: {previewStats.badCount}</span>}
            </div>
          )}

          {/* 提交后排错 */}
          {result && (
            <div className="text-xs space-y-2">
              {result.bad.length === 0 ? (
                <div className="p-2.5 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-600 dark:text-emerald-400 flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 shrink-0" />
                  <span>入池成功：新增 {result.added} 条、覆盖更新 {result.updated} 条</span>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-600 dark:text-amber-400 flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <AlertCircle className="h-4 w-4 shrink-0" />
                      <span>已入池 {result.added} 条，另有 {result.bad.length} 行无法解析：</span>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 text-[11px] border-amber-500/40 text-amber-600 hover:bg-amber-500/20"
                      onClick={keepOnlyBadLines}
                    >
                      仅保留异常行以修改
                    </Button>
                  </div>
                  <pre className="max-h-24 overflow-auto rounded-lg bg-zinc-950 p-2 font-mono text-[11px] text-red-300 whitespace-pre-wrap border border-red-900/40">
                    {result.bad.join('\n')}
                  </pre>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border/60 px-4 py-3 bg-muted/20">
          <Button size="sm" variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button size="sm" onClick={() => void submit()} disabled={!text.trim() || submitting} className="gap-1.5 shadow-sm">
            {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
            确认入池
          </Button>
        </div>
      </div>
    </div>
  )
}

// ─── 共享小件 ────────────────────────────────────────────────────────

function nowTime(): string {
  const d = new Date()
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':')
}

function sortEntries(list: PoolEntryView[]): PoolEntryView[] {
  const order: PoolEntryView['state'][] = ['running', 'unused', 'used', 'failed', 'wasted']
  return [...list].sort((a, b) => {
    const d = order.indexOf(a.state) - order.indexOf(b.state)
    return d !== 0 ? d : a.id.localeCompare(b.id)
  })
}

function StateBadge({ state }: { state: PoolEntryView['state'] }): React.ReactNode {
  const map: Record<PoolEntryView['state'], { label: string; cls: string; dot: string }> = {
    running: {
      label: '执行中',
      cls: 'bg-primary/10 text-primary border-primary/30',
      dot: 'bg-primary animate-pulse'
    },
    unused: {
      label: '未用',
      cls: 'bg-zinc-500/10 text-zinc-500 border-zinc-500/30',
      dot: 'bg-zinc-400'
    },
    used: {
      label: '已入库',
      cls: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30',
      dot: 'bg-emerald-500'
    },
    failed: {
      label: '失败',
      cls: 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/30',
      dot: 'bg-red-500'
    },
    wasted: {
      label: '作废',
      cls: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30',
      dot: 'bg-amber-500'
    }
  }
  const s = map[state]
  return (
    <Badge variant="outline" className={cn('text-[11px] font-normal py-0 px-1.5 h-5 flex items-center gap-1.5 w-fit', s.cls)}>
      <span className={cn('h-1.5 w-1.5 rounded-full', s.dot)} />
      <span>{s.label}</span>
    </Badge>
  )
}

/** 8 步 stepper：compact=表格行内迷你版 */
function StepBar({ step, compact }: { step: number; compact?: boolean }): React.ReactNode {
  return (
    <div className={cn('flex items-center w-full', compact ? 'gap-0' : 'gap-1')}>
      {STEPS.map((s, i) => {
        const done = i < step
        const active = i === step
        return (
          <div key={s.key} className="flex items-center flex-1 min-w-0 last:flex-none">
            <div className="flex flex-col items-center gap-1 shrink-0">
              <div
                className={cn(
                  'flex items-center justify-center rounded-full transition-colors',
                  compact ? 'h-3.5 w-3.5' : 'h-7 w-7',
                  done && 'bg-emerald-500 text-white',
                  active && 'bg-primary text-primary-foreground ring-3 ring-primary/20',
                  !done && !active && 'bg-muted text-muted-foreground/50'
                )}
              >
                {done && <CheckCircle2 className={compact ? 'h-2.5 w-2.5' : 'h-3.5 w-3.5'} />}
                {active && <Loader2 className={cn(compact ? 'h-2 w-2' : 'h-3.5 w-3.5', 'animate-spin')} />}
                {!done && !active && <span className={cn('rounded-full bg-current', compact ? 'h-1 w-1' : 'h-1.5 w-1.5')} />}
              </div>
              {!compact && (
                <span className={cn('text-[10px] whitespace-nowrap', active ? 'text-primary font-semibold' : done ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground/60')}>
                  {s.label}
                </span>
              )}
            </div>
            {i < STEPS.length - 1 && (
              <div className={cn('flex-1 mx-1', compact ? 'h-px' : 'h-0.5 rounded-full', done ? 'bg-emerald-500' : 'bg-muted')} />
            )}
          </div>
        )
      })}
    </div>
  )
}
