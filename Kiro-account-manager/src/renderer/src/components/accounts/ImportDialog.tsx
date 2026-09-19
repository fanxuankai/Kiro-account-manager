import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '../ui'
import { X, Upload, ClipboardPaste, Check, FileText } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/hooks/useTranslation'
import { parseImportContentAuto, type ParsedImport } from '@/lib/importParse'

/** 导入结果回执：ok=false 时 message 以错误样式展示，弹窗不关 */
export interface ImportResult {
  ok: boolean
  message: string
}

interface ImportDialogProps {
  open: boolean
  onClose: () => void
  /** 执行解析结果的入库（export / items 两类），返回结果回执；onProgress 用于验证式导入的进度回显 */
  onImport: (
    parsed: ParsedImport,
    onProgress?: (done: number, total: number) => void
  ) => Promise<ImportResult>
}

/**
 * 导入账号弹窗 — 粘贴与选文件双入口，共用自动格式识别。
 * 支持：完整导出 JSON / OIDC 凭证数组 / 卡密 / 邮箱,RefreshToken 行格式；
 * 粘贴内容带 markdown 代码围栏（```json ... ```）会自动剥离。
 */
export function ImportDialog({ open, onClose, onImport }: ImportDialogProps): React.ReactNode {
  const [content, setContent] = useState('')
  // 解析错误（格式不合法）与导入回执分开存：前者红字常驻，后者绿/红按 ok
  const [parseError, setParseError] = useState('')
  const [result, setResult] = useState<ImportResult | null>(null)
  const [importing, setImporting] = useState(false)
  // 验证式导入进度（已完成/总数），显示在导入按钮上
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const { t } = useTranslation()
  const isEn = t('common.unknown') === 'Unknown'

  useEffect(() => {
    if (open) {
      setContent('')
      setParseError('')
      setResult(null)
      setProgress(null)
    }
  }, [open])

  if (!open) return null

  // 粘贴或选文件拿到内容后的统一导入流程
  const runImport = async (raw: string): Promise<void> => {
    setParseError('')
    setResult(null)
    setProgress(null)
    const parsed = parseImportContentAuto(raw)
    if (parsed.kind === 'invalid') {
      setParseError(parsed.message)
      return
    }
    setImporting(true)
    // 点击即显示 0/n：进度回调只在每条完成时触发，不先占位的话验证期间按钮毫无反馈、像卡住
    if (parsed.kind === 'items') setProgress({ done: 0, total: parsed.items.length })
    try {
      const r = await onImport(parsed, (done, total) => setProgress({ done, total }))
      setResult(r)
      // 导入成功：短暂展示结果后自动关闭
      if (r.ok) {
        setTimeout(() => {
          onClose()
          setImporting(false)
        }, 1200)
        return
      }
    } finally {
      setImporting(false)
    }
  }

  const handlePickFile = async (): Promise<void> => {
    setParseError('')
    setResult(null)
    const fileData = await window.api.importFromFile()
    if (!fileData) return
    await runImport(fileData.content)
  }

  // 粘贴按钮：读剪贴板填入文本域（用户确认后再点导入）
  const handlePaste = async (): Promise<void> => {
    try {
      const text = await navigator.clipboard.readText()
      if (text) setContent((prev) => (prev ? prev + '\n' + text : text))
    } catch {
      /* 剪贴板权限被拒时静默，用户仍可手动 Ctrl/Cmd+V */
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
      <div className="relative bg-background rounded-xl shadow-2xl w-[500px] animate-in fade-in zoom-in-95 duration-200">
        {/* 标题栏 */}
        <div className="flex items-center justify-between px-6 py-4 border-b">
          <div className="flex items-center gap-2">
            <Upload className="h-5 w-5" />
            <h2 className="text-lg font-semibold">{isEn ? 'Import Accounts' : '导入账号'}</h2>
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

        {/* 内容区 */}
        <div className="p-6 space-y-3">
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder={isEn
              ? 'Paste credentials here: OIDC JSON array / full export JSON / card key lines (email----password----token----id----secret) / email,refreshToken'
              : '粘贴凭证内容：OIDC JSON 数组 / 完整导出 JSON / 卡密（邮箱----密码----Token----ID----Secret）/ 邮箱,RefreshToken'}
            className="w-full h-44 p-3 text-xs font-mono rounded-lg border bg-background resize-none focus:outline-none focus:ring-1 focus:ring-primary"
            spellCheck={false}
          />

          <div className="flex items-center justify-between">
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={handlePaste}>
                <ClipboardPaste className="h-4 w-4 mr-1.5" />
                {isEn ? 'Paste' : '粘贴'}
              </Button>
              <Button variant="outline" size="sm" onClick={handlePickFile}>
                <FileText className="h-4 w-4 mr-1.5" />
                {isEn ? 'Choose File' : '选择文件'}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {isEn ? 'Auto-detects format' : '自动识别格式'}
            </p>
          </div>

          {/* 解析错误：红字常驻，不关弹窗 */}
          {parseError && (
            <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-lg">
              <p className="text-xs text-red-600 dark:text-red-400">{parseError}</p>
            </div>
          )}

          {/* 导入回执：成功绿 / 失败红 */}
          {result && (
            <div className={cn(
              'p-3 border rounded-lg',
              result.ok
                ? 'bg-green-500/10 border-green-500/30'
                : 'bg-red-500/10 border-red-500/30'
            )}>
              <p className={cn(
                'text-xs flex items-start gap-1.5',
                result.ok ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'
              )}>
                {result.ok && <Check className="h-4 w-4 shrink-0 mt-0.5" />}
                {result.message}
              </p>
            </div>
          )}
        </div>

        {/* 底部按钮 */}
        <div className="flex justify-end gap-3 px-6 py-4 border-t bg-muted/30">
          <Button variant="outline" onClick={onClose}>
            {isEn ? 'Cancel' : '取消'}
          </Button>
          <Button
            onClick={() => runImport(content)}
            disabled={importing || !content.trim()}
          >
            <Upload className="h-4 w-4 mr-2" />
            {importing && progress
              ? `${isEn ? 'Importing' : '导入中'} ${progress.done}/${progress.total}`
              : result?.ok
                ? (isEn ? 'Imported' : '已导入')
                : (isEn ? 'Import' : '导入')}
          </Button>
        </div>
      </div>
    </div>,
    document.body
  )
}
