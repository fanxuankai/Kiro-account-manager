import { useState, useEffect } from 'react'
import { X, Download, Copy, Check } from 'lucide-react'
import { Button, Card, CardContent, CardHeader, CardTitle } from '../ui'
import { useIdleAccountsStore } from '@/store/idleAccounts'
import { useTranslation } from '@/hooks/useTranslation'
import type { Account } from '@/types/account'

interface IdleEditDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  account: Account | null
}

// 闲置库编辑账号：可改别名与凭证字段；不含"验证并刷新"等联网操作
export function IdleEditDialog({
  open,
  onOpenChange,
  account
}: IdleEditDialogProps): React.ReactNode {
  const { updateAccount } = useIdleAccountsStore()
  const { t } = useTranslation()
  const isEn = t('common.unknown') === 'Unknown'

  // OIDC 凭证（核心）
  const [refreshToken, setRefreshToken] = useState('')
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [region, setRegion] = useState('us-east-1')

  // 可编辑字段
  const [nickname, setNickname] = useState('')

  // 状态
  const [error, setError] = useState<string | null>(null)
  const [copiedToken, setCopiedToken] = useState(false)

  const handleCopyAccessToken = (): void => {
    if (account?.credentials.accessToken) {
      navigator.clipboard.writeText(account.credentials.accessToken)
      setCopiedToken(true)
      setTimeout(() => setCopiedToken(false), 2000)
    }
  }

  // 当账号变化时更新表单
  useEffect(() => {
    if (account) {
      setRefreshToken(account.credentials.refreshToken || '')
      setClientId(account.credentials.clientId || '')
      setClientSecret(account.credentials.clientSecret || '')
      setRegion(account.credentials.region || 'us-east-1')
      setNickname(account.nickname || '')
      setError(null)
    }
  }, [account])

  // 从本地配置导入（读取本地缓存文件，无网络请求）
  const handleImportFromLocal = async (): Promise<void> => {
    try {
      const result = await window.api.loadKiroCredentials()
      if (result.success && result.data) {
        setRefreshToken(result.data.refreshToken)
        setClientId(result.data.clientId)
        setClientSecret(result.data.clientSecret)
        setRegion(result.data.region)
        setError(null)
      } else {
        setError(result.error || (isEn ? 'Import failed' : '导入失败'))
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : (isEn ? 'Import failed' : '导入失败'))
    }
  }

  // 保存（纯本地：仅更新别名与凭证字段，其余快照保持不变）
  const handleSave = (): void => {
    if (!account) return

    updateAccount(account.id, {
      nickname: nickname || undefined,
      credentials: {
        ...account.credentials,
        refreshToken,
        clientId,
        clientSecret,
        region
      }
    })

    onOpenChange(false)
  }

  if (!open || !account) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={() => onOpenChange(false)} />

      <Card className="relative w-full max-w-lg max-h-[90vh] overflow-auto z-10 animate-in zoom-in-95 duration-200">
        {/* 头部 */}
        <CardHeader className="pb-4 border-b sticky top-0 bg-background z-20">
          <div className="flex items-center justify-between">
            <CardTitle className="text-xl font-bold">{isEn ? 'Edit Idle Account' : '编辑闲置账号'}</CardTitle>
            <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full hover:bg-red-500 hover:text-white transition-colors" onClick={() => onOpenChange(false)}>
              <X className="h-4 w-4" />
            </Button>
          </div>
          <p className="text-sm text-muted-foreground mt-1">{isEn ? 'Modify nickname or update credentials (offline)' : '修改别名或更新凭证（纯离线，不验证）'}</p>
        </CardHeader>

        <CardContent className="p-6 space-y-6">
          {/* 当前账号信息（快照） */}
          <div className="p-4 bg-primary/5 rounded-xl border border-primary/10 space-y-3">
            <div className="flex items-center justify-between border-b border-primary/10 pb-2">
              <span className="text-sm font-semibold text-foreground/80">{isEn ? 'Account Info (snapshot)' : '账号信息（快照）'}</span>
            </div>
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <span className="text-muted-foreground text-xs block mb-1">{isEn ? 'Email' : '邮箱'}</span>
                <span className="font-medium font-mono text-xs truncate block" title={account.email}>{account.email}</span>
              </div>
              <div>
                <span className="text-muted-foreground text-xs block mb-1">{isEn ? 'Plan' : '订阅计划'}</span>
                <span className="font-medium">{account.subscription.title || account.subscription.type}</span>
              </div>
              <div>
                <span className="text-muted-foreground text-xs block mb-1">{isEn ? 'Usage' : '使用额度'}</span>
                <span className="font-medium">
                  {account.usage.current.toLocaleString()} / {account.usage.limit.toLocaleString()}
                </span>
              </div>
              <div>
                <span className="text-muted-foreground text-xs block mb-1">{isEn ? 'Days Left' : '剩余天数'}</span>
                <span className="font-medium">{account.subscription.daysRemaining ?? '-'} {isEn ? 'd' : '天'}</span>
              </div>
            </div>
          </div>

          {/* 别名 */}
          <div className="space-y-2">
            <label className="text-sm font-medium">{isEn ? 'Nickname' : '账号别名'}</label>
            <input
              type="text"
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              placeholder={isEn ? 'Give this account a memorable name' : '给这个账号起个好记的名字'}
              className="w-full h-10 px-3 py-2 text-sm rounded-xl border border-input bg-background/50 ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
            />
          </div>

          {/* 凭证配置 */}
          <div className="space-y-5 pt-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-semibold">
                  {account.credentials.authMethod === 'social' ? (isEn ? 'Social Login' : '社交登录凭证') : (isEn ? 'OIDC Credentials' : 'OIDC 凭证配置')}
                </h3>
                {account.credentials.authMethod === 'social' && (
                  <span className="px-2 py-0.5 text-xs rounded-full bg-primary/10 text-primary">
                    {account.credentials.provider || account.idp}
                  </span>
                )}
              </div>
              {account.credentials.authMethod !== 'social' && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8 rounded-lg text-xs"
                  onClick={handleImportFromLocal}
                >
                  <Download className="h-3 w-3 mr-1.5" />
                  {isEn ? 'Import Local' : '从本地导入'}
                </Button>
              )}
            </div>

            {account.credentials.authMethod === 'social' && (
              <p className="text-xs text-muted-foreground">
                {isEn ? 'Social login only needs Refresh Token' : '社交登录账号只需要 Refresh Token，不需要 Client ID 和 Client Secret'}
              </p>
            )}

            <div className="space-y-4">
              {/* Access Token (只读，可复制) */}
              {account.credentials.accessToken && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="text-sm font-medium">Access Token</label>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      onClick={handleCopyAccessToken}
                    >
                      {copiedToken ? <Check className="h-3 w-3 mr-1 text-success" /> : <Copy className="h-3 w-3 mr-1" />}
                      {copiedToken ? (isEn ? 'Copied' : '已复制') : (isEn ? 'Copy' : '复制')}
                    </Button>
                  </div>
                  <div className="w-full px-3 py-2.5 text-sm rounded-xl border border-input bg-muted/50 font-mono text-muted-foreground truncate">
                    {account.credentials.accessToken.slice(0, 50)}...
                  </div>
                </div>
              )}

              <div className="space-y-2">
                <label className="text-sm font-medium">
                  Refresh Token <span className="text-destructive">*</span>
                </label>
                <textarea
                  value={refreshToken}
                  onChange={(e) => setRefreshToken(e.target.value)}
                  placeholder="aorAAAAA..."
                  className="w-full min-h-[80px] px-3 py-2.5 text-sm rounded-xl border border-input bg-background/50 ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 resize-none font-mono"
                />
              </div>

              {account.credentials.authMethod !== 'social' && (
                <>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <label className="text-sm font-medium">
                        Client ID
                      </label>
                      <input
                        type="text"
                        value={clientId}
                        onChange={(e) => setClientId(e.target.value)}
                        placeholder="Client ID"
                        className="w-full h-10 px-3 py-2 text-sm rounded-xl border border-input bg-background/50 ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 font-mono"
                      />
                    </div>

                    <div className="space-y-2">
                      <label className="text-sm font-medium">
                        Client Secret
                      </label>
                      <input
                        type="text"
                        value={clientSecret}
                        onChange={(e) => setClientSecret(e.target.value)}
                        placeholder="Client Secret"
                        className="w-full h-10 px-3 py-2 text-sm rounded-xl border border-input bg-background/50 ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 font-mono"
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <label className="text-sm font-medium">AWS Region</label>
                    <select
                      value={region}
                      onChange={(e) => setRegion(e.target.value)}
                      className="w-full h-10 px-3 py-2 text-sm rounded-xl border border-input bg-background/50 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                    >
                      <option value="us-east-1">us-east-1 (N. Virginia)</option>
                      <option value="us-west-2">us-west-2 (Oregon)</option>
                      <option value="eu-west-1">eu-west-1 (Ireland)</option>
                    </select>
                  </div>
                </>
              )}
            </div>
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
          <Button variant="outline" onClick={() => onOpenChange(false)} className="rounded-xl h-10 px-6">
            {isEn ? 'Cancel' : '取消'}
          </Button>
          <Button onClick={handleSave} className="rounded-xl h-10 px-6">
            {isEn ? 'Save Changes' : '保存更改'}
          </Button>
        </div>
      </Card>
    </div>
  )
}
