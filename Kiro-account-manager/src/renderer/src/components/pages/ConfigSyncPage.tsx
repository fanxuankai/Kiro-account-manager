import { useState, useCallback } from 'react'
import {
  Archive, Download, Upload, FileJson, ShieldAlert, CheckCircle2,
  Trash2, RefreshCw, AlertTriangle
} from 'lucide-react'
import { useAccountsStore } from '@/store/accounts'
import { useWebhookStore } from '@/store/webhooks'
import { useTranslation } from '@/hooks/useTranslation'
import { Card, CardContent, CardHeader, CardTitle, Button, Label, Switch } from '../ui'

/**
 * 配置同步页面
 *
 * 把"非敏感的应用配置"（代理池、Webhook、注册模板、限速/定时/配额、过滤偏好等）
 * 导出为单一 JSON 文件，方便在多台电脑之间同步。
 *
 * 敏感数据（账号凭据、refreshToken 等）不会被导出，
 * 它们走「账号管理 - 导出」专用通道（独立加密）。
 */

interface PortableConfig {
  version: 1
  exportedAt: string
  app: string  // "kiro-account-manager"
  /** 代理池条目（脱敏：密码字段会被打码） */
  proxyPool?: Array<Record<string, unknown>>
  proxyPoolConfig?: Record<string, unknown>
  /** Webhook 列表 */
  webhooks?: Array<Record<string, unknown>>
  /** RegisterPage 配置（kiro-register-config） */
  registerConfig?: Record<string, unknown>
  /** 注册模板（kiro-register-templates） */
  registerTemplates?: Array<Record<string, unknown>>
  /** 其它注册相关 localStorage 设置 */
  registerLocalStorage?: Record<string, string>
  /** App 设置（部分非敏感字段） */
  appSettings?: {
    theme?: string
    darkMode?: boolean
    language?: string
    autoRefreshEnabled?: boolean
    autoRefreshInterval?: number
    autoRefreshConcurrency?: number
    autoUsageRefreshEnabled?: boolean
    autoUsageRefreshInterval?: number
    statusCheckInterval?: number
    privacyMode?: boolean
    usagePrecision?: boolean
    autoSwitchEnabled?: boolean
    autoSwitchThreshold?: number
    autoSwitchInterval?: number
    switchTarget?: string
  }
}

const REGISTER_LS_KEYS = [
  'kiro-register-ratelimit-enabled',
  'kiro-register-ratelimit-max',
  'kiro-register-autobackoff',
  'kiro-register-dailyquota-limit',
  'kiro-register-schedule-enabled',
  'kiro-register-schedule-time',
  'kiro-register-mixed-sources'
]

