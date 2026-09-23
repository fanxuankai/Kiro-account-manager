import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { Button, Badge, Input } from '../ui'
import { Trash2, RefreshCw, Download, Search, X, Copy, ChevronDown, ChevronUp, ChevronsDown, ArrowDown, Filter } from 'lucide-react'
import { useTranslation } from '../../hooks/useTranslation'
import { useVirtualizer } from '@tanstack/react-virtual'

interface LogEntry {
  timestamp: string
  level: string
  category: string
  message: string
  data?: unknown
}

interface ProxyDetailedLogsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

// 自定义下拉框组件
interface DropdownOption {
  value: string
  label: string
  icon?: React.ReactNode
}

interface CustomDropdownProps {
  value: string
  options: DropdownOption[]
  onChange: (value: string) => void
  placeholder?: string
  className?: string
}

function CustomDropdown({ value, options, onChange, placeholder, className }: CustomDropdownProps) {
  const [isOpen, setIsOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  const selectedOption = options.find(opt => opt.value === value)

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  return (
    <div ref={dropdownRef} className={`relative ${className || ''}`}>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="relative h-8 px-2 pr-7 rounded-lg border border-border bg-background/50 text-xs cursor-pointer hover:border-primary/50 focus:border-primary focus:outline-none transition-all flex items-center gap-1.5"
      >
        {selectedOption?.icon}
        <span className="flex-1 text-left truncate">{selectedOption?.label || placeholder}</span>
        <ChevronDown className={`w-3.5 h-3.5 absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>
      
      {isOpen && (
        <div className="absolute top-full left-0 mt-1 min-w-full py-1 rounded-lg border border-border bg-popover shadow-lg z-50 animate-in fade-in-0 zoom-in-95">
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => {
                onChange(option.value)
                setIsOpen(false)
              }}
              className={`w-full px-2.5 py-1.5 text-xs text-left flex items-center gap-1.5 hover:bg-accent transition-colors ${
                option.value === value ? 'bg-accent text-accent-foreground' : ''
              }`}
            >
              {option.icon}
              <span>{option.label}</span>
              {option.value === value && (
                <svg className="w-4 h-4 ml-auto text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function ProxyDetailedLogsDialog({ open, onOpenChange }: ProxyDetailedLogsDialogProps) {
  const { t } = useTranslation()
  const isEn = t('common.unknown') === 'Unknown'
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [searchText, setSearchText] = useState('')
  const [levelFilter, setLevelFilter] = useState<string>('all')
  const [categoryFilter, setCategoryFilter] = useState<string>('all')
  const [isAtBottom, setIsAtBottom] = useState(true)
  const [newLogCount, setNewLogCount] = useState(0)
  const [expandedLogs, setExpandedLogs] = useState<Set<number>>(new Set())
  const prevLogCount = useRef(0)
  const [timeRange, setTimeRange] = useState<string>(() => {
    return localStorage.getItem('proxyLogs_timeRange') || 'all'
  })
  const [displayLimit, setDisplayLimit] = useState<string>(() => {
    return localStorage.getItem('proxyLogs_displayLimit') || 'all'
  })
  const scrollRef = useRef<HTMLDivElement>(null)
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null)

  const loadLogs = useCallback(async () => {
    try {
      const result = await window.api.proxyGetLogs()
      setLogs(result)
    } catch (error) {
      console.error('Failed to load logs:', error)
    }
  }, [])

  useEffect(() => {
    if (open) {
      setLoading(true)
      loadLogs().finally(() => setLoading(false))
      
      // 每 1.5 秒刷新一次
      pollIntervalRef.current = setInterval(() => {
        loadLogs().then(() => {
          // 如果用户不在底部，累计新日志数
          if (!isAtBottom && logs.length > prevLogCount.current) {
            setNewLogCount(prev => prev + (logs.length - prevLogCount.current))
          }
          prevLogCount.current = logs.length
        })
      }, 1500)
    }

    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current)
        pollIntervalRef.current = null
      }
    }
  }, [open, loadLogs, isAtBottom, logs.length])

  // 监听滚动位置判断是否在底部
  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    setIsAtBottom(atBottom)
    if (atBottom) setNewLogCount(0)
  }, [])

  const scrollToBottom = () => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
      setIsAtBottom(true)
      setNewLogCount(0)
    }
  }

  useEffect(() => {
    localStorage.setItem('proxyLogs_timeRange', timeRange)
  }, [timeRange])

  useEffect(() => {
    localStorage.setItem('proxyLogs_displayLimit', displayLimit)
  }, [displayLimit])

  const handleClearLogs = async () => {
    try {
      await window.api.proxyClearLogs()
      setLogs([])
    } catch (error) {
      console.error('Failed to clear logs:', error)
    }
  }

  const handleExportLogs = () => {
    const content = logs.map(log => {
      const dataStr = log.data ? ` | ${JSON.stringify(log.data)}` : ''
      return `[${log.timestamp}] [${log.level}] [${log.category}] ${log.message}${dataStr}`
    }).join('\n')

    const blob = new Blob([content], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `proxy-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.log`
    a.click()
    URL.revokeObjectURL(url)
  }

  const handleCopyLog = (log: LogEntry) => {
    const dataStr = log.data ? `\nData: ${JSON.stringify(log.data, null, 2)}` : ''
    const content = `[${log.timestamp}] [${log.level}] [${log.category}]\n${log.message}${dataStr}`
    navigator.clipboard.writeText(content)
  }

  const toggleExpand = (index: number) => {
    const newExpanded = new Set(expandedLogs)
    if (newExpanded.has(index)) {
      newExpanded.delete(index)
    } else {
      newExpanded.add(index)
    }
    setExpandedLogs(newExpanded)
  }

  // 获取所有类别（缓存）
  const categories = useMemo(() => {
    return Array.from(new Set(logs.map(log => log.category))).sort()
  }, [logs])

  // 时间范围过滤
  const getTimeRangeMs = (range: string): number => {
    const hour = 60 * 60 * 1000
    const day = 24 * hour
    switch (range) {
      case '1h': return hour
      case '6h': return 6 * hour
      case '12h': return 12 * hour
      case '1d': return day
      case '3d': return 3 * day
      case '7d': return 7 * day
      case '30d': return 30 * day
      case '180d': return 180 * day
      case '1y': return 365 * day
      default: return 0
    }
  }

  // 过滤日志（缓存，避免每次渲染都重新计算）
  const filteredLogs = useMemo(() => {
    const now = Date.now()
    const rangeMs = getTimeRangeMs(timeRange)
    const search = searchText.toLowerCase()
    
    let result = logs.filter(log => {
      // 时间范围过滤
      if (rangeMs > 0) {
        const logTime = new Date(log.timestamp).getTime()
        if (now - logTime > rangeMs) return false
      }
      if (levelFilter !== 'all' && log.level !== levelFilter) return false
      if (categoryFilter !== 'all' && log.category !== categoryFilter) return false
      if (search) {
        // 先检查 message 和 category（快速）
        if (log.message.toLowerCase().includes(search) ||
            log.category.toLowerCase().includes(search)) {
          return true
        }
        // 只有在前面没匹配时才检查 data（慢）
        if (log.data) {
          try {
            return JSON.stringify(log.data).toLowerCase().includes(search)
          } catch {
            return false
          }
        }
        return false
      }
      return true
    })
    
    // 显示条数限制
    if (displayLimit !== 'all') {
      const limit = parseInt(displayLimit)
      if (limit > 0) result = result.slice(-limit)
    }
    
    // 正序，最新在底部（配合智能跟随滚到底部）
    return result
  }, [logs, timeRange, levelFilter, categoryFilter, searchText, displayLimit])

  // 虚拟滚动
  const virtualizer = useVirtualizer({
    count: filteredLogs.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (idx) => expandedLogs.has(idx) ? 120 : 32,
    overscan: 20
  })

  // 智能滚动：在底部时自动跟随新日志
  useEffect(() => {
    if (isAtBottom && filteredLogs.length > 0) {
      virtualizer.scrollToIndex(filteredLogs.length - 1, { align: 'end' })
    }
  }, [filteredLogs.length, isAtBottom, virtualizer])

  const getLevelColor = (level: string) => {
    switch (level) {
      case 'ERROR': return 'bg-destructive/20 text-destructive border-destructive/30'
      case 'WARN': return 'bg-warning/20 text-warning border-warning/30'
      case 'INFO': return 'bg-primary/20 text-primary border-primary/30'
      case 'DEBUG': return 'bg-muted text-muted-foreground border-muted'
      default: return 'bg-muted text-muted-foreground border-muted'
    }
  }

  const getLevelRowBg = (level: string) => {
    switch (level) {
      case 'ERROR': return 'bg-destructive/5 hover:bg-destructive/10'
      case 'WARN': return 'bg-warning/5 hover:bg-warning/10'
      case 'INFO': return 'hover:bg-primary/5'
      case 'DEBUG': return 'hover:bg-muted/50'
      default: return 'hover:bg-muted/50'
    }
  }

  const formatTime = (timestamp: string) => {
    try {
      if (!timestamp) return '-'
      const date = new Date(timestamp)
      if (isNaN(date.getTime())) return timestamp || '-'
      const year = date.getFullYear()
      const month = (date.getMonth() + 1).toString().padStart(2, '0')
      const day = date.getDate().toString().padStart(2, '0')
      const hours = date.getHours().toString().padStart(2, '0')
      const minutes = date.getMinutes().toString().padStart(2, '0')
      const seconds = date.getSeconds().toString().padStart(2, '0')
      const ms = date.getMilliseconds().toString().padStart(3, '0')
      return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${ms}`
    } catch {
      return timestamp || '-'
    }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => onOpenChange(false)}>
      <div 
        className="glass-card-strong rounded-2xl shadow-2xl max-w-[90vw] w-[1200px] h-[80vh] flex flex-col overflow-hidden animate-in zoom-in-95 duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 标题栏 */}
        <div className="flex-shrink-0 flex items-center justify-between px-5 py-4 border-b border-border">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-primary/10">
              <svg className="w-5 h-5 text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            </div>
            <h2 className="text-lg font-semibold">{isEn ? 'Proxy Detailed Logs' : '反代详细日志'}</h2>
          </div>
          <div className="flex items-center gap-2">
            <CustomDropdown
              value={timeRange}
              onChange={setTimeRange}
              className="min-w-[70px]"
              options={[
                { value: 'all', label: isEn ? 'All Time' : '全部时间' },
                { value: '1h', label: isEn ? '1 Hour' : '1小时' },
                { value: '6h', label: isEn ? '6 Hours' : '6小时' },
                { value: '12h', label: isEn ? '12 Hours' : '12小时' },
                { value: '1d', label: isEn ? '1 Day' : '1天' },
                { value: '3d', label: isEn ? '3 Days' : '3天' },
                { value: '7d', label: isEn ? '7 Days' : '7天' },
                { value: '30d', label: isEn ? '30 Days' : '30天' },
                { value: '180d', label: isEn ? '180 Days' : '180天' },
                { value: '1y', label: isEn ? '1 Year' : '1年' },
              ]}
            />
            <CustomDropdown
              value={displayLimit}
              onChange={setDisplayLimit}
              className="min-w-[70px]"
              options={[
                { value: 'all', label: isEn ? 'All' : '全部' },
                { value: '5000', label: '5000' },
                { value: '10000', label: isEn ? '10K' : '1万' },
                { value: '50000', label: isEn ? '50K' : '5万' },
                { value: '100000', label: isEn ? '100K' : '10万' },
                { value: '200000', label: isEn ? '200K' : '20万' },
                { value: '500000', label: isEn ? '500K' : '50万' },
                { value: '1000000', label: isEn ? '1M' : '100万' },
              ]}
            />
            <Badge variant="secondary" className="font-mono">
              {filteredLogs.length} / {logs.length} {isEn ? 'entries' : '条'}
            </Badge>
            <Button variant="ghost" size="icon" className="rounded-full hover:bg-red-500 hover:text-white transition-colors" onClick={() => onOpenChange(false)}>
              <X className="w-4 h-4" />
            </Button>
          </div>
        </div>

        {/* 工具栏 */}
        <div className="flex-shrink-0 flex items-center gap-2 px-4 py-2.5 border-b border-border">
          {/* 搜索 */}
          <div className="relative flex-1 min-w-[100px]">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <Input
              placeholder={isEn ? 'Search logs...' : '搜索日志内容...'}
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              className="pl-8 pr-8 h-8 text-xs bg-background/50 border-border focus:border-primary"
            />
            {searchText && (
              <Button
                variant="ghost"
                size="icon"
                className="absolute right-1 top-1/2 -translate-y-1/2 w-7 h-7 rounded-full"
                onClick={() => setSearchText('')}
              >
                <X className="w-3.5 h-3.5" />
              </Button>
            )}
          </div>

          {/* 级别过滤 */}
          <CustomDropdown
            value={levelFilter}
            onChange={setLevelFilter}
            options={[
              { value: 'all', label: isEn ? 'All' : '全部', icon: <span className="w-2.5 h-2.5 rounded-full bg-gradient-to-r from-destructive via-warning to-primary" /> },
              { value: 'ERROR', label: 'ERR', icon: <span className="w-2.5 h-2.5 rounded-full bg-destructive" /> },
              { value: 'WARN', label: 'WARN', icon: <span className="w-2.5 h-2.5 rounded-full bg-warning" /> },
              { value: 'INFO', label: 'INFO', icon: <span className="w-2.5 h-2.5 rounded-full bg-primary" /> },
              { value: 'DEBUG', label: 'DBG', icon: <span className="w-2.5 h-2.5 rounded-full bg-gray-400" /> },
            ]}
          />

          {/* 类别过滤 */}
          <CustomDropdown
            value={categoryFilter}
            onChange={setCategoryFilter}
            className="min-w-[100px]"
            options={[
              { value: 'all', label: isEn ? 'All' : '全部', icon: <svg className="w-3 h-3 text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" /></svg> },
              ...categories.map(cat => ({ 
                value: cat, 
                label: cat,
                icon: <svg className="w-3 h-3 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A2 2 0 013 12V7a4 4 0 014-4z" /></svg>
              }))
            ]}
          />

          <div className="h-5 w-px bg-border flex-shrink-0" />

          {/* 显示条数 */}
          <CustomDropdown
            value={displayLimit}
            onChange={setDisplayLimit}
            className="min-w-[60px]"
            options={[
              { value: 'all', label: isEn ? 'All' : '全部' },
              { value: '5000', label: '5K' },
              { value: '10000', label: '10K' },
              { value: '50000', label: '50K' },
              { value: '100000', label: '100K' },
            ]}
          />

          {/* 时间范围 */}
          <CustomDropdown
            value={timeRange}
            onChange={setTimeRange}
            className="min-w-[60px]"
            options={[
              { value: 'all', label: isEn ? 'All' : '全部' },
              { value: '1h', label: '1h' },
              { value: '6h', label: '6h' },
              { value: '1d', label: '1d' },
              { value: '7d', label: '7d' },
            ]}
          />

          <div className="h-5 w-px bg-border flex-shrink-0" />

          {/* 操作按钮 */}
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={loadLogs} disabled={loading}>
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </Button>
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={handleExportLogs} disabled={logs.length === 0}>
            <Download className="w-3.5 h-3.5" />
          </Button>
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-destructive" onClick={handleClearLogs} disabled={logs.length === 0}>
            <Trash2 className="w-3.5 h-3.5" />
          </Button>
        </div>

        {/* 日志列表（虚拟滚动） */}
        <div className="flex-1 overflow-hidden relative">
          <div
            ref={scrollRef}
            className="h-full overflow-y-auto font-mono text-xs"
            onScroll={handleScroll}
          >
            {filteredLogs.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-2">
                <Filter className="h-8 w-8 opacity-20" />
                <span className="text-sm">{logs.length === 0 ? (isEn ? 'No logs yet' : '暂无日志记录') : (isEn ? 'No matching logs' : '没有匹配的日志')}</span>
              </div>
            ) : (
              <div style={{ height: virtualizer.getTotalSize(), width: '100%', position: 'relative' }}>
                {virtualizer.getVirtualItems().map(virtualRow => {
                  const index = virtualRow.index
                  const log = filteredLogs[index]
                  const isExpanded = expandedLogs.has(index)
                  const hasData = log.data !== undefined && log.data !== null

                  return (
                    <div
                      key={virtualRow.key}
                      data-index={index}
                      ref={virtualizer.measureElement}
                      style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${virtualRow.start}px)` }}
                      className={`group rounded-lg px-3 py-1.5 transition-colors ${getLevelRowBg(log.level)}`}
                    >
                      <div className="flex items-start gap-2">
                        <span className="text-muted-foreground whitespace-nowrap flex-shrink-0 tabular-nums text-[10px]">
                          {formatTime(log.timestamp)}
                        </span>
                        <Badge 
                          variant="outline" 
                          className={`text-[9px] px-1 py-0 flex-shrink-0 font-semibold ${getLevelColor(log.level)}`}
                        >
                          {log.level}
                        </Badge>
                        <span className="text-primary/80 flex-shrink-0 font-medium text-[10px]">{log.category}</span>
                        <span className="flex-1 break-all text-foreground/90 text-[11px]">{log.message}</span>
                        <div className="flex-shrink-0 opacity-0 group-hover:opacity-100 flex items-center gap-0.5 transition-opacity">
                          {hasData && (
                            <Button variant="ghost" size="icon" className="w-5 h-5 rounded-full" onClick={() => toggleExpand(index)}>
                              {isExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                            </Button>
                          )}
                          <Button variant="ghost" size="icon" className="w-5 h-5 rounded-full" onClick={() => handleCopyLog(log)}>
                            <Copy className="w-3 h-3" />
                          </Button>
                        </div>
                      </div>
                      {isExpanded && hasData && (
                        <pre className="mt-1.5 ml-20 p-2 rounded-md bg-muted/50 border border-border text-primary overflow-x-auto text-[10px] leading-4">
                          {JSON.stringify(log.data, null, 2)}
                        </pre>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* 回到底部浮动按钮 */}
          {!isAtBottom && (
            <button
              className="absolute bottom-3 right-3 flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-primary text-primary-foreground text-xs font-medium shadow-lg hover:bg-primary/90 transition-all"
              onClick={scrollToBottom}
            >
              <ChevronsDown className="h-3.5 w-3.5" />
              {newLogCount > 0 ? (
                <>{isEn ? `${newLogCount} new` : `${newLogCount} 条新`}</>
              ) : (
                <>{isEn ? 'Bottom' : '底部'}</>
              )}
            </button>
          )}
        </div>

        {/* 底部状态栏 */}
        <div className="flex-shrink-0 flex items-center justify-between px-4 py-1.5 border-t border-border text-[10px] text-muted-foreground">
          <span>{isEn ? 'Showing' : '显示'} {filteredLogs.length.toLocaleString()} / {logs.length.toLocaleString()}</span>
          <div className="flex items-center gap-1">
            <ArrowDown className={`h-3 w-3 ${isAtBottom ? 'text-success' : 'text-muted-foreground/40'}`} />
            <span>{isAtBottom ? (isEn ? 'Following' : '跟随中') : (isEn ? 'Scrolled up' : '已暂停跟随')}</span>
          </div>
        </div>
      </div>
    </div>
  )
}


