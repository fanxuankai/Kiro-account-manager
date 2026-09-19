import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import QRCode from 'qrcode'
import { Button } from '../ui'
import { useAccountsStore } from '@/store/accounts'
import type { Account } from '@/types/account'
import { cn } from '@/lib/utils'
import { formatPaymentLinkText } from './_helpers'
import { PayInAppDialog } from '../payment/PayInAppDialog'
import {
  Wallet,
  X,
  Copy,
  ExternalLink,
  Pencil,
  Trash2,
  AlertTriangle,
  Clock,
  Link2,
  CreditCard
} from 'lucide-react'

/**
 * 待付款支付链接弹窗 — 展示账号上落库的升级支付链接（subscription.paymentLink）。
 * 能力：二维码 / 三行复制（邮箱+说明+链接，与订阅页同格式）/ 无痕打开 / 手动编辑 / 清空。
 * 新鲜度按 paymentLinkAt 估算（超 24 小时提示可能过期——Stripe Checkout Session
 * 默认 24h 有效，实测口径 2026-09-19 确认）；paymentLinkAt 保留作历史标记。
 */

interface PaymentLinkDialogProps {
  /** 目标账号（null = 关闭） */
  account: Account | null
  onClose: () => void
  isEn: boolean
}

// 与订阅页链接失效判定同口径：Stripe Checkout Session 默认 24 小时
const LINK_STALE_AFTER_MS = 24 * 60 * 60 * 1000

function validHttpUrl(input: string): boolean {
  try {
    const u = new URL(input)
    return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname
  } catch {
    return false
  }
}

