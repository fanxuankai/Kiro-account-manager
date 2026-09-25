// Google 号池：Gmail 卡密（邮箱+密码+2FA 密钥）手动授权激活 Kiro。
// 主进程 googlePool/ 模块为唯一数据源，本页面只持视图；
// 授权流程：点「授权」→ 应用打开 Kiro Google OAuth 窗口（代理+指纹已装配）→
// 人工登录（密码 + 2FA，2FA 六位码由本页本地算好一键复制）→ 主进程拦 kiro://
// 回调换 token → verifyAccountCredentials → addAccount 入账号管理 → 回填池状态。
// 与 GitHub 号池（LoginPagePool）完全独立：数据、IPC、页面互不共享。

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { Button, Card, CardContent, CardHeader, Badge, Input, Label } from '../ui'
import {
  Play, Pause, Plus, Ban, ExternalLink, Loader2, EyeOff, Eye, Search,
  ChevronRight, Terminal, Trash2, Undo2, X, ClipboardCopy, KeyRound, CheckCircle2,
  Settings2, Copy, Check, MoreHorizontal, AlertCircle,
  Globe, Shield, Chrome, Sparkles
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAccountsStore } from '@/store/accounts'
import type { SubscriptionType } from '@/types/account'

// ─── 类型 ─────────────────────────────────────────────────────────────

