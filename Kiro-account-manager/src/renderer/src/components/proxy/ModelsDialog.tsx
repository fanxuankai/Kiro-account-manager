import { useState, useEffect } from 'react'
import { X, RefreshCw, Loader2, Cpu, FileText, Image, Hash, Sparkles, Zap, Shuffle, Brain, Database, AlertTriangle, Globe } from 'lucide-react'
import { Button, Card, CardContent, CardHeader, CardTitle, Badge } from '../ui'
import { cn } from '@/lib/utils'

interface ModelInfo {
  id: string
  name: string
  description: string
  inputTypes?: string[]
  maxInputTokens?: number | null
  maxOutputTokens?: number | null
  rateMultiplier?: number
  rateUnit?: string
  supportsThinking?: boolean
  thinkingEfforts?: string[]
  supportsPromptCaching?: boolean
  modelProvider?: string
}

interface ModelsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  isEn: boolean
  onOpenModelMapping?: () => void
  mappingCount?: number
}

export function ModelsDialog({
  open,
  onOpenChange,
  isEn,
  onOpenModelMapping,
  mappingCount = 0
}: ModelsDialogProps) {
  const [models, setModels] = useState<ModelInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [fromCache, setFromCache] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // IP 限制提示是否显示 (用户点击关闭后持久化)
  const [showIpTip, setShowIpTip] = useState(() => {
    return localStorage.getItem('models_dialog_ip_tip_dismissed') !== '1'
  })

  const dismissIpTip = () => {
    localStorage.setItem('models_dialog_ip_tip_dismissed', '1')
    setShowIpTip(false)
  }

  const fetchModels = async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await window.api.proxyGetModels()
      if (result.success) {
        setModels(result.models)
        setFromCache(result.fromCache || false)
      } else {
        setError(result.error || 'Failed to fetch models')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (open) {
      fetchModels()
    }
  }, [open])

  if (!open) return null

  const formatTokens = (tokens: number | null | undefined) => {
    if (tokens === null || tokens === undefined) return '-'
    if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(1)}M`
    if (tokens >= 1000) return `${(tokens / 1000).toFixed(0)}K`
    return tokens.toString()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={() => onOpenChange(false)} />
      <Card className="relative w-[850px] max-h-[85vh] shadow-2xl border-0 overflow-hidden animate-in fade-in zoom-in-95 duration-200 glass-card-strong">
        <CardHeader className="pb-4 border-b sticky top-0 z-10">
          <div className="flex items-center justify-between">
            <CardTitle className="text-xl flex items-center gap-3">
              <div className="p-2 rounded-xl bg-primary/10">
                <Cpu className="h-6 w-6 text-primary" />
              </div>
              <div>
                <span className="font-bold">{isEn ? 'Available Models' : '可用模型'}</span>
                <div className="flex items-center gap-2 mt-1">
                  <Badge className="bg-primary/10 text-primary border-primary/20 font-semibold">
                    {models.length} {isEn ? 'models' : '个模型'}
                  </Badge>
                  {fromCache && (
                    <Badge variant="secondary" className="text-xs bg-warning/10 text-warning border-0">
                      <Sparkles className="h-3 w-3 mr-1" />
                      {isEn ? 'Cached' : '缓存'}
                    </Badge>
                  )}
                </div>
              </div>
            </CardTitle>
            <div className="flex items-center gap-2">
              {onOpenModelMapping && (
                <Button 
                  variant="outline" 
                  size="sm" 
                  onClick={onOpenModelMapping}
                  className="rounded-lg"
                >
                  <Shuffle className="h-4 w-4" />
                  <span className="ml-1.5">{isEn ? 'Mapping' : '映射'}</span>
                  {mappingCount > 0 && (
                    <Badge className="ml-1.5 h-5 px-1.5 bg-primary/20 text-primary text-xs">
                      {mappingCount}
                    </Badge>
                  )}
                </Button>
              )}
              <Button 
                variant="outline" 
                size="sm" 
                onClick={fetchModels}
                disabled={loading}
                className="rounded-lg"
              >
                {loading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
                <span className="ml-1.5">{isEn ? 'Refresh' : '刷新'}</span>
              </Button>
              <Button variant="ghost" size="icon" className="h-9 w-9 rounded-lg hover:bg-red-500 hover:text-white transition-colors" onClick={() => onOpenChange(false)}>
                <X className="h-5 w-5" />
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-4">
          {/* IP 限制提示横幅 (Pro+ 订阅但缺失高级模型) */}
          {showIpTip && (
            <div className="mb-3 rounded-xl border border-warning/30 bg-gradient-to-r from-warning/10 to-warning/5 p-3.5 relative">
              <div className="flex items-start gap-3">
                <div className="shrink-0 p-1.5 rounded-lg bg-warning/20">
                  <AlertTriangle className="h-4 w-4 text-warning" />
                </div>
                <div className="flex-1 min-w-0 pr-6">
                  <p className="text-sm font-semibold text-warning mb-1.5 flex items-center gap-1.5">
                    <Globe className="h-3.5 w-3.5" />
                    {isEn
                      ? 'Pro/Pro Max subscription but missing advanced models?'
                      : '订阅 Pro/Pro Max 但看不到高级模型？'}
                  </p>
                  <p className="text-xs text-warning/90 leading-relaxed mb-1">
                    {isEn
                      ? 'This is likely caused by regional restrictions on China-mainland IPs. Try the following:'
                      : '这通常是国内 IP 被限制导致的。请尝试以下方案：'}
                  </p>
                  <ul className="text-xs text-warning/90 space-y-0.5 list-disc list-inside">
                    <li>{isEn ? 'Enable VPN/proxy (system-level or app-level)' : '开启 VPN / 代理（系统级或应用级均可）'}</li>
                    <li>{isEn ? 'Switch to high-quality outbound IP (US/EU residential preferred)' : '切换到优质外网 IP（推荐美国 / 欧洲住宅 IP）'}</li>
                    <li>{isEn ? 'Click Refresh after IP change to reload models' : 'IP 切换后点击右上角「刷新」重新加载模型'}</li>
                  </ul>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="absolute top-2 right-2 h-7 w-7 hover:bg-warning/20 text-warning"
                  onClick={dismissIpTip}
                  title={isEn ? "Don't show again" : '不再显示'}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
          <div className="max-h-[calc(85vh-140px)] overflow-y-auto pr-2">
            {loading && models.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
                <div className="p-4 rounded-full bg-primary/10 mb-4">
                  <Loader2 className="h-8 w-8 animate-spin text-primary" />
                </div>
                <p className="font-medium">{isEn ? 'Loading models...' : '加载模型中...'}</p>
              </div>
            ) : error ? (
              <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
                <div className="p-4 rounded-full bg-destructive/10 mb-4">
                  <X className="h-8 w-8 text-destructive" />
                </div>
                <p className="text-destructive font-medium">{error}</p>
                <p className="text-sm mt-2">{isEn ? 'Make sure proxy is running and has synced accounts' : '请确保代理服务已启动且已同步账号'}</p>
              </div>
            ) : models.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
                <div className="p-4 rounded-full bg-muted mb-4">
                  <Cpu className="h-8 w-8" />
                </div>
                <p className="font-medium">{isEn ? 'No models available' : '暂无可用模型'}</p>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                {models.map((model, index) => (
                  <div 
                    key={model.id} 
                    className={cn(
                      "group p-3 rounded-xl border hover:shadow-md hover:border-primary/30 transition-all duration-200",
                      index === 0 ? "border-primary/40 bg-primary/10" : "bg-background"
                    )}
                  >
                    <div className="flex items-start gap-2 mb-2">
                      <div className={cn(
                        "w-2 h-2 rounded-full mt-1.5 shrink-0",
                        index === 0 ? "bg-primary" : "bg-muted-foreground/30"
                      )} />
                      <div className="flex-1 min-w-0">
                        <code className="text-sm font-bold text-foreground">{model.id}</code>
                        {model.name && model.name !== model.id && (
                          <p className="text-[11px] text-primary/70 font-medium truncate">{model.name}</p>
                        )}
                      </div>
                    </div>
                    <p className="text-[11px] text-muted-foreground line-clamp-2 mb-2 pl-4">
                      {model.description || (isEn ? 'No description' : '无描述')}
                    </p>
                    <div className="flex items-center justify-between pt-2 border-t border-border/50">
                      <div className="flex items-center gap-2">
                        <div className="flex items-center gap-1">
                          {model.inputTypes?.includes('TEXT') && (
                            <Badge variant="secondary" className="text-[10px] px-1.5 h-5 bg-blue-500/10 text-blue-600 dark:text-blue-400 border-0">
                              <FileText className="h-3 w-3" />
                            </Badge>
                          )}
                          {model.inputTypes?.includes('IMAGE') && (
                            <Badge variant="secondary" className="text-[10px] px-1.5 h-5 bg-purple-500/10 text-purple-600 dark:text-purple-400 border-0">
                              <Image className="h-3 w-3" />
                            </Badge>
                          )}
                        </div>
                        {model.supportsThinking && (
                          <Badge variant="secondary" className="text-[10px] px-1.5 h-5 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-0" title={model.thinkingEfforts?.join(', ')}>
                            <Brain className="h-3 w-3" />
                          </Badge>
                        )}
                        {model.supportsPromptCaching && (
                          <Badge variant="secondary" className="text-[10px] px-1.5 h-5 bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 border-0">
                            <Database className="h-3 w-3" />
                          </Badge>
                        )}
                        {model.rateMultiplier !== undefined && (
                          <Badge variant="secondary" className="text-[10px] px-1.5 h-5 bg-amber-500/10 text-amber-600 dark:text-amber-400 border-0">
                            <Zap className="h-3 w-3 mr-0.5" />
                            {model.rateMultiplier}x {model.rateUnit || 'credit'}
                          </Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-1 text-[11px] font-mono text-muted-foreground">
                        <Hash className="h-3 w-3" />
                        <span className="text-green-600 dark:text-green-400">{formatTokens(model.maxInputTokens)}</span>
                        <span>/</span>
                        <span className="text-orange-600 dark:text-orange-400">{formatTokens(model.maxOutputTokens)}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}