export function PaymentLinkDialog({
  account,
  onClose,
  isEn
}: PaymentLinkDialogProps): React.ReactNode {
  const updateAccount = useAccountsStore((s) => s.updateAccount)
  const sub = account?.subscription
  const url = sub?.paymentLink || ''
  const generatedAt = sub?.paymentLinkAt

  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')
  const [dataUrl, setDataUrl] = useState<string | null>(null)
  const [qrFailed, setQrFailed] = useState(false)
  const [copied, setCopied] = useState(false)
  const [payInApp, setPayInApp] = useState(false)

  // 打开/切换账号时进入查看态；无链接时直接进入编辑态（手动补录）
  useEffect(() => {
    setValue(url)
    setEditing(!url)
  }, [account?.id, url])

  // 生成二维码（Stripe 链接较长，中等纠错 + 2 倍尺寸保证 Retina 清晰）
  useEffect(() => {
    if (!url) return
    let cancelled = false
    setDataUrl(null)
    setQrFailed(false)
    QRCode.toDataURL(url, { width: 640, margin: 2, errorCorrectionLevel: 'M' })
      .then((d) => {
        if (!cancelled) setDataUrl(d)
      })
      .catch(() => {
        if (!cancelled) setQrFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [url])

  // Esc 关闭
  useEffect(() => {
    if (!account) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [account, onClose])

  if (!account) return null

  const stale = generatedAt !== undefined && Date.now() - generatedAt > LINK_STALE_AFTER_MS
  const minutesAgo =
    generatedAt !== undefined ? Math.max(0, Math.round((Date.now() - generatedAt) / 60000)) : null

  const handleCopy = async (): Promise<void> => {
    await navigator.clipboard.writeText(
      formatPaymentLinkText(account.email || account.id, url, sub?.paymentLinkPlan, isEn)
    )
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const handleOpen = async (): Promise<void> => {
    await window.api.openSubscriptionWindow(url)
  }

  const handleSave = (): void => {
    const link = value.trim()
    if (!validHttpUrl(link)) return
    // 手动补录时顺带点亮"待付款"标记（徽章/筛选依赖 paymentLinkAt）
    updateAccount(account.id, {
      subscription: {
        ...account.subscription,
        paymentLink: link,
        paymentLinkAt: account.subscription.paymentLinkAt ?? Date.now()
      }
    })
    setEditing(false)
  }

  const handleClear = (): void => {
    // 只清链接与套餐名；paymentLinkAt 保留作历史（与升级成功后的清空口径一致）
    updateAccount(account.id, {
      subscription: { ...account.subscription, paymentLink: undefined, paymentLinkPlan: undefined }
    })
    onClose()
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative bg-background rounded-xl shadow-2xl w-full max-w-md animate-in fade-in zoom-in-95 duration-200">
        {/* 标题栏 */}
        <div className="flex items-center justify-between px-5 py-3 border-b">
          <div className="flex items-center gap-2 min-w-0">
            <Wallet className="h-5 w-5 text-amber-600 flex-shrink-0" />
            <h2 className="text-base font-semibold truncate" title={account.email || account.id}>
              {account.email || account.id}
            </h2>
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

        {/* 新鲜度提示 */}
        {generatedAt !== undefined && (
          <div
            className={cn(
              'flex items-center gap-1.5 px-5 py-2 text-xs border-b',
              stale ? 'text-amber-600 bg-amber-500/5' : 'text-muted-foreground'
            )}
          >
            {stale ? (
              <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
            ) : (
              <Clock className="h-3.5 w-3.5 flex-shrink-0" />
            )}
            {stale
              ? isEn
                ? `May have expired — generated ${minutesAgo} min ago (valid for ~24h)`
                : `可能已过期：生成于 ${minutesAgo} 分钟前（有效期约 24 小时），建议重新获取`
              : isEn
                ? `Generated ${minutesAgo} min ago`
                : `生成于 ${minutesAgo} 分钟前`}
          </div>
        )}

        {editing ? (
          /* 编辑态：手动补录 / 修正链接 */
          <div className="px-5 py-4 space-y-3">
            <p className="text-xs text-muted-foreground">
              {isEn
                ? 'Enter the payment URL (http:// or https://)'
                : '输入支付链接（http:// 或 https:// 开头）'}
            </p>
            <input
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSave()
              }}
              placeholder="https://pay.stripe.com/..."
              className="w-full rounded-lg border border-foreground/15 bg-[var(--glass-bg)] backdrop-blur-md px-3 py-2 text-sm font-mono focus-visible:outline-none focus-visible:border-primary/50 focus-visible:ring-2 focus-visible:ring-primary/30"
            />
            <div className="flex justify-end gap-2">
              {url && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setValue(url)
                    setEditing(false)
                  }}
                >
                  {isEn ? 'Cancel' : '取消'}
                </Button>
              )}
              <Button size="sm" disabled={!validHttpUrl(value.trim())} onClick={handleSave}>
                {isEn ? 'Save' : '保存'}
              </Button>
            </div>
          </div>
        ) : (
          /* 查看态：二维码 + 链接 + 操作 */
          <div className="px-5 py-4 flex flex-col items-center gap-3">
            {dataUrl ? (
              <img src={dataUrl} alt="QR" className="w-52 h-52 rounded-lg border bg-white p-1" />
            ) : (
              <div className="w-52 h-52 rounded-lg border flex items-center justify-center text-xs text-muted-foreground">
                {qrFailed
                  ? isEn
                    ? 'QR generate failed'
                    : '二维码生成失败'
                  : isEn
                    ? 'Generating...'
                    : '生成中...'}
              </div>
            )}
            <p
              className="w-full text-center text-xs font-mono text-muted-foreground break-all line-clamp-2"
              title={url}
            >
              {url}
            </p>
            <div className="flex items-center justify-end gap-2 w-full">
              <Button
                variant="outline"
                size="sm"
                className="text-red-500 hover:text-red-600"
                onClick={handleClear}
              >
                <Trash2 className="h-3.5 w-3.5 mr-1" />
                {isEn ? 'Clear' : '清空'}
              </Button>
              <span className="flex-1" />
              <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                <Pencil className="h-3.5 w-3.5 mr-1" />
                {isEn ? 'Edit' : '编辑'}
              </Button>
              <Button variant="outline" size="sm" onClick={() => void handleOpen()}>
                <ExternalLink className="h-3.5 w-3.5 mr-1" />
                {isEn ? 'Open' : '打开'}
              </Button>
              {/* 应用内支付：窗口自动填账单地址，卡号与 Pay 人工 */}
              <Button
                variant="outline"
                size="sm"
                title={isEn ? 'Pay in app window (auto-fill billing address)' : '应用内支付（自动填账单地址）'}
                onClick={() => setPayInApp(true)}
              >
                <CreditCard className="h-3.5 w-3.5 mr-1" />
                {isEn ? 'Pay in app' : '应用内支付'}
              </Button>
              {/* 仅复制 URL（要发原始链接时用） */}
              <Button
                variant="outline"
                size="sm"
                title={isEn ? 'Copy link only' : '复制链接（仅 URL）'}
                onClick={() => void navigator.clipboard.writeText(url)}
              >
                <Link2 className="h-3.5 w-3.5" />
              </Button>
              {/* 复制完整信息：邮箱+说明+链接 三行（便于按邮箱检索聊天记录） */}
              <Button size="sm" onClick={() => void handleCopy()}>
                <Copy className="h-3.5 w-3.5 mr-1" />
                {copied
                  ? isEn
                    ? 'Copied'
                    : '已复制'
                  : isEn
                    ? 'Copy (email+link)'
                    : '复制（邮箱+链接）'}
              </Button>
            </div>
          </div>
        )}
      </div>
      {payInApp && url && (
        <PayInAppDialog
          target={{ url, accountId: account.id, email: account.email }}
          onClose={() => setPayInApp(false)}
          isEn={isEn}
        />
      )}
    </div>,
    document.body
  )
}
