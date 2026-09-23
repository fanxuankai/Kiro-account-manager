import { useState, useCallback, useMemo, useRef, useEffect } from 'react'
import {
  Stethoscope, CheckCircle2, XCircle, Loader2, Play, AlertTriangle,
  Globe, Network, Mail, Activity, Download, MessageSquare, Zap, Square,
  RefreshCw, Trash2, Flag, RotateCcw
} from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { useAccountsStore } from '@/store/accounts'
import { Card, CardContent, CardHeader, CardTitle, Button, Badge, Label, Input } from '../ui'
import { cn } from '@/lib/utils'

/** 账号测活：常用模型候选（可在输入框自定义其它模型 ID） */
const LIVENESS_MODELS = [
  'claude-sonnet-4.5',
  'claude-sonnet-4',
  'claude-haiku-4.5',
  'claude-opus-4.5',
  'claude-3.7-sonnet',
  'auto'
]

interface LivenessResult {
  success: boolean
  latencyMs: number
  model?: string
  content?: string
  usage?: { inputTokens: number; outputTokens: number; credits: number }
  error?: string
}

/** 脱敏代理 URL（隐藏密码） */
function maskProxyUrl(url: string): string {
  return url.replace(/:([^:@/]+)@/, ':***@')
}

/** 双语文本 */
interface BiText { en: string; zh: string }

interface DiagnoseTarget {
  id: string
  label: BiText
  url: string
  category: 'network' | 'kiro' | 'email' | 'proxy' | 'custom'
  description: BiText
  expectStatus?: number[]
}

const DEFAULT_TARGETS: DiagnoseTarget[] = [
  // 网络连通
  {
    id: 'public-ip', label: { en: 'Public connectivity', zh: '公网连通性' }, url: 'https://api.ipify.org?format=json',
    category: 'network', description: { en: 'Check basic internet access', zh: '检测能否访问互联网（基础连通性）' }
  },
  {
    id: 'cloudflare', label: { en: 'Cloudflare', zh: 'Cloudflare' }, url: 'https://1.1.1.1',
    category: 'network', description: { en: 'Check international network reachability', zh: '检测国际网络是否通畅' }
  },
  // Kiro / AWS
  {
    id: 'kiro-auth', label: { en: 'Kiro Auth Endpoint', zh: 'Kiro Auth Endpoint' },
    url: 'https://prod.us-east-1.auth.desktop.kiro.dev/.well-known/openid-configuration',
    category: 'kiro', description: { en: 'Social login token refresh endpoint', zh: '社交登录 Token 刷新端点' },
    expectStatus: [200, 401, 403, 404]
  },
  {
    id: 'kiro-oidc', label: { en: 'AWS OIDC', zh: 'AWS OIDC' },
    url: 'https://oidc.us-east-1.amazonaws.com/',
    category: 'kiro', description: { en: 'OIDC registration endpoint', zh: 'OIDC 注册端点' },
    expectStatus: [200, 400, 403, 405]
  },
  {
    id: 'kiro-codewhisperer', label: { en: 'CodeWhisperer API', zh: 'CodeWhisperer API' },
    url: 'https://q.us-east-1.amazonaws.com/',
    category: 'kiro', description: { en: 'Kiro main API endpoint (q.amazonaws.com)', zh: 'Kiro 主 API 端点（q.amazonaws.com）' },
    expectStatus: [200, 400, 403, 405]
  },
  {
    id: 'aws-signin', label: { en: 'AWS SignIn', zh: 'AWS SignIn' },
    url: 'https://us-east-1.signin.aws/',
    category: 'kiro', description: { en: 'Required endpoint for the signup flow', zh: '注册流程必经端点' },
    expectStatus: [200, 400, 403]
  },
  // Email Services
  {
    id: 'tempmail-plus', label: { en: 'TempMail.Plus API', zh: 'TempMail.Plus API' },
    url: 'https://tempmail.plus/api/mails?email=test@mailto.plus',
    category: 'email', description: { en: 'TempMail.Plus mailbox service', zh: 'TempMail.Plus 邮箱服务' },
    expectStatus: [200, 400, 401, 403]
  },
  {
    id: 'outlook-login', label: { en: 'Outlook Login', zh: 'Outlook Login' },
    url: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token',
    category: 'email', description: { en: 'Outlook token refresh endpoint', zh: 'Outlook Token 刷新端点' },
    expectStatus: [200, 400, 405]
  }
]

const CATEGORIES = [
  { id: 'network', label: { en: 'Network', zh: '网络' }, icon: Globe, color: 'text-blue-500' },
  { id: 'kiro', label: { en: 'Kiro / AWS', zh: 'Kiro / AWS' }, icon: Activity, color: 'text-purple-500' },
  { id: 'email', label: { en: 'Email', zh: '邮箱服务' }, icon: Mail, color: 'text-amber-500' },
  { id: 'proxy', label: { en: 'Proxy', zh: '代理' }, icon: Network, color: 'text-cyan-500' },
  { id: 'custom', label: { en: 'Custom', zh: '自定义' }, icon: Activity, color: 'text-emerald-500' }
] as const

