import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  Network, Plus, Trash2, RefreshCw, Power, PowerOff, Upload, CheckCircle2,
  XCircle, Loader2, Globe, Clock, Activity, Settings2, Copy, FileText,
  Link2, Users, Shuffle, Unlink, Stethoscope, Pencil
} from 'lucide-react'
import { useAccountsStore } from '@/store/accounts'
import { useTranslation } from '@/hooks/useTranslation'
import { Card, CardContent, CardHeader, CardTitle, Button, Input, Label, Switch, Badge } from '../ui'
import { cn } from '@/lib/utils'
import type { ProxyEntry, ProxyPoolStrategy } from '@/types/proxy'
import { IP_DETECT_ENDPOINTS } from '@/types/proxy'

const STRATEGY_OPTIONS: { value: ProxyPoolStrategy; label: string; labelEn: string; desc: string; descEn: string }[] = [
  { value: 'round_robin', label: '轮询', labelEn: 'Round Robin', desc: '依次使用每个代理', descEn: 'Use each proxy in sequence' },
  { value: 'random', label: '随机', labelEn: 'Random', desc: '随机挑选', descEn: 'Pick randomly' },
  { value: 'least_used', label: '最少使用', labelEn: 'Least Used', desc: '使用次数少的优先', descEn: 'Prefer proxies used less' },
  { value: 'fastest', label: '最快优先', labelEn: 'Fastest', desc: '按延迟升序', descEn: 'Sort by latency asc' }
]

interface ChainDiag {
  upstreamReachable: boolean; upstreamError?: string; upstreamRtMs?: number
  targetReachable: boolean; targetError?: string; targetRtMs?: number
  targetStatus?: number; targetStatusText?: string; targetBodySnippet?: string
  endToEndOk?: boolean; endToEndError?: string; endToEndRtMs?: number
}

function ChainDiagnosisCard({
  diag,
  isEn
}: {
  diag: { targetUrl: string; success: boolean; error?: string; diagnose?: ChainDiag }
  isEn: boolean
}): React.ReactNode {
  if (!diag.success || !diag.diagnose) {
    return (
      <div className="mt-2 text-[11px] rounded-md bg-red-500/10 border border-red-500/30 text-red-700 dark:text-red-400 px-2 py-1.5">
        {isEn ? 'Diagnose failed: ' : '诊断失败：'}{diag.error || 'unknown error'}
      </div>
    )
  }
  const d = diag.diagnose
  const Row = ({ ok, label, rt, err }: { ok: boolean; label: string; rt?: number; err?: string }): React.ReactNode => (
    <div className="flex items-start gap-2 text-[11px]">
      <span className={cn('mt-0.5 inline-flex items-center justify-center w-4 h-4 rounded-full text-[10px] font-bold',
        ok ? 'bg-green-500/20 text-green-600 dark:text-green-400' : 'bg-red-500/20 text-red-600 dark:text-red-400')}>
        {ok ? '✓' : '✗'}
      </span>
      <span className="flex-1">
        <span className="text-foreground">{label}</span>
        {rt !== undefined && <span className="ml-1 text-muted-foreground font-mono">{rt}ms</span>}
        {err && <div className="mt-0.5 text-red-600 dark:text-red-400 break-all">{err}</div>}
      </span>
    </div>
  )
  return (
    <div className="mt-2 space-y-1.5 rounded-md border border-border bg-card/50 px-3 py-2">
      <div className="text-[10px] text-muted-foreground font-mono truncate">
        target: {diag.targetUrl.replace(/:([^:@/]+)@/, ':***@')}
      </div>
      <Row
        ok={d.upstreamReachable}
        label={isEn ? 'A) Upstream TCP reachable' : 'A) 上游中转 TCP 可达'}
        rt={d.upstreamRtMs}
        err={d.upstreamError}
      />
      <Row
        ok={d.targetReachable}
        label={isEn ? 'B) Via upstream → target proxy entry' : 'B) 经上游 → 目标代理入口'}
        rt={d.targetRtMs}
        err={d.targetError}
      />
      <Row
        ok={d.endToEndOk === true}
        label={isEn
          ? `C) End-to-end CONNECT (status ${d.targetStatus ?? '?'} ${d.targetStatusText ?? ''})`.trim()
          : `C) 端到端 CONNECT（状态 ${d.targetStatus ?? '?'} ${d.targetStatusText ?? ''}）`.trim()}
        rt={d.endToEndRtMs}
        err={d.endToEndError}
      />
      {d.targetBodySnippet && (
        <div className="mt-1 text-[10px] text-muted-foreground font-mono break-all">
          body: {d.targetBodySnippet.slice(0, 160)}
        </div>
      )}
    </div>
  )
}

interface PoolHealthStats {
  total: number
  enabled: number
  alive: number
  slow: number
  dead: number
  untested: number
  testing: number
  totalUsed: number
  totalFailed: number
  totalSuccess: number
  successRate: number | null
  avgLatencyMs: number | null
  topUsed: Array<{ id: string; label: string; used: number; failed: number; success: number; rate: number | null; status: ProxyEntry['status'] }>
}

/** 把代理池实时聚合成几个关键指标，给"健康看板"用 */
function computePoolHealth(proxies: ProxyEntry[]): PoolHealthStats {
  const stats: PoolHealthStats = {
    total: proxies.length,
    enabled: 0, alive: 0, slow: 0, dead: 0, untested: 0, testing: 0,
    totalUsed: 0, totalFailed: 0, totalSuccess: 0,
    successRate: null,
    avgLatencyMs: null,
    topUsed: []
  }
  let latencySum = 0
  let latencyCount = 0
  for (const p of proxies) {
    if (p.enabled) stats.enabled++
    if (p.status === 'alive') stats.alive++
    else if (p.status === 'slow') stats.slow++
    else if (p.status === 'dead') stats.dead++
    else if (p.status === 'untested') stats.untested++
    else if (p.status === 'testing') stats.testing++
    stats.totalUsed += p.usedCount
    stats.totalFailed += p.failCount
    if (p.latencyMs && (p.status === 'alive' || p.status === 'slow')) {
      latencySum += p.latencyMs
      latencyCount++
    }
  }
  stats.totalSuccess = Math.max(0, stats.totalUsed - stats.totalFailed)
  stats.successRate = stats.totalUsed > 0 ? stats.totalSuccess / stats.totalUsed : null
  stats.avgLatencyMs = latencyCount > 0 ? Math.round(latencySum / latencyCount) : null
  stats.topUsed = proxies
    .slice()
    .filter((p) => p.usedCount > 0)
    .sort((a, b) => b.usedCount - a.usedCount)
    .slice(0, 5)
    .map((p) => {
      const success = Math.max(0, p.usedCount - p.failCount)
      return {
        id: p.id,
        label: p.label || `${p.protocol}://${p.host}:${p.port}`,
        used: p.usedCount,
        failed: p.failCount,
        success,
        rate: p.usedCount > 0 ? success / p.usedCount : null,
        status: p.status
      }
    })
  return stats
}

function StatTile({
  label, value, sub, tone
}: {
  label: string
  value: React.ReactNode
  sub?: React.ReactNode
  tone?: 'default' | 'green' | 'amber' | 'red' | 'blue'
}): React.ReactNode {
  const toneCls = tone === 'green' ? 'text-green-600 dark:text-green-400'
    : tone === 'amber' ? 'text-amber-600 dark:text-amber-400'
    : tone === 'red' ? 'text-red-600 dark:text-red-400'
    : tone === 'blue' ? 'text-blue-600 dark:text-blue-400'
    : 'text-foreground'
  return (
    <div className="rounded-lg border border-border bg-card/50 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={cn('mt-0.5 text-lg font-semibold tabular-nums', toneCls)}>{value}</div>
      {sub !== undefined && <div className="text-[11px] text-muted-foreground">{sub}</div>}
    </div>
  )
}

