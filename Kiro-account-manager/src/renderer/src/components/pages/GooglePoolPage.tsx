// Google 号池：Gmail 卡密（邮箱+密码+2FA 密钥）手动授权激活 Kiro。
// 主进程 googlePool/ 模块为唯一数据源，本页面只持视图；
// 授权流程：点「授权」→ 应用打开 Kiro Google OAuth 窗口（代理+指纹已装配）→
// 人工登录（密码 + 2FA，2FA 六位码由本页本地算好一键复制）→ 主进程拦 kiro://
// 回调换 token → verifyAccountCredentials → addAccount 入账号管理 → 回填池状态。
// 与 GitHub 号池（LoginPagePool）完全独立：数据、IPC、页面互不共享。

import { useState, useEffect, useRef, useCallback } from 'react'
import { Button, Card, CardContent, CardHeader, CardTitle, Badge, Input, Label } from '../ui'
import {
  Play, Plus, Ban, ExternalLink, Loader2, EyeOff, Eye, Search,
  ChevronRight, Terminal, Trash2, Undo2, X, ClipboardCopy, KeyRound, CheckCircle2
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAccountsStore } from '@/store/accounts'
import type { SubscriptionType } from '@/types/account'

// ─── 类型（与 preload index.d.ts 的 window.api 声明同构）──────────────

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

// ─── 页面 ────────────────────────────────────────────────────────────

