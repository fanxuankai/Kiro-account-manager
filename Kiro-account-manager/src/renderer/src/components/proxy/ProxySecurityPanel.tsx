// 反代 v1.8 安全 / 限流 / 可观测设置面板
import { useState, useEffect, useCallback } from 'react'
import { Card, CardContent, CardHeader, CardTitle, Button, Input, Label, Switch, Badge } from '../ui'
import { ChevronDown, ChevronRight, Shield, AlertTriangle, RefreshCw, Download, Copy, CheckCircle2, FileText, Activity } from 'lucide-react'

interface ProxyConfigSecurity {
  host: string
  apiKey?: string
  apiKeys?: Array<{ key: string; enabled: boolean }>
  maxRequestBodyBytes?: number
  allowedIPs?: string[]
  deniedIPs?: string[]
  allowExternalWithoutApiKey?: boolean
  rateLimitPerKeyPerMinute?: number
  sessionAffinityEnabled?: boolean
  keepAliveTimeoutMs?: number
  headersTimeoutMs?: number
  recentRequestsLimit?: number
  enableMetrics?: boolean
  fallbackPort?: number
  enableAuditLog?: boolean
  tls?: { enabled?: boolean; cert?: string; key?: string; certPath?: string; keyPath?: string }
}

interface SelfSignedCertInfo {
  cert?: string
  key?: string
  fingerprint?: string
  notBefore?: number
  notAfter?: number
  subject?: string
  altNames?: string[]
}

interface AuditEntry {
  ts: number
  type: string
  data: Record<string, unknown>
}

interface ProxySecurityPanelProps {
  config: ProxyConfigSecurity & Record<string, unknown>
  // 使用 unknown 替代严格类型，避免父组件 ProxyConfig 类型与本组件接口的精确字段冲突
  // 实际写入仅使用 spread，类型安全由父组件的 ProxyConfig 接口保证
  setConfig: React.Dispatch<React.SetStateAction<unknown>>
  isRunning: boolean
  isEn: boolean
}

