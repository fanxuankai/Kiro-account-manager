// 号池：GitHub 账号（账密+2FA）批量自动激活 Kiro。
// 主进程 loginPool/ 模块为唯一数据源，本页面只持视图 + 批次控制；
// 激活成功（result 事件）→ verifyAccountCredentials → addAccount 入账号管理
// → loginPoolMarkStored 回填，与「添加账号」弹窗的 GitHub 登录完全同一条入库链路。

import { useState, useEffect, useRef, useCallback } from 'react'
import { Button, Card, CardContent, CardHeader, CardTitle, Badge, Input, Label, Switch } from '../ui'
import {
  Play, Pause, Plus, RotateCcw, Ban, ExternalLink, CheckCircle2, Clock, Loader2,
  KeyRound, EyeOff, Search, ChevronRight, Terminal, Trash2, Undo2, X
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAccountsStore } from '@/store/accounts'
import type { SubscriptionType } from '@/types/account'

// ─── 类型（与 preload index.d.ts 的 window.api 声明同构）──────────────

interface PoolEntryView {
  id: string
  username: string
  state: 'unused' | 'running' | 'used' | 'failed' | 'wasted'
  step: number
  failReason?: string
  kiroEmail?: string
  addedAt: number
  takenAt?: number
  doneAt?: number
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

// ─── 页面 ────────────────────────────────────────────────────────────

export function LoginPagePool(): React.ReactNode {
  const { accounts, addAccount } = useAccountsStore()

  const [entries, setEntries] = useState<PoolEntryView[]>([])
  const [batch, setBatch] = useState<BatchState>({ running: false, paused: false, cooldownSec: 0, unused: 0 })
  const [logs, setLogs] = useState<LogLine[]>([])
  const [showLogs, setShowLogs] = useState(true)
  const [addOpen, setAddOpen] = useState(false)
  const [filter, setFilter] = useState<'all' | PoolEntryView['state']>('all')
  const [query, setQuery] = useState('')

  // 批次选项（开始/继续时读一次）
  const [intervalSec, setIntervalSec] = useState<string>('60')
  const [semiAuto, setSemiAuto] = useState(false)
  const [manualPolicy, setManualPolicy] = useState<'wait' | 'skip'>('wait')

  const logRef = useRef<HTMLDivElement>(null)
  const pushLog = useCallback((line: LogLine) => {
    setLogs((prev) => [...prev.slice(-200), line])
  }, [])

  // 同 userId 或 同邮箱+同 provider 视为重复（与添加账号弹窗同规则）
  const isAccountExists = useCallback(
    (email: string, userId: string): boolean =>
      Array.from(accounts.values()).some(
        (acc) => (userId && acc.userId === userId) || (email && acc.email === email && acc.credentials.provider === 'Github')
      ),
    [accounts]
  )

  // 激活成功后的入库（复用添加账号弹窗 handleLoginSuccess 的 social 分支）
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

  // 初始化 + 订阅主进程事件
  useEffect(() => {
    void window.api.loginPoolList().then((list) => setEntries(list))
    const unsubscribe = window.api.onLoginPoolUpdate((update) => {
      if (update.kind === 'entry') {
        setEntries((prev) => {
          const next = prev.filter((e) => e.id !== update.entry.id)
          next.push(update.entry)
          return sortEntries(next)
        })
      } else if (update.kind === 'log') {
        setLogs((prev) => [...prev.slice(-200), update.line])
      } else if (update.kind === 'batch') {
        setBatch(update.state)
      } else if (update.kind === 'result') {
        void handleResult(update.payload)
      }
    })
    // 系统协议兜底：窗口内拦截漏掉、OS 把 kiro:// 转回本应用时转发给主进程（state 不匹配会被忽略）
    const unsubCallback = window.api.onSocialAuthCallback((data) => {
      if (data.code && data.state) {
        void window.api.loginPoolManualCallback(data.code, data.state)
      }
    })
    return () => {
      unsubscribe()
      unsubCallback()
    }
  }, [handleResult])

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [logs])

  // ── 操作 ──

  const startOrResume = useCallback(() => {
    const opts = {
      intervalSec: intervalSec === 'rand' ? ('rand' as const) : Number(intervalSec),
      semiAuto,
      manualPolicy
    }
    void window.api.loginPoolStart(opts)
  }, [intervalSec, semiAuto, manualPolicy])