export function GooglePoolPage(): React.ReactNode {
  const { accounts, addAccount, proxyPool, proxyPoolConfig } = useAccountsStore()

  const [entries, setEntries] = useState<GooglePoolView[]>([])
  const [running, setRunning] = useState(false)
  const [logs, setLogs] = useState<LogLine[]>([])
  const [showLogs, setShowLogs] = useState(true)
  const [followEnd, setFollowEnd] = useState(true)
  const [addOpen, setAddOpen] = useState(false)
  const [filter, setFilter] = useState<'all' | GooglePoolView['state']>('all')
  const [query, setQuery] = useState('')
  // 批量删除勾选（running 行不可选）
  const [selected, setSelected] = useState<Set<string>>(new Set())
  // 凭据明文显示开关（默认打码；记忆在 localStorage）
  const [showSecrets, setShowSecrets] = useState((): boolean => localStorage.getItem('googlepool_show_secrets') === 'true')
  const toggleShowSecrets = (): void => {
    setShowSecrets((v) => {
      localStorage.setItem('googlepool_show_secrets', String(!v))
      return !v
    })
  }
  // 出口代理模式：off=直连；pool=静态代理池；api=动态提链接口
  const [proxyMode, setProxyMode] = useState<'off' | 'pool' | 'api'>(
    () => (localStorage.getItem('googlepool_proxymode') as 'off' | 'pool' | 'api' | null) ?? 'off'
  )
  const updateProxyMode = (v: 'off' | 'pool' | 'api'): void => {
    setProxyMode(v)
    localStorage.setItem('googlepool_proxymode', v)
  }
  // 自动填表（默认开）：拟人填邮箱/密码，2FA 密钥版自动填码；验证码/手机挑战与授权确认仍人工
  const [autofill, setAutofill] = useState<boolean>(() => localStorage.getItem('googlepool_autofill') !== 'false')
  const updateAutofill = (v: boolean): void => {
    setAutofill(v)
    localStorage.setItem('googlepool_autofill', String(v))
  }
  const usablePoolCount = Array.from(proxyPool.values()).filter(
    (p) => p.enabled && p.status === 'alive'
  ).length

  const logRef = useRef<HTMLDivElement>(null)
  const pushLog = useCallback((line: LogLine) => {
    setLogs((prev) => [...prev.slice(-200), line])
  }, [])

  // 同 userId 或 同邮箱+同 provider 视为重复（与添加账号弹窗同规则）
  const isAccountExists = useCallback(
    (email: string, userId: string): boolean =>
      Array.from(accounts.values()).some(
        (acc) => (userId && acc.userId === userId) || (email && acc.email === email && acc.credentials.provider === 'Google')
      ),
    [accounts]
  )

  // 授权成功后的入库（复用 LoginPagePool handleResult 的 social 分支，provider=Google）
  const handleResult = useCallback(
    async (payload: {
      entryId: string
      email: string
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
      }
    },
    [addAccount, isAccountExists, pushLog]
  )

  /** 拉全量快照刷新（操作后调用；restoreLogs=false 不动日志区） */
  const refreshList = useCallback((restoreLogs = false): void => {
    void window.api.googlePoolList().then((snap) => {
      setEntries(snap.entries)
      setRunning(snap.running)
      if (restoreLogs) setLogs(snap.logs)
    })
  }, [])

  // 初始化 + 订阅主进程事件
  useEffect(() => {
    refreshList(true)
    const unsubscribe = window.api.onGooglePoolUpdate((update) => {
      if (update.kind === 'entry') {
        setEntries((prev) => {
          const next = prev.filter((e) => e.id !== update.entry.id)
          next.push(update.entry)
          return sortEntries(next)
        })
      } else if (update.kind === 'log') {
        setLogs((prev) => [...prev.slice(-200), update.line])
      } else if (update.kind === 'result') {
        void handleResult(update.payload)
      }
    })
    // 系统协议兜底：窗口内拦截漏掉、OS 把 kiro:// 转回本应用时转发给主进程（state 匹配会被忽略）
    const unsubCallback = window.api.onSocialAuthCallback((data) => {
      if (data.code && data.state) {
        void window.api.googlePoolManualCallback(data.code, data.state)
      }
    })
    return () => {
      unsubscribe()
      unsubCallback()
    }
  }, [handleResult, refreshList])

  useEffect(() => {
    if (followEnd) logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [logs, followEnd])

  const handleLogScroll = (e: React.UIEvent<HTMLDivElement>): void => {
    const el = e.currentTarget
    setFollowEnd(el.scrollHeight - el.scrollTop - el.clientHeight < 40)
  }

  // ── 操作 ──

  // 出口代理参数：pool 模式只取「启用 + 验活可用」的池条目快照；
  // api 模式带代理池页维护的提链源配置
  const buildProxyOpts = useCallback(() => {
    if (proxyMode === 'off') return undefined
    if (proxyMode === 'api') {
      return {
        enabled: true,
        mode: 'api' as const,
        entries: [] as Array<{ url: string; usedCount: number; latencyMs?: number }>,
        strategy: proxyPoolConfig.strategy,
        api: {
          url: (proxyPoolConfig.dynamicApiUrl || '').trim(),
          viaProxy: (proxyPoolConfig.dynamicViaProxy || '').trim(),
          batchSize: Math.min(20, Math.max(1, Number(proxyPoolConfig.dynamicBatchSize) || 5))
        }
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
  const list = entries.filter((e) => (filter === 'all' || e.state === filter) && (!query || e.email.toLowerCase().includes(query.toLowerCase())))
  // 勾选逻辑只作用于当前筛选视图里的可选行（running 除外）
  const selectableIds = list.filter((e) => e.state !== 'running').map((e) => e.id)
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
  const handleAuthorize = (id: string): void => {
    void window.api.googlePoolAuthorize(id, { autofill, proxy: buildProxyOpts() }).then((r) => {
      if (!r.success) pushLog({ time: nowTime(), level: 'warn', msg: r.error || '发起授权失败' })
    })
  }

  // ── TOTP：行内复制 + 授权中实时显示（本地计算，密钥不出主进程）──

  // 行内按钮点击 → 复制当前码，按钮上短暂回显（3s）
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
  // 授权中条目的实时验证码（登录 Google 2FA 页时直接看这里；5s 刷新；仅 2FA 密钥版有）
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

  const summary = {
    total: entries.length,
    success: entries.filter((e) => e.state === 'used').length,
    failed: entries.filter((e) => e.state === 'failed').length,
    unused: entries.filter((e) => e.state === 'unused').length,
    wasted: entries.filter((e) => e.state === 'wasted').length
  }
  const chips: { key: 'all' | GooglePoolView['state']; label: string; count: number }[] = [
    { key: 'all', label: '全部', count: summary.total },
    { key: 'unused', label: '未用', count: summary.unused },
    { key: 'used', label: '已入库', count: summary.success },
    { key: 'failed', label: '失败', count: summary.failed },
    { key: 'wasted', label: '作废', count: summary.wasted }
  ]

  return (
    <div className="h-full flex flex-col min-h-0 p-4 gap-3">
      {/* 标题 + 控制区 */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-lg font-bold flex items-center gap-2">
            <KeyRound className="h-5 w-5 text-primary" /> Google 号池
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Gmail 卡密（邮箱+密码+2FA）手动授权激活 Kiro：点「授权」后在弹出窗口登录，2FA 验证码本地算好直接复制
          </p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <Button size="sm" variant="outline" onClick={() => setAddOpen(true)}>
            <Plus className="h-4 w-4" /> 粘贴入池
          </Button>
          <div
            className="flex items-center gap-1.5"
            title="自动拟人填写邮箱/密码（2FA 密钥版连验证码一起填）；图形验证码、手机验证等挑战与最终授权确认仍由人工在窗口中处理"
          >
            <Label className="text-xs text-muted-foreground whitespace-nowrap">自动填表</Label>
            <select
              value={autofill ? 'on' : 'off'}
              onChange={(e) => updateAutofill(e.target.value === 'on')}
              disabled={running}
              className="h-8 rounded-lg border border-input bg-background px-2 text-xs disabled:opacity-50"
            >
              <option value="on">开（账密自动填）</option>
              <option value="off">关（全程手动）</option>
            </select>
          </div>
          <div
            className="flex items-center gap-1.5"
            title="授权窗口的出口 IP：代理池=session 注入；提链 API=一次性端点。取不到可用代理则不发起，不直连。建议选与卡密国家标记对口的出口"
          >
            <Label className="text-xs text-muted-foreground whitespace-nowrap">出口代理</Label>
            <select
              value={proxyMode}
              onChange={(e) => updateProxyMode(e.target.value as 'off' | 'pool' | 'api')}
              disabled={running}
              className="h-8 rounded-lg border border-input bg-background px-2 text-xs disabled:opacity-50"
            >
              <option value="off">关闭（直连）</option>
              <option value="pool">代理池{usablePoolCount > 0 ? `（${usablePoolCount} 可用）` : '（池空）'}</option>
              <option value="api">
                提链 API{!(proxyPoolConfig.dynamicApiUrl || '').trim() ? '（未配置）' : ''}
              </option>
            </select>
          </div>
        </div>
      </div>

      {/* 授权中卡片 */}
      {current && (
        <Card className="shrink-0">
          <CardContent className="py-3 px-4 flex items-center gap-4 flex-wrap">
            <div className="flex items-center gap-2 text-xs">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
              <span className="font-mono">{current.email}</span>
              <span className="text-muted-foreground">
                授权窗口中 · {autofill ? '账密自动填，验证码/挑战/确认请人工' : '全程手动登录'}
              </span>
            </div>
            {runningTotp && (
              <div className="flex items-center gap-1.5" title="当前 2FA 验证码（本地计算，每 5 秒刷新）">
                <span className="text-xs text-muted-foreground">2FA 码</span>
                <span className="font-mono text-base font-bold tracking-widest text-primary">{runningTotp.code}</span>
                <span className="text-[10px] text-muted-foreground">{runningTotp.remainSec}s</span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-1.5 text-[11px] gap-1"
                  onClick={() => navigator.clipboard.writeText(runningTotp.code)}
                >
                  <ClipboardCopy className="h-3 w-3" /> 复制
                </Button>
              </div>
            )}
            <div className="flex-1" />
            <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => void window.api.googlePoolFocusWindow()}>
              <ExternalLink className="h-3.5 w-3.5" /> 观察窗口
            </Button>
          </CardContent>
        </Card>
      )}

      {/* 工具栏 + 筛选 */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-1.5 flex-wrap">
          {chips.map((c) => (
            <button
              key={c.key}
              onClick={() => setFilter(c.key)}
              className={cn(
                'px-2.5 py-1 rounded-full text-xs border transition-colors',
                filter === c.key ? 'bg-primary text-primary-foreground border-primary' : 'text-muted-foreground hover:bg-muted/50 border-transparent'
              )}
            >
              {c.label} {c.count}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        <div className="relative">
          <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索邮箱…" className="h-8 w-44 pl-8 text-xs" />
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="h-8 text-xs"
          title={showSecrets ? '密码/2FA 当前明文显示，点击恢复打码' : '显示密码/2FA 明文'}
          onClick={toggleShowSecrets}
        >
          {showSecrets ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
          {showSecrets ? '明文' : '打码'}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-8 text-xs"
          title="删除勾选的条目（不可恢复）"
          disabled={!selected.size}
          onClick={handleRemoveSelected}
        >
          <Trash2 className="h-3.5 w-3.5" /> 删除所选{selected.size ? `（${selected.size}）` : ''}
        </Button>
        <Button size="sm" variant="ghost" className="h-8 text-xs" title="把已入库的条目移出列表（账号保留在账号管理）" onClick={() => { void window.api.googlePoolClearFinished().then(() => refreshList()) }}>
          <Trash2 className="h-3.5 w-3.5" /> 清除已入库
        </Button>
        <Button size="sm" variant="ghost" className="h-8 text-xs" title="已入库/失败/作废全部拨回未用" onClick={() => { void window.api.googlePoolRestoreAll().then(() => refreshList()) }}>
          <Undo2 className="h-3.5 w-3.5" /> 全部恢复未用
        </Button>
      </div>

      {/* 表格 */}
      <Card className="flex-1 min-h-0 flex flex-col">
        <div className="flex-1 overflow-y-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0 z-10">
              <tr className="text-muted-foreground border-b bg-muted/50 backdrop-blur">
                <th className="text-left font-medium py-2 px-3 w-8">
                  <input
                    type="checkbox"
                    className="h-3 w-3 accent-primary align-middle"
                    checked={allSelected}
                    disabled={!selectableIds.length}
                    onChange={toggleSelectAll}
                    ref={(el) => {
                      if (el) el.indeterminate = someSelected && !allSelected
                    }}
                  />
                </th>
                <th className="text-left font-medium py-2 px-2">邮箱</th>
                <th className="text-left font-medium py-2 px-2">密码</th>
                <th className="text-left font-medium py-2 px-2">2FA / 辅邮</th>
                <th className="text-left font-medium py-2 px-2">国家</th>
                <th className="text-left font-medium py-2 px-2">状态</th>
                <th className="text-left font-medium py-2 px-2">入库邮箱</th>
                <th className="text-left font-medium py-2 px-2">原因</th>
                <th className="text-right font-medium py-2 px-3">操作</th>
              </tr>
            </thead>
            <tbody>
              {list.length === 0 && (
                <tr>
                  <td colSpan={10} className="py-10 text-center text-muted-foreground">
                    {entries.length === 0 ? '池是空的：点「粘贴入池」，支持 2FA 密钥版与辅助邮箱版两种卡密' : '没有符合条件的条目'}
                  </td>
                </tr>
              )}
              {list.map((e) => (
                <tr key={e.id} className={cn('border-b last:border-0 hover:bg-muted/30', e.state === 'running' && 'bg-primary/[0.05]')}>
                  <td className="py-1.5 px-3">
                    {e.state === 'running' ? (
                      <span className="block h-1 w-1 rounded-full bg-primary animate-pulse" />
                    ) : (
                      <input
                        type="checkbox"
                        className="h-3 w-3 accent-primary align-middle"
                        checked={selected.has(e.id)}
                        onChange={() => toggleSelect(e.id)}
                      />
                    )}
                  </td>
                  <td className="py-1.5 px-2 font-mono">{e.email}</td>
                  <td className="py-1.5 px-2 font-mono">
                    <span className={cn(!showSecrets && 'text-muted-foreground')} title={showSecrets ? undefined : '点击工具栏「打码/明文」切换'}>
                      {showSecrets ? e.password : e.passwordMasked}
                    </span>
                  </td>
                  <td className="py-1.5 px-2">
                    {e.secret ? (
                      <div className="flex items-center gap-1.5">
                        <span className={cn('font-mono', !showSecrets && 'text-muted-foreground')} title={showSecrets ? undefined : '点击工具栏「打码/明文」切换'}>
                          {showSecrets ? e.secret : e.secretMasked}
                        </span>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 px-2 text-[11px] gap-1 rounded-md border-primary/25 bg-primary/10 text-primary hover:bg-primary/20 hover:text-primary"
                          title="本地计算当前 6 位验证码并复制（Google 两步验证页直接粘贴）"
                          onClick={() => handleCopyTotp(e.id)}
                        >
                          <ClipboardCopy className="h-3 w-3" />
                          {totpFlash && totpFlash.id === e.id ? `${totpFlash.code}（${totpFlash.remainSec}s）` : '验证码'}
                        </Button>
                      </div>
                    ) : e.recoveryEmail ? (
                      <div className="flex items-center gap-1.5" title={e.recoveryPassword ? `辅邮凭据：${showSecrets ? e.recoveryPassword : '••••'}` : '辅助邮箱：Google 验证挑战时发码到这里'}>
                        <span className="font-mono text-muted-foreground truncate max-w-[150px]">{e.recoveryEmail}</span>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 px-2 text-[11px] gap-1 rounded-md border-primary/25 bg-primary/10 text-primary hover:bg-primary/20 hover:text-primary shrink-0"
                          title="复制辅助邮箱用户名，并打开 yopmail 收件页（免登录收信）"
                          onClick={() => {
                            const user = e.recoveryEmail!.split('@')[0]
                            navigator.clipboard.writeText(user)
                            void window.api.openExternal(`https://yopmail.com/en/?login=${encodeURIComponent(user)}`)
                          }}
                        >
                          <ExternalLink className="h-3 w-3" /> yopmail
                        </Button>
                      </div>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="py-1.5 px-2">{e.country ? <Badge variant="outline" className="text-[10px] uppercase">{e.country}</Badge> : <span className="text-muted-foreground">—</span>}</td>
                  <td className="py-1.5 px-2"><StateBadge state={e.state} /></td>
                  <td className="py-1.5 px-2 text-muted-foreground truncate max-w-[180px]" title={e.kiroEmail}>{e.kiroEmail ?? '—'}</td>
                  <td className="py-1.5 px-2 text-red-600 dark:text-red-400 truncate max-w-[200px]" title={e.failReason}>{e.failReason ?? '—'}</td>
                  <td className="py-1.5 px-3">
                    <div className="flex items-center justify-end gap-1">
                      {(e.state === 'unused' || e.state === 'failed') && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 px-2 text-[11px] gap-1 rounded-md border-primary/25 bg-primary/10 text-primary hover:bg-primary/20 hover:text-primary"
                          disabled={running}
                          title={e.state === 'failed' ? '再次发起授权' : '打开授权窗口，登录由人工完成'}
                          onClick={() => handleAuthorize(e.id)}
                        >
                          <Play className="h-3 w-3" /> {e.state === 'failed' ? '重试' : '授权'}
                        </Button>
                      )}
                      {e.state !== 'running' && e.state !== 'used' && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 px-2 text-[11px] gap-1 rounded-md border-emerald-500/25 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/20"
                          title="已在「添加账号」等其他途径入库？标记为已用，防止重复授权"
                          onClick={() => { void window.api.googlePoolMarkUsed(e.id).then(() => refreshList()) }}
                        >
                          <CheckCircle2 className="h-3 w-3" /> 已用
                        </Button>
                      )}
                      {e.state !== 'running' && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 px-2 text-[11px] gap-1 rounded-md border-sky-500/25 bg-sky-500/10 text-sky-600 dark:text-sky-400 hover:bg-sky-500/20"
                          title="拨回未用"
                          onClick={() => { void window.api.googlePoolRestore(e.id).then(() => refreshList()) }}
                        >
                          <Undo2 className="h-3 w-3" /> 恢复
                        </Button>
                      )}
                      {e.state !== 'running' && e.state !== 'wasted' && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 px-2 text-[11px] gap-1 rounded-md border-amber-500/25 bg-amber-500/10 text-amber-600 dark:text-amber-400 hover:bg-amber-500/20"
                          title="作废后不再参与授权"
                          onClick={() => { void window.api.googlePoolMarkWasted(e.id).then(() => refreshList()) }}
                        >
                          <Ban className="h-3 w-3" /> 作废
                        </Button>
                      )}
                      {e.state !== 'running' && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 px-2 text-[11px] gap-1 rounded-md border-destructive/25 bg-destructive/10 text-destructive hover:bg-destructive/20"
                          title="从池中删除此条目"
                          onClick={() => {
                            void window.api.googlePoolRemove(e.id).then(() => {
                              setEntries((prev) => prev.filter((x) => x.id !== e.id))
                              setSelected((prev) => {
                                const next = new Set(prev)
                                next.delete(e.id)
                                return next
                              })
                            })
                          }}
                        >
                          <Trash2 className="h-3 w-3" /> 删除
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {/* 状态条 */}
        {running && (
          <div className="border-t px-4 py-2 flex items-center gap-3 text-xs text-muted-foreground shrink-0">
            <Loader2 className="h-3 w-3 animate-spin" />
            授权窗口执行中 · 手动登录完成后自动入库（中途关窗 = 取消，条目拨回未用）
          </div>
        )}
      </Card>

      {/* 执行日志（可折叠） */}
      <Card className="shrink-0">
        <CardHeader className="py-2 border-b flex flex-row items-center justify-between cursor-pointer select-none" onClick={() => setShowLogs((v) => !v)}>
          <CardTitle className="text-xs font-normal flex items-center gap-2">
            <Terminal className="h-3.5 w-3.5" /> 执行日志
            <span className="text-muted-foreground">（{logs.length}）</span>
          </CardTitle>
          <ChevronRight className={cn('h-4 w-4 text-muted-foreground transition-transform', showLogs && 'rotate-90')} />
        </CardHeader>
        {showLogs && (
          <div className="relative">
            <div
              ref={logRef}
              onScroll={handleLogScroll}
              className="h-[42vh] max-h-[520px] min-h-[200px] overflow-y-auto p-3 font-mono text-xs leading-5 space-y-0.5 bg-zinc-950 text-zinc-200 rounded-b-xl"
            >
              {logs.length === 0 && <div className="text-zinc-600">暂无日志</div>}
              {logs.map((l, i) => (
                <div key={i} className="flex gap-2">
                  <span className="text-zinc-600 shrink-0">{l.time}</span>
                  <span className={cn(
                    l.level === 'ok' && 'text-emerald-400',
                    l.level === 'err' && 'text-red-400',
                    l.level === 'warn' && 'text-amber-400',
                    l.level === 'info' && 'text-zinc-300'
                  )}>{l.msg}</span>
                </div>
              ))}
            </div>
            {!followEnd && (
              <button
                type="button"
                onClick={() => {
                  const el = logRef.current
                  if (el) el.scrollTo({ top: el.scrollHeight })
                  setFollowEnd(true)
                }}
                className="absolute bottom-2 right-3 rounded-full border border-zinc-700 bg-zinc-800/95 px-2.5 py-1 text-[11px] text-zinc-300 shadow hover:bg-zinc-700"
              >
                ↓ 回到底部
              </button>
            )}
          </div>
        )}
      </Card>

      {/* 入池弹窗 */}
      {addOpen && <AddGooglePoolDialog onClose={() => setAddOpen(false)} onDone={() => { refreshList() }} pushLog={pushLog} />}
    </div>
  )
}

// ─── 入池弹窗 ────────────────────────────────────────────────────────

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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="w-full max-w-xl rounded-xl border bg-card shadow-lg" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h3 className="text-sm font-semibold">粘贴入池（Gmail 卡密）</h3>
          <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="p-4 space-y-3">
          <p className="text-xs text-muted-foreground leading-5">
            每行一条，两种格式（分隔符严格 4 连字符，同邮箱重贴 = 覆盖凭据）：<br />
            ① 2FA 密钥版：<code className="font-mono">邮箱----密码----2FA密钥[----国家标记]</code>
            （密钥 = Google 两步验证 base32，空格分组可保留；验证码由应用本地计算，勿贴外部网站）<br />
            ② 辅助邮箱版：<code className="font-mono">邮箱----密码----辅助邮箱[----辅邮凭据[----国家标记]]</code>
            （无 2FA 密钥；Google 验证挑战时到辅助邮箱收码，可点行内 yopmail 直达）
          </p>
          <textarea
            value={text}
            onChange={(e) => { setText(e.target.value); setResult(null) }}
            spellCheck={false}
            placeholder={'someone@gmail.com----MyP@ssw0rd----ivir rjuw rw7g rxl2 sg3y krfy x2e7 zzmr----mx\nbob@gmail.com----MyP@ssw0rd----recovery@hotmail.com----aE0asqOhyk----pa'}
            className="w-full h-48 rounded-lg border border-input bg-background p-3 font-mono text-xs resize-none focus:outline-none focus:ring-1 focus:ring-primary"
          />
          {result && (
            <div className="text-xs space-y-2">
              {result.bad.length === 0 ? (
                <p className="text-emerald-600 dark:text-emerald-400">
                  已入池 {result.added} 条、覆盖 {result.updated} 条
                </p>
              ) : (
                <>
                  <p className="text-amber-600 dark:text-amber-400">
                    已入池 {result.added} 条、覆盖 {result.updated} 条；{result.bad.length} 行无法识别（留在输入框中待修）：
                  </p>
                  <pre className="max-h-24 overflow-auto rounded bg-muted/60 p-2 font-mono text-[11px] whitespace-pre-wrap">{result.bad.join('\n')}</pre>
                </>
              )}
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t px-4 py-3">
          <Button size="sm" variant="outline" onClick={onClose}>取消</Button>
          <Button size="sm" onClick={submit} disabled={!text.trim() || busy}>
            {busy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Plus className="h-4 w-4 mr-1" />}
            入池
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
  const map: Record<GooglePoolView['state'], { label: string; cls: string }> = {
    running: { label: '授权中', cls: 'bg-primary/10 text-primary border-primary/30' },
    unused: { label: '未用', cls: 'bg-zinc-500/10 text-zinc-500 border-zinc-500/30' },
    used: { label: '已入库', cls: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30' },
    failed: { label: '失败', cls: 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/30' },
    wasted: { label: '作废', cls: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30' }
  }
  const s = map[state]
  return <Badge variant="outline" className={cn('text-xs', s.cls)}>{s.label}</Badge>
}
