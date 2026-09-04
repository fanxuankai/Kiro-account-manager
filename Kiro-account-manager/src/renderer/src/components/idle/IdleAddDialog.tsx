import { useState, useEffect } from 'react'
import { X, ClipboardPaste, FolderOpen, Loader2 } from 'lucide-react'
import { Button, Card, CardContent, CardHeader, CardTitle } from '../ui'
import { useIdleAccountsStore } from '@/store/idleAccounts'
import { useTranslation } from '@/hooks/useTranslation'
import { splitCredentialLine } from '@/lib/utils'

interface IdleAddDialogProps {
  isOpen: boolean
  onClose: () => void
}

// 闲置库添加账号：纯离线粘贴导入（不做任何在线验证/在线登录）。
// 支持三种粘贴格式，自动识别：
//  1. JSON 数组/对象（与「导出 → OIDC JSON」格式对齐：email/refreshToken/clientId/clientSecret/provider...）
//  2. 卡密：邮箱----密码----RefreshToken----ClientId----ClientSecret[----登录方式]
//  3. 普通行：邮箱,RefreshToken[,昵称[,登录方式]]（兼容 | 分隔）
// 邮箱缺失的凭证会被跳过（离线无法从 token 反查邮箱）。
export function IdleAddDialog({ isOpen, onClose }: IdleAddDialogProps): React.ReactNode {
  const { groups, importAccounts } = useIdleAccountsStore()
  const { t } = useTranslation()
  const isEn = t('common.unknown') === 'Unknown'

  const [pasteText, setPasteText] = useState('')
  const [selectedGroupId, setSelectedGroupId] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  // 打开时重置表单
  useEffect(() => {
    if (isOpen) {
      setPasteText('')
      setSelectedGroupId('')
      setError(null)
    }
  }, [isOpen])

  const parsePastedCredentials = (): {
    items: Array<{
      email: string
      password?: string
      refreshToken: string
      clientId?: string
      clientSecret?: string
      region?: string
      idp?: string
      nickname?: string
    }>
    invalidCount: number
  } => {
    const trimmed = pasteText.trim()
    if (!trimmed) {
      throw new Error(isEn ? 'Please paste credential data' : '请粘贴凭证数据')
    }

    // 1) 尝试 JSON（数组或单对象）
    try {
      const parsed = JSON.parse(trimmed) as unknown
      const arr = Array.isArray(parsed) ? parsed : [parsed]
      const items: Array<{ email: string; password?: string; refreshToken: string; clientId?: string; clientSecret?: string; region?: string; idp?: string }> = []
      let invalid = 0
      for (const raw of arr) {
        if (!raw || typeof raw !== 'object') { invalid++; continue }
        const obj = raw as Record<string, unknown>
        const email = typeof obj.email === 'string' ? obj.email.trim() : ''
        const refreshToken = typeof obj.refreshToken === 'string' ? obj.refreshToken.trim() : ''
        if (!refreshToken) { invalid++; continue }
        if (!email) { invalid++; continue } // 离线无法从 token 反查邮箱
        items.push({
          email,
          password: typeof obj.password === 'string' ? obj.password : undefined,
          refreshToken,
          clientId: typeof obj.clientId === 'string' ? obj.clientId : undefined,
          clientSecret: typeof obj.clientSecret === 'string' ? obj.clientSecret : undefined,
          region: typeof obj.region === 'string' ? obj.region : undefined,
          idp: typeof obj.provider === 'string' ? obj.provider : undefined
        })
      }
      if (items.length === 0 && invalid > 0) {
        throw new Error(isEn ? 'No valid credentials (need email + refreshToken)' : '没有有效凭证（JSON 需包含 email 和 refreshToken）')
      }
      return { items, invalidCount: invalid }
    } catch (e) {
      if (e instanceof SyntaxError) {
        // 非 JSON → 走行格式解析
      } else {
        throw e
      }
    }

    // 2) 行格式：卡密（含 ----）或普通（, / | 分隔）
    const lines = trimmed.split('\n').filter(line => line.trim() && !line.trim().startsWith('#'))
    if (lines.length === 0) {
      throw new Error(isEn ? 'Empty input' : '输入为空')
    }

    const items: Array<{ email: string; password?: string; refreshToken: string; clientId?: string; clientSecret?: string; idp?: string; nickname?: string }> = []
    let invalid = 0

    for (const line of lines) {
      if (line.includes('----')) {
        // 卡密格式：邮箱----密码----RefreshToken----ClientId----ClientSecret[----登录方式]
        const parts = splitCredentialLine(line)
        const email = parts[0]?.trim() || ''
        const rawPwd = parts[1]?.trim()
        const refreshToken = parts[2]?.trim() || ''
        const clientId = parts[3]?.trim() || undefined
        const clientSecret = parts[4]?.trim() || undefined
        const rawIdp = parts[5]?.trim()
        const idp = rawIdp || ((!clientId && !clientSecret) ? 'Google' : 'BuilderId')
        if (!email || !refreshToken) { invalid++; continue }
        items.push({
          email,
          password: (rawPwd && rawPwd !== 'no_password') ? rawPwd : undefined,
          refreshToken,
          clientId,
          clientSecret,
          idp
        })
      } else {
        // 普通格式：邮箱,RefreshToken[,昵称[,登录方式]]（兼容 | 分隔）
        const parts = line.includes('|') ? line.split('|') : line.split(',')
        const email = parts[0]?.trim() || ''
        const refreshToken = parts[1]?.trim() || ''
        if (!email || !refreshToken) { invalid++; continue }
        items.push({
          email,
          refreshToken,
          nickname: parts[2]?.trim() || undefined,
          idp: parts[3]?.trim() || 'Google'
        })
      }
    }

    if (items.length === 0) {
      throw new Error(isEn
        ? 'Invalid format. Use JSON / kami (email----pwd----token----id----secret) / email,token lines'
        : '格式错误：支持 JSON、卡密（邮箱----密码----Token----ID----Secret）、或 邮箱,Token 每行一个')
    }
    return { items, invalidCount: invalid }
  }

  const handleSubmit = async (): Promise<void> => {
    setIsSubmitting(true)
    setError(null)
    try {
      const { items, invalidCount } = parsePastedCredentials()
      const result = importAccounts(items.map(item => ({
        ...item,
        groupId: selectedGroupId || undefined
      })))
      const skipped = result.errors.find(e => e.id === 'skipped')?.error
      const parts = [
        `${isEn ? 'Imported' : '导入成功'} ${result.success} ${isEn ? 'account(s)' : '个'}`,
        invalidCount > 0 ? `${isEn ? 'invalid' : '格式无效'} ${invalidCount}` : '',
        skipped ?? ''
      ].filter(Boolean)
      alert(parts.join(isEn ? ', ' : '，'))
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : (isEn ? 'Import failed' : '导入失败'))
    } finally {
      setIsSubmitting(false)
    }
  }

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />

      <Card className="relative w-full max-w-xl max-h-[85vh] overflow-auto z-10 animate-in zoom-in-95 duration-200">
        <CardHeader className="pb-4 border-b sticky top-0 bg-background z-20">
          <div className="flex items-center justify-between">
            <CardTitle className="text-xl font-bold">{isEn ? 'Add Idle Account' : '添加闲置账号'}</CardTitle>
            <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full hover:bg-red-500 hover:text-white transition-colors" onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            {isEn ? 'Paste credentials (offline, no verification)' : '粘贴凭证批量添加（纯离线，不做在线验证）'}
          </p>
        </CardHeader>

        <CardContent className="p-6 space-y-5">
          {/* 离线说明 */}
          <div className="p-3 bg-muted/50 border border-border/50 rounded-lg text-xs text-muted-foreground">
            {isEn
              ? 'Idle accounts are never auto-refreshed. To restore keep-alive, move the account back to Account Manager.'
              : '闲置账号不会自动刷新 Token。需要保活时，请在列表中「移回账号管理」。'}
          </div>

          {/* 分组选择 */}
          <div className="space-y-2">
            <label className="text-sm font-medium flex items-center gap-1.5">
              <FolderOpen className="h-4 w-4 text-muted-foreground" />
              {isEn ? 'Add to group' : '添加到分组'}
            </label>
            <select
              value={selectedGroupId}
              onChange={(e) => setSelectedGroupId(e.target.value)}
              className="w-full h-10 px-3 py-2 text-sm rounded-xl border border-input bg-background/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
            >
              <option value="">{isEn ? 'Ungrouped' : '未分组'}</option>
              {Array.from(groups.values()).sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).map(g => (
                <option key={g.id} value={g.id}>{g.name}</option>
              ))}
            </select>
          </div>

          {/* 凭证粘贴 */}
          <div className="space-y-2">
            <label className="text-sm font-medium flex items-center gap-1.5">
              <ClipboardPaste className="h-4 w-4 text-muted-foreground" />
              {isEn ? 'Credentials' : '凭证数据'}
            </label>
            <textarea
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              placeholder={isEn
                ? 'Supports:\n1. JSON array [{email, refreshToken, clientId, clientSecret, provider}]\n2. Kami lines: email----password----token----id----secret\n3. Plain lines: email,token'
                : '支持格式：\n1. JSON 数组（含 email/refreshToken/clientId/clientSecret/provider）\n2. 卡密：邮箱----密码----Token----ID----Secret\n3. 普通行：邮箱,Token（每行一个）'}
              className="w-full min-h-[200px] px-3 py-2.5 text-sm rounded-xl border border-input bg-background/50 ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 resize-y font-mono text-xs"
            />
            <p className="text-xs text-muted-foreground">
              {isEn
                ? 'Credentials without email are skipped (offline import cannot resolve email from token).'
                : '缺少邮箱的凭证会被跳过（离线导入无法从 Token 反查邮箱）。'}
            </p>
          </div>

          {/* 错误信息 */}
          {error && (
            <div className="p-3 bg-destructive/10 text-destructive rounded-xl text-sm flex items-center gap-2 animate-in fade-in slide-in-from-top-2">
              <div className="w-1.5 h-1.5 rounded-full bg-destructive shrink-0" />
              {error}
            </div>
          )}
        </CardContent>

        {/* 底部按钮 */}
        <div className="sticky bottom-0 bg-background/95 backdrop-blur p-4 border-t flex justify-end gap-3 z-20">
          <Button variant="outline" onClick={onClose} className="rounded-xl h-10 px-6">
            {isEn ? 'Cancel' : '取消'}
          </Button>
          <Button onClick={handleSubmit} disabled={isSubmitting || !pasteText.trim()} className="rounded-xl h-10 px-6">
            {isSubmitting ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                {isEn ? 'Importing...' : '导入中...'}
              </>
            ) : (
              isEn ? 'Import' : '导入'
            )}
          </Button>
        </div>
      </Card>
    </div>
  )
}
