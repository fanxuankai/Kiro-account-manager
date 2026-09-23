import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '../ui'
import { useTranslation } from '@/hooks/useTranslation'
import { X, Save, RefreshCw } from 'lucide-react'

interface SteeringEditorProps {
  filename: string
  onClose: () => void
  onSaved?: () => void
}

export function SteeringEditor({ filename, onClose, onSaved }: SteeringEditorProps) {
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [modified, setModified] = useState(false)
  const { t } = useTranslation()
  const isEn = t('common.unknown') === 'Unknown'

  useEffect(() => {
    loadContent()
  }, [filename])

  const loadContent = async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await window.api.readKiroSteeringFile(filename)
      if (result.success && result.content !== undefined) {
        setContent(result.content)
        setModified(false)
      } else {
        setError(result.error || (isEn ? 'Failed to read file' : '读取文件失败'))
      }
    } catch (err) {
      setError(isEn ? 'Failed to read file' : '读取文件失败')
      console.error(err)
    } finally {
      setLoading(false)
    }
  }

  const saveContent = async () => {
    setSaving(true)
    setError(null)
    try {
      const result = await window.api.saveKiroSteeringFile(filename, content)
      if (result.success) {
        setModified(false)
        onSaved?.()
      } else {
        setError(result.error || (isEn ? 'Failed to save file' : '保存文件失败'))
      }
    } catch (err) {
      setError(isEn ? 'Failed to save file' : '保存文件失败')
      console.error(err)
    } finally {
      setSaving(false)
    }
  }

  const handleClose = () => {
    if (modified) {
      if (confirm(isEn ? 'File modified. Close anyway? Unsaved changes will be lost.' : '文件已修改，确定要关闭吗？未保存的更改将丢失。')) {
        onClose()
      }
    } else {
      onClose()
    }
  }

  const handleChange = (value: string) => {
    setContent(value)
    setModified(true)
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div 
        className="absolute inset-0 bg-black/50"
        onClick={handleClose}
      />
      
      {/* Dialog */}
      <div className="relative bg-background rounded-lg shadow-xl w-[90vw] max-w-4xl h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <div className="flex items-center gap-2">
            <h2 className="font-semibold">{isEn ? 'Edit Steering File' : '编辑 Steering 文件'}</h2>
            <span className="text-sm text-muted-foreground font-mono">{filename}</span>
            {modified && <span className="text-xs text-warning">● {isEn ? 'Modified' : '已修改'}</span>}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={loadContent} disabled={loading}>
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </Button>
            <Button 
              variant="default" 
              size="sm" 
              onClick={saveContent} 
              disabled={saving || !modified}
            >
              <Save className="h-4 w-4 mr-1" />
              {saving ? (isEn ? 'Saving...' : '保存中...') : (isEn ? 'Save' : '保存')}
            </Button>
            <Button variant="ghost" size="sm" onClick={handleClose}>
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="px-4 py-2 bg-destructive/10 text-destructive text-sm">
            {error}
          </div>
        )}

        {/* Editor */}
        <div className="flex-1 p-4 overflow-hidden">
          {loading ? (
            <div className="flex items-center justify-center h-full">
              <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <textarea
              value={content}
              onChange={(e) => handleChange(e.target.value)}
              className="w-full h-full p-4 font-mono text-sm bg-muted rounded-lg border-0 resize-none focus:outline-none focus:ring-2 focus:ring-primary"
              placeholder={isEn ? 'Edit steering rules here...' : '在此编辑 Steering 规则...'}
              spellCheck={false}
            />
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-2 border-t text-xs text-muted-foreground">
          {isEn ? 'Tip: Steering files use Markdown format to define AI assistant behavior rules' : '提示：Steering 文件使用 Markdown 格式，用于定义 AI 助手的行为规则'}
        </div>
      </div>
    </div>,
    document.body
  )
}


