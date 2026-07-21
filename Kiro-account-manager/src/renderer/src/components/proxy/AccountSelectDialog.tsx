import { useState, useMemo } from 'react'
import { X, Search, Check, User, CreditCard, Zap, Mail, AlertCircle, Ban } from 'lucide-react'
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Badge } from '../ui'
import type { Account } from '../../types/account'

interface AccountSelectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  accounts: Map<string, Account>
  selectedAccountId?: string
  onSelect: (accountId: string | undefined) => void
  isEn: boolean
}

export function AccountSelectDialog({
  open,
  onOpenChange,
  accounts,
  selectedAccountId,
  onSelect,
  isEn
}: AccountSelectDialogProps) {
  const [searchQuery, setSearchQuery] = useState('')

  const accountList = useMemo(() => {
    return Array.from(accounts.values())
  }, [accounts])

  const filteredAccounts = useMemo(() => {
    if (!searchQuery.trim()) return accountList
    const query = searchQuery.toLowerCase()
    return accountList.filter(acc => 
      acc.email?.toLowerCase().includes(query) ||
      acc.id.toLowerCase().includes(query) ||
      acc.subscription?.title?.toLowerCase().includes(query)
    )
  }, [accountList, searchQuery])

  const handleSelect = (accountId: string | undefined) => {
    onSelect(accountId)
    onOpenChange(false)
  }

  const getUsagePercent = (acc: Account): number => {
    const usage = acc.usage
    if (!usage) return 0
    // 直接通过 current/limit 计算百分比，确保准确性
    if (usage.limit > 0) {
      return Math.min(100, (usage.current / usage.limit) * 100)
    }
    return usage.percentUsed || 0
  }

  const getUsageText = (acc: Account): string => {
    const usage = acc.usage
    if (!usage) return '-'
    return `${usage.current.toFixed(1)} / ${usage.limit}`
  }

  const getSubscriptionColor = (title?: string): string => {
    if (!title) return 'bg-gray-500 text-white'
    const t = title.toUpperCase()
    // KIRO PRO MAX - 玫红（必须先于 PRO+/PRO）
    if (t.includes('PRO_MAX') || t.includes('PRO MAX') || t.includes('PROMAX') || t === 'PRO_MAX') return 'bg-rose-500 text-white'
    // KIRO PRO+ / PRO_PLUS - 紫色
    if (t.includes('PRO+') || t.includes('PRO_PLUS') || t.includes('PROPLUS')) return 'bg-purple-500 text-white'
    // KIRO POWER - 金色
    if (t.includes('POWER')) return 'bg-amber-500 text-white'
    // KIRO PRO - 蓝色
    if (t.includes('PRO')) return 'bg-blue-500 text-white'
    // KIRO FREE - 灰色
    return 'bg-gray-500 text-white'
  }

  // 检测是否为封禁账号（通过 lastError 判断）
  const isBannedAccount = (acc: Account): boolean => {
    const lowerError = acc.lastError?.toLowerCase()
    if (!lowerError) return false
    const hasSuspendedSignal =
      lowerError.includes('accountsuspendedexception') ||
      lowerError.includes('account suspended') ||
      lowerError.includes('temporarily_suspended') ||
      lowerError.includes('temporarily suspended') ||
      (lowerError.includes('user id is') && lowerError.includes('suspended')) ||
      lowerError.includes('账户已封禁') ||
      lowerError.includes('已封禁') ||
      /\b423\b/.test(lowerError)
    if (hasSuspendedSignal) return true
    if (
      lowerError.includes('fetch failed') ||
      lowerError.includes('network') ||
      lowerError.includes('token expired') ||
      lowerError.includes('token 过期') ||
      lowerError.includes('刷新失败') ||
      lowerError.includes('unauthorizedexception')
    ) {
      return false
    }
    return false
  }

  const getStatusInfo = (acc: Account): { icon: React.ReactNode; text: string; color: string } | null => {
    // 优先检测封禁状态
    if (isBannedAccount(acc)) {
      return {
        icon: <Ban className="h-3.5 w-3.5" />,
        text: isEn ? 'Banned' : '已封禁',
        color: 'bg-destructive/10 text-destructive'
      }
    }
    
    switch (acc.status) {
      case 'error':
        return {
          icon: <AlertCircle className="h-3.5 w-3.5" />,
          text: isEn ? 'Error' : '错误',
          color: 'bg-destructive/10 text-destructive'
        }
      case 'expired':
        return {
          icon: <Ban className="h-3.5 w-3.5" />,
          text: isEn ? 'Expired' : '已过期',
          color: 'bg-warning/10 text-warning'
        }
      case 'refreshing':
        return {
          icon: <Zap className="h-3.5 w-3.5" />,
          text: isEn ? 'Refreshing' : '刷新中',
          color: 'bg-warning/10 text-warning'
        }
      case 'active':
        return null // 正常状态不显示标签
      default:
        return null
    }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={() => onOpenChange(false)} />
      <Card className="relative w-[600px] max-h-[80vh] shadow-2xl border-0 overflow-hidden animate-in fade-in zoom-in-95 duration-200 glass-card-strong">
        <CardHeader className="pb-3 border-b sticky top-0 z-10">
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg">{isEn ? 'Select Account' : '选择账号'}</CardTitle>
            <Button variant="ghost" size="icon" className="h-8 w-8 rounded-lg hover:bg-red-500 hover:text-white transition-colors" onClick={() => onOpenChange(false)}>
              <X className="h-4 w-4" />
            </Button>
          </div>
          <div className="relative mt-3">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder={isEn ? 'Search by email, ID or subscription...' : '搜索邮箱、ID 或订阅类型...'}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
            />
          </div>
        </CardHeader>
        <CardContent className="p-0 overflow-y-auto max-h-[60vh]">
          {/* 默认选项：第一个可用账号 */}
          <div
            className={`p-4 border-b cursor-pointer transition-colors hover:bg-accent/50 ${
              !selectedAccountId ? 'bg-primary/5 border-l-2 border-l-primary' : ''
            }`}
            onClick={() => handleSelect(undefined)}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center">
                  <Zap className="h-5 w-5 text-muted-foreground" />
                </div>
                <div>
                  <div className="font-medium">{isEn ? 'First Available' : '第一个可用账号'}</div>
                  <div className="text-sm text-muted-foreground">
                    {isEn ? 'Automatically use the first available account' : '自动使用第一个可用的账号'}
                  </div>
                </div>
              </div>
              {!selectedAccountId && (
                <Check className="h-5 w-5 text-primary" />
              )}
            </div>
          </div>

          {/* 账号列表 */}
          {filteredAccounts.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground">
              {searchQuery ? (isEn ? 'No accounts found' : '未找到匹配的账号') : (isEn ? 'No accounts available' : '暂无可用账号')}
            </div>
          ) : (
            filteredAccounts.map(acc => {
              const isSelected = selectedAccountId === acc.id
              const usagePercent = getUsagePercent(acc)
              const usageText = getUsageText(acc)
              const statusInfo = getStatusInfo(acc)
              const isBanned = isBannedAccount(acc)
              const hasError = acc.status === 'error' || acc.status === 'expired' || isBanned
              
              return (
                <div
                  key={acc.id}
                  className={`p-4 border-b cursor-pointer transition-colors hover:bg-accent/50 ${
                    isSelected ? 'bg-primary/5 border-l-2 border-l-primary' : ''
                  } ${hasError ? 'opacity-60' : ''}`}
                  onClick={() => handleSelect(acc.id)}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex items-start gap-3 flex-1 min-w-0">
                      <div className={`w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 ${
                        hasError ? 'bg-destructive/10' : 'bg-primary/10'
                      }`}>
                        {hasError ? (
                          <AlertCircle className="h-5 w-5 text-destructive" />
                        ) : (
                          <User className="h-5 w-5 text-primary" />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        {/* 邮箱 */}
                        <div className="flex items-center gap-2">
                          <Mail className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                          <span className="font-medium truncate">
                            {acc.email || acc.id.substring(0, 12) + '...'}
                          </span>
                          {/* 状态标签 */}
                          {statusInfo && (
                            <Badge className={`text-xs ${statusInfo.color}`}>
                              {statusInfo.icon}
                              <span className="ml-1">{statusInfo.text}</span>
                            </Badge>
                          )}
                        </div>
                        
                        {/* 错误信息 */}
                        {acc.lastError && (
                          <div className="text-xs text-destructive mt-1 truncate">
                            {acc.lastError}
                          </div>
                        )}
                        
                        {/* 订阅类型和使用量 */}
                        <div className="flex items-center gap-3 mt-2">
                          <Badge className={`text-xs ${getSubscriptionColor(acc.subscription?.title)}`}>
                            <CreditCard className="h-3 w-3 mr-1" />
                            {acc.subscription?.title || 'Unknown'}
                          </Badge>
                          <span className="text-xs text-muted-foreground">
                            {isEn ? 'Usage' : '使用量'}: {usageText}
                          </span>
                        </div>
                        
                        {/* 使用量进度条 */}
                        <div className="mt-2 w-full bg-muted rounded-full h-1.5 overflow-hidden">
                          <div 
                            className={`h-full transition-all ${
                              usagePercent > 80 ? 'bg-destructive' : usagePercent > 50 ? 'bg-warning' : 'bg-success'
                            }`}
                            style={{ width: `${usagePercent}%` }}
                          />
                        </div>
                        
                        {/* ID */}
                        <div className="text-xs text-muted-foreground mt-1.5 font-mono">
                          ID: {acc.id.substring(0, 20)}...
                        </div>
                      </div>
                    </div>
                    {isSelected && (
                      <Check className="h-5 w-5 text-primary flex-shrink-0 mt-2" />
                    )}
                  </div>
                </div>
              )
            })
          )}
        </CardContent>
      </Card>
    </div>
  )
}