function HealthDashboard({ stats, isEn }: { stats: PoolHealthStats; isEn: boolean }): React.ReactNode {
  if (stats.total === 0) return null
  const availabilityRate = stats.total > 0 ? (stats.alive + stats.slow) / stats.total : 0
  const successPct = stats.successRate !== null ? Math.round(stats.successRate * 100) : null
  const successTone: 'green' | 'amber' | 'red' | 'default' = successPct === null ? 'default'
    : successPct >= 80 ? 'green' : successPct >= 50 ? 'amber' : 'red'
  const availTone: 'green' | 'amber' | 'red' | 'default' = stats.total === 0 ? 'default'
    : availabilityRate >= 0.7 ? 'green' : availabilityRate >= 0.3 ? 'amber' : 'red'
  return (
    <Card className="hover-lift">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Activity className="h-4 w-4 text-primary" />
          {isEn ? 'Pool Health Dashboard' : '代理池健康看板'}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
          <StatTile
            label={isEn ? 'Total / Enabled' : '总数 / 已启用'}
            value={<>{stats.total}<span className="text-muted-foreground text-base"> / {stats.enabled}</span></>}
          />
          <StatTile
            label={isEn ? 'Availability' : '可用率'}
            value={`${Math.round(availabilityRate * 100)}%`}
            sub={`${stats.alive + stats.slow} ${isEn ? 'alive' : '可用'}`}
            tone={availTone}
          />
          <StatTile
            label={isEn ? 'Success Rate' : '成功率'}
            value={successPct !== null ? `${successPct}%` : '—'}
            sub={`${stats.totalSuccess} / ${stats.totalUsed}`}
            tone={successTone}
          />
          <StatTile
            label={isEn ? 'Avg Latency' : '平均延迟'}
            value={stats.avgLatencyMs !== null ? `${stats.avgLatencyMs}ms` : '—'}
            tone="blue"
          />
          <StatTile
            label={isEn ? 'Dead' : '失效'}
            value={stats.dead}
            tone={stats.dead > 0 ? 'red' : 'default'}
          />
          <StatTile
            label={isEn ? 'Untested' : '未测试'}
            value={stats.untested + stats.testing}
            tone={stats.untested > 0 ? 'amber' : 'default'}
          />
        </div>

        {stats.topUsed.length > 0 && (
          <div>
            <div className="mb-2 text-xs text-muted-foreground">
              {isEn ? `Top ${stats.topUsed.length} most used proxies` : `承担量 Top ${stats.topUsed.length}`}
            </div>
            <div className="space-y-1.5">
              {stats.topUsed.map((p) => {
                const rate = p.rate !== null ? Math.round(p.rate * 100) : null
                const ratePct = p.rate !== null ? p.rate * 100 : 0
                const barTone = rate === null ? 'bg-muted-foreground/30'
                  : rate >= 80 ? 'bg-green-500'
                  : rate >= 50 ? 'bg-amber-500' : 'bg-red-500'
                return (
                  <div key={p.id} className="space-y-0.5">
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <div className="flex items-center gap-2 min-w-0 flex-1">
                        <StatusBadge status={p.status} />
                        <span className="font-mono text-[11px] truncate">{p.label}</span>
                      </div>
                      <div className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                        {p.success}/{p.used}
                        {rate !== null && <span className="ml-1.5 font-medium text-foreground">{rate}%</span>}
                      </div>
                    </div>
                    <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                      <div className={cn('h-full transition-all', barTone)} style={{ width: `${ratePct}%` }} />
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function StatusBadge({ status, latency }: { status: ProxyEntry['status']; latency?: number }): React.ReactNode {
  const cfg = {
    untested: { color: 'bg-muted text-muted-foreground', label: '未测试', labelEn: 'Untested' },
    testing: { color: 'bg-blue-500/15 text-blue-600 dark:text-blue-400', label: '测试中', labelEn: 'Testing' },
    alive: { color: 'bg-green-500/15 text-green-600 dark:text-green-400', label: '可用', labelEn: 'Alive' },
    slow: { color: 'bg-amber-500/15 text-amber-600 dark:text-amber-400', label: '较慢', labelEn: 'Slow' },
    dead: { color: 'bg-red-500/15 text-red-600 dark:text-red-400', label: '失效', labelEn: 'Dead' }
  }[status]

  return (
    <span className={cn('inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-medium', cfg.color)}>
      {status === 'testing' && <Loader2 className="h-3 w-3 animate-spin" />}
      {status === 'alive' && <CheckCircle2 className="h-3 w-3" />}
      {status === 'slow' && <Activity className="h-3 w-3" />}
      {status === 'dead' && <XCircle className="h-3 w-3" />}
      <span>{cfg.label}</span>
      {latency !== undefined && (status === 'alive' || status === 'slow') && (
        <span className="font-mono opacity-70">{latency}ms</span>
      )}
    </span>
  )
}

export function ProxyPoolPage(): React.ReactNode {
  const { t } = useTranslation()
  const isEn = t('common.unknown') === 'Unknown'
  const {
    proxyPool,
    proxyPoolConfig,
    addProxy,
    importProxies,
    removeProxy,
    removeProxies,
    toggleProxyEnabled,
    updateProxy,
    validateProxy,
    validateProxiesBatch,
    clearProxyPool,
    setProxyPoolConfig,
    accounts,
    accountProxyBindings,
    unbindAccountFromProxy,
    clearAccountProxyBindings,
    autoDistributeAccountsToProxies
  } = useAccountsStore()

  const [singleInput, setSingleInput] = useState('')
  const [bulkInput, setBulkInput] = useState('')
  const [bulkOpen, setBulkOpen] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  // 搜索 / 过滤（v1.8 扩展：协议 / 启用状态 / 延迟 / 最后验证时间 + 全文）
  const [filterText, setFilterText] = useState('')
  const [filterStatus, setFilterStatus] = useState<'all' | ProxyEntry['status']>('all')
  const [filterProtocol, setFilterProtocol] = useState<'all' | ProxyEntry['protocol']>('all')
  const [filterEnabled, setFilterEnabled] = useState<'all' | 'enabled' | 'disabled'>('all')
  const [filterLatency, setFilterLatency] = useState<'all' | 'fast' | 'medium' | 'slow' | 'unknown'>('all')
  const [filterTestedWithin, setFilterTestedWithin] = useState<'all' | '1h' | '1d' | '7d' | 'never'>('all')
  const [advancedSearchOpen, setAdvancedSearchOpen] = useState(false)
  const [isValidatingAll, setIsValidatingAll] = useState(false)
  const [testConcurrency, setTestConcurrency] = useState(10)
  // 反代分桶：每代理承载账号数（0 = 均分）
  const [accountsPerProxy, setAccountsPerProxy] = useState<number>(5)
  const [bindingPanelExpanded, setBindingPanelExpanded] = useState(false)
  // 代理链诊断状态
  const [chainDiagnosing, setChainDiagnosing] = useState(false)
  const [chainDiagnose, setChainDiagnose] = useState<{
    targetUrl: string
    success: boolean
    error?: string
    diagnose?: {
      upstreamReachable: boolean; upstreamError?: string; upstreamRtMs?: number
      targetReachable: boolean; targetError?: string; targetRtMs?: number
      targetStatus?: number; targetStatusText?: string; targetBodySnippet?: string
      endToEndOk?: boolean; endToEndError?: string; endToEndRtMs?: number
    }
  } | null>(null)

  // 用池里第一条 enabled 代理作为诊断目标；如果没有则用任意第一条
  const runChainDiagnose = useCallback(async () => {
    const upstream = proxyPoolConfig.upstreamProxy?.trim()
    if (!upstream) return
    const candidates = Array.from(proxyPool.values())
    const target = candidates.find((p) => p.enabled) || candidates[0]
    if (!target) return
    setChainDiagnosing(true)
    setChainDiagnose(null)
    try {
      const res = await window.api.proxyPoolDiagnoseChain({
        targetUrl: target.url,
        upstreamProxy: upstream
      })
      setChainDiagnose({ targetUrl: target.url, ...res })
    } catch (err) {
      setChainDiagnose({
        targetUrl: target.url,
        success: false,
        error: err instanceof Error ? err.message : String(err)
      })
    } finally {
      setChainDiagnosing(false)
    }
  }, [proxyPool, proxyPoolConfig.upstreamProxy])

  // Kiro IP 池测试连接状态
  const [kiroTesting, setKiroTesting] = useState(false)
  const [kiroTestResult, setKiroTestResult] = useState<
    | {
        success: true
        exitIp: string
        latencyMs: number
        lockCount?: number
        lockThreshold?: number
        warnings: string[]
      }
    | { success: false; error: string }
    | null
  >(null)

  const runKiroPoolTest = useCallback(async () => {
    const apiBase = proxyPoolConfig.kiroPoolApiBase?.trim() || ''
    const username = proxyPoolConfig.kiroPoolUsername?.trim() || ''
    const password = proxyPoolConfig.kiroPoolPassword || ''
    if (!apiBase || !username || !password) return
    setKiroTesting(true)
    setKiroTestResult(null)
    try {
      const res = await window.api.proxyPoolTestKiroPool({ apiBase, username, password })
      if (res.success) {
        setKiroTestResult({
          success: true,
          exitIp: res.exitIp ?? '?',
          latencyMs: res.latencyMs ?? 0,
          lockCount: res.lockCount,
          lockThreshold: res.lockThreshold,
          warnings: res.warnings ?? []
        })
      } else {
        setKiroTestResult({ success: false, error: res.error || '未知错误' })
      }
    } catch (err) {
      setKiroTestResult({ success: false, error: err instanceof Error ? err.message : String(err) })
    } finally {
      setKiroTesting(false)
    }
  }, [proxyPoolConfig.kiroPoolApiBase, proxyPoolConfig.kiroPoolUsername, proxyPoolConfig.kiroPoolPassword])

  const proxies = useMemo(() => Array.from(proxyPool.values()), [proxyPool])
  const poolHealth = useMemo(() => computePoolHealth(proxies), [proxies])

  // 反代分桶：当前账号-代理绑定关系
  const bindingStats = useMemo(() => {
    const allAccounts = Array.from(accounts.values())
    const totalActive = allAccounts.filter((a) => a.status === 'active').length
    const boundCount = Object.keys(accountProxyBindings).filter(
      (aid) => accounts.has(aid)
    ).length
    const aliveProxies = proxies.filter((p) => p.enabled && p.status !== 'dead')
    // 每代理承载的账号数
    const perProxy: Record<string, number> = {}
    for (const [aid, pid] of Object.entries(accountProxyBindings)) {
      if (!accounts.has(aid)) continue
      perProxy[pid] = (perProxy[pid] || 0) + 1
    }
    // 风险点：单代理账号数 > 推荐阈值（默认 5）
    const overloadedProxies = Object.entries(perProxy)
      .filter(([, c]) => c > 10)
      .map(([pid, c]) => ({ pid, count: c, proxy: proxyPool.get(pid) }))
    return {
      totalActive,
      boundCount,
      unboundCount: totalActive - boundCount,
      aliveProxyCount: aliveProxies.length,
      perProxy,
      overloadedProxies
    }
  }, [accounts, accountProxyBindings, proxies, proxyPool])

  // 后台定时验活
  const lastAutoValidateRef = useRef(0)
  useEffect(() => {
    const intervalMin = proxyPoolConfig.autoValidateIntervalMin
    if (!intervalMin || intervalMin <= 0) return

    const tick = (): void => {
      const now = Date.now()
      if (now - lastAutoValidateRef.current < intervalMin * 60_000) return
      const enabledIds = Array.from(proxyPool.values())
        .filter((p) => p.enabled)
        .map((p) => p.id)
      if (enabledIds.length === 0) return
      lastAutoValidateRef.current = now
      console.log(`[ProxyPool] Auto-validate ${enabledIds.length} proxies`)
      void validateProxiesBatch(enabledIds, proxyPoolConfig.autoValidateConcurrency || 5)
    }

    // 每分钟检查一次
    const timer = setInterval(tick, 60_000)
    return () => clearInterval(timer)
  }, [proxyPoolConfig.autoValidateIntervalMin, proxyPoolConfig.autoValidateConcurrency, proxyPool, validateProxiesBatch])

  const handleAutoDistribute = useCallback((onlyUnbound: boolean) => {
    if (bindingStats.aliveProxyCount === 0) {
      alert(isEn ? 'No alive proxies. Validate proxies first.' : '没有可用代理，请先验活代理')
      return
    }
    const activeAccountIds = Array.from(accounts.values())
      .filter((a) => a.status === 'active')
      .map((a) => a.id)
    if (activeAccountIds.length === 0) {
      alert(isEn ? 'No active accounts.' : '没有可用账号')
      return
    }
    const result = autoDistributeAccountsToProxies({
      accountsPerProxy,
      onlyUnbound,
      accountIds: activeAccountIds
    })
    alert(isEn
      ? `Distributed ${result.distributed} accounts, skipped ${result.skipped}`
      : `已分配 ${result.distributed} 个账号，跳过 ${result.skipped}`
    )
  }, [accounts, accountsPerProxy, autoDistributeAccountsToProxies, bindingStats.aliveProxyCount, isEn])

  const stats = useMemo(() => {
    let alive = 0, dead = 0, slow = 0, untested = 0, enabled = 0
    for (const p of proxies) {
      if (p.enabled) enabled++
      if (p.status === 'alive') alive++
      else if (p.status === 'dead') dead++
      else if (p.status === 'slow') slow++
      else if (p.status === 'untested') untested++
    }
    return { total: proxies.length, alive, dead, slow, untested, enabled }
  }, [proxies])

  // v1.8 升级版过滤：全文匹配（任意字段片段都能搜到）+ 多维度筛选
  const filtered = useMemo(() => {
    const now = Date.now()
    const HOUR = 60 * 60 * 1000
    const DAY = 24 * HOUR
    return proxies.filter(p => {
      // 状态过滤
      if (filterStatus !== 'all' && p.status !== filterStatus) return false
      // 协议过滤
      if (filterProtocol !== 'all' && p.protocol !== filterProtocol) return false
      // 启用状态过滤
      if (filterEnabled === 'enabled' && !p.enabled) return false
      if (filterEnabled === 'disabled' && p.enabled) return false
      // 延迟范围过滤
      if (filterLatency !== 'all') {
        const lat = p.latencyMs
        if (filterLatency === 'unknown') {
          if (typeof lat === 'number') return false
        } else if (typeof lat !== 'number') {
          return false
        } else {
          if (filterLatency === 'fast' && lat >= 200) return false
          if (filterLatency === 'medium' && (lat < 200 || lat >= 1000)) return false
          if (filterLatency === 'slow' && lat < 1000) return false
        }
      }
      // 最后验证时间过滤
      if (filterTestedWithin !== 'all') {
        if (filterTestedWithin === 'never') {
          if (p.lastTestedAt) return false
        } else if (!p.lastTestedAt) {
          return false
        } else {
          const diff = now - p.lastTestedAt
          if (filterTestedWithin === '1h' && diff > HOUR) return false
          if (filterTestedWithin === '1d' && diff > DAY) return false
          if (filterTestedWithin === '7d' && diff > 7 * DAY) return false
        }
      }
      // 全文搜索（host / port / protocol / username / label / lastBoundEmail / url / tags）
      if (filterText) {
        const q = filterText.toLowerCase().trim()
        const haystack = [
          p.host,
          String(p.port),
          p.protocol,
          p.username || '',
          p.label || '',
          p.lastBoundEmail || '',
          p.url || '',
          (p.tags || []).join(' '),
          p.source || ''
        ].join(' ').toLowerCase()
        if (!haystack.includes(q)) return false
      }
      return true
    })
  }, [proxies, filterText, filterStatus, filterProtocol, filterEnabled, filterLatency, filterTestedWithin])

  // 已应用的过滤条件计数（用于在 UI 显示"高级搜索"徽章）
  const activeAdvancedFilterCount = useMemo(() => {
    let n = 0
    if (filterProtocol !== 'all') n++
    if (filterEnabled !== 'all') n++
    if (filterLatency !== 'all') n++
    if (filterTestedWithin !== 'all') n++
    return n
  }, [filterProtocol, filterEnabled, filterLatency, filterTestedWithin])

  const clearAdvancedFilters = useCallback(() => {
    setFilterProtocol('all')
    setFilterEnabled('all')
    setFilterLatency('all')
    setFilterTestedWithin('all')
  }, [])

  const handleAddSingle = useCallback(() => {
    if (!singleInput.trim()) return
    const id = addProxy(singleInput.trim())
    if (id) {
      setSingleInput('')
    } else {
      alert(isEn ? 'Invalid proxy URL or duplicate' : '代理 URL 无效或重复')
    }
  }, [singleInput, addProxy, isEn])

  const handleImport = useCallback(() => {
    if (!bulkInput.trim()) return
    const result = importProxies(bulkInput)
    alert(isEn
      ? `Imported: added ${result.added}, skipped ${result.skipped}, failed ${result.failed}`
      : `导入完成：新增 ${result.added}，跳过 ${result.skipped}，失败 ${result.failed}`
    )
    setBulkInput('')
    setBulkOpen(false)
  }, [bulkInput, importProxies, isEn])

  const handleValidateAll = useCallback(async () => {
    const ids = filtered.map(p => p.id)
    if (ids.length === 0) return
    setIsValidatingAll(true)
    try {
      await validateProxiesBatch(ids, testConcurrency)
    } finally {
      setIsValidatingAll(false)
    }
  }, [filtered, validateProxiesBatch, testConcurrency])

  const handleValidateSelected = useCallback(async () => {
    const ids = Array.from(selectedIds)
    if (ids.length === 0) return
    setIsValidatingAll(true)
    try {
      await validateProxiesBatch(ids, testConcurrency)
    } finally {
      setIsValidatingAll(false)
    }
  }, [selectedIds, validateProxiesBatch, testConcurrency])

  const handleDeleteSelected = useCallback(() => {
    if (selectedIds.size === 0) return
    if (!confirm(isEn ? `Delete ${selectedIds.size} proxies?` : `确定删除 ${selectedIds.size} 个代理？`)) return
    removeProxies(Array.from(selectedIds))
    setSelectedIds(new Set())
  }, [selectedIds, removeProxies, isEn])

  const handleRemoveDead = useCallback(() => {
    const deadIds = proxies.filter(p => p.status === 'dead').map(p => p.id)
    if (deadIds.length === 0) return
    if (!confirm(isEn ? `Remove ${deadIds.length} dead proxies?` : `确定移除 ${deadIds.length} 个失效代理？`)) return
    removeProxies(deadIds)
  }, [proxies, removeProxies, isEn])

  const toggleSelect = (id: string): void => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleSelectAll = (): void => {
    if (selectedIds.size === filtered.length && filtered.length > 0) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(filtered.map(p => p.id)))
    }
  }

  return (
    <div className="flex-1 p-6 space-y-6 overflow-auto">
      {/* Header */}
      <div className="page-hero p-6">
        <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-br from-cyan-500/20 to-transparent rounded-full blur-2xl" />
        <div className="absolute bottom-0 left-0 w-24 h-24 bg-gradient-to-tr from-cyan-500/20 to-transparent rounded-full blur-2xl" />
        <div className="relative flex items-center gap-4">
          <div className="p-3 rounded-xl bg-cyan-500 shadow-lg shadow-cyan-500/25">
            <Network className="h-6 w-6 text-white" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-cyan-600 dark:text-cyan-400">
              {isEn ? 'Proxy Pool' : '代理池'}
            </h1>
            <p className="text-muted-foreground">
              {isEn
                ? 'IP rotation pool for registration tasks. Reduces association/risk control on batch sign-ups.'
                : '注册批量任务的 IP 轮换池。降低同 IP 多账号关联风控。'
              }
            </p>
          </div>
        </div>
      </div>

      {/* 健康看板：池总览 + Top 承担量 */}
      <HealthDashboard stats={poolHealth} isEn={isEn} />

      {/* 池总开关 + 调度策略 */}
      <Card className="hover-lift">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Settings2 className="h-4 w-4 text-primary" />
            {isEn ? 'Pool Configuration' : '池配置'}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* 总开关 */}
          <div className="flex items-center gap-3">
            <Switch
              checked={proxyPoolConfig.enabled}
              onCheckedChange={(v) => setProxyPoolConfig({ enabled: v })}
            />
            <div>
              <Label className="cursor-pointer text-sm">
                {isEn ? 'Enable proxy pool for registration' : '为注册流程启用代理池'}
              </Label>
              <p className="text-[11px] text-muted-foreground">
                {isEn
                  ? 'When enabled, each registration task picks an available proxy by the strategy below.'
                  : '开启后，每个注册任务会按下方策略自动选取一个可用代理'
                }
              </p>
            </div>
          </div>

          {/* 调度策略 */}
          <div className="space-y-2">
            <Label className="text-xs">{isEn ? 'Selection Strategy' : '调度策略'}</Label>
            <div className="flex flex-wrap gap-2">
              {STRATEGY_OPTIONS.map(opt => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setProxyPoolConfig({ strategy: opt.value })}
                  className={cn(
                    'px-3 py-1.5 rounded-md border text-xs transition-colors',
                    proxyPoolConfig.strategy === opt.value
                      ? 'border-primary bg-primary/10 text-primary font-medium'
                      : 'border-border hover:border-primary/50'
                  )}
                  title={isEn ? opt.descEn : opt.desc}
                >
                  {isEn ? opt.labelEn : opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* 自动停用 + 失败阈值 + 测试 URL */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-2">
            <div className="flex items-center gap-2">
              <Switch
                checked={proxyPoolConfig.autoDisableDead}
                onCheckedChange={(v) => setProxyPoolConfig({ autoDisableDead: v })}
              />
              <Label className="text-xs cursor-pointer">
                {isEn ? 'Auto-disable on failure' : '失败自动停用'}
              </Label>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{isEn ? 'Failure threshold' : '失败阈值'}</Label>
              <Input
                type="number" min={1} max={20}
                value={proxyPoolConfig.failureThreshold}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10)
                  if (!isNaN(v) && v >= 1) setProxyPoolConfig({ failureThreshold: v })
                }}
                className="h-8 text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{isEn ? 'IP Detection Endpoint' : 'IP 检测端点'}</Label>
              <div className="flex gap-1.5">
                <select
                  value={IP_DETECT_ENDPOINTS.find(e => e.url === proxyPoolConfig.testUrl)?.id || '_custom'}
                  onChange={(e) => {
                    const ep = IP_DETECT_ENDPOINTS.find(ep => ep.id === e.target.value)
                    if (ep) setProxyPoolConfig({ testUrl: ep.url })
                  }}
                  className="h-8 text-xs rounded-lg border border-foreground/15 bg-[var(--glass-bg)] backdrop-blur-md px-2 flex-shrink-0"
                >
                  {IP_DETECT_ENDPOINTS.map(ep => (
                    <option key={ep.id} value={ep.id}>{ep.label}</option>
                  ))}
                  <option value="_custom">{isEn ? 'Custom...' : '自定义...'}</option>
                </select>
                <Input
                  value={proxyPoolConfig.testUrl}
                  onChange={(e) => setProxyPoolConfig({ testUrl: e.target.value })}
                  placeholder="https://api.ipify.org?format=json"
                  className="h-8 text-xs font-mono flex-1"
                />
              </div>
            </div>
          </div>

          {/* 定时自动验活 (B2) */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs flex items-center gap-1">
                <Clock className="h-3 w-3" />
                {isEn ? 'Auto-validate interval (min, 0=off)' : '定时自动验活（分钟，0=关闭）'}
              </Label>
              <Input
                type="number" min={0} max={1440}
                value={proxyPoolConfig.autoValidateIntervalMin}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10)
                  if (!isNaN(v) && v >= 0) setProxyPoolConfig({ autoValidateIntervalMin: v })
                }}
                className="h-8 text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{isEn ? 'Auto-validate concurrency' : '验活并发'}</Label>
              <Input
                type="number" min={1} max={50}
                value={proxyPoolConfig.autoValidateConcurrency}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10)
                  if (!isNaN(v) && v >= 1) setProxyPoolConfig({ autoValidateConcurrency: v })
                }}
                disabled={proxyPoolConfig.autoValidateIntervalMin === 0}
                className="h-8 text-xs"
              />
            </div>
          </div>

          {/* 上游中转代理（代理链）：用于目标代理要求非大陆来源 IP 的场景 */}
          <div className="space-y-1">
            <Label className="text-xs">
              {isEn ? 'Upstream relay proxy (proxy chaining)' : '上游中转代理（代理链）'}
            </Label>
            <div className="flex items-center gap-2">
              <Input
                value={proxyPoolConfig.upstreamProxy || ''}
                onChange={(e) => setProxyPoolConfig({ upstreamProxy: e.target.value })}
                placeholder={isEn ? 'e.g. socks5://127.0.0.1:7890 (empty = off)' : '如 socks5://127.0.0.1:7890（留空=不启用）'}
                className="h-8 text-xs font-mono flex-1"
              />
              <Button
                size="sm" variant="outline"
                className="h-8 px-3 text-xs whitespace-nowrap"
                disabled={!proxyPoolConfig.upstreamProxy?.trim() || proxyPool.size === 0 || chainDiagnosing}
                onClick={() => void runChainDiagnose()}
                title={isEn ? 'Diagnose proxy chain (locates failure layer)' : '诊断代理链（定位失败在哪一层）'}
              >
                {chainDiagnosing
                  ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  : <Stethoscope className="h-3.5 w-3.5" />}
                <span className="ml-1">{isEn ? 'Diagnose' : '诊断'}</span>
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              {isEn
                ? 'When set, traffic chains: local → relay → target proxy → site. Use when the target proxy requires a non-mainland source IP (e.g. bestproxy). Supports http/socks5; your VPN local port works.'
                : '填写后链路为：本机 → 上游中转 → 目标代理 → 目标站点。用于目标代理要求非大陆来源 IP 的情况（如 bestproxy）。支持 http/socks5，可填你科学上网的本地端口。'}
            </p>
            {chainDiagnose && <ChainDiagnosisCard diag={chainDiagnose} isEn={isEn} />}
          </div>
        </CardContent>
      </Card>

      {/* 动态出口源：号池/批量订阅「api 出口」模式的数据源（与上方静态池条目互不影响） */}
      <Card className="hover-lift">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Link2 className="h-4 w-4 text-primary" />
            {isEn ? 'Dynamic Exit Source' : '动态出口源'}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1">
            <Label className="text-xs">{isEn ? 'Source type' : '来源类型'}</Label>
            <select
              value={proxyPoolConfig.dynamicSourceType || 'extract-api'}
              onChange={(e) =>
                setProxyPoolConfig({ dynamicSourceType: e.target.value as 'extract-api' | 'kiro-pool' })
              }
              className="h-8 w-full max-w-sm rounded-lg border border-input bg-background px-2 text-xs"
            >
              <option value="extract-api">{isEn ? 'Whitelist extract API (one-time endpoints)' : '白名单提链接口（一次性端点）'}</option>
              <option value="kiro-pool">{isEn ? 'Kiro IP pool service (fixed socks5 + login locks)' : 'Kiro IP 池服务（固定 socks5 + 登录锁）'}</option>
            </select>
          </div>
          {(proxyPoolConfig.dynamicSourceType || 'extract-api') === 'extract-api' ? (
            <>
              <p className="text-[11px] text-muted-foreground leading-relaxed">
                {isEn
                  ? 'Batch-extract one-time endpoints from a whitelist API (plain-text IP:port per line, e.g. novproxy). Consumers opt in: login-pool windows and batch subscription link fetching, one endpoint each.'
                  : '从白名单提链接口批量提取一次性端点（纯文本每行一个 IP:port，如 novproxy）。号池注册、批量订阅获取链接可选接入，每个窗口/链接消费一个独立出口。'}
              </p>
              <div className="space-y-1">
                <Label className="text-xs">{isEn ? 'Extract API URL' : '提链接口地址'}</Label>
                <Input
                  value={proxyPoolConfig.dynamicApiUrl || ''}
                  onChange={(e) => setProxyPoolConfig({ dynamicApiUrl: e.target.value })}
                  placeholder="https://white.example.com/white/api?region=US&num=1&time=10&format=1&type=txt"
                  className="h-8 text-xs font-mono"
                />
                <p className="text-[11px] text-muted-foreground">
                  {isEn
                    ? 'num is overridden by batch size below; time (minutes) sets endpoint TTL; region etc. stay as written.'
                    : 'num 会按下方提取数量覆盖；time（分钟）决定端点有效期；region 等参数按 URL 原样生效。'}
                </p>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs">{isEn ? 'Local relay' : '本地中转'}</Label>
                  <Input
                    value={proxyPoolConfig.dynamicViaProxy || ''}
                    onChange={(e) => setProxyPoolConfig({ dynamicViaProxy: e.target.value })}
                    placeholder={isEn ? 'empty = system proxy' : '留空=自动取系统代理'}
                    className="h-8 text-xs font-mono"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">{isEn ? 'Batch size (num)' : '提取数量（num）'}</Label>
                  <Input
                    type="number" min={1} max={20}
                    value={proxyPoolConfig.dynamicBatchSize ?? 5}
                    onChange={(e) => {
                      const v = parseInt(e.target.value, 10)
                      if (!isNaN(v) && v >= 1 && v <= 20) setProxyPoolConfig({ dynamicBatchSize: v })
                    }}
                    className="h-8 text-xs"
                  />
                </div>
              </div>
            </>
          ) : (
            <>
              <p className="text-[11px] text-muted-foreground leading-relaxed">
                {isEn
                  ? 'The socks5 proxy runs on the current exit IP (returned by the IP API, rotates with server-side rebinding): socks5://username:password@<exitIP>:4722. Every proxied operation is wrapped in a login lock (lock before, unlock after); while held the server never rotates, so requests cannot be cut mid-flight. After N locks (all released) the server rotates automatically.'
                  : 'socks5 服务在当前出口 IP 上（由查 IP 接口返回，随服务端换绑自动换主机）：socks5://账号:密码@<出口IP>:4722。每个走此代理的操作整体包在登录锁里（先 lock 后 unlock），持锁期间服务端不换 IP、请求不会中途被断；累计 N 把锁全部释放后服务端自动换绑。'}
              </p>
              <div className="space-y-1">
                <Label className="text-xs">{isEn ? 'Service API base' : '服务 API 地址'}</Label>
                <Input
                  value={proxyPoolConfig.kiroPoolApiBase || ''}
                  onChange={(e) => setProxyPoolConfig({ kiroPoolApiBase: e.target.value })}
                  placeholder="http://<服务器IP>:4721"
                  className="h-8 text-xs font-mono"
                />
                <p className="text-[11px] text-muted-foreground">
                  {isEn
                    ? 'socks5 proxy auto-connects to <exitIP>:4722 from the IP API; do NOT use the control server as proxy.'
                    : 'socks5 代理自动连「查 IP 接口返回的出口IP:4722」；注意不能用控制服务器当代理（出口会是服务器本机 IP）。'}
                </p>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs">{isEn ? 'Admin username' : '管理员账号'}</Label>
                  <Input
                    value={proxyPoolConfig.kiroPoolUsername || ''}
                    onChange={(e) => setProxyPoolConfig({ kiroPoolUsername: e.target.value })}
                    placeholder={isEn ? 'platform admin account = proxy username' : '平台管理员账号（= 代理账号）'}
                    className="h-8 text-xs font-mono"
                    autoComplete="off"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">{isEn ? 'Login password' : '登录密码'}</Label>
                  <Input
                    type="password"
                    value={proxyPoolConfig.kiroPoolPassword || ''}
                    onChange={(e) => setProxyPoolConfig({ kiroPoolPassword: e.target.value })}
                    placeholder={isEn ? 'platform password = proxy password' : '平台登录密码（= 代理密码）'}
                    className="h-8 text-xs font-mono"
                    autoComplete="new-password"
                  />
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="sm" variant="outline"
                  className="h-8 px-3 text-xs"
                  disabled={
                    kiroTesting ||
                    !proxyPoolConfig.kiroPoolApiBase?.trim() ||
                    !proxyPoolConfig.kiroPoolUsername?.trim() ||
                    !proxyPoolConfig.kiroPoolPassword
                  }
                  onClick={() => void runKiroPoolTest()}
                  title={isEn ? 'Full drill: query IP → lock → probe exit → unlock (consumes one lock count)' : '全链路演练：查 IP → 上锁 → 探测出口 → 解锁（消耗服务端一次锁计数）'}
                >
                  {kiroTesting
                    ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    : <Activity className="h-3.5 w-3.5" />}
                  <span className="ml-1">{isEn ? 'Test connection' : '测试连接'}</span>
                </Button>
                {kiroTestResult?.success && (
                  <span className="text-[11px] text-green-600 dark:text-green-400">
                    {isEn ? 'Exit IP ' : '出口 '}
                    <span className="font-mono">{kiroTestResult.exitIp}</span>
                    （{kiroTestResult.latencyMs}ms
                    {kiroTestResult.lockCount !== undefined && kiroTestResult.lockThreshold !== undefined
                      ? isEn
                        ? ` · lock ${kiroTestResult.lockCount}/${kiroTestResult.lockThreshold}`
                        : ` · 锁 ${kiroTestResult.lockCount}/${kiroTestResult.lockThreshold}`
                      : ''}）
                  </span>
                )}
                {kiroTestResult && !kiroTestResult.success && (
                  <span className="text-[11px] text-red-600 dark:text-red-400 break-all">{kiroTestResult.error}</span>
                )}
              </div>
              {kiroTestResult?.success && kiroTestResult.warnings.length > 0 && (
                <div className="text-[11px] text-amber-600 dark:text-amber-400 space-y-0.5">
                  {kiroTestResult.warnings.map((w, i) => (
                    <div key={i} className="break-all">⚠ {w}</div>
                  ))}
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* 添加代理 */}
      <Card className="hover-lift">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Plus className="h-4 w-4 text-primary" />
            {isEn ? 'Add Proxies' : '添加代理'}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* 单个添加 */}
          <div className="flex gap-2">
            <Input
              value={singleInput}
              onChange={(e) => setSingleInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleAddSingle()}
              placeholder={isEn
                ? 'http://user:pass@host:port or socks5://... or hy2://auth@host:443/?sni=.. or vless://uuid@host:443?type=ws&security=tls&sni=..'
                : 'http://user:pass@host:port 或 socks5://... 或 hy2://auth@host:443/?sni=.. 或 vless://uuid@host:443?type=ws&security=tls&sni=..'
              }
              className="font-mono text-xs"
            />
            <Button onClick={handleAddSingle} disabled={!singleInput.trim()}>
              <Plus className="h-4 w-4 mr-1" />
              {isEn ? 'Add' : '添加'}
            </Button>
            <Button variant="outline" onClick={() => setBulkOpen(!bulkOpen)}>
              <Upload className="h-4 w-4 mr-1" />
              {isEn ? 'Bulk' : '批量'}
            </Button>
          </div>

          {/* 批量导入 */}
          {bulkOpen && (
            <div className="space-y-2 p-3 bg-muted/30 rounded-lg border border-dashed">
              <Label className="text-xs">
                {isEn
                  ? 'One proxy per line. Supports: http(s)://, socks5://, hy2://auth@host:443/?sni=.., vless://uuid@host:443?type=ws&security=tls&sni=..'
                  : '每行一个代理。支持格式: http(s)://、socks5://、hy2://auth@host:443/?sni=..、vless://uuid@host:443?type=ws&security=tls&sni=..'
                }
              </Label>
              <textarea
                value={bulkInput}
                onChange={(e) => setBulkInput(e.target.value)}
                rows={5}
                className="w-full px-3 py-2 bg-background border rounded-lg text-xs font-mono resize-none"
                placeholder={'http://127.0.0.1:7890\nuser:pass@1.2.3.4:8080\nsocks5://example.com:1080\nhy2://auth@hy2.example.com:443/?sni=cdn.example.com&insecure=1'}
              />
              <div className="flex gap-2 justify-end">
                <Button variant="ghost" size="sm" onClick={() => { setBulkInput(''); setBulkOpen(false) }}>
                  {isEn ? 'Cancel' : '取消'}
                </Button>
                <Button size="sm" onClick={handleImport} disabled={!bulkInput.trim()}>
                  <FileText className="h-4 w-4 mr-1" />
                  {isEn ? 'Import' : '导入'}
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 统计 + 工具栏 */}
      <Card>
        <CardContent className="py-3 space-y-3">
          <div className="flex items-center gap-4 text-sm flex-wrap">
            <span className="text-muted-foreground">
              {isEn ? 'Total:' : '总计：'} <strong className="text-foreground">{stats.total}</strong>
            </span>
            <Badge variant="outline" className="text-green-600 border-green-200 bg-green-50 dark:bg-green-950/30">
              {isEn ? 'Alive' : '可用'}: {stats.alive}
            </Badge>
            <Badge variant="outline" className="text-amber-600 border-amber-200 bg-amber-50 dark:bg-amber-950/30">
              {isEn ? 'Slow' : '较慢'}: {stats.slow}
            </Badge>
            <Badge variant="outline" className="text-red-600 border-red-200 bg-red-50 dark:bg-red-950/30">
              {isEn ? 'Dead' : '失效'}: {stats.dead}
            </Badge>
            <Badge variant="outline" className="text-muted-foreground">
              {isEn ? 'Untested' : '未测试'}: {stats.untested}
            </Badge>
            <span className="ml-auto text-xs text-muted-foreground">
              {isEn ? `${stats.enabled} enabled` : `${stats.enabled} 已启用`}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
              placeholder={isEn ? 'Search any field (host/port/protocol/user/email/label/url)...' : '搜索任意字段（host/端口/协议/user/邮箱/备注/URL）...'}
              className="h-8 max-w-md text-xs"
            />
            <select
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value as 'all' | ProxyEntry['status'])}
              className="h-8 px-2 rounded-md border bg-background text-xs"
            >
              <option value="all">{isEn ? 'All Status' : '全部状态'}</option>
              <option value="alive">{isEn ? 'Alive' : '可用'}</option>
              <option value="slow">{isEn ? 'Slow' : '较慢'}</option>
              <option value="dead">{isEn ? 'Dead' : '失效'}</option>
              <option value="untested">{isEn ? 'Untested' : '未测试'}</option>
            </select>

            <Button
              size="sm"
              variant={advancedSearchOpen || activeAdvancedFilterCount > 0 ? 'default' : 'outline'}
              className="h-8"
              onClick={() => setAdvancedSearchOpen(!advancedSearchOpen)}
            >
              {isEn ? 'Advanced' : '高级'}
              {activeAdvancedFilterCount > 0 && (
                <span className="ml-1.5 px-1.5 py-0.5 rounded-full bg-background/30 text-[10px]">
                  {activeAdvancedFilterCount}
                </span>
              )}
            </Button>

            {(filterText || filterStatus !== 'all' || activeAdvancedFilterCount > 0) && (
              <Button
                size="sm"
                variant="ghost"
                className="h-8 text-xs"
                onClick={() => {
                  setFilterText('')
                  setFilterStatus('all')
                  clearAdvancedFilters()
                }}
              >
                {isEn ? 'Clear' : '清空'}
              </Button>
            )}

            <div className="w-px h-6 bg-border" />

            <Button
              size="sm"
              variant="outline"
              onClick={handleValidateAll}
              disabled={isValidatingAll || filtered.length === 0}
            >
              {isValidatingAll
                ? <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                : <RefreshCw className="h-4 w-4 mr-1" />
              }
              {isEn ? `Test All (${filtered.length})` : `全部测试 (${filtered.length})`}
            </Button>

            {selectedIds.size > 0 && (
              <>
                <Button size="sm" variant="outline" onClick={handleValidateSelected}>
                  <RefreshCw className="h-4 w-4 mr-1" />
                  {isEn ? `Test Selected (${selectedIds.size})` : `测试选中 (${selectedIds.size})`}
                </Button>
                <Button size="sm" variant="outline" className="text-destructive" onClick={handleDeleteSelected}>
                  <Trash2 className="h-4 w-4 mr-1" />
                  {isEn ? `Delete (${selectedIds.size})` : `删除 (${selectedIds.size})`}
                </Button>
              </>
            )}

            <Button size="sm" variant="ghost" onClick={handleRemoveDead} disabled={stats.dead === 0}>
              <XCircle className="h-4 w-4 mr-1" />
              {isEn ? 'Remove Dead' : '移除失效'}
            </Button>

            <Button
              size="sm"
              variant="ghost"
              className="text-destructive ml-auto"
              onClick={() => {
                if (proxies.length === 0) return
                if (confirm(isEn ? 'Clear all proxies?' : '确定清空所有代理？')) clearProxyPool()
              }}
              disabled={proxies.length === 0}
            >
              <Trash2 className="h-4 w-4 mr-1" />
              {isEn ? 'Clear All' : '清空'}
            </Button>

            <div className="flex items-center gap-1 text-xs">
              <span className="text-muted-foreground">{isEn ? 'Concurrency:' : '并发:'}</span>
              <Input
                type="number" min={1} max={50}
                value={testConcurrency}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10)
                  if (!isNaN(v) && v >= 1) setTestConcurrency(v)
                }}
                className="h-7 w-14 text-xs text-center"
              />
            </div>
          </div>

          {/* 高级搜索折叠面板：协议 / 启用 / 延迟 / 最后验证 */}
          {advancedSearchOpen && (
            <div className="flex flex-wrap items-center gap-2 p-3 rounded-md border bg-muted/30 mt-2">
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-muted-foreground">{isEn ? 'Protocol:' : '协议:'}</span>
                <select
                  value={filterProtocol}
                  onChange={(e) => setFilterProtocol(e.target.value as 'all' | ProxyEntry['protocol'])}
                  className="h-7 px-2 rounded-md border bg-background text-xs"
                >
                  <option value="all">{isEn ? 'All' : '全部'}</option>
                  <option value="http">HTTP</option>
                  <option value="https">HTTPS</option>
                  <option value="socks5">SOCKS5</option>
                  <option value="socks4">SOCKS4</option>
                  <option value="hy2">HY2</option>
                  <option value="vless">VLESS</option>
                </select>
              </div>

              <div className="flex items-center gap-1.5">
                <span className="text-xs text-muted-foreground">{isEn ? 'Enabled:' : '启用:'}</span>
                <select
                  value={filterEnabled}
                  onChange={(e) => setFilterEnabled(e.target.value as 'all' | 'enabled' | 'disabled')}
                  className="h-7 px-2 rounded-md border bg-background text-xs"
                >
                  <option value="all">{isEn ? 'All' : '全部'}</option>
                  <option value="enabled">{isEn ? 'Enabled' : '已启用'}</option>
                  <option value="disabled">{isEn ? 'Disabled' : '已停用'}</option>
                </select>
              </div>

              <div className="flex items-center gap-1.5">
                <span className="text-xs text-muted-foreground">{isEn ? 'Latency:' : '延迟:'}</span>
                <select
                  value={filterLatency}
                  onChange={(e) => setFilterLatency(e.target.value as 'all' | 'fast' | 'medium' | 'slow' | 'unknown')}
                  className="h-7 px-2 rounded-md border bg-background text-xs"
                >
                  <option value="all">{isEn ? 'All' : '全部'}</option>
                  <option value="fast">{isEn ? '< 200ms (Fast)' : '< 200ms（快）'}</option>
                  <option value="medium">{isEn ? '200-1000ms' : '200-1000ms'}</option>
                  <option value="slow">{isEn ? '> 1000ms (Slow)' : '> 1000ms（慢）'}</option>
                  <option value="unknown">{isEn ? 'Unknown' : '未知'}</option>
                </select>
              </div>

              <div className="flex items-center gap-1.5">
                <span className="text-xs text-muted-foreground">{isEn ? 'Tested:' : '验证于:'}</span>
                <select
                  value={filterTestedWithin}
                  onChange={(e) => setFilterTestedWithin(e.target.value as 'all' | '1h' | '1d' | '7d' | 'never')}
                  className="h-7 px-2 rounded-md border bg-background text-xs"
                >
                  <option value="all">{isEn ? 'Any time' : '任意时间'}</option>
                  <option value="1h">{isEn ? 'Last 1h' : '最近 1 小时'}</option>
                  <option value="1d">{isEn ? 'Last 1 day' : '最近 1 天'}</option>
                  <option value="7d">{isEn ? 'Last 7 days' : '最近 7 天'}</option>
                  <option value="never">{isEn ? 'Never tested' : '从未测试'}</option>
                </select>
              </div>

              {activeAdvancedFilterCount > 0 && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 ml-auto text-xs"
                  onClick={clearAdvancedFilters}
                >
                  {isEn ? 'Reset' : '重置'}
                </Button>
              )}

              <div className="w-full text-[10px] text-muted-foreground mt-1">
                {isEn
                  ? `Matched ${filtered.length} of ${proxies.length}`
                  : `匹配 ${filtered.length} / ${proxies.length}`}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 账号-代理 N:1 绑定分桶 */}
      <Card className="hover-lift">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Link2 className="h-4 w-4 text-primary" />
            {isEn ? 'Account-to-IP Bucketing' : '账号绑定代理 IP'}
            <span className="text-[10px] font-normal text-muted-foreground">
              {isEn
                ? '— Limit accounts per IP to avoid risk-control association'
                : '— 限制每 IP 账号数，避免被风控关联'
              }
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* 统计 */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
            <div className="p-2 bg-muted/30 rounded">
              <div className="text-[10px] text-muted-foreground">{isEn ? 'Active Accounts' : '可用账号'}</div>
              <div className="text-lg font-bold">{bindingStats.totalActive}</div>
            </div>
            <div className="p-2 bg-green-50 dark:bg-green-950/20 rounded">
              <div className="text-[10px] text-muted-foreground">{isEn ? 'Bound' : '已绑定'}</div>
              <div className="text-lg font-bold text-green-600">{bindingStats.boundCount}</div>
            </div>
            <div className="p-2 bg-amber-50 dark:bg-amber-950/20 rounded">
              <div className="text-[10px] text-muted-foreground">{isEn ? 'Unbound' : '未绑定'}</div>
              <div className="text-lg font-bold text-amber-600">{bindingStats.unboundCount}</div>
            </div>
            <div className="p-2 bg-cyan-50 dark:bg-cyan-950/20 rounded">
              <div className="text-[10px] text-muted-foreground">{isEn ? 'Alive Proxies' : '可用代理'}</div>
              <div className="text-lg font-bold text-cyan-600">{bindingStats.aliveProxyCount}</div>
            </div>
          </div>

          {/* 风险提示 */}
          {bindingStats.overloadedProxies.length > 0 && (
            <div className="p-2 bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-800 rounded text-xs">
              <div className="flex items-center gap-1.5 font-medium text-red-700 dark:text-red-300">
                <XCircle className="h-3.5 w-3.5" />
                {isEn ? 'Risk: Overloaded proxies' : '风险：超载代理'}
              </div>
              <p className="text-muted-foreground mt-1">
                {isEn
                  ? `${bindingStats.overloadedProxies.length} proxy/proxies are carrying more than 10 accounts. Consider re-distributing.`
                  : `${bindingStats.overloadedProxies.length} 个代理承载了超过 10 个账号，建议重新分配。`
                }
              </p>
            </div>
          )}

          {/* 自动分配 */}
          <div className="flex items-center gap-3 flex-wrap p-3 bg-muted/20 rounded-lg border border-dashed">
            <div className="flex items-center gap-2">
              <Shuffle className="h-4 w-4 text-primary" />
              <Label className="text-sm">{isEn ? 'Accounts per proxy' : '每代理承载'}:</Label>
              <Input
                type="number" min={0} max={50}
                value={accountsPerProxy}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10)
                  if (!isNaN(v) && v >= 0) setAccountsPerProxy(v)
                }}
                className="h-8 w-20 text-xs text-center"
              />
              <span className="text-[10px] text-muted-foreground italic">
                {accountsPerProxy === 0
                  ? (isEn ? '(0 = even split)' : '(0 = 均分)')
                  : (isEn ? `accounts → 1 IP` : '账号 / IP')
                }
              </span>
            </div>
            <Button size="sm" onClick={() => handleAutoDistribute(true)} disabled={bindingStats.unboundCount === 0}>
              <Users className="h-4 w-4 mr-1" />
              {isEn ? `Auto-Bind Unbound (${bindingStats.unboundCount})` : `自动绑定未分配 (${bindingStats.unboundCount})`}
            </Button>
            <Button size="sm" variant="outline" onClick={() => handleAutoDistribute(false)}>
              <RefreshCw className="h-4 w-4 mr-1" />
              {isEn ? 'Re-Distribute All' : '重新分配全部'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive ml-auto"
              onClick={() => {
                if (bindingStats.boundCount === 0) return
                if (confirm(isEn ? `Unbind all ${bindingStats.boundCount} accounts?` : `解绑全部 ${bindingStats.boundCount} 个账号？`)) {
                  clearAccountProxyBindings()
                }
              }}
              disabled={bindingStats.boundCount === 0}
            >
              <Unlink className="h-4 w-4 mr-1" />
              {isEn ? 'Unbind All' : '解绑全部'}
            </Button>
          </div>

          {/* 详细绑定关系（折叠） */}
          <button
            onClick={() => setBindingPanelExpanded(!bindingPanelExpanded)}
            className="text-xs text-primary hover:underline flex items-center gap-1"
          >
            {bindingPanelExpanded
              ? (isEn ? '▼ Hide binding details' : '▼ 隐藏绑定明细')
              : (isEn ? '▶ Show binding details' : '▶ 显示绑定明细')
            }
          </button>

          {bindingPanelExpanded && (
            <div className="space-y-2 max-h-64 overflow-y-auto border rounded-lg">
              {proxies.filter((p) => p.enabled && p.status !== 'dead').map((p) => {
                const boundAccountIds = Object.entries(accountProxyBindings)
                  .filter(([, pid]) => pid === p.id)
                  .map(([aid]) => aid)
                if (boundAccountIds.length === 0) return null
                return (
                  <div key={p.id} className="p-2 border-b last:border-b-0">
                    <div className="flex items-center justify-between gap-2 text-xs mb-1">
                      <span className="font-mono truncate" title={p.url}>
                        {p.host}:{p.port}
                        {p.label && <Badge variant="outline" className="ml-1.5 h-4 text-[9px]">{p.label}</Badge>}
                      </span>
                      <Badge variant="outline" className="text-[10px]">
                        {boundAccountIds.length} {isEn ? 'accounts' : '账号'}
                      </Badge>
                    </div>
                    <div className="flex flex-wrap gap-1 pl-2">
                      {boundAccountIds.map((aid) => {
                        const acc = accounts.get(aid)
                        return (
                          <span
                            key={aid}
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-muted text-[10px] hover:bg-destructive/10 transition-colors group"
                          >
                            <span title={acc?.email}>{(acc?.email || aid.slice(0, 8))}</span>
                            <button
                              onClick={() => unbindAccountFromProxy(aid)}
                              className="opacity-30 group-hover:opacity-100 text-destructive"
                              title={isEn ? 'Unbind' : '解绑'}
                            >
                              <XCircle className="h-2.5 w-2.5" />
                            </button>
                          </span>
                        )
                      })}
                    </div>
                  </div>
                )
              })}
              {bindingStats.unboundCount > 0 && (
                <div className="p-2 bg-amber-50 dark:bg-amber-950/10 text-xs">
                  <span className="text-amber-700 dark:text-amber-300">
                    {isEn ? `${bindingStats.unboundCount} accounts have no proxy binding (will use global proxy / direct).` : `${bindingStats.unboundCount} 个账号未绑定代理（将走全局代理 / 直连）`}
                  </span>
                </div>
              )}
              {bindingStats.boundCount === 0 && (
                <div className="p-4 text-center text-xs text-muted-foreground">
                  {isEn ? 'No bindings yet. Click "Auto-Bind" above to start.' : '尚无绑定。点击上方"自动绑定"开始。'}
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* 代理列表 */}
      {filtered.length > 0 ? (
        <Card>
          <CardContent className="py-0 px-0">
            {/* 表头 */}
            <div className="flex items-center gap-3 py-2 px-3 border-b text-xs font-medium text-muted-foreground bg-muted/30">
              <button onClick={toggleSelectAll} className="flex-shrink-0">
                <input
                  type="checkbox"
                  readOnly
                  checked={selectedIds.size === filtered.length && filtered.length > 0}
                  className="cursor-pointer"
                />
              </button>
              <span className="w-12 text-center">{isEn ? 'On' : '启用'}</span>
              <span className="flex-1">URL</span>
              <span className="w-24 text-center">{isEn ? 'Status' : '状态'}</span>
              <span className="w-20 text-center">{isEn ? 'Used' : '使用'}</span>
              <span className="w-20 text-center">{isEn ? 'Failed' : '失败'}</span>
              <span className="w-32 text-center">{isEn ? 'External IP / Email' : '出口 IP / 邮箱'}</span>
              <span className="w-24 text-center">{isEn ? 'Actions' : '操作'}</span>
            </div>

            <ProxyVirtualList
              filtered={filtered}
              selectedIds={selectedIds}
              onSelect={toggleSelect}
              onToggle={toggleProxyEnabled}
              onTest={validateProxy}
              onDelete={removeProxy}
              onSaveLabel={(id, label) => updateProxy(id, { label })}
              isEn={isEn}
            />
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            <Globe className="h-12 w-12 mx-auto mb-3 opacity-30" />
            <p className="text-sm">
              {proxies.length === 0
                ? (isEn ? 'No proxies yet. Add some to begin.' : '暂无代理。先添加一些代理。')
                : (isEn ? 'No proxies match the current filter.' : '当前筛选无匹配代理。')
              }
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

interface ProxyRowProps {
  proxy: ProxyEntry
  selected: boolean
  onSelect: () => void
  onToggle: () => void
  onTest: () => Promise<unknown>
  onDelete: () => void
  onSaveLabel: (label?: string) => void
  isEn: boolean
}

function ProxyRow({ proxy, selected, onSelect, onToggle, onTest, onDelete, onSaveLabel, isEn }: ProxyRowProps): React.ReactNode {
  // 脱敏密码部分
  const displayUrl = useMemo(() => {
    if (!proxy.password) return proxy.url
    return proxy.url.replace(/:([^:@\/]+)@/, ':***@')
  }, [proxy.url, proxy.password])

  const handleCopy = (): void => {
    void navigator.clipboard.writeText(proxy.url)
  }

  // 备注 inline 编辑：点击铅笔/徽章进入编辑，回车/失焦保存，ESC 取消
  const [editingLabel, setEditingLabel] = useState(false)
  const [labelDraft, setLabelDraft] = useState(proxy.label || '')
  const startEditLabel = (): void => {
    setLabelDraft(proxy.label || '')
    setEditingLabel(true)
  }
  const saveLabel = (): void => {
    const v = labelDraft.trim()
    if (v !== (proxy.label || '')) onSaveLabel(v || undefined)
    setEditingLabel(false)
  }

  return (
    <div className={cn(
      'flex items-center gap-3 py-2 px-3 border-b last:border-b-0 hover:bg-muted/40 text-xs transition-colors',
      selected && 'bg-primary/5',
      !proxy.enabled && 'opacity-60'
    )}>
      <input type="checkbox" checked={selected} onChange={onSelect} className="flex-shrink-0 cursor-pointer" />
      <button
        onClick={onToggle}
        className="w-12 flex justify-center text-muted-foreground hover:text-foreground"
        title={isEn ? (proxy.enabled ? 'Disable' : 'Enable') : (proxy.enabled ? '停用' : '启用')}
      >
        {proxy.enabled
          ? <Power className="h-4 w-4 text-green-500" />
          : <PowerOff className="h-4 w-4" />
        }
      </button>
      <span className="flex-1 font-mono truncate flex items-center min-w-0" title={displayUrl}>
        <span className="opacity-50 mr-1 flex-shrink-0">{proxy.protocol}://</span>
        <span className="truncate">{proxy.host}:{proxy.port}{proxy.username && <span className="opacity-50 ml-1">@{proxy.username}</span>}</span>
        {editingLabel ? (
          <input
            autoFocus
            value={labelDraft}
            onChange={(e) => setLabelDraft(e.target.value)}
            onBlur={saveLabel}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') saveLabel()
              else if (e.key === 'Escape') { setLabelDraft(proxy.label || ''); setEditingLabel(false) }
            }}
            placeholder={isEn ? 'Note' : '备注'}
            className="ml-2 px-1.5 h-5 text-[10px] rounded border border-primary bg-background font-sans w-28 flex-shrink-0 focus:outline-none focus:ring-1 focus:ring-primary"
          />
        ) : proxy.label ? (
          <Badge
            variant="outline"
            className="ml-2 h-4 text-[9px] cursor-pointer hover:bg-muted flex-shrink-0"
            onClick={startEditLabel}
            title={isEn ? 'Click to edit note' : '点击编辑备注'}
          >
            {proxy.label}
          </Badge>
        ) : null}
      </span>
      <span className="w-24 flex justify-center">
        <StatusBadge status={proxy.status} latency={proxy.latencyMs} />
      </span>
      <span className="w-20 text-center font-mono tabular-nums">{proxy.usedCount}</span>
      <span className={cn('w-20 text-center font-mono tabular-nums', proxy.failCount > 0 && 'text-amber-600')}>
        {proxy.failCount}
      </span>
      <span className="w-32 text-center text-[10px] truncate" title={proxy.lastBoundEmail}>
        {proxy.lastBoundEmail
          ? <span className="text-muted-foreground">{proxy.lastBoundEmail}</span>
          : (proxy.lastTestedAt
            ? <span className="text-muted-foreground inline-flex items-center gap-0.5">
                <Clock className="h-2.5 w-2.5" />
                {Math.round((Date.now() - proxy.lastTestedAt) / 60000)}m
              </span>
            : <span className="opacity-40">-</span>
          )
        }
      </span>
      <span className="w-24 flex justify-center gap-1">
        <button
          onClick={() => void onTest()}
          disabled={proxy.status === 'testing'}
          className="p-1 rounded hover:bg-muted"
          title={isEn ? 'Test' : '测试'}
        >
          {proxy.status === 'testing'
            ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
            : <RefreshCw className="h-3.5 w-3.5" />
          }
        </button>
        <button
          onClick={startEditLabel}
          className="p-1 rounded hover:bg-muted"
          title={isEn ? 'Edit note' : '编辑备注'}
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
        <button onClick={handleCopy} className="p-1 rounded hover:bg-muted" title={isEn ? 'Copy URL' : '复制 URL'}>
          <Copy className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={onDelete}
          className="p-1 rounded hover:bg-destructive/10 text-destructive"
          title={isEn ? 'Delete' : '删除'}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </span>
    </div>
  )
}

/**
 * 代理列表虚拟化渲染（处理几百到几千个代理时避免卡顿）
 * 行高约 44px（含 padding 和 border）
 */
interface ProxyVirtualListProps {
  filtered: ProxyEntry[]
  selectedIds: Set<string>
  onSelect: (id: string) => void
  onToggle: (id: string) => void
  onTest: (id: string) => Promise<unknown>
  onDelete: (id: string) => void
  onSaveLabel: (id: string, label?: string) => void
  isEn: boolean
}

function ProxyVirtualList({ filtered, selectedIds, onSelect, onToggle, onTest, onDelete, onSaveLabel, isEn }: ProxyVirtualListProps): React.ReactNode {
  const parentRef = useRef<HTMLDivElement>(null)
  const ROW_HEIGHT = 44

  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10
  })

  // 行数较少（< 50）时不虚拟，直接渲染避免虚拟列表布局开销
  if (filtered.length < 50) {
    return (
      <div ref={parentRef} className="max-h-[60vh] overflow-y-auto">
        {filtered.map((p) => (
          <ProxyRow
            key={p.id}
            proxy={p}
            selected={selectedIds.has(p.id)}
            onSelect={() => onSelect(p.id)}
            onToggle={() => onToggle(p.id)}
            onTest={() => onTest(p.id)}
            onDelete={() => onDelete(p.id)}
            onSaveLabel={(label) => onSaveLabel(p.id, label)}
            isEn={isEn}
          />
        ))}
      </div>
    )
  }

  const items = virtualizer.getVirtualItems()
  return (
    <div ref={parentRef} className="max-h-[60vh] overflow-y-auto" style={{ contain: 'strict' }}>
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
        {items.map((virtualRow) => {
          const p = filtered[virtualRow.index]
          if (!p) return null
          return (
            <div
              key={virtualRow.key}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${virtualRow.start}px)`
              }}
            >
              <ProxyRow
                proxy={p}
                selected={selectedIds.has(p.id)}
                onSelect={() => onSelect(p.id)}
                onToggle={() => onToggle(p.id)}
                onTest={() => onTest(p.id)}
                onDelete={() => onDelete(p.id)}
                onSaveLabel={(label) => onSaveLabel(p.id, label)}
                isEn={isEn}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}