export function ConfigSyncPage(): React.ReactNode {
  const { t } = useTranslation()
  const isEn = t('common.unknown') === 'Unknown'
  const store = useAccountsStore()

  // 导出选项（默认全开）
  const [opts, setOpts] = useState({
    proxyPool: true,
    webhooks: true,
    registerConfig: true,
    registerTemplates: true,
    registerSettings: true,
    appSettings: true,
    /** 包含代理密码？关闭时只导出 host:port，更安全用于分享 */
    includeProxyCredentials: false,
    /** 启用密码加密：使用用户密码 + Web Crypto AES-GCM */
    encrypt: false
  })
  const [encryptPassword, setEncryptPassword] = useState('')

  const [lastExportSize, setLastExportSize] = useState<number | null>(null)
  const [lastImportResult, setLastImportResult] = useState<{
    success: boolean
    counts?: Record<string, number>
    error?: string
  } | null>(null)

  const handleExport = useCallback(async (): Promise<void> => {
    const payload: PortableConfig = {
      version: 1,
      exportedAt: new Date().toISOString(),
      app: 'kiro-account-manager'
    }

    if (opts.proxyPool && store.proxyPool.size > 0) {
      payload.proxyPool = Array.from(store.proxyPool.values()).map((p) => {
        const out: Record<string, unknown> = { ...p }
        if (!opts.includeProxyCredentials) {
          // 脱敏：密码 + url 中的密码部分
          delete out.password
          out.url = p.url.replace(/:([^:@/]+)@/, ':***@')
        }
        return out
      })
      payload.proxyPoolConfig = { ...store.proxyPoolConfig }
    }

    if (opts.webhooks) {
      const webhooks = Array.from(useWebhookStore.getState().webhooks.values())
      payload.webhooks = webhooks.map((w) => ({ ...w }))
    }

    if (opts.registerConfig) {
      try {
        const raw = localStorage.getItem('kiro-register-config')
        if (raw) payload.registerConfig = JSON.parse(raw)
      } catch { /* ignore */ }
    }

    if (opts.registerTemplates) {
      try {
        const raw = localStorage.getItem('kiro-register-templates')
        if (raw) payload.registerTemplates = JSON.parse(raw)
      } catch { /* ignore */ }
    }

    if (opts.registerSettings) {
      const reg: Record<string, string> = {}
      for (const k of REGISTER_LS_KEYS) {
        const v = localStorage.getItem(k)
        if (v != null) reg[k] = v
      }
      payload.registerLocalStorage = reg
    }

    if (opts.appSettings) {
      payload.appSettings = {
        theme: store.theme,
        darkMode: store.darkMode,
        language: store.language,
        autoRefreshEnabled: store.autoRefreshEnabled,
        autoRefreshInterval: store.autoRefreshInterval,
        autoRefreshConcurrency: store.autoRefreshConcurrency,
        autoUsageRefreshEnabled: store.autoUsageRefreshEnabled,
        autoUsageRefreshInterval: store.autoUsageRefreshInterval,
        statusCheckInterval: store.statusCheckInterval,
        privacyMode: store.privacyMode,
        usagePrecision: store.usagePrecision,
        autoSwitchEnabled: store.autoSwitchEnabled,
        autoSwitchThreshold: store.autoSwitchThreshold,
        autoSwitchInterval: store.autoSwitchInterval,
        switchTarget: store.switchTarget
      }
    }

    let outputText = JSON.stringify(payload, null, 2)
    let extension = 'json'

    // C4: 可选加密
    if (opts.encrypt) {
      if (!encryptPassword.trim()) {
        alert(isEn ? 'Please enter encryption password' : '请输入加密密码')
        return
      }
      try {
        outputText = await encryptText(outputText, encryptPassword)
        extension = 'kcfg'
      } catch (err) {
        alert(isEn ? `Encryption failed: ${err}` : `加密失败: ${err}`)
        return
      }
    }

    setLastExportSize(outputText.length)

    const blob = new Blob([outputText], { type: opts.encrypt ? 'application/octet-stream' : 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `kiro-config-${new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-')}.${extension}`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }, [opts, store, encryptPassword, isEn])

  const handleImport = useCallback(async (file: File): Promise<void> => {
    try {
      let text = await file.text()
      // C4: 加密文件自动识别 + 弹窗输入密码解密
      if (file.name.endsWith('.kcfg') || text.startsWith('KCFG1:')) {
        const pwd = prompt(isEn ? 'Enter decryption password:' : '请输入解密密码：')
        if (!pwd) return
        try {
          text = await decryptText(text, pwd)
        } catch (err) {
          setLastImportResult({ success: false, error: `解密失败：${err instanceof Error ? err.message : String(err)}` })
          return
        }
      }
      const data = JSON.parse(text) as PortableConfig
      if (data.app !== 'kiro-account-manager') {
        setLastImportResult({ success: false, error: '文件不是有效的 Kiro 账号管理器配置（app 标识不匹配）' })
        return
      }

      const counts: Record<string, number> = {}

      // 代理池
      if (data.proxyPool && data.proxyPool.length > 0) {
        let added = 0
        for (const p of data.proxyPool) {
          // 跳过脱敏过的密码
          if (typeof (p as { url?: string }).url === 'string' && !(p as { url: string }).url.includes('***')) {
            const id = store.addProxy((p as { url: string }).url, {
              label: (p as { label?: string }).label,
              source: 'import-config',
              tags: (p as { tags?: string[] }).tags
            })
            if (id) added++
          } else if ((p as { host?: string }).host && (p as { port?: number }).port) {
            // 脱敏的代理：只有 host:port 时按 http 默认导入
            const proto = (p as { protocol?: string }).protocol || 'http'
            const url = `${proto}://${(p as { host: string }).host}:${(p as { port: number }).port}`
            const id = store.addProxy(url, {
              label: (p as { label?: string }).label,
              source: 'import-config-masked',
              tags: (p as { tags?: string[] }).tags
            })
            if (id) added++
          }
        }
        counts['代理池'] = added
      }
      if (data.proxyPoolConfig) {
        store.setProxyPoolConfig(data.proxyPoolConfig as Partial<typeof store.proxyPoolConfig>)
      }

      // Webhooks
      if (data.webhooks && data.webhooks.length > 0) {
        const ws = useWebhookStore.getState()
        let added = 0
        for (const w of data.webhooks) {
          const input = w as Parameters<typeof ws.addWebhook>[0]
          if (input.kind && input.url) {
            ws.addWebhook(input)
            added++
          }
        }
        counts['Webhook'] = added
      }

      // 注册配置
      if (data.registerConfig) {
        try {
          localStorage.setItem('kiro-register-config', JSON.stringify(data.registerConfig))
          counts['注册配置'] = 1
        } catch { /* ignore */ }
      }

      // 注册模板
      if (data.registerTemplates) {
        try {
          localStorage.setItem('kiro-register-templates', JSON.stringify(data.registerTemplates))
          counts['注册模板'] = data.registerTemplates.length
        } catch { /* ignore */ }
      }

      // 注册相关 localStorage
      if (data.registerLocalStorage) {
        let n = 0
        for (const [k, v] of Object.entries(data.registerLocalStorage)) {
          if (REGISTER_LS_KEYS.includes(k)) {
            try { localStorage.setItem(k, v); n++ } catch { /* ignore */ }
          }
        }
        counts['注册偏好'] = n
      }

      // App 设置
      if (data.appSettings) {
        const s = data.appSettings
        if (s.theme != null) store.setTheme(s.theme)
        if (s.darkMode != null) store.setDarkMode(s.darkMode)
        if (s.language != null) store.setLanguage(s.language as 'auto' | 'en' | 'zh')
        if (s.autoRefreshEnabled != null) store.setAutoRefresh(s.autoRefreshEnabled, s.autoRefreshInterval)
        if (s.autoRefreshConcurrency != null) store.setAutoRefreshConcurrency(s.autoRefreshConcurrency)
        if (s.autoUsageRefreshEnabled != null) store.setAutoUsageRefresh(s.autoUsageRefreshEnabled, s.autoUsageRefreshInterval)
        if (s.statusCheckInterval != null) store.setStatusCheckInterval(s.statusCheckInterval)
        if (s.privacyMode != null) store.setPrivacyMode(s.privacyMode)
        if (s.usagePrecision != null) store.setUsagePrecision(s.usagePrecision)
        if (s.autoSwitchEnabled != null) store.setAutoSwitch(s.autoSwitchEnabled, s.autoSwitchThreshold, s.autoSwitchInterval)
        if (s.switchTarget != null && (s.switchTarget === 'ide' || s.switchTarget === 'cli' || s.switchTarget === 'both')) {
          store.setSwitchTarget(s.switchTarget)
        }
        counts['App 设置'] = 1
      }

      setLastImportResult({ success: true, counts })
    } catch (err) {
      setLastImportResult({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  }, [store])

  return (
    <div className="flex-1 p-6 space-y-6 overflow-auto">
      {/* Header */}
      <div className="page-hero p-6">
        <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-br from-indigo-500/20 to-transparent rounded-full blur-2xl" />
        <div className="absolute bottom-0 left-0 w-24 h-24 bg-gradient-to-tr from-indigo-500/20 to-transparent rounded-full blur-2xl" />
        <div className="relative flex items-center gap-4">
          <div className="p-3 rounded-xl bg-indigo-500 shadow-lg shadow-indigo-500/25">
            <Archive className="h-6 w-6 text-white" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-indigo-600 dark:text-indigo-400">
              {isEn ? 'Config Sync' : '配置同步'}
            </h1>
            <p className="text-muted-foreground">
              {isEn
                ? 'Export & import non-sensitive app config (proxy pool, webhooks, register templates, app preferences) for multi-device sync.'
                : '导出/导入非敏感配置（代理池、Webhook、注册模板、应用偏好），用于多设备同步'
              }
            </p>
          </div>
        </div>
      </div>

      {/* 安全提示 */}
      <Card className="border-amber-200 dark:border-amber-800 bg-amber-50/30 dark:bg-amber-950/10">
        <CardContent className="py-3 flex items-start gap-2">
          <ShieldAlert className="h-4 w-4 text-amber-600 flex-shrink-0 mt-0.5" />
          <div className="text-xs space-y-1">
            <p className="font-medium text-amber-700 dark:text-amber-300">
              {isEn ? 'Security Notice' : '安全提示'}
            </p>
            <p className="text-muted-foreground">
              {isEn
                ? 'This export does NOT include account credentials, refresh tokens, or other sensitive secrets — use "Account Export" (under Accounts page) for those.'
                : '本页导出"不包含"账号凭据、Refresh Token 等敏感数据。账号导出请走"账户管理 → 导出"专用通道。'
              }
            </p>
            <p className="text-muted-foreground">
              {isEn
                ? 'Tip: keep "Include proxy credentials" OFF when sharing the file with others.'
                : '提示：分享给他人时，建议关闭"包含代理密码"选项，密码会被打码。'
              }
            </p>
          </div>
        </CardContent>
      </Card>

      {/* 导出 */}
      <Card className="hover-lift">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Download className="h-4 w-4 text-primary" />
            {isEn ? 'Export' : '导出'}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-2 text-sm">
            <ExportToggle
              label={`${isEn ? 'Proxy Pool' : '代理池'} (${store.proxyPool.size})`}
              checked={opts.proxyPool}
              onChange={(v) => setOpts((p) => ({ ...p, proxyPool: v }))}
            />
            <ExportToggle
              label={`${isEn ? 'Webhooks' : 'Webhook'} (${useWebhookStore.getState().webhooks.size})`}
              checked={opts.webhooks}
              onChange={(v) => setOpts((p) => ({ ...p, webhooks: v }))}
            />
            <ExportToggle
              label={isEn ? 'Register Config' : '注册配置'}
              checked={opts.registerConfig}
              onChange={(v) => setOpts((p) => ({ ...p, registerConfig: v }))}
            />
            <ExportToggle
              label={isEn ? 'Register Templates' : '注册模板'}
              checked={opts.registerTemplates}
              onChange={(v) => setOpts((p) => ({ ...p, registerTemplates: v }))}
            />
            <ExportToggle
              label={isEn ? 'Register Preferences' : '注册偏好（限速/定时/配额等）'}
              checked={opts.registerSettings}
              onChange={(v) => setOpts((p) => ({ ...p, registerSettings: v }))}
            />
            <ExportToggle
              label={isEn ? 'App Settings (theme/lang/auto-refresh)' : 'App 设置（主题/语言/自动刷新）'}
              checked={opts.appSettings}
              onChange={(v) => setOpts((p) => ({ ...p, appSettings: v }))}
            />
          </div>

          <div className="border-t pt-3 flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-2">
              <Switch
                checked={opts.includeProxyCredentials}
                onCheckedChange={(v) => setOpts((p) => ({ ...p, includeProxyCredentials: v }))}
              />
              <Label className="text-xs cursor-pointer flex items-center gap-1.5">
                {opts.includeProxyCredentials
                  ? <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                  : <ShieldAlert className="h-3.5 w-3.5 text-muted-foreground" />
                }
                {isEn ? 'Include proxy credentials (NOT recommended for sharing)' : '包含代理密码（分享时不建议）'}
              </Label>
            </div>
            {/* C4: 加密导出 */}
            <div className="flex items-center gap-2">
              <Switch
                checked={opts.encrypt}
                onCheckedChange={(v) => setOpts((p) => ({ ...p, encrypt: v }))}
              />
              <Label className="text-xs cursor-pointer flex items-center gap-1.5">
                <ShieldAlert className="h-3.5 w-3.5 text-green-500" />
                {isEn ? 'Encrypt (AES-GCM)' : '加密导出 (AES-GCM)'}
              </Label>
            </div>
            {opts.encrypt && (
              <input
                type="password"
                value={encryptPassword}
                onChange={(e) => setEncryptPassword(e.target.value)}
                placeholder={isEn ? 'Password...' : '加密密码...'}
                className="h-8 px-2 rounded-md border bg-background text-xs flex-1 max-w-xs"
              />
            )}
            <Button className="ml-auto" onClick={handleExport} disabled={opts.encrypt && !encryptPassword.trim()}>
              <FileJson className="h-4 w-4 mr-2" />
              {isEn ? 'Export' : '导出'}
            </Button>
          </div>

          {lastExportSize !== null && (
            <p className="text-[10px] text-muted-foreground">
              {isEn
                ? `Last export: ${(lastExportSize / 1024).toFixed(1)} KB`
                : `上次导出大小: ${(lastExportSize / 1024).toFixed(1)} KB`
              }
            </p>
          )}
        </CardContent>
      </Card>

      {/* 导入 */}
      <Card className="hover-lift">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Upload className="h-4 w-4 text-primary" />
            {isEn ? 'Import' : '导入'}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Label className="text-xs">
            {isEn
              ? 'Choose a previously exported config JSON. Duplicates will be merged/skipped automatically.'
              : '选择之前导出的配置 JSON 文件。重复项会自动合并/跳过。'
            }
          </Label>
          <div className="flex items-center gap-2">
            <input
              type="file"
              accept="application/json,.json"
              className="text-xs"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) void handleImport(file)
                e.currentTarget.value = ''
              }}
            />
          </div>

          {lastImportResult && (
            <div className={`p-3 rounded-lg border ${
              lastImportResult.success
                ? 'border-green-200 dark:border-green-800 bg-green-50/50 dark:bg-green-950/10'
                : 'border-red-200 dark:border-red-800 bg-red-50/50 dark:bg-red-950/10'
            }`}>
              {lastImportResult.success ? (
                <>
                  <div className="flex items-center gap-2 text-sm font-medium text-green-700 dark:text-green-300">
                    <CheckCircle2 className="h-4 w-4" />
                    {isEn ? 'Import Successful' : '导入成功'}
                  </div>
                  {lastImportResult.counts && (
                    <div className="mt-2 grid grid-cols-2 gap-1 text-xs">
                      {Object.entries(lastImportResult.counts).map(([k, v]) => (
                        <div key={k} className="flex justify-between">
                          <span className="text-muted-foreground">{k}</span>
                          <span className="font-mono tabular-nums">{v}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <div className="flex items-start gap-2 text-sm text-red-700 dark:text-red-300">
                  <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" />
                  <div>
                    <div className="font-medium">{isEn ? 'Import Failed' : '导入失败'}</div>
                    <div className="text-xs mt-0.5">{lastImportResult.error}</div>
                  </div>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* 危险操作 */}
      <Card className="border-red-200 dark:border-red-800">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2 text-red-600">
            <Trash2 className="h-4 w-4" />
            {isEn ? 'Danger Zone' : '危险操作'}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <Button
            variant="outline"
            size="sm"
            className="text-red-600 border-red-200 hover:bg-red-50 dark:hover:bg-red-950/20"
            onClick={() => {
              if (!confirm(isEn
                ? 'Reset register page preferences (rate limit / schedule / quota / mixed sources / blacklist / templates)? This does NOT affect accounts.'
                : '重置注册页所有偏好（限速/定时/配额/混合源/黑名单/模板）？不影响账号数据。'
              )) return
              for (const k of REGISTER_LS_KEYS) localStorage.removeItem(k)
              localStorage.removeItem('kiro-register-templates')
              localStorage.removeItem('kiro-register-email-blacklist')
              alert(isEn ? 'Done. Please reload the page.' : '已重置，请刷新页面')
            }}
          >
            <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
            {isEn ? 'Reset Register Preferences' : '重置注册页偏好'}
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}

function ExportToggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }): React.ReactNode {
  return (
    <label className="flex items-center gap-2 p-2 rounded hover:bg-muted/40 cursor-pointer">
      <Switch checked={checked} onCheckedChange={onChange} />
      <span className="text-sm">{label}</span>
    </label>
  )
}

// ============ AES-GCM 加密辅助（C4） ============

const ENC_PREFIX = 'KCFG1:'
const PBKDF2_ITER = 100_000

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const enc = new TextEncoder()
  // 用 .slice() 拿到独立的 ArrayBuffer 视图，规避 TypeScript 5 严格 ArrayBufferLike 类型问题
  const baseKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(password).slice().buffer,
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  )
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt.slice().buffer, iterations: PBKDF2_ITER, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

function b64encode(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let s = ''
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i])
  return btoa(s)
}
function b64decode(s: string): Uint8Array {
  const bin = atob(s)
  const arr = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
  return arr
}

async function encryptText(plaintext: string, password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await deriveKey(password, salt)
  const plaintextBytes = new TextEncoder().encode(plaintext)
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv.slice().buffer },
    key,
    plaintextBytes.slice().buffer
  )
  return `${ENC_PREFIX}${b64encode(salt)}.${b64encode(iv)}.${b64encode(ciphertext)}`
}

async function decryptText(envelope: string, password: string): Promise<string> {
  if (!envelope.startsWith(ENC_PREFIX)) throw new Error('Not an encrypted KCFG payload')
  const parts = envelope.slice(ENC_PREFIX.length).split('.')
  if (parts.length !== 3) throw new Error('Invalid encrypted payload format')
  const [saltB64, ivB64, ctB64] = parts
  const salt = b64decode(saltB64)
  const iv = b64decode(ivB64)
  const ct = b64decode(ctB64)
  const key = await deriveKey(password, salt)
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv.slice().buffer },
    key,
    ct.slice().buffer
  )
  return new TextDecoder().decode(plaintext)
}
