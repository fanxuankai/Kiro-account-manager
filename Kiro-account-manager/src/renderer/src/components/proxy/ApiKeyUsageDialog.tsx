import { useState, useMemo } from 'react'
import { X, BarChart3, Clock, Cpu, Coins, TrendingUp } from 'lucide-react'
import { Button, Card, CardContent, CardHeader, CardTitle, Badge } from '../ui'
import { useTranslation } from '../../hooks/useTranslation'

interface UsageRecord {
  timestamp: number
  model: string
  inputTokens: number
  outputTokens: number
  credits: number
  path: string
}

interface ModelStats {
  requests: number
  credits: number
  inputTokens: number
  outputTokens: number
}

interface DailyStats {
  requests: number
  credits: number
  inputTokens: number
  outputTokens: number
}

interface ApiKeyUsageDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  apiKey: {
    id: string
    name: string
    usage: {
      totalRequests: number
      totalCredits: number
      totalInputTokens: number
      totalOutputTokens: number
      daily: Record<string, DailyStats>
      byModel?: Record<string, ModelStats>
    }
    usageHistory?: UsageRecord[]
  } | null
}

export function ApiKeyUsageDialog({ open, onOpenChange, apiKey }: ApiKeyUsageDialogProps) {
  const { t } = useTranslation()
  const isEn = t('common.unknown') === 'Unknown'
  const [activeTab, setActiveTab] = useState<'history' | 'model' | 'daily'>('history')

  const formatTime = (timestamp: number) => {
    const date = new Date(timestamp)
    return date.toLocaleString()
  }

  const formatModel = (model: string) => {
    return model.replace('anthropic.', '').replace('-v1:0', '')
  }

  // 计算每日统计（最近7天）
  const dailyChartData = useMemo(() => {
    if (!apiKey?.usage.daily) return []
    const entries = Object.entries(apiKey.usage.daily)
      .sort((a, b) => b[0].localeCompare(a[0]))
      .slice(0, 7)
      .reverse()
    return entries.map(([date, stats]) => ({
      date: date.slice(5), // MM-DD
      ...stats
    }))
  }, [apiKey?.usage.daily])

  // 计算模型统计
  const modelStats = useMemo(() => {
    if (!apiKey?.usage.byModel) return []
    return Object.entries(apiKey.usage.byModel)
      .map(([model, stats]) => ({
        model: formatModel(model),
        ...stats
      }))
      .sort((a, b) => b.requests - a.requests)
  }, [apiKey?.usage.byModel])

  // 计算最大值用于图表
  const maxDailyCredits = useMemo(() => {
    return Math.max(...dailyChartData.map(d => d.credits), 0.001)
  }, [dailyChartData])

  const maxModelRequests = useMemo(() => {
    return Math.max(...modelStats.map(m => m.requests), 1)
  }, [modelStats])

  if (!open || !apiKey) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={() => onOpenChange(false)} />
      <Card className="relative w-[900px] max-h-[85vh] shadow-2xl border-0 overflow-hidden animate-in fade-in zoom-in-95 duration-200 glass-card-strong">
        <CardHeader className="pb-3 border-b sticky top-0 z-10">
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg flex items-center gap-2">
              <BarChart3 className="h-5 w-5 text-primary" />
              {isEn ? 'Usage Details' : '用量详情'} - {apiKey.name}
            </CardTitle>
            <Button variant="ghost" size="icon" className="h-8 w-8 rounded-lg hover:bg-red-500 hover:text-white transition-colors" onClick={() => onOpenChange(false)}>
              <X className="h-4 w-4" />
            </Button>
          </div>
          
          {/* 总计统计 */}
          <div className="grid grid-cols-4 gap-4 mt-4">
            <div className="bg-primary/10 rounded-lg p-3">
              <div className="text-xs text-muted-foreground mb-1">{isEn ? 'Total Requests' : '总请求数'}</div>
              <div className="text-xl font-bold text-primary">{apiKey.usage.totalRequests.toLocaleString()}</div>
            </div>
            <div className="bg-success/10 rounded-lg p-3">
              <div className="text-xs text-muted-foreground mb-1">{isEn ? 'Total Credits' : '总 Credits'}</div>
              <div className="text-xl font-bold text-success">{apiKey.usage.totalCredits.toFixed(4)}</div>
            </div>
            <div className="bg-primary/10 rounded-lg p-3">
              <div className="text-xs text-muted-foreground mb-1">{isEn ? 'Input Tokens' : '输入 Tokens'}</div>
              <div className="text-xl font-bold text-primary">{apiKey.usage.totalInputTokens.toLocaleString()}</div>
            </div>
            <div className="bg-[var(--gradient-to)]/10 rounded-lg p-3">
              <div className="text-xs text-muted-foreground mb-1">{isEn ? 'Output Tokens' : '输出 Tokens'}</div>
              <div className="text-xl font-bold text-[var(--gradient-to)]">{apiKey.usage.totalOutputTokens.toLocaleString()}</div>
            </div>
          </div>

          {/* Tab 切换 */}
          <div className="flex gap-2 mt-4">
            <Button
              variant={activeTab === 'history' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setActiveTab('history')}
            >
              <Clock className="h-4 w-4 mr-1" />
              {isEn ? 'History' : '历史记录'}
            </Button>
            <Button
              variant={activeTab === 'model' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setActiveTab('model')}
            >
              <Cpu className="h-4 w-4 mr-1" />
              {isEn ? 'By Model' : '按模型'}
            </Button>
            <Button
              variant={activeTab === 'daily' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setActiveTab('daily')}
            >
              <TrendingUp className="h-4 w-4 mr-1" />
              {isEn ? 'Daily Stats' : '每日统计'}
            </Button>
          </div>
        </CardHeader>
        
        <CardContent className="p-4 max-h-[calc(85vh-280px)] overflow-y-auto">
          {/* 历史记录 */}
          {activeTab === 'history' && (
            <div>
              {apiKey.usageHistory && apiKey.usageHistory.length > 0 ? (
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 sticky top-0">
                    <tr>
                      <th className="text-left p-2 font-medium">{isEn ? 'Time' : '时间'}</th>
                      <th className="text-left p-2 font-medium">{isEn ? 'Model' : '模型'}</th>
                      <th className="text-left p-2 font-medium">{isEn ? 'Path' : '路径'}</th>
                      <th className="text-right p-2 font-medium">{isEn ? 'In' : '输入'}</th>
                      <th className="text-right p-2 font-medium">{isEn ? 'Out' : '输出'}</th>
                      <th className="text-right p-2 font-medium">Credits</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono">
                    {apiKey.usageHistory.map((record, idx) => (
                      <tr key={idx} className="border-b border-muted/30 hover:bg-muted/30">
                        <td className="p-2 text-muted-foreground whitespace-nowrap text-xs">{formatTime(record.timestamp)}</td>
                        <td className="p-2 truncate max-w-[150px]" title={record.model}>{formatModel(record.model)}</td>
                        <td className="p-2 truncate max-w-[120px] text-muted-foreground" title={record.path}>{record.path}</td>
                        <td className="p-2 text-right text-muted-foreground">{record.inputTokens.toLocaleString()}</td>
                        <td className="p-2 text-right text-muted-foreground">{record.outputTokens.toLocaleString()}</td>
                        <td className="p-2 text-right text-muted-foreground">{record.credits.toFixed(6)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="flex items-center justify-center h-32 text-muted-foreground">
                  {isEn ? 'No usage history yet' : '暂无用量记录'}
                </div>
              )}
            </div>
          )}

          {/* 模型统计 */}
          {activeTab === 'model' && (
            <div className="space-y-4">
              {modelStats.length > 0 ? (
                modelStats.map((stat, idx) => (
                  <div key={idx} className="bg-muted/30 rounded-lg p-4">
                    <div className="flex items-center justify-between mb-2">
                      <div className="font-medium flex items-center gap-2">
                        <Cpu className="h-4 w-4 text-primary" />
                        {stat.model}
                      </div>
                      <Badge variant="secondary">{stat.requests} {isEn ? 'requests' : '次请求'}</Badge>
                    </div>
                    {/* 进度条 */}
                    <div className="h-2 bg-muted rounded-full overflow-hidden mb-3">
                      <div 
                        className="h-full bg-primary transition-all"
                        style={{ width: `${(stat.requests / maxModelRequests) * 100}%` }}
                      />
                    </div>
                    <div className="grid grid-cols-3 gap-4 text-sm">
                      <div>
                        <span className="text-muted-foreground">{isEn ? 'Credits' : 'Credits'}:</span>
                        <span className="ml-2 font-mono">{stat.credits.toFixed(4)}</span>
                      </div>
                      <div>
                        <span className="text-muted-foreground">{isEn ? 'Input' : '输入'}:</span>
                        <span className="ml-2 font-mono">{stat.inputTokens.toLocaleString()}</span>
                      </div>
                      <div>
                        <span className="text-muted-foreground">{isEn ? 'Output' : '输出'}:</span>
                        <span className="ml-2 font-mono">{stat.outputTokens.toLocaleString()}</span>
                      </div>
                    </div>
                  </div>
                ))
              ) : (
                <div className="flex items-center justify-center h-32 text-muted-foreground">
                  {isEn ? 'No model statistics yet' : '暂无模型统计'}
                </div>
              )}
            </div>
          )}

          {/* 每日统计 */}
          {activeTab === 'daily' && (
            <div className="space-y-4">
              {dailyChartData.length > 0 ? (
                <>
                  {/* 简单柱状图 */}
                  <div className="bg-muted/30 rounded-lg p-4">
                    <div className="text-sm font-medium mb-4 flex items-center gap-2">
                      <Coins className="h-4 w-4 text-primary" />
                      {isEn ? 'Daily Credits (Last 7 Days)' : '每日 Credits（最近7天）'}
                    </div>
                    <div className="flex items-end gap-2 h-32">
                      {dailyChartData.map((data, idx) => (
                        <div key={idx} className="flex-1 flex flex-col items-center">
                          <div 
                            className="w-full bg-primary rounded-t transition-all hover:bg-primary/80"
                            style={{ height: `${(data.credits / maxDailyCredits) * 100}%`, minHeight: '4px' }}
                            title={`${data.credits.toFixed(4)} credits`}
                          />
                          <div className="text-xs text-muted-foreground mt-2">{data.date}</div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* 每日详情表格 */}
                  <table className="w-full text-sm">
                    <thead className="bg-muted/50">
                      <tr>
                        <th className="text-left p-2 font-medium">{isEn ? 'Date' : '日期'}</th>
                        <th className="text-right p-2 font-medium">{isEn ? 'Requests' : '请求数'}</th>
                        <th className="text-right p-2 font-medium">Credits</th>
                        <th className="text-right p-2 font-medium">{isEn ? 'Input' : '输入'}</th>
                        <th className="text-right p-2 font-medium">{isEn ? 'Output' : '输出'}</th>
                      </tr>
                    </thead>
                    <tbody className="font-mono">
                      {Object.entries(apiKey.usage.daily)
                        .sort((a, b) => b[0].localeCompare(a[0]))
                        .slice(0, 30)
                        .map(([date, stats], idx) => (
                          <tr key={idx} className="border-b border-muted/30 hover:bg-muted/30">
                            <td className="p-2">{date}</td>
                            <td className="p-2 text-right">{stats.requests}</td>
                            <td className="p-2 text-right">{stats.credits.toFixed(4)}</td>
                            <td className="p-2 text-right text-muted-foreground">{stats.inputTokens.toLocaleString()}</td>
                            <td className="p-2 text-right text-muted-foreground">{stats.outputTokens.toLocaleString()}</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </>
              ) : (
                <div className="flex items-center justify-center h-32 text-muted-foreground">
                  {isEn ? 'No daily statistics yet' : '暂无每日统计'}
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}