export function ProxySecurityPanel({ config, setConfig, isRunning, isEn }: ProxySecurityPanelProps): React.ReactNode {
  const [expanded, setExpanded] = useState(false)
  const [showAudit, setShowAudit] = useState(false)
  const [showCert, setShowCert] = useState(false)
  const [certInfo, setCertInfo] = useState<SelfSignedCertInfo | null>(null)
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([])
  const [needsRestart, setNeedsRestart] = useState(false)
  const [copiedCert, setCopiedCert] = useState(false)
  const [regenerating, setRegenerating] = useState(false)
  // 输入框本地状态（确保编辑时不被 config 同步打断）
  const [allowedIPsText, setAllowedIPsText] = useState((config.allowedIPs || []).join('\n'))
  const [deniedIPsText, setDeniedIPsText] = useState((config.deniedIPs || []).join('\n'))

  useEffect(() => {
    setAllowedIPsText((config.allowedIPs || []).join('\n'))
    setDeniedIPsText((config.deniedIPs || []).join('\n'))
  }, [config.allowedIPs, config.deniedIPs])

  // 加载 needsRestart 状态
  useEffect(() => {
    if (!isRunning) { setNeedsRestart(false); return }
    let mounted = true
    void window.api.proxyNeedsRestart().then(r => { if (mounted) setNeedsRestart(r.needsRestart) })
    const timer = setInterval(() => {
      void window.api.proxyNeedsRestart().then(r => { if (mounted) setNeedsRestart(r.needsRestart) })
    }, 5000)
    return () => { mounted = false; clearInterval(timer) }
  }, [isRunning])

  const updateConfig = useCallback(<K extends keyof ProxyConfigSecurity>(key: K, value: ProxyConfigSecurity[K]) => {
    setConfig((prev: unknown) => ({ ...(prev as object), [key]: value }))
    void window.api.proxyUpdateConfig({ [key]: value })
  }, [setConfig])

  // 解析 IP 文本（每行一个）
  const parseIPList = (text: string): string[] => text.split('\n').map(s => s.trim()).filter(Boolean)

  const fetchCertInfo = useCallback(async () => {
    const info = await window.api.proxySelfSignedCertInfo()
    if (info.success) setCertInfo(info)
  }, [])

  useEffect(() => {
    if (showCert && !certInfo) void fetchCertInfo()
  }, [showCert, certInfo, fetchCertInfo])

  const handleRegenerateCert = useCallback(async () => {
    if (!confirm(isEn ? 'Regenerate self-signed certificate? You will need to re-install it on clients.' : '重新生成自签证书？所有客户端需要重新安装。')) return
    setRegenerating(true)
    try {
      const info = await window.api.proxySelfSignedCertRegenerate()
      if (info.success) {
        setCertInfo(info)
        alert(isEn ? 'Regenerated. Restart proxy to apply.' : '已重新生成。重启反代后生效。')
      } else {
        alert(isEn ? `Failed: ${info.error}` : `失败: ${info.error}`)
      }
    } finally {
      setRegenerating(false)
    }
  }, [isEn])

  const handleDownloadCert = useCallback(() => {
    if (!certInfo?.cert) return
    const blob = new Blob([certInfo.cert], { type: 'application/x-pem-file' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'kiro-proxy-cert.crt'
    a.click()
    URL.revokeObjectURL(url)
  }, [certInfo])

  const handleCopyCert = useCallback(async () => {
    if (!certInfo?.cert) return
    await navigator.clipboard.writeText(certInfo.cert)
    setCopiedCert(true)
    setTimeout(() => setCopiedCert(false), 2000)
  }, [certInfo])

  const fetchAudit = useCallback(async () => {
    const r = await window.api.proxyAuditLog()
    setAuditEntries(r.entries)
  }, [])

  useEffect(() => {
    if (showAudit) void fetchAudit()
  }, [showAudit, fetchAudit])

  const handleRestart = useCallback(async () => {
    if (!confirm(isEn ? 'Restart proxy server now? Active streams will be interrupted.' : '立即重启反代服务器？正在进行的流式响应会被中断。')) return
    const r = await window.api.proxyRestart()
    if (r.success) {
      setNeedsRestart(false)
    } else {
      alert(isEn ? `Restart failed: ${r.error}` : `重启失败: ${r.error}`)
    }
  }, [isEn])

  return (
    <Card className="hover-lift">
      <CardHeader className="pb-3 cursor-pointer" onClick={() => setExpanded(!expanded)}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Shield className="h-5 w-5 text-amber-500" />
            <CardTitle className="text-base">{isEn ? 'Security & Observability (v1.8)' : '安全与可观测设置 (v1.8)'}</CardTitle>
            {needsRestart && (
              <Badge variant="destructive" className="ml-2">
                <AlertTriangle className="h-3 w-3 mr-1" />
                {isEn ? 'Restart required' : '需要重启'}
              </Badge>
            )}
          </div>
          <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
            {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </Button>
        </div>
      </CardHeader>

      {expanded && (
        <CardContent className="space-y-4 text-sm">
          {needsRestart && (
            <div className="flex items-center justify-between p-3 rounded-md bg-amber-500/10 border border-amber-500/20">
              <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400">
                <AlertTriangle className="h-4 w-4" />
                <span className="text-xs">{isEn ? 'Configuration change requires a restart to take effect.' : '配置已更改，重启后生效。'}</span>
              </div>
              <Button size="sm" onClick={handleRestart}>
                <RefreshCw className="h-3 w-3 mr-1" />
                {isEn ? 'Restart Now' : '立即重启'}
              </Button>
            </div>
          )}

          {/* 请求安全 */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">{isEn ? 'Max body size (MB)' : '请求体上限 (MB)'}</Label>
              <Input
                type="number"
                min={1}
                max={100}
                step={1}
                value={Math.round((config.maxRequestBodyBytes || 10 * 1024 * 1024) / (1024 * 1024))}
                onChange={(e) => {
                  const mb = parseInt(e.target.value) || 10
                  updateConfig('maxRequestBodyBytes', mb * 1024 * 1024)
                }}
                placeholder="10"
                className="h-9"
              />
              <p className="text-xs text-muted-foreground mt-1">{isEn ? 'Reject larger requests with HTTP 413' : '超过则返回 HTTP 413'}</p>
            </div>
            <div>
              <Label className="text-xs">{isEn ? 'Rate limit (req/min per Key)' : '限速（每 Key 每分钟）'}</Label>
              <Input
                type="number"
                min={0}
                max={10000}
                step={10}
                value={config.rateLimitPerKeyPerMinute || 0}
                onChange={(e) => updateConfig('rateLimitPerKeyPerMinute', parseInt(e.target.value) || 0)}
                placeholder={isEn ? '0 = unlimited' : '0 = 不限制'}
                className="h-9"
              />
              <p className="text-xs text-muted-foreground mt-1">{isEn ? 'Anonymous → by IP' : '匿名时按 IP 限速'}</p>
            </div>
          </div>

          {/* IP 访问控制 */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">{isEn ? 'Allowed IPs (whitelist)' : 'IP 白名单'}</Label>
              <textarea
                value={allowedIPsText}
                onChange={(e) => setAllowedIPsText(e.target.value)}
                onBlur={() => updateConfig('allowedIPs', parseIPList(allowedIPsText))}
                placeholder={isEn ? 'One per line, supports CIDR (e.g. 10.0.0.0/8)' : '每行一个，支持 CIDR (如 10.0.0.0/8)'}
                className="w-full h-20 px-3 py-2 text-xs rounded-md border border-input bg-background"
              />
              <p className="text-xs text-muted-foreground mt-1">{isEn ? 'Empty = no restriction' : '为空 = 不限制'}</p>
            </div>
            <div>
              <Label className="text-xs">{isEn ? 'Denied IPs (blacklist)' : 'IP 黑名单'}</Label>
              <textarea
                value={deniedIPsText}
                onChange={(e) => setDeniedIPsText(e.target.value)}
                onBlur={() => updateConfig('deniedIPs', parseIPList(deniedIPsText))}
                placeholder={isEn ? 'Higher priority than allowed list' : '优先级高于白名单'}
                className="w-full h-20 px-3 py-2 text-xs rounded-md border border-input bg-background"
              />
              <p className="text-xs text-muted-foreground mt-1">{isEn ? 'IPv4 / IPv6 / CIDR' : '支持 IPv4 / IPv6 / CIDR'}</p>
            </div>
          </div>

          {/* 危险绑定 */}
          {(config.host === '0.0.0.0' || config.host === '::') && (
            <div className="flex items-start gap-3 p-3 rounded-md bg-red-500/10 border border-red-500/20">
              <AlertTriangle className="h-4 w-4 text-red-600 dark:text-red-400 mt-0.5 flex-shrink-0" />
              <div className="flex-1">
                <p className="text-xs font-medium text-red-600 dark:text-red-400">{isEn ? `Binding to ${config.host} exposes accounts to the network!` : `当前绑定到 ${config.host}（局域网/公网可访问）`}</p>
                <p className="text-xs text-muted-foreground mt-1">
                  {isEn ? 'API Key is required to start the server.' : '必须设置至少一个 API Key 才能启动。'}
                </p>
                <label className="flex items-center gap-2 mt-2 cursor-pointer">
                  <Switch
                    checked={config.allowExternalWithoutApiKey || false}
                    onCheckedChange={(checked) => updateConfig('allowExternalWithoutApiKey', checked)}
                    disabled={isRunning}
                  />
                  <span className="text-xs text-red-600 dark:text-red-400">{isEn ? 'I understand the risk, allow without API Key (DANGEROUS)' : '我了解风险，允许无 Key 启动（危险）'}</span>
                </label>
              </div>
            </div>
          )}

          {/* 会话粘性 + 限速 */}
          <div className="grid grid-cols-2 gap-3">
            <div className="flex items-center justify-between p-3 rounded-md border bg-background/50">
              <div>
                <Label className="text-sm">{isEn ? 'Session affinity' : '会话粘性'}</Label>
                <p className="text-xs text-muted-foreground mt-1">{isEn ? 'Route same client to same account (prompt cache + anti-risk)' : '同客户端总用同账号（保 cache + 防风控）'}</p>
              </div>
              <Switch
                checked={config.sessionAffinityEnabled || false}
                onCheckedChange={(checked) => updateConfig('sessionAffinityEnabled', checked)}
              />
            </div>
            <div className="flex items-center justify-between p-3 rounded-md border bg-background/50">
              <div>
                <Label className="text-sm">{isEn ? 'Prometheus /metrics' : 'Prometheus /metrics'}</Label>
                <p className="text-xs text-muted-foreground mt-1">{isEn ? 'Expose monitoring metrics endpoint' : '暴露监控指标端点'}</p>
              </div>
              <Switch
                checked={config.enableMetrics || false}
                onCheckedChange={(checked) => updateConfig('enableMetrics', checked)}
              />
            </div>
          </div>

          {/* 审计日志 + 日志条数 */}
          <div className="grid grid-cols-2 gap-3">
            <div className="flex items-center justify-between p-3 rounded-md border bg-background/50">
              <div>
                <Label className="text-sm">{isEn ? 'Audit log' : '审计日志'}</Label>
                <p className="text-xs text-muted-foreground mt-1">{isEn ? 'Track config changes & critical events' : '记录配置变更与关键事件'}</p>
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  checked={config.enableAuditLog || false}
                  onCheckedChange={(checked) => updateConfig('enableAuditLog', checked)}
                />
                <Button variant="outline" size="sm" onClick={() => setShowAudit(!showAudit)}>
                  <FileText className="h-3 w-3 mr-1" />
                  {isEn ? 'View' : '查看'}
                </Button>
              </div>
            </div>
            <div>
              <Label className="text-xs">{isEn ? 'Recent requests limit' : '最近请求日志条数'}</Label>
              <Input
                type="number"
                min={20}
                max={10000}
                step={50}
                value={config.recentRequestsLimit || 100}
                onChange={(e) => updateConfig('recentRequestsLimit', parseInt(e.target.value) || 100)}
                className="h-9"
              />
              <p className="text-xs text-muted-foreground mt-1">{isEn ? 'Default 100, max 10000' : '默认 100，上限 10000'}</p>
            </div>
          </div>

          {/* keep-alive 超时 */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">{isEn ? 'Keep-alive timeout (sec)' : 'keep-alive 空闲超时（秒）'}</Label>
              <Input
                type="number"
                min={5}
                max={600}
                step={5}
                value={Math.round((config.keepAliveTimeoutMs || 65000) / 1000)}
                onChange={(e) => updateConfig('keepAliveTimeoutMs', (parseInt(e.target.value) || 65) * 1000)}
                className="h-9"
              />
            </div>
            <div>
              <Label className="text-xs">{isEn ? 'HTTP fallback port (when TLS enabled)' : 'HTTP 回退端口（启用 TLS 时）'}</Label>
              <Input
                type="number"
                min={0}
                max={65535}
                step={1}
                value={config.fallbackPort || 0}
                onChange={(e) => updateConfig('fallbackPort', parseInt(e.target.value) || 0)}
                placeholder={isEn ? '0 = disabled' : '0 = 不启用'}
                className="h-9"
                disabled={isRunning}
              />
            </div>
          </div>

          {/* TLS 自签证书 */}
          <div className="border-t pt-3">
            <div className="flex items-center justify-between mb-2">
              <Label className="text-sm font-medium">{isEn ? 'Self-signed TLS Certificate' : '自签 TLS 证书'}</Label>
              <Button variant="outline" size="sm" onClick={() => setShowCert(!showCert)}>
                {showCert ? (isEn ? 'Hide' : '隐藏') : (isEn ? 'Show details' : '查看详情')}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground mb-2">
              {isEn
                ? 'When TLS is enabled but no cert/key configured, the proxy auto-generates a 2-year self-signed cert (in userData/proxy-tls/). Install on clients or set NODE_TLS_REJECT_UNAUTHORIZED=0.'
                : '启用 TLS 但未配置证书时，反代自动生成 2 年有效期的自签证书（位于 userData/proxy-tls/）。客户端需要安装该证书或设置 NODE_TLS_REJECT_UNAUTHORIZED=0。'}
            </p>
            {showCert && certInfo && (
              <div className="space-y-2 mt-3">
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div>
                    <span className="text-muted-foreground">{isEn ? 'Subject:' : '主体:'}</span>
                    <p className="font-mono">{certInfo.subject || '-'}</p>
                  </div>
                  <div>
                    <span className="text-muted-foreground">{isEn ? 'Expires:' : '过期:'}</span>
                    <p className="font-mono">{certInfo.notAfter ? new Date(certInfo.notAfter).toLocaleString() : '-'}</p>
                  </div>
                  <div className="col-span-2">
                    <span className="text-muted-foreground">{isEn ? 'SHA-256 Fingerprint:' : 'SHA-256 指纹:'}</span>
                    <p className="font-mono text-[10px] break-all">{certInfo.fingerprint || '-'}</p>
                  </div>
                  <div className="col-span-2">
                    <span className="text-muted-foreground">{isEn ? 'Subject Alt Names:' : '备用名称 (SAN):'}</span>
                    <p className="font-mono text-[10px]">{certInfo.altNames?.join(', ') || '-'}</p>
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={handleDownloadCert}>
                    <Download className="h-3 w-3 mr-1" />
                    {isEn ? 'Download .crt' : '下载 .crt'}
                  </Button>
                  <Button variant="outline" size="sm" onClick={handleCopyCert}>
                    {copiedCert ? <CheckCircle2 className="h-3 w-3 mr-1 text-green-500" /> : <Copy className="h-3 w-3 mr-1" />}
                    {copiedCert ? (isEn ? 'Copied' : '已复制') : (isEn ? 'Copy PEM' : '复制 PEM')}
                  </Button>
                  <Button variant="outline" size="sm" onClick={handleRegenerateCert} disabled={regenerating}>
                    <RefreshCw className={`h-3 w-3 mr-1 ${regenerating ? 'animate-spin' : ''}`} />
                    {isEn ? 'Regenerate' : '重新生成'}
                  </Button>
                </div>
              </div>
            )}
          </div>

          {/* 审计日志查看 */}
          {showAudit && (
            <div className="border-t pt-3">
              <div className="flex items-center justify-between mb-2">
                <Label className="text-sm font-medium">{isEn ? 'Audit Log (recent 200)' : '审计日志（最近 200 条）'}</Label>
                <Button variant="outline" size="sm" onClick={fetchAudit}>
                  <RefreshCw className="h-3 w-3 mr-1" />
                  {isEn ? 'Refresh' : '刷新'}
                </Button>
              </div>
              <div className="max-h-64 overflow-y-auto rounded-md border bg-muted/30 p-2 space-y-1">
                {auditEntries.length === 0 ? (
                  <p className="text-xs text-muted-foreground text-center py-4">{isEn ? 'No entries' : '暂无记录'}</p>
                ) : (
                  auditEntries.slice().reverse().map((entry, i) => (
                    <div key={i} className="text-[10px] font-mono p-1.5 rounded bg-background/50 border">
                      <div className="flex items-center gap-2 text-muted-foreground">
                        <span>{new Date(entry.ts).toLocaleTimeString()}</span>
                        <Badge variant="outline" className="text-[9px] px-1 py-0">{entry.type}</Badge>
                      </div>
                      <pre className="mt-1 break-all whitespace-pre-wrap">{JSON.stringify(entry.data, null, 0)}</pre>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {/* /metrics 端点提示 */}
          {config.enableMetrics && isRunning && (
            <div className="flex items-center gap-2 p-2 rounded-md bg-blue-500/10 border border-blue-500/20 text-xs">
              <Activity className="h-3 w-3 text-blue-500" />
              <span className="text-muted-foreground">{isEn ? 'Metrics available at:' : '指标端点:'}</span>
              <code className="font-mono">/metrics</code>
            </div>
          )}
        </CardContent>
      )}
    </Card>
  )
}