type DiagnoseResult = { id: string; success: boolean; httpStatus?: number; latencyMs?: number; error?: string }

export function DiagnosePage(): React.ReactNode {
  const { t } = useTranslation()
  const isEn = t('common.unknown') === 'Unknown'
  const pick = (x: BiText): string => (isEn ? x.en : x.zh)
  const { proxyPool, proxyPoolConfig, accounts, selectedIds, getAccountProxyUrl, updateAccount, removeAccounts } = useAccountsStore()

  // ============ 账号测活状态 ============
  const accountList = useMemo(() => Array.from(accounts.values()), [accounts])
  // 账户管理页多选的账号（用于"批量测活选中"）
  const selectedAccounts = useMemo(
    () => Array.from(selectedIds).map((id) => accounts.get(id)).filter((a): a is NonNullable<typeof a> => !!a),
    [selectedIds, accounts]
  )
  // 若从账户页带着选中账号进入，自动默认"选中账号"批量模式
  const [livenessMode, setLivenessMode] = useState<'single' | 'selected'>(
    () => (useAccountsStore.getState().selectedIds.size > 0 ? 'selected' : 'single')
  )
  const [livenessAccountId, setLivenessAccountId] = useState<string>('')
  // 模型选择持久化：从 localStorage 恢复上次选择
  const [livenessModel, setLivenessModel] = useState<string>(() => {
    try { return localStorage.getItem('kiro-liveness-model') || LIVENESS_MODELS[0] } catch { return LIVENESS_MODELS[0] }
  })
  const [livenessMessage, setLivenessMessage] = useState<string>('Hi, reply with "pong" only.')
  const [livenessRunning, setLivenessRunning] = useState(false)
  const [livenessResult, setLivenessResult] = useState<LivenessResult | null>(null)
  // 批量测活结果：accountId -> 结果（undefined 表示进行中）
  const [livenessBatch, setLivenessBatch] = useState<Map<string, LivenessResult | null>>(new Map())
  const [livenessConcurrency] = useState(3)
  // 中止标志：停止按钮 / 组件卸载时置 true，让 worker 立即停止（避免切页后继续消耗账号 credits）
  const livenessAbort = useRef(false)

  // 本地缓存的真实模型列表（来自代理缓存 / Kiro 可用模型；持久化到 localStorage，离线/代理未启时也能用上次结果）
  const [cachedModels, setCachedModels] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem('kiro-liveness-models-cache')
      if (raw) {
        const arr = JSON.parse(raw)
        if (Array.isArray(arr)) return arr.filter((x): x is string => typeof x === 'string')
      }
    } catch { /* ignore */ }
    return []
  })
  const [modelsLoading, setModelsLoading] = useState(false)
  // datalist 选项 = 缓存的真实模型 ∪ 内置常用候选（去重，缓存优先）
  const modelOptions = useMemo(() => Array.from(new Set([...cachedModels, ...LIVENESS_MODELS])), [cachedModels])

  // 模型选择持久化
  useEffect(() => {
    try { localStorage.setItem('kiro-liveness-model', livenessModel) } catch { /* ignore */ }
  }, [livenessModel])

  /** 拉取真实可用模型并缓存：优先代理缓存模型，回退 Kiro 可用模型；失败保留上次缓存 */
  const loadModels = useCallback(async (): Promise<void> => {
    setModelsLoading(true)
    try {
      let models: string[] = []
      try {
        const r = await window.api.proxyGetModels()
        if (r.success && r.models?.length) models = r.models.map((m) => m.id)
      } catch { /* 代理未启动则忽略，走下面回退 */ }
      if (models.length === 0) {
        try {
          const r = await window.api.getKiroAvailableModels()
          if (r.models?.length) models = r.models.map((m) => m.id)
        } catch { /* 无 active 账号则忽略 */ }
      }
      if (models.length > 0) {
        setCachedModels(models)
        try { localStorage.setItem('kiro-liveness-models-cache', JSON.stringify(models)) } catch { /* ignore */ }
      }
    } finally {
      setModelsLoading(false)
    }
  }, [])

  // 进入页面后台刷新一次模型列表（成功则更新缓存，失败则保留上次）
  useEffect(() => { void loadModels() }, [loadModels])

  // 组件卸载时中止所有进行中的批量测活，防止后台继续调用 Kiro API 浪费额度
  useEffect(() => {
    return () => { livenessAbort.current = true }
  }, [])

  /** 对单个账号执行测活（复用 IPC） */
  const testOneAccount = useCallback(async (account: typeof accountList[number]): Promise<LivenessResult> => {
    const cred = account.credentials
    try {
      return await window.api.diagnoseAccountLiveness({
        account: {
          id: account.id,
          email: account.email,
          accessToken: cred.accessToken,
          refreshToken: cred.refreshToken,
          clientId: cred.clientId,
          clientSecret: cred.clientSecret,
          region: cred.region,
          authMethod: cred.authMethod,
          provider: cred.provider,
          profileArn: account.profileArn,
          machineId: account.machineId,
          expiresAt: cred.expiresAt,
          proxyUrl: getAccountProxyUrl(account.id)
        },
        model: livenessModel.trim(),
        message: livenessMessage.trim() || undefined
      })
    } catch (err) {
      return { success: false, latencyMs: 0, error: err instanceof Error ? err.message : String(err) }
    }
  }, [livenessModel, livenessMessage, getAccountProxyUrl])

  const runLiveness = useCallback(async (): Promise<void> => {
    const account = accounts.get(livenessAccountId)
    if (!account) return
    livenessAbort.current = false
    setLivenessRunning(true)
    setLivenessResult(null)
    const res = await testOneAccount(account)
    if (livenessAbort.current) return  // 组件已卸载，不再 setState
    setLivenessResult(res)
    setLivenessRunning(false)
  }, [accounts, livenessAccountId, testOneAccount])

  /** 批量测活选中账号（并发受限，可中止） */
  const runLivenessBatch = useCallback(async (): Promise<void> => {
    if (selectedAccounts.length === 0) return
    livenessAbort.current = false
    setLivenessRunning(true)
    // 初始化所有为"进行中"(null)
    const init = new Map<string, LivenessResult | null>()
    for (const a of selectedAccounts) init.set(a.id, null)
    setLivenessBatch(new Map(init))

    const queue = [...selectedAccounts]
    const worker = async (): Promise<void> => {
      for (;;) {
        if (livenessAbort.current) break  // 停止/卸载 → 不再取新账号测试
        const acc = queue.shift()
        if (!acc) break
        const res = await testOneAccount(acc)
        if (livenessAbort.current) break  // 测完发现已中止 → 不再 setState（组件可能已卸载）
        setLivenessBatch((prev) => {
          const next = new Map(prev)
          next.set(acc.id, res)
          return next
        })
      }
    }
    const workers = Array.from({ length: Math.min(livenessConcurrency, selectedAccounts.length) }, () => worker())
    await Promise.all(workers)
    if (!livenessAbort.current) setLivenessRunning(false)
  }, [selectedAccounts, testOneAccount, livenessConcurrency])

  /** 停止批量测活 */
  const stopLivenessBatch = useCallback((): void => {
    livenessAbort.current = true
    setLivenessRunning(false)
  }, [])

  /** 单个账号重测（用于批量结果列表里每行的「重测」按钮） */
  const retestOne = useCallback(async (accountId: string): Promise<void> => {
    const account = accounts.get(accountId)
    if (!account) return
    livenessAbort.current = false
    setLivenessBatch((prev) => new Map(prev).set(accountId, null)) // 标记进行中
    const res = await testOneAccount(account)
    if (livenessAbort.current) return
    setLivenessBatch((prev) => new Map(prev).set(accountId, res))
  }, [accounts, testOneAccount])

  /** 当前批量结果里失败的账号（保持 selectedAccounts 顺序） */
  const failedAccountIds = useMemo(() => {
    return selectedAccounts.filter((a) => { const r = livenessBatch.get(a.id); return r && !r.success }).map((a) => a.id)
  }, [selectedAccounts, livenessBatch])

  /** 重测全部失败的账号（并发受限，可中止） */
  const retestFailed = useCallback(async (): Promise<void> => {
    const ids = failedAccountIds
    if (ids.length === 0) return
    livenessAbort.current = false
    setLivenessRunning(true)
    setLivenessBatch((prev) => {
      const next = new Map(prev)
      for (const id of ids) next.set(id, null) // 失败项重置为进行中
      return next
    })
    const queue = ids.map((id) => accounts.get(id)).filter((a): a is NonNullable<typeof a> => !!a)
    const worker = async (): Promise<void> => {
      for (;;) {
        if (livenessAbort.current) break
        const acc = queue.shift()
        if (!acc) break
        const res = await testOneAccount(acc)
        if (livenessAbort.current) break
        setLivenessBatch((prev) => new Map(prev).set(acc.id, res))
      }
    }
    const workers = Array.from({ length: Math.min(livenessConcurrency, queue.length) }, () => worker())
    await Promise.all(workers)
    if (!livenessAbort.current) setLivenessRunning(false)
  }, [failedAccountIds, accounts, testOneAccount, livenessConcurrency])

  /** 一键把失败账号标记为 error 状态（账号管理页会显示红色错误态） */
  const markFailedAsError = useCallback((): void => {
    for (const id of failedAccountIds) {
      const r = livenessBatch.get(id)
      updateAccount(id, { status: 'error', lastError: r?.error || (isEn ? 'Liveness test failed' : '测活失败') })
    }
  }, [failedAccountIds, livenessBatch, updateAccount, isEn])

  /** 一键删除失败账号（带确认） */
  const deleteFailed = useCallback((): void => {
    const ids = failedAccountIds
    if (ids.length === 0) return
    const ok = window.confirm(
      isEn
        ? `Delete ${ids.length} accounts that failed the liveness test? This cannot be undone.`
        : `确定删除 ${ids.length} 个测活失败的账号？此操作不可恢复。`
    )
    if (!ok) return
    removeAccounts(ids)
    setLivenessBatch((prev) => {
      const next = new Map(prev)
      for (const id of ids) next.delete(id)
      return next
    })
  }, [failedAccountIds, removeAccounts, isEn])

  // 批量结果统计
  const batchStats = useMemo(() => {
    let done = 0, ok = 0, fail = 0
    for (const r of livenessBatch.values()) {
      if (r === null) continue
      done++
      if (r.success) ok++
      else fail++
    }
    return { done, ok, fail, total: livenessBatch.size }
  }, [livenessBatch])

  // 自定义探测 URL（替代旧的 MoEmail 字段，可填任意 HTTP/HTTPS 端点做连通性测试）
  // 兼容老配置：先读新 key，找不到则尝试读旧的 MoEmail key 完成迁移
  const [customProbeUrl, setCustomProbeUrl] = useState<string>(() => {
    try {
      const v = localStorage.getItem('kiro-diagnose-probe-url')
      if (v !== null) return v
      // 一次性迁移老数据
      const legacy = localStorage.getItem('kiro-diagnose-moemail') || ''
      if (legacy) {
        try {
          localStorage.setItem('kiro-diagnose-probe-url', legacy)
          localStorage.removeItem('kiro-diagnose-moemail')
        } catch { /* ignore */ }
      }
      return legacy
    } catch { return '' }
  })
  const [useProxy, setUseProxy] = useState<boolean>(false)
  const [selectedProxyId, setSelectedProxyId] = useState<string>('')
  const [isRunning, setIsRunning] = useState(false)
  const [results, setResults] = useState<Record<string, DiagnoseResult>>({})
  const [progress, setProgress] = useState<{ done: number; total: number }>({ done: 0, total: 0 })

  const availableProxies = Array.from(proxyPool.values()).filter((p) => p.enabled && p.status !== 'dead')

  const buildTargets = useCallback((): DiagnoseTarget[] => {
    const list = [...DEFAULT_TARGETS]
    const trimmed = customProbeUrl.trim()
    if (trimmed) {
      // 用户填的 URL 直接作为探测目标，不再追加任何路径
      // 自动补 https:// 前缀（如果用户只填了域名）
      const probeUrl = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
      list.push({
        id: 'custom-probe',
        label: { en: 'Custom Probe URL', zh: '自定义探测 URL' },
        url: probeUrl,
        category: 'custom',
        description: { en: 'User-provided URL for connectivity test', zh: '用户填写的 URL 连通性测试' },
        expectStatus: [200, 201, 204, 301, 302, 400, 401, 403, 404, 405]
      })
    }
    return list
  }, [customProbeUrl, isEn])

  const runDiagnose = useCallback(async (): Promise<void> => {
    const targets = buildTargets()
    setIsRunning(true)
    setResults({})
    setProgress({ done: 0, total: targets.length })

    const proxyUrl = useProxy && selectedProxyId
      ? proxyPool.get(selectedProxyId)?.url
      : undefined

    try {
      // 分批跑，每次 4 个，让结果逐步出现
      const BATCH = 4
      const next: Record<string, DiagnoseResult> = {}
      for (let i = 0; i < targets.length; i += BATCH) {
        const slice = targets.slice(i, i + BATCH)
        const resp = await window.api.diagnoseRun({
          proxyUrl,
          targets: slice.map((tg) => ({ id: tg.id, label: pick(tg.label), url: tg.url, expectStatus: tg.expectStatus }))
        })
        for (const r of resp.results) {
          next[r.id] = r
        }
        setResults({ ...next })
        setProgress({ done: Math.min(i + BATCH, targets.length), total: targets.length })
      }
    } finally {
      setIsRunning(false)
      // 持久化用户填的探测 URL
      try { localStorage.setItem('kiro-diagnose-probe-url', customProbeUrl) } catch { /* ignore */ }
    }
  }, [buildTargets, useProxy, selectedProxyId, proxyPool, customProbeUrl])

  const exportReport = useCallback(() => {
    const targets = buildTargets()
    const lines = [
      isEn ? 'Kiro Account Manager - Diagnostic Report' : 'Kiro Account Manager - 诊断报告',
      `${isEn ? 'Generated' : '生成时间'}: ${new Date().toLocaleString()}`,
      `${isEn ? 'Proxy' : '代理'}: ${useProxy && selectedProxyId ? proxyPool.get(selectedProxyId)?.url : (isEn ? 'Direct' : '直连')}`,
      `------------------------------------`
    ]
    for (const tg of targets) {
      const r = results[tg.id]
      lines.push(`[${pick(tg.label)}]`)
      lines.push(`  URL: ${tg.url}`)
      if (!r) {
        lines.push(`  ${isEn ? 'Status' : '状态'}: ${isEn ? 'Not tested' : '未测试'}`)
      } else {
        lines.push(`  ${isEn ? 'Status' : '状态'}: ${r.success ? (isEn ? '✓ Pass' : '✓ 通过') : (isEn ? '✗ Fail' : '✗ 失败')}`)
        if (r.httpStatus) lines.push(`  HTTP: ${r.httpStatus}`)
        if (r.latencyMs != null) lines.push(`  ${isEn ? 'Latency' : '延迟'}: ${r.latencyMs}ms`)
        if (r.error) lines.push(`  ${isEn ? 'Error' : '错误'}: ${r.error}`)
      }
      lines.push('')
    }
    void navigator.clipboard.writeText(lines.join('\n'))
    alert(isEn ? 'Report copied to clipboard' : '诊断报告已复制到剪贴板')
  }, [buildTargets, results, useProxy, selectedProxyId, proxyPool, isEn])

  const stats = (() => {
    const all = Object.values(results)
    return {
      total: all.length,
      passed: all.filter((r) => r.success).length,
      failed: all.filter((r) => !r.success).length
    }
  })()

  return (
    <div className="flex-1 p-6 space-y-6 overflow-auto">
      {/* Header */}
      <div className="page-hero p-6">
        <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-br from-emerald-500/20 to-transparent rounded-full blur-2xl" />
        <div className="absolute bottom-0 left-0 w-24 h-24 bg-gradient-to-tr from-emerald-500/20 to-transparent rounded-full blur-2xl" />
        <div className="relative flex items-center gap-4">
          <div className="p-3 rounded-xl bg-emerald-500 shadow-lg shadow-emerald-500/25">
            <Stethoscope className="h-6 w-6 text-white" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-emerald-600 dark:text-emerald-400">
              {isEn ? 'Diagnostics' : '一键诊断'}
            </h1>
            <p className="text-muted-foreground">
              {isEn
                ? 'Test network / Kiro API / email service / proxy connectivity in one click.'
                : '一键检测网络、Kiro/AWS API、邮箱服务、代理连通性，快速定位问题'
              }
            </p>
          </div>
        </div>
      </div>

      {/* 配置 */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Activity className="h-4 w-4 text-primary" />
            {isEn ? 'Diagnostic Config' : '诊断配置'}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* 自定义探测 URL */}
          <div className="space-y-1">
            <Label className="text-xs">{isEn ? 'Custom probe URL (optional)' : '自定义探测 URL（可选）'}</Label>
            <Input
              value={customProbeUrl}
              onChange={(e) => setCustomProbeUrl(e.target.value)}
              placeholder={isEn ? 'https://example.com/health' : 'https://example.com/health'}
              disabled={isRunning}
              className="font-mono text-xs"
            />
            <p className="text-[11px] text-muted-foreground">
              {isEn
                ? 'Any HTTP/HTTPS endpoint will be added to the diagnostic list (HEAD request, expecting 2xx/3xx/4xx).'
                : '可填任意 HTTP/HTTPS 地址用于连通性测试（HEAD 请求，2xx/3xx/4xx 都视为通）。'}
            </p>
          </div>

          {/* 代理选项 */}
          <div className="flex items-center gap-3 flex-wrap">
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={useProxy}
                onChange={(e) => setUseProxy(e.target.checked)}
                disabled={isRunning}
              />
              <span>{isEn ? 'Test through proxy' : '通过代理测试'}</span>
            </label>
            {useProxy && (
              availableProxies.length > 0 ? (
                <select
                  value={selectedProxyId}
                  onChange={(e) => setSelectedProxyId(e.target.value)}
                  disabled={isRunning}
                  className="h-8 px-2 rounded-md border bg-background text-xs flex-1 max-w-md"
                >
                  <option value="">-- {isEn ? 'Select a proxy' : '选择一个代理'} --</option>
                  {availableProxies.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.protocol}://{p.host}:{p.port}
                      {p.label ? ` (${p.label})` : ''}
                      {p.status === 'alive' && p.latencyMs ? ` - ${p.latencyMs}ms` : ''}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="text-xs text-muted-foreground italic">
                  {proxyPoolConfig.enabled
                    ? (isEn ? 'No available proxy in pool' : '代理池无可用代理')
                    : (isEn ? 'Proxy pool disabled, configure it in "Proxy Pool" first' : '代理池未启用，请先在「代理池」配置')}
                </span>
              )
            )}
          </div>

          <div className="flex items-center gap-2 pt-2">
            <Button onClick={runDiagnose} disabled={isRunning}>
              {isRunning
                ? <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                : <Play className="h-4 w-4 mr-1" />
              }
              {isRunning
                ? `运行中 ${progress.done}/${progress.total}`
                : (isEn ? 'Run Diagnostics' : '开始诊断')
              }
            </Button>
            {stats.total > 0 && (
              <Button variant="outline" size="sm" onClick={exportReport}>
                <Download className="h-4 w-4 mr-1" />
                {isEn ? 'Copy Report' : '复制报告'}
              </Button>
            )}
            {stats.total > 0 && (
              <div className="ml-auto flex items-center gap-2 text-xs">
                <Badge variant="outline" className="text-green-600 border-green-200">
                  <CheckCircle2 className="h-3 w-3 mr-1" /> {stats.passed}
                </Badge>
                {stats.failed > 0 && (
                  <Badge variant="outline" className="text-red-600 border-red-200">
                    <XCircle className="h-3 w-3 mr-1" /> {stats.failed}
                  </Badge>
                )}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* 账号测活：指定账号走反代逻辑给指定模型发测试消息 */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <MessageSquare className="h-4 w-4 text-emerald-500" />
            {isEn ? 'Account Liveness Test' : '账号测活'}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-[11px] text-muted-foreground">
            {isEn
              ? 'Send a real chat message to the selected model via the reverse-proxy call path (account-bound proxy applies). Verifies the account can actually get a response.'
              : '走反代底层调用给指定模型发一条真实消息（自动应用账号绑定的代理），验证账号能否正常返回。'}
          </p>

          {/* 模式切换：单个账号 / 选中账号批量 */}
          <div className="flex items-center gap-1 p-0.5 bg-muted rounded-md w-fit">
            <button
              type="button"
              onClick={() => setLivenessMode('single')}
              disabled={livenessRunning}
              className={cn(
                'px-3 h-7 rounded text-xs font-medium transition-colors',
                livenessMode === 'single' ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {isEn ? 'Single' : '单个账号'}
            </button>
            <button
              type="button"
              onClick={() => setLivenessMode('selected')}
              disabled={livenessRunning}
              className={cn(
                'px-3 h-7 rounded text-xs font-medium transition-colors flex items-center gap-1',
                livenessMode === 'selected' ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {isEn ? 'Selected' : '选中账号'}
              <Badge variant="secondary" className="h-4 px-1.5 text-[10px] tabular-nums">{selectedAccounts.length}</Badge>
            </button>
          </div>

          {livenessMode === 'selected' && selectedAccounts.length === 0 && (
            <div className="flex items-center gap-1.5 text-[11px] text-amber-600">
              <AlertTriangle className="h-3.5 w-3.5" />
              {isEn
                ? 'No accounts selected. Go to the Accounts page and multi-select first.'
                : '未选中任何账号。请先到「账号管理」页面多选账号。'}
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {/* 单个模式：账号选择 */}
            {livenessMode === 'single' && (
              <div className="space-y-1">
                <Label className="text-xs">{isEn ? 'Account' : '账号'}</Label>
                <select
                  value={livenessAccountId}
                  onChange={(e) => setLivenessAccountId(e.target.value)}
                  disabled={livenessRunning}
                  className="h-9 w-full px-2 rounded-md border bg-background text-xs"
                >
                  <option value="">-- {isEn ? 'Select an account' : '选择账号'} --</option>
                  {accountList.map((a) => {
                    const bound = getAccountProxyUrl(a.id)
                    return (
                      <option key={a.id} value={a.id}>
                        {a.email}
                        {a.subscription?.type ? ` [${a.subscription.type}]` : ''}
                        {bound ? ' 🔗' : ''}
                      </option>
                    )
                  })}
                </select>
                {livenessAccountId && getAccountProxyUrl(livenessAccountId) && (
                  <p className="text-[10px] text-muted-foreground">
                    {isEn ? 'Bound proxy: ' : '绑定代理: '}
                    <code className="font-mono">{maskProxyUrl(getAccountProxyUrl(livenessAccountId)!)}</code>
                  </p>
                )}
              </div>
            )}

            {/* 模型选择（两种模式共用） */}
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <Label className="text-xs">{isEn ? 'Model' : '模型'}</Label>
                <button
                  type="button"
                  onClick={() => void loadModels()}
                  disabled={modelsLoading}
                  className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
                  title={isEn ? 'Refresh models from proxy cache / Kiro' : '从代理缓存 / Kiro 刷新可用模型'}
                >
                  <RefreshCw className={cn('h-3 w-3', modelsLoading && 'animate-spin')} />
                  {cachedModels.length > 0
                    ? (isEn ? `${cachedModels.length} cached` : `${cachedModels.length} 个缓存`)
                    : (isEn ? 'Refresh' : '刷新')}
                </button>
              </div>
              <input
                list="liveness-models"
                value={livenessModel}
                onChange={(e) => setLivenessModel(e.target.value)}
                disabled={livenessRunning}
                placeholder="claude-sonnet-4.5"
                className="h-9 w-full px-2 rounded-md border bg-background text-xs font-mono"
              />
              <datalist id="liveness-models">
                {modelOptions.map((m) => <option key={m} value={m} />)}
              </datalist>
            </div>
          </div>

          {/* 测试消息 */}
          <div className="space-y-1">
            <Label className="text-xs">{isEn ? 'Test message' : '测试消息'}</Label>
            <Input
              value={livenessMessage}
              onChange={(e) => setLivenessMessage(e.target.value)}
              disabled={livenessRunning}
              placeholder='Hi, reply with "pong" only.'
              className="text-xs"
            />
          </div>

          <div className="flex items-center gap-2">
            {livenessMode === 'single' ? (
              <Button onClick={runLiveness} disabled={livenessRunning || !livenessAccountId || !livenessModel.trim()}>
                {livenessRunning ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Zap className="h-4 w-4 mr-1" />}
                {livenessRunning ? (isEn ? 'Testing...' : '测试中...') : (isEn ? 'Test Now' : '开始测活')}
              </Button>
            ) : (
              <>
                <Button onClick={runLivenessBatch} disabled={livenessRunning || selectedAccounts.length === 0 || !livenessModel.trim()}>
                  {livenessRunning ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Zap className="h-4 w-4 mr-1" />}
                  {livenessRunning
                    ? `${isEn ? 'Testing' : '测试中'} ${batchStats.done}/${batchStats.total}`
                    : `${isEn ? 'Test Selected' : '批量测活'} (${selectedAccounts.length})`}
                </Button>
                {livenessRunning && (
                  <Button variant="destructive" onClick={stopLivenessBatch}>
                    <Square className="h-4 w-4 mr-1" />
                    {isEn ? 'Stop' : '停止'}
                  </Button>
                )}
              </>
            )}
            {livenessMode === 'selected' && batchStats.total > 0 && (
              <div className="ml-auto flex items-center gap-2 text-xs">
                <Badge variant="outline" className="text-green-600 border-green-200">
                  <CheckCircle2 className="h-3 w-3 mr-1" /> {batchStats.ok}
                </Badge>
                {batchStats.fail > 0 && (
                  <Badge variant="outline" className="text-red-600 border-red-200">
                    <XCircle className="h-3 w-3 mr-1" /> {batchStats.fail}
                  </Badge>
                )}
              </div>
            )}
          </div>

          {/* 单个测活结果 */}
          {livenessMode === 'single' && livenessResult && (
            <div className={cn(
              'rounded-md p-3 text-xs space-y-2 border',
              livenessResult.success
                ? 'bg-green-50/50 dark:bg-green-950/10 border-green-200 dark:border-green-900'
                : 'bg-red-50/50 dark:bg-red-950/10 border-red-200 dark:border-red-900'
            )}>
              <div className="flex items-center gap-2">
                {livenessResult.success
                  ? <CheckCircle2 className="h-4 w-4 text-green-500" />
                  : <XCircle className="h-4 w-4 text-red-500" />
                }
                <span className="font-medium">
                  {livenessResult.success
                    ? (isEn ? 'Account is alive' : '账号正常')
                    : (isEn ? 'Failed' : '失败')}
                </span>
                <span className="ml-auto font-mono tabular-nums text-muted-foreground">
                  {livenessResult.latencyMs}ms
                </span>
              </div>

              {livenessResult.success && (
                <>
                  {livenessResult.content && (
                    <div className="bg-background/60 rounded p-2 font-mono text-[11px] break-all max-h-32 overflow-y-auto">
                      {livenessResult.content || <span className="text-muted-foreground italic">{isEn ? '(empty response)' : '(空响应)'}</span>}
                    </div>
                  )}
                  {livenessResult.usage && (
                    <div className="flex items-center gap-3 text-[10px] text-muted-foreground tabular-nums">
                      <span>{isEn ? 'Input' : '输入'}: {livenessResult.usage.inputTokens}</span>
                      <span>{isEn ? 'Output' : '输出'}: {livenessResult.usage.outputTokens}</span>
                      <span>Credits: {livenessResult.usage.credits}</span>
                    </div>
                  )}
                </>
              )}

              {!livenessResult.success && livenessResult.error && (
                <div className="flex items-start gap-1.5 text-red-500">
                  <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
                  <span className="break-all">{livenessResult.error}</span>
                </div>
              )}
            </div>
          )}

          {/* 失败账号批量操作工具栏 */}
          {livenessMode === 'selected' && !livenessRunning && failedAccountIds.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 p-2 rounded-md bg-red-50/50 dark:bg-red-950/10 border border-red-200 dark:border-red-900">
              <span className="text-xs text-red-600 dark:text-red-400 flex items-center gap-1">
                <AlertTriangle className="h-3.5 w-3.5" />
                {isEn ? `${failedAccountIds.length} failed` : `${failedAccountIds.length} 个失败`}
              </span>
              <div className="ml-auto flex items-center gap-1.5">
                <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => void retestFailed()}>
                  <RotateCcw className="h-3.5 w-3.5 mr-1" />
                  {isEn ? 'Retest failed' : '重测失败'}
                </Button>
                <Button variant="outline" size="sm" className="h-7 text-xs" onClick={markFailedAsError}>
                  <Flag className="h-3.5 w-3.5 mr-1" />
                  {isEn ? 'Mark as error' : '标记为错误'}
                </Button>
                <Button variant="destructive" size="sm" className="h-7 text-xs" onClick={deleteFailed}>
                  <Trash2 className="h-3.5 w-3.5 mr-1" />
                  {isEn ? 'Delete failed' : '删除失败'}
                </Button>
              </div>
            </div>
          )}

          {/* 批量测活结果列表 */}
          {livenessMode === 'selected' && batchStats.total > 0 && (
            <div className="space-y-1 max-h-80 overflow-y-auto">
              {selectedAccounts.map((a) => {
                const r = livenessBatch.get(a.id)
                const pending = r === null
                return (
                  <div
                    key={a.id}
                    className={cn(
                      'flex items-center gap-2 p-2 rounded-md text-xs',
                      pending && 'bg-muted/30',
                      r && r.success && 'bg-green-50/50 dark:bg-green-950/10',
                      r && !r.success && 'bg-red-50/50 dark:bg-red-950/10'
                    )}
                  >
                    <div className="w-5 flex justify-center flex-shrink-0">
                      {pending && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
                      {r && r.success && <CheckCircle2 className="h-4 w-4 text-green-500" />}
                      {r && !r.success && <XCircle className="h-4 w-4 text-red-500" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium truncate flex items-center gap-1">
                        {a.email}
                        {getAccountProxyUrl(a.id) && <span title={isEn ? 'bound proxy' : '已绑定代理'}>🔗</span>}
                      </div>
                      {r && r.success && r.content && (
                        <div className="text-[10px] text-muted-foreground truncate font-mono" title={r.content}>
                          → {r.content}
                        </div>
                      )}
                      {r && !r.success && r.error && (
                        <div className="text-[10px] text-red-500 truncate" title={r.error}>{r.error}</div>
                      )}
                    </div>
                    {r && (
                      <span className="font-mono tabular-nums text-[10px] text-muted-foreground flex-shrink-0">
                        {r.latencyMs}ms
                      </span>
                    )}
                    {/* 单行重测：进行中不显示；已出结果（成功/失败）均可单独重测 */}
                    {!pending && (
                      <button
                        type="button"
                        onClick={() => void retestOne(a.id)}
                        disabled={livenessRunning}
                        title={isEn ? 'Retest this account' : '重测该账号'}
                        className="flex-shrink-0 p-1 rounded hover:bg-background/80 text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40"
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* 结果分组 */}
      {CATEGORIES.map((cat) => {
        const items = buildTargets().filter((t) => t.category === cat.id)
        if (items.length === 0) return null
        const Icon = cat.icon
        return (
          <Card key={cat.id}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <Icon className={cn('h-4 w-4', cat.color)} />
                {pick(cat.label)}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-1.5">
              {items.map((tg) => {
                const r = results[tg.id]
                return (
                  <div
                    key={tg.id}
                    className={cn(
                      'flex items-center gap-3 p-2 rounded-md text-xs',
                      r?.success && 'bg-green-50/50 dark:bg-green-950/10',
                      r && !r.success && 'bg-red-50/50 dark:bg-red-950/10',
                      !r && 'bg-muted/30'
                    )}
                  >
                    <div className="w-5 flex justify-center">
                      {!r && <span className="h-2 w-2 rounded-full bg-muted-foreground/30" />}
                      {r?.success && <CheckCircle2 className="h-4 w-4 text-green-500" />}
                      {r && !r.success && <XCircle className="h-4 w-4 text-red-500" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium">{pick(tg.label)}</div>
                      <div className="text-[10px] text-muted-foreground truncate" title={tg.url}>
                        {tg.url}
                      </div>
                      {tg.description && (
                        <div className="text-[10px] text-muted-foreground italic">{pick(tg.description)}</div>
                      )}
                      {r?.error && (
                        <div className="text-[10px] text-red-500 mt-0.5 flex items-start gap-1">
                          <AlertTriangle className="h-3 w-3 flex-shrink-0 mt-0.5" />
                          <span className="break-all">{r.error}</span>
                        </div>
                      )}
                    </div>
                    {r && (
                      <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                        {r.httpStatus && (
                          <span className={cn(
                            'font-mono px-1.5 py-0.5 rounded',
                            r.httpStatus >= 200 && r.httpStatus < 300 && 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300',
                            r.httpStatus >= 400 && 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300'
                          )}>HTTP {r.httpStatus}</span>
                        )}
                        {r.latencyMs != null && (
                          <span className="font-mono tabular-nums">{r.latencyMs}ms</span>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}