  const current = entries.find((e) => e.state === 'running') || null
  const list = entries.filter((e) => (filter === 'all' || e.state === filter) && (!query || e.username.includes(query)))
  const summary = {
    total: entries.length,
    success: entries.filter((e) => e.state === 'used').length,
    failed: entries.filter((e) => e.state === 'failed').length,
    unused: entries.filter((e) => e.state === 'unused').length,
    wasted: entries.filter((e) => e.state === 'wasted').length
  }
  const chips: { key: 'all' | PoolEntryView['state']; label: string; count: number }[] = [
    { key: 'all', label: '全部', count: summary.total },
    { key: 'unused', label: '未用', count: summary.unused },
    { key: 'used', label: '已入库', count: summary.success },
    { key: 'failed', label: '失败', count: summary.failed },
    { key: 'wasted', label: '作废', count: summary.wasted }
  ]
  const batchIdle = !batch.running
  const batchRunningActive = batch.running && !batch.paused

  return (
    <div className="h-full flex flex-col min-h-0 p-4 gap-3">
      {/* 标题 + 批次控制 */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-lg font-bold flex items-center gap-2">
            <KeyRound className="h-5 w-5 text-primary" /> 号池
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            GitHub 账号（账密 + 2FA）批量自动激活 Kiro，完成后直接进入账号管理
          </p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex gap-2">
            {batchRunningActive ? (
              <Button size="sm" variant="outline" onClick={() => void window.api.loginPoolPause()}>
                <Pause className="h-4 w-4" /> 暂停批次
              </Button>
            ) : (
              <Button size="sm" onClick={startOrResume} disabled={summary.unused === 0 && batchIdle}>
                <Play className="h-4 w-4" /> {batch.paused ? '继续批次' : '开始批次'}
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={() => setAddOpen(true)}>
              <Plus className="h-4 w-4" /> 粘贴入池
            </Button>
          </div>
          <div className="flex items-center gap-1.5">
            <Label className="text-xs text-muted-foreground whitespace-nowrap">批次间隔</Label>
            <select
              value={intervalSec}
              onChange={(e) => setIntervalSec(e.target.value)}
              disabled={batchRunningActive}
              title="相邻两个号之间的冷却，防风控"
              className="h-8 rounded-lg border border-input bg-background px-2 text-xs disabled:opacity-50"
            >
              <option value="30">30s</option>
              <option value="60">60s</option>
              <option value="120">120s</option>
              <option value="rand">随机 30–120s</option>
            </select>
          </div>
          <label
            className="flex items-center gap-1.5 cursor-pointer"
            title="勾选后自动填表+自动 2FA，Sign in / Verify / Authorize 由人手点（防风控降级档）"
          >
            <Switch checked={semiAuto} onCheckedChange={setSemiAuto} disabled={batchRunningActive} />
            <span className="text-xs text-muted-foreground flex items-center gap-1">
              <EyeOff className="h-3.5 w-3.5" /> 点击人工兜底
            </span>
          </label>
          <div className="flex items-center gap-1.5" title="触发人机/邮箱设备验证时的策略">
            <Label className="text-xs text-muted-foreground whitespace-nowrap">人工验证</Label>
            <select
              value={manualPolicy}
              onChange={(e) => setManualPolicy(e.target.value as 'wait' | 'skip')}
              disabled={batchRunningActive}
              className="h-8 rounded-lg border border-input bg-background px-2 text-xs disabled:opacity-50"
            >
              <option value="wait">暂停等人工</option>
              <option value="skip">标失败跳过</option>
            </select>
          </div>
        </div>
      </div>

      {/* 当前执行卡 */}
      {current && (
        <Card className="border-primary/20 shrink-0">
          <CardContent className="p-4">
            <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
              <div className="flex items-center gap-2.5">
                <Loader2 className="h-4 w-4 text-primary animate-spin" />
                <span className="text-sm font-mono font-semibold">{current.username}</span>
                <span className="text-xs text-muted-foreground">
                  {current.step < STEPS.length ? STEPS[Math.min(current.step, 7)].label : '完成'}
                </span>
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => void window.api.loginPoolFocusWindow()}>
                  <ExternalLink className="h-3.5 w-3.5 mr-1" /> 观察窗口
                </Button>
              </div>
            </div>
            <StepBar step={current.step} />
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
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索账号…" className="h-8 w-44 pl-8 text-xs" />
        </div>
        <Button size="sm" variant="ghost" className="h-8 text-xs" title="把已入库的条目移出列表（账号保留在账号管理）" onClick={() => { void window.api.loginPoolClearFinished().then(() => window.api.loginPoolList().then(setEntries)) }}>
          <Trash2 className="h-3.5 w-3.5" /> 清除已入库
        </Button>
        <Button size="sm" variant="ghost" className="h-8 text-xs" title="已入库/失败/作废全部拨回未用，再轮一遍" onClick={() => { void window.api.loginPoolRestoreAll().then(() => window.api.loginPoolList().then(setEntries)) }}>
          <Undo2 className="h-3.5 w-3.5" /> 全部恢复未用
        </Button>
      </div>

      {/* 表格 */}
      <Card className="flex-1 min-h-0 flex flex-col">
        <div className="flex-1 overflow-y-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0 z-10">
              <tr className="text-muted-foreground border-b bg-muted/50 backdrop-blur">
                <th className="text-left font-medium py-2 px-3 w-6"></th>
                <th className="text-left font-medium py-2 px-2">账号</th>
                <th className="text-left font-medium py-2 px-2">密码</th>
                <th className="text-left font-medium py-2 px-2">2FA</th>
                <th className="text-left font-medium py-2 px-2">状态</th>
                <th className="text-left font-medium py-2 px-2 w-56">执行进度</th>
                <th className="text-left font-medium py-2 px-2">入库邮箱</th>
                <th className="text-left font-medium py-2 px-2">原因</th>
                <th className="text-right font-medium py-2 px-3">操作</th>
              </tr>
            </thead>
            <tbody>
              {list.length === 0 && (
                <tr>
                  <td colSpan={9} className="py-10 text-center text-muted-foreground">
                    {entries.length === 0 ? '池是空的：点「粘贴入池」，每行一条 账号----密码----2FA密钥' : '没有符合条件的条目'}
                  </td>
                </tr>
              )}
              {list.map((e) => (
                <tr key={e.id} className={cn('border-b last:border-0 hover:bg-muted/30', e.state === 'running' && 'bg-primary/[0.05]')}>
                  <td className="py-1.5 px-3">
                    <span className={cn('block h-1 w-1 rounded-full', e.state === 'running' ? 'bg-primary animate-pulse' : 'bg-transparent')} />
                  </td>
                  <td className="py-1.5 px-2 font-mono">{e.username}</td>
                  <td className="py-1.5 px-2 text-muted-foreground">{e.passwordMasked}</td>
                  <td className="py-1.5 px-2 text-muted-foreground font-mono">{e.secretMasked}</td>
                  <td className="py-1.5 px-2"><StateBadge state={e.state} /></td>
                  <td className="py-1.5 px-2">
                    {e.state === 'running' ? (
                      <StepBar step={e.step} compact />
                    ) : (
                      <span className="text-muted-foreground">
                        {e.state === 'used' ? `✓ ${e.step}/8` : e.state === 'failed' ? `中断于 ${e.step}/8` : '—'}
                      </span>
                    )}
                  </td>
                  <td className="py-1.5 px-2 text-muted-foreground truncate max-w-[180px]" title={e.kiroEmail}>{e.kiroEmail ?? '—'}</td>
                  <td className="py-1.5 px-2 text-red-600 dark:text-red-400 truncate max-w-[200px]" title={e.failReason}>{e.failReason ?? '—'}</td>
                  <td className="py-1.5 px-3 text-right whitespace-nowrap">
                    {e.state === 'unused' && (
                      <Button size="sm" variant="ghost" className="h-6 px-2" disabled={batch.running} onClick={() => void window.api.loginPoolRunOne(e.id)}>单跑</Button>
                    )}
                    {e.state === 'failed' && (
                      <Button size="sm" variant="ghost" className="h-6 px-2" disabled={batch.running} onClick={() => void window.api.loginPoolRunOne(e.id)}>重试</Button>
                    )}
                    {e.state !== 'running' && (
                      <>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 px-2"
                          title={e.state === 'used' ? '拨回未用（可再轮一遍）' : '恢复未用'}
                          onClick={() => { void window.api.loginPoolRestore(e.id).then(() => window.api.loginPoolList().then(setEntries)) }}
                        >
                          <RotateCcw className="h-3 w-3" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 px-2 text-muted-foreground"
                          title={e.state === 'wasted' ? '删除条目' : '作废（不再参与取号）'}
                          onClick={() => {
                            if (e.state === 'wasted') {
                              void window.api.loginPoolRemove(e.id).then(() => setEntries((prev) => prev.filter((x) => x.id !== e.id)))
                            } else {
                              void window.api.loginPoolMarkWasted(e.id).then(() => window.api.loginPoolList().then(setEntries))
                            }
                          }}
                        >
                          {e.state === 'wasted' ? <Trash2 className="h-3 w-3" /> : <Ban className="h-3 w-3" />}
                        </Button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {/* 批次状态条 */}
        {(batch.running || batch.cooldownSec > 0) && (
          <div className="border-t px-4 py-2 flex items-center gap-3 text-xs text-muted-foreground shrink-0">
            {batchRunningActive ? (
              <>
                <Loader2 className="h-3 w-3 animate-spin" />
                批次执行中 · 待执行 {batch.unused}
                {batch.cooldownSec > 0 && (
                  <span className="flex items-center gap-1"><Clock className="h-3 w-3" /> 下一号 {batch.cooldownSec}s</span>
                )}
              </>
            ) : batch.paused ? (
              <>已暂停 · 当前号跑完后不再取下一号</>
            ) : (
              <>批次挂起</>
            )}
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
          <div ref={logRef} className="max-h-36 overflow-y-auto p-3 font-mono text-[11px] leading-5 space-y-0.5 bg-zinc-950 text-zinc-200 rounded-b-xl">
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
        )}
      </Card>

      {/* 入池弹窗 */}
      {addOpen && <AddPoolDialog onClose={() => setAddOpen(false)} onDone={() => { void window.api.loginPoolList().then(setEntries) }} pushLog={pushLog} />}
    </div>
  )
}

// ─── 入池弹窗 ────────────────────────────────────────────────────────

function AddPoolDialog({ onClose, onDone, pushLog }: { onClose: () => void; onDone: () => void; pushLog: (line: LogLine) => void }): React.ReactNode {
  const [text, setText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<{ added: number; updated: number; bad: string[] } | null>(null)

  const submit = async (): Promise<void> => {
    if (!text.trim() || submitting) return
    setSubmitting(true)
    try {
      const r = await window.api.loginPoolAddText(text)
      setResult(r)
      pushLog({ time: nowTime(), level: r.bad.length ? 'warn' : 'ok', msg: `入池：新增 ${r.added}、覆盖 ${r.updated}${r.bad.length ? `、非法 ${r.bad.length} 行` : ''}` })
      if (r.bad.length === 0) {
        onDone()
        onClose()
      } else {
        // 非法行留在输入框里供人工修
        setText(r.bad.join('\n'))
        onDone()
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <Card className="relative w-full max-w-lg z-10">
        <CardHeader className="pb-3 border-b">
          <div className="flex flex-row items-center justify-between">
            <CardTitle className="text-base font-bold">粘贴入池</CardTitle>
            <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full" onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            每行一条 <code className="px-1 bg-muted rounded">账号----密码----2FA密钥</code>（分隔符严格 4 连字符；2FA 密钥 = GitHub 两步验证的 base32 setup key）。同账号重贴 = 覆盖凭据保持状态。
          </p>
        </CardHeader>
        <CardContent className="pt-4 space-y-3">
          <textarea
            className="w-full min-h-[160px] px-3 py-2.5 text-sm rounded-xl border border-input bg-background/50 font-mono focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary resize-none"
            placeholder={'dev-rover-4821----MyP@ssw0rd----DHTJZSRCRXVW6DVV\notter-build-3177----AnotherPass----K7QP2XAMKR4W7DVV'}
            value={text}
            onChange={(e) => { setText(e.target.value); setResult(null) }}
            autoFocus
          />
          {result && result.bad.length > 0 && (
            <div className="text-xs text-amber-600 dark:text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2">
              {result.added > 0 && <>已入池 {result.added} 条、覆盖 {result.updated} 条；</>}
              以下 {result.bad.length} 行格式非法（段数≠3 / 密钥非 base32），已留在输入框：
              <pre className="mt-1 whitespace-pre-wrap font-mono text-[11px] max-h-20 overflow-y-auto">{result.bad.join('\n')}</pre>
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>取消</Button>
            <Button onClick={() => void submit()} disabled={!text.trim() || submitting}>
              {submitting ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Plus className="h-4 w-4 mr-1" />}
              解析入池
            </Button>
          </div>
        </CardContent>
      </Card>
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
  const map: Record<PoolEntryView['state'], { label: string; cls: string }> = {
    unused: { label: '未用', cls: 'bg-muted text-muted-foreground border-transparent' },
    running: { label: '执行中', cls: 'bg-primary/10 text-primary border-primary/30' },
    used: { label: '已入库', cls: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30' },
    failed: { label: '失败', cls: 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/30' },
    wasted: { label: '作废', cls: 'bg-zinc-500/10 text-zinc-500 border-zinc-500/30' }
  }
  const s = map[state]
  return <Badge variant="outline" className={cn('text-xs', s.cls)}>{s.label}</Badge>
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
            <div className="flex flex-col items-center gap-1.5 shrink-0">
              <div
                className={cn(
                  'flex items-center justify-center rounded-full transition-colors',
                  compact ? 'h-4 w-4' : 'h-8 w-8',
                  done && 'bg-emerald-500 text-white',
                  active && 'bg-primary text-primary-foreground ring-4 ring-primary/20',
                  !done && !active && 'bg-muted text-muted-foreground/50'
                )}
              >
                {done && <CheckCircle2 className={compact ? 'h-3 w-3' : 'h-4.5 w-4.5'} />}
                {active && <Loader2 className={cn(compact ? 'h-2.5 w-2.5' : 'h-4 w-4', 'animate-spin')} />}
                {!done && !active && <span className={cn('rounded-full bg-current', compact ? 'h-1 w-1' : 'h-1.5 w-1.5')} />}
              </div>
              {!compact && (
                <span className={cn('text-[10px] whitespace-nowrap', active ? 'text-primary font-medium' : done ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground/60')}>
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
