import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button, Badge } from '../ui'
import { X, FileJson, FileText, Table, Clipboard, Check, Download, Key, Braces } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAccountsStore } from '@/store/accounts'
import { useTranslation } from '@/hooks/useTranslation'
import type { Account } from '@/types/account'

const EXPORT_FORMATS = ['json', 'oidc', 'txt', 'csv', 'kami', 'clipboard'] as const
type ExportFormat = (typeof EXPORT_FORMATS)[number]

// 记住上次使用的导出格式，非法存量值回退到 json
function loadExportFormat(): ExportFormat {
  const saved = localStorage.getItem('accounts_exportFormat')
  return (EXPORT_FORMATS as readonly string[]).includes(saved ?? '')
    ? (saved as ExportFormat)
    : 'json'
}

interface ExportDialogProps {
  open: boolean
  onClose: () => void
  accounts: Account[]
  selectedCount: number
}

export function ExportDialog({ open, onClose, accounts, selectedCount }: ExportDialogProps) {
  // 导出格式持久化到 localStorage，账号页/设置页两个入口共用
  const [selectedFormat, setSelectedFormat] = useState<ExportFormat>(loadExportFormat)
  useEffect(() => {
    localStorage.setItem('accounts_exportFormat', selectedFormat)
  }, [selectedFormat])
  const [includeCredentials, setIncludeCredentials] = useState(true)
  const [copied, setCopied] = useState(false)
  const { exportAccounts } = useAccountsStore()
  const { t } = useTranslation()
  const isEn = t('common.unknown') === 'Unknown'

  if (!open) return null

  const formats: { id: ExportFormat; name: string; icon: typeof FileJson; desc: string }[] = [
    { id: 'json', name: 'JSON', icon: FileJson, desc: isEn ? 'Full data, can be imported' : '完整数据，可用于导入' },
    { id: 'oidc', name: 'OIDC JSON', icon: Braces, desc: isEn ? 'Minimal JSON, paste to OIDC batch import' : 'OIDC 精简 JSON，可粘贴到批量添加' },
    { id: 'kami', name: isEn ? 'Card Key' : '卡密', icon: Key, desc: isEn ? 'email----password----token----id----secret' : '卡密格式：邮箱----密码----Token----ID----Secret' },
    { id: 'txt', name: 'TXT', icon: FileText, desc: isEn ? 'Text format' : (includeCredentials ? '可导入格式：邮箱,Token,昵称,登录方式' : '纯文本格式，每行一个账号') },
    { id: 'csv', name: 'CSV', icon: Table, desc: isEn ? 'Excel compatible' : (includeCredentials ? '可导入格式，Excel 兼容' : 'Excel 兼容格式') },
    { id: 'clipboard', name: isEn ? 'Clipboard' : '剪贴板', icon: Clipboard, desc: isEn ? 'Copy to clipboard' : (includeCredentials ? '可导入格式：邮箱,Token' : '复制到剪贴板') },
  ]

  // 生成导出内容
  const generateContent = (format: ExportFormat): string => {
    switch (format) {
      case 'json':
        // 使用 store 的 exportAccounts 函数导出完整数据
        const exportData = exportAccounts(accounts.map(a => a.id))
        // 如果不包含凭证，移除敏感信息
        if (!includeCredentials) {
          exportData.accounts = exportData.accounts.map(acc => ({
            ...acc,
            credentials: {
              ...acc.credentials,
              accessToken: '',
              refreshToken: '',
              csrfToken: ''
            }
          }))
        }
        return JSON.stringify(exportData, null, 2)

      case 'oidc': {
        // 精简 JSON：只含关键凭证（邮箱/密码/refreshToken/clientId/clientSecret/provider）
        // 字段名与 OIDC 批量添加的 JSON 解析对齐，可直接复制粘贴导入
        const minimal = accounts.map(acc => {
          const item: Record<string, string> = {
            email: acc.email,
            refreshToken: acc.credentials?.refreshToken || '',
            provider: acc.idp || 'BuilderId'
          }
          if (acc.password) item.password = acc.password
          if (acc.credentials?.clientId) item.clientId = acc.credentials.clientId
          if (acc.credentials?.clientSecret) item.clientSecret = acc.credentials.clientSecret
          return item
        })
        return JSON.stringify(minimal, null, 2)
      }

      case 'txt':
        if (includeCredentials) {
          // 包含凭证时导出可导入格式：邮箱,RefreshToken,昵称,登录方式
          return accounts.map(acc => 
            [
              acc.email,
              acc.credentials?.refreshToken || '',
              acc.nickname || '',
              acc.idp || 'Google'
            ].join(',')
          ).join('\n')
        }
        // 不包含凭证时导出摘要信息
        return accounts.map(acc => {
          const lines = [
            `邮箱: ${acc.email}`,
            acc.nickname ? `昵称: ${acc.nickname}` : null,
            acc.idp ? `登录方式: ${acc.idp}` : null,
            acc.subscription?.title ? `订阅: ${acc.subscription.title}` : null,
            acc.usage ? `用量: ${acc.usage.current ?? 0}/${acc.usage.limit ?? 0}` : null,
          ].filter(Boolean)
          return lines.join('\n')
        }).join('\n\n---\n\n')

      case 'csv':
        // CSV 格式：包含凭证时可用于导入
        const headers = includeCredentials 
          ? ['邮箱', '昵称', '登录方式', 'RefreshToken', 'ClientId', 'ClientSecret', 'Region']
          : ['邮箱', '昵称', '登录方式', '订阅类型', '订阅标题', '已用量', '总额度']
        const rows = accounts.map(acc => includeCredentials 
          ? [
              acc.email,
              acc.nickname || '',
              acc.idp || '',
              acc.credentials?.refreshToken || '',
              acc.credentials?.clientId || '',
              acc.credentials?.clientSecret || '',
              acc.credentials?.region || 'us-east-1'
            ]
          : [
              acc.email,
              acc.nickname || '',
              acc.idp || '',
              acc.subscription?.type || '',
              acc.subscription?.title || '',
              String(acc.usage?.current ?? ''),
              String(acc.usage?.limit ?? '')
            ]
        )
        // 添加 BOM 以支持 Excel 中文
        return '\ufeff' + [headers, ...rows].map(row => 
          row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')
        ).join('\n')

      case 'kami':
        // 卡密格式：邮箱----密码----RefreshToken----ClientId----ClientSecret----登录方式
        // 第6字段(登录方式/idp)用于导入时还原认证方式：GitHub/Google 是 social 登录、无 ClientId/Secret，
        // 缺了它会被导入端误判为 BuilderId(IdC) 而验证失败
        return accounts.map(acc => 
          [
            acc.email,
            acc.password || 'no_password',
            acc.credentials?.refreshToken || '',
            acc.credentials?.clientId || '',
            acc.credentials?.clientSecret || '',
            acc.idp || 'BuilderId'
          ].join('----')
        ).join('\n')

      case 'clipboard':
        if (includeCredentials) {
          // 包含凭证时导出可导入格式：邮箱,RefreshToken
          return accounts.map(acc => 
            `${acc.email},${acc.credentials?.refreshToken || ''}`
          ).join('\n')
        }
        // 不包含凭证时导出摘要信息
        return accounts.map(acc => 
          `${acc.email}${acc.nickname ? ` (${acc.nickname})` : ''} - ${acc.subscription?.title || '未知订阅'}`
        ).join('\n')

      default:
        return ''
    }
  }

  // 导出处理
  const handleExport = async () => {
    const content = generateContent(selectedFormat)
    const count = accounts.length

    if (selectedFormat === 'clipboard') {
      await navigator.clipboard.writeText(content)
      setCopied(true)
      setTimeout(() => {
        setCopied(false)
        onClose()
      }, 1500)
      return
    }

    const extensions: Record<string, string> = {
      json: 'json',
      oidc: 'json',
      txt: 'txt',
      csv: 'csv',
      kami: 'txt'
    }
    const filename = `kiro-accounts-${new Date().toISOString().slice(0, 10)}.${extensions[selectedFormat]}`
    
    const success = await window.api.exportToFile(content, filename)
    if (success) {
      alert(isEn ? `Exported ${count} accounts` : `已导出 ${count} 个账号`)
      onClose()
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* 背景遮罩 */}
      <div 
        className="absolute inset-0 bg-black/50"
        onClick={onClose}
      />
      
      {/* 对话框 */}
      <div className="relative bg-background rounded-xl shadow-2xl w-[450px] animate-in fade-in zoom-in-95 duration-200">
        {/* 标题栏 */}
        <div className="flex items-center justify-between px-6 py-4 border-b">
          <div className="flex items-center gap-2">
            <Download className="h-5 w-5" />
            <h2 className="text-lg font-semibold">{isEn ? 'Export Accounts' : '导出账号'}</h2>
            <Badge variant="secondary">
              {selectedCount > 0 ? (isEn ? `${selectedCount} selected` : `${selectedCount} 个选中`) : (isEn ? `All ${accounts.length}` : `全部 ${accounts.length} 个`)}
            </Badge>
          </div>
          <Button 
            variant="ghost" 
            size="sm" 
            className="h-8 w-8 p-0 rounded-lg hover:bg-red-500 hover:text-white transition-colors"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
        
        {/* 格式选择 */}
        <div className="p-6 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            {formats.map(format => {
              const Icon = format.icon
              const isSelected = selectedFormat === format.id
              return (
                <button
                  key={format.id}
                  onClick={() => setSelectedFormat(format.id)}
                  className={cn(
                    "p-4 rounded-lg border-2 text-left transition-all",
                    isSelected 
                      ? "border-primary bg-primary/5" 
                      : "border-muted hover:border-muted-foreground/30"
                  )}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <Icon className={cn("h-4 w-4", isSelected && "text-primary")} />
                    <span className={cn("font-medium", isSelected && "text-primary")}>
                      {format.name}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">{format.desc}</p>
                </button>
              )
            })}
          </div>

          {/* 选项 */}
          {selectedFormat === 'oidc' && (
            <div className="p-3 bg-muted rounded-lg">
              <p className="text-xs text-muted-foreground">
                {isEn
                  ? 'Minimal JSON array (email / password / refreshToken / clientId / clientSecret / provider). Paste directly into the OIDC batch import box.'
                  : '精简 JSON 数组，含 邮箱 / 密码 / RefreshToken / ClientId / ClientSecret / provider，可直接粘贴到「OIDC 批量添加」输入框。'}
              </p>
            </div>
          )}
          {selectedFormat === 'kami' && (
            <div className="p-3 bg-muted rounded-lg">
              <p className="text-xs text-muted-foreground">
                {isEn ? 'Format: email----password----refreshToken----clientId----clientSecret' : '格式：邮箱----密码----RefreshToken----ClientId----ClientSecret'}
                <br />
                {isEn ? 'One account per line, empty lines are ignored. Supports auto-detection of separators (----, spaces, tabs)' : '每行一个账号，空行无效。导入时支持自动识别分隔符（----、空格、Tab）'}
              </p>
            </div>
          )}
          {selectedFormat === 'json' && (
            <label className="flex items-center gap-2 p-3 bg-muted rounded-lg cursor-pointer">
              <input
                type="checkbox"
                checked={includeCredentials}
                onChange={(e) => setIncludeCredentials(e.target.checked)}
                className="w-4 h-4 rounded"
              />
              <div>
                <p className="text-sm font-medium">{isEn ? 'Include credentials' : '包含凭证信息'}</p>
                <p className="text-xs text-muted-foreground">{isEn ? 'Include sensitive data for full import' : '包含 Token 等敏感数据，可用于完整导入'}</p>
              </div>
            </label>
          )}
        </div>

        {/* 底部按钮 */}
        <div className="flex justify-end gap-3 px-6 py-4 border-t bg-muted/30">
          <Button variant="outline" onClick={onClose}>
            {isEn ? 'Cancel' : '取消'}
          </Button>
          {(selectedFormat === 'kami' || selectedFormat === 'oidc') && (
            <Button variant="outline" disabled={copied} onClick={async () => {
              const content = generateContent(selectedFormat)
              await navigator.clipboard.writeText(content)
              setCopied(true)
              setTimeout(() => {
                setCopied(false)
                onClose()
              }, 1500)
            }}>
              {copied ? (
                <>
                  <Check className="h-4 w-4 mr-2" />
                  {isEn ? 'Copied' : '已复制'}
                </>
              ) : (
                <>
                  <Clipboard className="h-4 w-4 mr-2" />
                  {isEn ? 'Copy' : '复制到剪贴板'}
                </>
              )}
            </Button>
          )}
          <Button onClick={handleExport} disabled={copied}>
            {copied ? (
              <>
                <Check className="h-4 w-4 mr-2" />
                {isEn ? 'Copied' : '已复制'}
              </>
            ) : selectedFormat === 'clipboard' ? (
              <>
                <Clipboard className="h-4 w-4 mr-2" />
                {isEn ? 'Copy' : '复制到剪贴板'}
              </>
            ) : (
              <>
                <Download className="h-4 w-4 mr-2" />
                {isEn ? 'Export' : '导出'}
              </>
            )}
          </Button>
        </div>
      </div>
    </div>,
    document.body
  )
}