interface GooglePoolView {
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

interface LogLine {
  time: string
  level: 'info' | 'ok' | 'err' | 'warn'
  msg: string
}

// 已处理过的授权结果（模块级，跨页面挂载保留）
const handledResults = new Set<string>()

// 国家代码转国旗 Emoji 与常见全称映射
const COUNTRY_MAP: Record<string, { flag: string; name: string }> = {
  us: { flag: '🇺🇸', name: '美国' },
  mx: { flag: '🇲🇽', name: '墨西哥' },
  pa: { flag: '🇵🇦', name: '巴拿马' },
  gb: { flag: '🇬🇧', name: '英国' },
  uk: { flag: '🇬🇧', name: '英国' },
  de: { flag: '🇩🇪', name: '德国' },
  fr: { flag: '🇫🇷', name: '法国' },
  jp: { flag: '🇯🇵', name: '日本' },
  kr: { flag: '🇰🇷', name: '韩国' },
  sg: { flag: '🇸🇬', name: '新加坡' },
  hk: { flag: '🇭🇰', name: '中国香港' },
  tw: { flag: '🇹🇼', name: '中国台湾' },
  in: { flag: '🇮🇳', name: '印度' },
  br: { flag: '🇧🇷', name: '巴西' },
  ca: { flag: '🇨🇦', name: '加拿大' },
  au: { flag: '🇦🇺', name: '澳大利亚' },
  id: { flag: '🇮🇩', name: '印尼' },
  ph: { flag: '🇵🇭', name: '菲律宾' },
  vn: { flag: '🇻🇳', name: '越南' },
  th: { flag: '🇹🇭', name: '泰国' },
  my: { flag: '🇲🇾', name: '马来西亚' },
  ru: { flag: '🇷🇺', name: '俄罗斯' }
}

function getCountryInfo(code?: string): { flag?: string; name?: string } {
  if (!code) return {}
  const c = code.toLowerCase().trim()
  return COUNTRY_MAP[c] || {}
}

// ─── 页面主组件 ───────────────────────────────────────────────────────

export function GooglePoolPage(): React.ReactNode {
  const { accounts, addAccount, proxyPool, proxyPoolConfig } = useAccountsStore()

  const [entries, setEntries] = useState<GooglePoolView[]>([])
  const [running, setRunning] = useState(false)
  const [batch, setBatch] = useState<{ active: boolean; paused: boolean; unused: number }>({
    active: false,
    paused: false,
    unused: 0
  })
  const [logs, setLogs] = useState<LogLine[]>([])
  const [showLogs, setShowLogs] = useState(false)
  const [logFilter, setLogFilter] = useState<'all' | 'err_warn' | 'ok'>('all')
  const [followEnd, setFollowEnd] = useState(true)
  const [addOpen, setAddOpen] = useState(false)
  const [filter, setFilter] = useState<'all' | GooglePoolView['state']>('all')
  const [query, setQuery] = useState('')
  // 控制策略设置抽屉/折叠栏
  const [showSettings, setShowSettings] = useState(false)

  // 批量勾选（running 行不可选）
  const [selected, setSelected] = useState<Set<string>>(new Set())

  // 凭据明文显示开关（默认打码；记忆在 localStorage）
  const [showSecrets, setShowSecrets] = useState((): boolean => localStorage.getItem('googlepool_show_secrets') === 'true')
  const toggleShowSecrets = (): void => {
    setShowSecrets((v) => {
      localStorage.setItem('googlepool_show_secrets', String(!v))
      return !v
    })
  }

  // 复制反馈计时器字典
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const triggerCopy = useCallback((key: string, text: string): void => {
    if (!text) return
    navigator.clipboard.writeText(text)
    setCopiedKey(key)
    setTimeout(() => {
      setCopiedKey((prev) => (prev === key ? null : prev))
    }, 1500)
  }, [])

  // 导出未用：复制为入池同构卡密文本
  const [exportedCount, setExportedCount] = useState(0)
  const unusedEntries = useMemo(() => entries.filter((e) => e.state === 'unused'), [entries])
  const handleExportUnused = useCallback((): void => {
    if (!unusedEntries.length) return
    const text = unusedEntries
      .map((e) =>
        e.secret
          ? [e.email, e.password, e.secret, e.country].filter(Boolean).join('----')
          : [e.email, e.password, e.recoveryEmail, e.recoveryPassword, e.country].filter(Boolean).join('----')
      )
      .join('\n')
    navigator.clipboard.writeText(text)
    setExportedCount(unusedEntries.length)
    setTimeout(() => setExportedCount(0), 1500)
  }, [unusedEntries])

  // 出口代理模式：off=直连；pool=静态代理池；api=动态提链接口
  const [proxyMode, setProxyMode] = useState<'off' | 'pool' | 'api'>(
    () => (localStorage.getItem('googlepool_proxymode') as 'off' | 'pool' | 'api' | null) ?? 'off'
  )
  const updateProxyMode = (v: 'off' | 'pool' | 'api'): void => {
    setProxyMode(v)
    localStorage.setItem('googlepool_proxymode', v)
  }

  // 自动填表（默认开）
  const [autofill, setAutofill] = useState<boolean>(() => localStorage.getItem('googlepool_autofill') !== 'false')
  const updateAutofill = (v: boolean): void => {
    setAutofill(v)
    localStorage.setItem('googlepool_autofill', String(v))
  }

  // 批次号间冷却
  const [batchInterval, setBatchInterval] = useState<string>(() => localStorage.getItem('googlepool_batch_interval') || '90')
  const updateBatchInterval = (v: string): void => {
    setBatchInterval(v)
    localStorage.setItem('googlepool_batch_interval', v)
  }

  // 执行方式：window=应用内窗口；extension=Chrome 无痕
  const [viaExt, setViaExt] = useState<boolean>(() => localStorage.getItem('googlepool_via') === 'extension')
  const updateViaExt = (v: boolean): void => {
    setViaExt(v)
    localStorage.setItem('googlepool_via', v ? 'extension' : 'window')
  }

  // 扩展在线状态
  const [extOnline, setExtOnline] = useState(false)
  useEffect(() => {
    const tick = (): void => {
      void window.api.googlePoolList().then((s) => setExtOnline(s.extensionOnline))
    }
    tick()
    const timer = setInterval(tick, 15000)
    return () => clearInterval(timer)
  }, [])

  const usablePoolCount = useMemo(
    () => Array.from(proxyPool.values()).filter((p) => p.enabled && p.status === 'alive').length,
    [proxyPool]
  )

  const logRef = useRef<HTMLDivElement>(null)
  const pushLog = useCallback((line: LogLine) => {
    setLogs((prev) => [...prev.slice(-300), line])
  }, [])

  // 判重查验
  const isAccountExists = useCallback(
    (email: string, userId: string): boolean =>
      Array.from(accounts.values()).some(
        (acc) => (userId && acc.userId === userId) || (email && acc.email === email && acc.credentials.provider === 'Google')
      ),
    [accounts]
  )

  // 授权成功后入库
  const handleResult = useCallback(
    async (payload: {
      resultId: string
      entryId: string
      email: string
      accessToken: string
      refreshToken: string
      profileArn?: string
      expiresIn?: number
    }) => {
      if (handledResults.has(payload.resultId)) return
      handledResults.add(payload.resultId)
      try {
        const result = await window.api.verifyAccountCredentials({
          refreshToken: payload.refreshToken,
          clientId: '',
          clientSecret: '',
          region: 'us-east-1',
          authMethod: 'social',
          provider: 'Google'
        })
        if (result.success && result.data) {
          const { email, userId } = result.data
          if (isAccountExists(email || '', userId || '')) {
            pushLog({ time: nowTime(), level: 'warn', msg: `${payload.email} 已存在于账号管理（${email || userId}），跳过入库` })
            await window.api.googlePoolMarkStored(payload.entryId, email || userId)
            return
          }
          const now = Date.now()
          addAccount({
            email,
            userId,
            nickname: email ? email.split('@')[0] : undefined,
            idp: 'Google',
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
              provider: 'Google',
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
          await window.api.googlePoolMarkStored(payload.entryId, email || userId)
          pushLog({ time: nowTime(), level: 'ok', msg: `${payload.email} 已入库账号管理（${email}）` })
        } else {
          pushLog({ time: nowTime(), level: 'err', msg: `${payload.email} 凭证验证失败：${result.error || '未知错误'}（token 已拿到，可稍后手动导入）` })
        }
      } catch (e) {
        pushLog({ time: nowTime(), level: 'err', msg: `${payload.email} 入库异常：${e instanceof Error ? e.message : String(e)}` })
      } finally {
        void window.api.googlePoolAckResult(payload.resultId)
      }
    },
    [addAccount, isAccountExists, pushLog]
  )

  const refreshList = useCallback((restoreLogs = false): void => {
    void window.api.googlePoolList().then((snap) => {
      setEntries(snap.entries)
      setRunning(snap.running)
      setBatch(snap.batch)
      if (restoreLogs) setLogs(snap.logs)
    })
  }, [])

  useEffect(() => {
    void window.api.googlePoolList().then((snap) => {
      setEntries(snap.entries)
      setRunning(snap.running)
      setBatch(snap.batch)
      setLogs(snap.logs)
      for (const p of snap.pending) void handleResult(p)
    })
    const unsubscribe = window.api.onGooglePoolUpdate((update) => {
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
        void window.api.googlePoolManualCallback(data.code, data.state)
      }
    })
    return () => {
      unsubscribe()
      unsubCallback()
    }
  }, [handleResult])

  useEffect(() => {
    if (followEnd && showLogs) logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [logs, followEnd, showLogs])

  const handleLogScroll = (e: React.UIEvent<HTMLDivElement>): void => {
    const el = e.currentTarget
    setFollowEnd(el.scrollHeight - el.scrollTop - el.clientHeight < 30)
  }

  // 出口代理参数组装
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

  const current = entries.find((e) => e.state === 'running') || null
  const list = useMemo(() => {
    return entries.filter(
      (e) => (filter === 'all' || e.state === filter) && (!query || e.email.toLowerCase().includes(query.toLowerCase()))
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
    void window.api.googlePoolRemoveMany([...selected]).then(() => {
      setSelected(new Set())
      refreshList()
    })
  }

  const handleRestoreSelected = async (): Promise<void> => {
    if (!selected.size) return
    for (const id of selected) {
      await window.api.googlePoolRestore(id)
    }
    setSelected(new Set())
    refreshList()
  }

  const handleMarkWastedSelected = async (): Promise<void> => {
    if (!selected.size) return
    for (const id of selected) {
      await window.api.googlePoolMarkWasted(id)
    }
    setSelected(new Set())
    refreshList()
  }

  const handleExportSelected = (): void => {
    const selectedList = entries.filter((e) => selected.has(e.id))
    if (!selectedList.length) return
    const text = selectedList
      .map((e) =>
        e.secret
          ? [e.email, e.password, e.secret, e.country].filter(Boolean).join('----')
          : [e.email, e.password, e.recoveryEmail, e.recoveryPassword, e.country].filter(Boolean).join('----')
      )
      .join('\n')
    navigator.clipboard.writeText(text)
    triggerCopy('batch_export', text)
  }

  const handleAuthorize = (id: string): void => {
    void window.api.googlePoolAuthorize(id, { autofill, viaExtension: viaExt, proxy: buildProxyOpts() }).then((r) => {
      if (!r.success) pushLog({ time: nowTime(), level: 'warn', msg: r.error || '发起授权失败' })
    })
  }

  // 行内 TOTP
  const [totpFlash, setTotpFlash] = useState<{ id: string; code: string; remainSec: number } | null>(null)
  const handleCopyTotp = (id: string): void => {
    void window.api.googlePoolTotp(id).then((r) => {
      if (r.success && r.code) {
        navigator.clipboard.writeText(r.code)
        setTotpFlash({ id, code: r.code, remainSec: r.remainSec ?? 30 })
        setTimeout(() => setTotpFlash((f) => (f && f.id === id ? null : f)), 3000)
      } else {
        pushLog({ time: nowTime(), level: 'err', msg: `验证码计算失败：${r.error || '未知错误'}` })
      }
    })
  }

  // 授权中条目的实时验证码
  const [runningTotp, setRunningTotp] = useState<{ code: string; remainSec: number } | null>(null)
  useEffect(() => {
    if (!current?.secret) {
      setRunningTotp(null)
      return
    }
    let alive = true
    const tick = (): void => {
      void window.api.googlePoolTotp(current.id).then((r) => {
        if (!alive) return
        if (r.success && r.code) setRunningTotp({ code: r.code, remainSec: r.remainSec ?? 30 })
      })
    }
    tick()
    const timer = setInterval(tick, 5000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [current])

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

  const chips: { key: 'all' | GooglePoolView['state']; label: string; count: number; activeCls: string; dotCls: string }[] = [
    { key: 'all', label: '全部', count: summary.total, activeCls: 'bg-primary text-primary-foreground border-primary', dotCls: 'bg-primary' },
    { key: 'unused', label: '未用', count: summary.unused, activeCls: 'bg-zinc-700 text-white border-zinc-700', dotCls: 'bg-zinc-400' },
    { key: 'used', label: '已入库', count: summary.success, activeCls: 'bg-emerald-600 text-white border-emerald-600', dotCls: 'bg-emerald-500' },
    { key: 'failed', label: '失败', count: summary.failed, activeCls: 'bg-red-600 text-white border-red-600', dotCls: 'bg-red-500' },
    { key: 'wasted', label: '作废', count: summary.wasted, activeCls: 'bg-amber-600 text-white border-amber-600', dotCls: 'bg-amber-500' }
  ]

  // 过滤后的日志
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
              <h2 className="text-base font-bold tracking-tight">Google 号池</h2>
              <Badge variant="outline" className="text-[11px] font-mono font-medium py-0 px-1.5 h-5 bg-background">
                {summary.total} 号
              </Badge>
              {batch.active && (
                <Badge className="bg-primary/15 text-primary border-primary/30 text-[11px] animate-pulse">
                  批次运行中 ({batch.unused} 待跑)
                </Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              Gmail 卡密手动/自动化授权激活 Kiro，本地实时计算 2FA 验证码
            </p>
          </div>
        </div>

        {/* 核心动作组 */}
        <div className="flex items-center gap-2">
          {batch.active ? (
            batch.paused ? (
              <Button size="sm" className="h-8 shadow-sm font-medium" onClick={() => { void window.api.googlePoolResumeBatch() }}>
                <Play className="h-3.5 w-3.5 mr-1" /> 继续批次
              </Button>
            ) : (
              <Button size="sm" variant="outline" className="h-8 shadow-sm" onClick={() => { void window.api.googlePoolPauseBatch() }}>
                <Pause className="h-3.5 w-3.5 mr-1" /> 暂停批次
              </Button>
            )
          ) : (
            <Button
              size="sm"
              disabled={running || (selected.size === 0 && summary.unused === 0)}
              className="h-8 shadow-sm font-medium gap-1.5"
              onClick={() => {
                void window.api.googlePoolStartBatch({
                  autofill,
                  batchIntervalSec: batchInterval === 'rand' ? ('rand' as const) : Number(batchInterval),
                  ...(selected.size > 0 ? { ids: [...selected] } : {}),
                  viaExtension: viaExt,
                  proxy: buildProxyOpts()
                })
                setSelected(new Set())
              }}
            >
              <Play className="h-3.5 w-3.5 fill-current" />
              <span>开始批次</span>
              <span className="opacity-80 text-[11px] font-mono">
                {selected.size > 0 ? `(${selected.size} 勾选)` : `(${summary.unused})`}
              </span>
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
            {viaExt && (
              <span className={cn('h-2 w-2 rounded-full', extOnline ? 'bg-emerald-500 ring-2 ring-emerald-500/20' : 'bg-red-500')} />
            )}
          </Button>
        </div>
      </div>

      {/* ── 策略设置折叠卡片 ── */}
      {showSettings && (
        <Card className="border border-border/60 bg-muted/30 shadow-xs animate-in fade-in-50 slide-in-from-top-1 duration-200">
          <CardContent className="p-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
              {/* 执行方式 */}
              <div className="space-y-1.5 bg-background/80 p-2.5 rounded-lg border border-border/50">
                <div className="flex items-center justify-between">
                  <Label className="text-[11px] text-muted-foreground font-medium flex items-center gap-1.5">
                    <Chrome className="h-3.5 w-3.5 text-primary" /> 执行方式
                  </Label>
                  {viaExt && (
                    <span className={cn('text-[10px] font-medium flex items-center gap-1', extOnline ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500')}>
                      <span className={cn('h-1.5 w-1.5 rounded-full', extOnline ? 'bg-emerald-500 animate-pulse' : 'bg-red-500')} />
                      {extOnline ? '扩展就绪' : '扩展未连接'}
                    </span>
                  )}
                </div>
                <select
                  value={viaExt ? 'extension' : 'window'}
                  onChange={(e) => updateViaExt(e.target.value === 'extension')}
                  disabled={running || batch.active}
                  className="w-full h-8 rounded-md border border-input bg-background px-2 text-xs focus:ring-1 focus:ring-primary focus:outline-none"
                >
                  <option value="window">应用内窗口 (内置自动化)</option>
                  <option value="extension">Chrome 扩展 (真机无痕/低风控)</option>
                </select>
              </div>

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
                  disabled={running}
                  className="w-full h-8 rounded-md border border-input bg-background px-2 text-xs focus:ring-1 focus:ring-primary focus:outline-none"
                >
                  <option value="off">关闭 (直连发起)</option>
                  <option value="pool">静态代理池 {usablePoolCount > 0 ? `(${usablePoolCount} 可用)` : '(池空)'}</option>
                  <option value="api">
                    {(proxyPoolConfig.dynamicSourceType || 'extract-api') === 'kiro-pool' ? '动态 IP 池服务' : '提链 API 动态提取'}
                  </option>
                </select>
              </div>

              {/* 自动填表 */}
              <div className="space-y-1.5 bg-background/80 p-2.5 rounded-lg border border-border/50">
                <Label className="text-[11px] text-muted-foreground font-medium flex items-center gap-1.5">
                  <Sparkles className="h-3.5 w-3.5 text-primary" /> 自动填表
                </Label>
                <select
                  value={autofill ? 'on' : 'off'}
                  onChange={(e) => updateAutofill(e.target.value === 'on')}
                  disabled={running}
                  className="w-full h-8 rounded-md border border-input bg-background px-2 text-xs focus:ring-1 focus:ring-primary focus:outline-none"
                >
                  <option value="on">开启 (账号/密码/2FA 自动填)</option>
                  <option value="off">关闭 (全程手动录入)</option>
                </select>
              </div>

              {/* 批次间隔 */}
              <div className="space-y-1.5 bg-background/80 p-2.5 rounded-lg border border-border/50">
                <Label className="text-[11px] text-muted-foreground font-medium flex items-center gap-1.5">
                  <Shield className="h-3.5 w-3.5 text-primary" /> 号间冷却 (防风控)
                </Label>
                <select
                  value={batchInterval}
                  onChange={(e) => updateBatchInterval(e.target.value)}
                  disabled={batch.active}
                  className="w-full h-8 rounded-md border border-input bg-background px-2 text-xs focus:ring-1 focus:ring-primary focus:outline-none"
                >
                  <option value="60">60 秒</option>
                  <option value="90">90 秒 (推荐)</option>
                  <option value="120">120 秒</option>
                  <option value="180">180 秒</option>
                  <option value="rand">随机 60–180 秒</option>
                </select>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── 当前授权运行中卡片 ── */}
      {current && (
        <Card className="shrink-0 border-primary/40 bg-primary/[0.03] shadow-sm">
          <CardContent className="py-2.5 px-4 flex items-center gap-4 flex-wrap">
            <div className="flex items-center gap-2.5 text-xs">
              <span className="relative flex h-2.5 w-2.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" />
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-primary" />
              </span>
              <span className="font-mono font-semibold text-foreground text-sm">{current.email}</span>
              <span className="text-muted-foreground">
                授权窗口已打开 · {autofill ? '账密已自动输入，验证码/挑战/确认人工处理' : '全程手动登录'}
              </span>
            </div>

            {runningTotp && (
              <div className="flex items-center gap-2 bg-background border border-primary/20 px-2.5 py-1 rounded-md shadow-xs" title="当前 2FA 验证码（本地实时计算，5秒刷新）">
                <span className="text-[11px] text-muted-foreground font-medium">2FA 码</span>
                <span className="font-mono text-base font-bold tracking-wider text-primary">{runningTotp.code}</span>
                <div className="w-4 h-4 relative flex items-center justify-center text-[10px] text-muted-foreground font-mono">
                  {runningTotp.remainSec}s
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-[11px] gap-1 hover:bg-primary/10 text-primary"
                  onClick={() => triggerCopy('running_totp', runningTotp.code)}
                >
                  {copiedKey === 'running_totp' ? <Check className="h-3 w-3" /> : <ClipboardCopy className="h-3 w-3" />}
                  {copiedKey === 'running_totp' ? '已复制' : '复制'}
                </Button>
              </div>
            )}

            <div className="flex-1" />
            <Button size="sm" variant="outline" className="h-7 text-xs gap-1.5" onClick={() => void window.api.googlePoolFocusWindow()}>
              <ExternalLink className="h-3.5 w-3.5" /> 切换置顶窗口
            </Button>
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
              placeholder="搜索邮箱或账号…"
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
            title="把全部未用号复制为卡密文本（同构格式，可直接再次入池）"
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
            onClick={() => { void window.api.googlePoolClearFinished().then(() => refreshList()) }}
          >
            <Trash2 className="h-3.5 w-3.5 mr-1" /> 清理已入库
          </Button>

          <Button
            size="sm"
            variant="ghost"
            className="h-8 text-xs px-2.5 text-muted-foreground hover:text-foreground"
            title="已入库/失败/作废全部拨回未用状态"
            onClick={() => { void window.api.googlePoolRestoreAll().then(() => refreshList()) }}
          >
            <Undo2 className="h-3.5 w-3.5 mr-1" /> 全部重置未用
          </Button>
        </div>
      </div>

      {/* ── 批量操作浮动条（当勾选条目时激活） ── */}
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
                <th className="text-left py-2 px-2 min-w-[190px]">邮箱账号</th>
                <th className="text-left py-2 px-2 min-w-[110px]">密码</th>
                <th className="text-left py-2 px-2 min-w-[180px]">2FA 密钥 / 辅助邮箱</th>
                <th className="text-center py-2 px-2 w-16">国家</th>
                <th className="text-left py-2 px-2 w-20">状态</th>
                <th className="text-left py-2 px-2 min-w-[160px]">入库绑定</th>
                <th className="text-left py-2 px-2 min-w-[160px]">备注/原因</th>
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
                          ? '当前号池为空，点击上方「粘贴入池」批量导入 Gmail 卡密'
                          : '没有找到匹配的账号记录'}
                      </p>
                    </div>
                  </td>
                </tr>
              )}
              {list.map((e) => {
                const isSelected = selected.has(e.id)
                const isRunning = e.state === 'running'
                const country = getCountryInfo(e.country)

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

                    {/* 邮箱 */}
                    <td className="py-2 px-2">
                      <div className="flex items-center gap-1.5 group max-w-[240px]">
                        <span className="font-mono text-foreground font-medium truncate select-all">{e.email}</span>
                        <button
                          type="button"
                          className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-foreground shrink-0"
                          title="复制邮箱"
                          onClick={() => triggerCopy(`email_${e.id}`, e.email)}
                        >
                          {copiedKey === `email_${e.id}` ? (
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

                    {/* 2FA / 辅助邮箱 */}
                    <td className="py-2 px-2">
                      {e.secret ? (
                        <div className="flex items-center gap-2">
                          <span
                            className={cn('font-mono text-[11px] truncate max-w-[90px]', !showSecrets && 'text-muted-foreground')}
                            title={e.secret}
                          >
                            {showSecrets ? e.secret : e.secretMasked}
                          </span>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-6 px-2 text-[11px] gap-1 rounded border-primary/30 bg-primary/10 text-primary hover:bg-primary/20 shrink-0 font-medium"
                            title="本地快速计算当前 6 位 2FA 动态码并自动复制到剪贴板"
                            onClick={() => handleCopyTotp(e.id)}
                          >
                            <ClipboardCopy className="h-3 w-3" />
                            {totpFlash && totpFlash.id === e.id ? (
                              <span className="font-mono text-emerald-600 dark:text-emerald-400 font-bold">{totpFlash.code} ({totpFlash.remainSec}s)</span>
                            ) : (
                              '获取验证码'
                            )}
                          </Button>
                        </div>
                      ) : e.recoveryEmail ? (
                        <div className="flex items-center gap-1.5 group max-w-[200px]" title={e.recoveryPassword ? `辅邮密码：${showSecrets ? e.recoveryPassword : '••••••'}` : '辅助邮箱'}>
                          <span className="font-mono text-muted-foreground truncate">{e.recoveryEmail}</span>
                          <button
                            type="button"
                            className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-foreground shrink-0"
                            title="复制辅助邮箱"
                            onClick={() => triggerCopy(`rec_${e.id}`, e.recoveryEmail!)}
                          >
                            {copiedKey === `rec_${e.id}` ? (
                              <Check className="h-3 w-3 text-emerald-500" />
                            ) : (
                              <Copy className="h-3 w-3" />
                            )}
                          </button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-5 px-1.5 text-[10px] gap-0.5 rounded text-sky-600 dark:text-sky-400 hover:bg-sky-500/10 shrink-0"
                            title="打开 yopmail 免登录信箱收取验证码"
                            onClick={() => {
                              const user = e.recoveryEmail!.split('@')[0]
                              navigator.clipboard.writeText(user)
                              void window.api.openExternal(`https://yopmail.com/en/?login=${encodeURIComponent(user)}`)
                            }}
                          >
                            <ExternalLink className="h-2.5 w-2.5" /> yopmail
                          </Button>
                        </div>
                      ) : (
                        <span className="text-muted-foreground/60">—</span>
                      )}
                    </td>

                    {/* 国家 */}
                    <td className="py-2 px-2 text-center">
                      {e.country ? (
                        <Badge
                          variant="outline"
                          className="text-[10px] uppercase font-mono px-1.5 py-0 h-4 border-border/80 bg-muted/40"
                          title={country.name ? `${country.name} (${e.country.toUpperCase()})` : e.country.toUpperCase()}
                        >
                          {country.flag && <span className="mr-1">{country.flag}</span>}
                          {e.country}
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground/60">—</span>
                      )}
                    </td>

                    {/* 状态 */}
                    <td className="py-2 px-2">
                      <StateBadge state={e.state} />
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

                    {/* 错误原因 */}
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
                        {/* 主操作：授权/重试 */}
                        {(e.state === 'unused' || e.state === 'failed') && (
                          <Button
                            size="sm"
                            className="h-6 px-2.5 text-[11px] gap-1 shadow-xs"
                            disabled={running || batch.active}
                            title={e.state === 'failed' ? '再次打开授权窗口重试' : '打开独立窗口登录并授权'}
                            onClick={() => handleAuthorize(e.id)}
                          >
                            <Play className="h-3 w-3 fill-current" />
                            {e.state === 'failed' ? '重试' : '授权'}
                          </Button>
                        )}

                        {/* 更多动作菜单 */}
                        <ActionDropdown
                          entry={e}
                          onRefresh={refreshList}
                          onRemove={(id) => {
                            void window.api.googlePoolRemove(id).then(() => {
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

        {/* 底部状态条 */}
        {(running || batch.active) && (
          <div className="border-t border-border/60 px-4 py-2 flex items-center justify-between text-xs text-muted-foreground bg-muted/20 shrink-0">
            <div className="flex items-center gap-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
              {batch.active ? (
                batch.paused ? (
                  <span>批次已暂停 · 当前号授权完成后将待机</span>
                ) : (
                  <span>批次执行中 · 剩余待跑 <strong className="text-foreground">{batch.unused}</strong> · 自动填表与防风控冷却中</span>
                )
              ) : (
                <span>单号授权进行中 · 手动完成登录后将自动入库</span>
              )}
            </div>
            {batch.active && (
              <span className="text-[11px] font-mono">
                当前冷却间隔: {batchInterval === 'rand' ? '随机 60-180s' : `${batchInterval}s`}
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

      {/* ── 入池粘贴弹窗 ── */}
      {addOpen && (
        <AddGooglePoolDialog
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
  entry: GooglePoolView
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
                void window.api.googlePoolMarkUsed(entry.id).then(onRefresh)
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
              void window.api.googlePoolRestore(entry.id).then(onRefresh)
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
                void window.api.googlePoolMarkWasted(entry.id).then(onRefresh)
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

// ─── 入池弹窗（带实时解析校验） ──────────────────────────────────────────

function AddGooglePoolDialog({
  onClose,
  onDone,
  pushLog
}: {
  onClose: () => void
  onDone: () => void
  pushLog: (line: LogLine) => void
}): React.ReactNode {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ added: number; updated: number; bad: string[] } | null>(null)

  // 简易前端快速预检统计
  const previewStats = useMemo(() => {
    if (!text.trim()) return null
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    let totpCount = 0
    let recoveryCount = 0
    let badCount = 0
    for (const l of lines) {
      const parts = l.split('----')
      if (parts.length < 3 || !parts[0].includes('@') || !parts[1]) {
        badCount++
        continue
      }
      if (parts[2].includes('@')) {
        recoveryCount++
      } else {
        totpCount++
      }
    }
    return { total: lines.length, totpCount, recoveryCount, badCount }
  }, [text])

  const submit = (): void => {
    if (!text.trim() || busy) return
    setBusy(true)
    void window.api.googlePoolAddText(text).then((r) => {
      setBusy(false)
      setResult(r)
      pushLog({
        time: nowTime(),
        level: r.bad.length ? 'warn' : 'ok',
        msg: `入池：新增 ${r.added}、覆盖 ${r.updated}${r.bad.length ? `、非法 ${r.bad.length} 行` : ''}`
      })
      if (!r.bad.length) {
        onDone()
        setTimeout(onClose, 600)
      }
    })
  }

  // 过滤只保留格式错误的行供用户修正
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
            <h3 className="text-sm font-semibold">粘贴卡密入池 (Gmail)</h3>
          </div>
          <Button size="sm" variant="ghost" className="h-7 w-7 p-0 rounded-full" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="p-4 space-y-3">
          <div className="text-xs text-muted-foreground leading-5 bg-muted/40 p-2.5 rounded-lg border border-border/50">
            <p className="font-medium text-foreground mb-1">格式规范（每行一条，以严格 4 连字符 <code className="bg-background px-1 rounded border">----</code> 分隔）：</p>
            <div className="space-y-1 font-mono text-[11px]">
              <div>① 2FA 密钥版：<span className="text-foreground">邮箱----密码----2FA密钥[----国家标记]</span></div>
              <div>② 辅助邮箱版：<span className="text-foreground">邮箱----密码----辅助邮箱[----辅邮凭据[----国家标记]]</span></div>
            </div>
          </div>

          <textarea
            value={text}
            onChange={(e) => { setText(e.target.value); setResult(null) }}
            spellCheck={false}
            placeholder={'someone@gmail.com----MyP@ssw0rd----ivir rjuw rw7g rxl2 sg3y krfy x2e7 zzmr----mx\nbob@gmail.com----MyP@ssw0rd----recovery@hotmail.com----aE0asqOhyk----pa'}
            className="w-full h-48 rounded-lg border border-input bg-background p-3 font-mono text-xs resize-none focus:outline-none focus:ring-1 focus:ring-primary leading-relaxed"
          />

          {/* 实时预检提示 */}
          {previewStats && !result && (
            <div className="flex items-center gap-3 text-xs text-muted-foreground px-1">
              <span>共识别 {previewStats.total} 行</span>
              {previewStats.totpCount > 0 && <span className="text-primary">2FA 密钥版: {previewStats.totpCount}</span>}
              {previewStats.recoveryCount > 0 && <span className="text-sky-500">辅邮版: {previewStats.recoveryCount}</span>}
              {previewStats.badCount > 0 && <span className="text-amber-500">可能异常: {previewStats.badCount}</span>}
            </div>
          )}

          {/* 提交后结果与异常行排错 */}
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
          <Button size="sm" onClick={submit} disabled={!text.trim() || busy} className="gap-1.5 shadow-sm">
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
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
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, '0'))
    .join(':')
}

function sortEntries(list: GooglePoolView[]): GooglePoolView[] {
  const order = ['running', 'unused', 'used', 'failed', 'wasted']
  return [...list].sort((a, b) => {
    const d = order.indexOf(a.state) - order.indexOf(b.state)
    if (d !== 0) return d
    if (a.state === 'unused') return a.addedAt - b.addedAt
    return (b.doneAt ?? b.takenAt ?? b.addedAt) - (a.doneAt ?? a.takenAt ?? a.addedAt)
  })
}

function StateBadge({ state }: { state: GooglePoolView['state'] }): React.ReactNode {
  const map: Record<GooglePoolView['state'], { label: string; cls: string; dot: string }> = {
    running: {
      label: '授权中',
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
