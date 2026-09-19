import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '../ui'
import {
  X,
  CreditCard,
  RefreshCw,
  ExternalLink,
  Loader2,
  CheckCircle,
  AlertTriangle,
  MapPin
} from 'lucide-react'

/**
 * 应用内支付弹窗 —— 发起 Stripe Checkout 应用内窗口支付。
 * 省份选择（记住上次）+ 随机账单地址预览（邮编与市/区真实对应），
 * 打开后窗口内自动选国家/省、填地址；卡号与 Pay 留人工。
 * 支付状态由 payment-update 推送回流到本弹窗展示（成功不触发账号刷新，
 * 订阅状态交给现有自动刷新）。
 */

interface PayInAppDialogProps {
  /** null = 关闭 */
  target: { url: string; accountId: string; email?: string } | null
  onClose: () => void
  isEn: boolean
}

/** 省份偏好的 localStorage key（跨弹窗/入口共用） */
const PROVINCE_LS_KEY = 'payment_province'

type Phase = 'idle' | 'filling' | 'filled' | 'success' | 'expired' | 'closed' | 'error'

export function PayInAppDialog({ target, onClose, isEn }: PayInAppDialogProps): React.ReactNode {
  const [provinces, setProvinces] = useState<string[]>([])
  const [province, setProvince] = useState<string>(
    () => localStorage.getItem(PROVINCE_LS_KEY) || ''
  )
  const [address, setAddress] = useState<{
    name: string
    zip: string
    city: string
    district: string
    street: string
    provinceZh: string
    provinceEn: string
  } | null>(null)
  const [opening, setOpening] = useState(false)
  const [phase, setPhase] = useState<Phase>('idle')
  const [opened, setOpened] = useState(false)

  const refreshAddress = useCallback((prov?: string): void => {
    void window.api.paymentGenerateAddress(prov || undefined).then(setAddress)
  }, [])

  // 打开时加载省份列表 + 生成地址预览
  useEffect(() => {
    if (!target) return
    void window.api.paymentProvinces().then((list) => {
      setProvinces(list)
      // 记住的省份不在列表（数据更新）则回退随机
      setProvince((cur) => (cur && list.includes(cur) ? cur : ''))
    })
    refreshAddress(localStorage.getItem(PROVINCE_LS_KEY) || undefined)
    setPhase('idle')
    setOpened(false)
  }, [target, refreshAddress])

  // 支付窗口状态回流（只认当前账号）
  useEffect(() => {
    if (!target) return
    const off = window.api.onPaymentUpdate((update) => {
      if (update.accountId !== target.accountId) return
      setPhase(update.phase)
    })
    return off
  }, [target])

  // Esc 关闭
  useEffect(() => {
    if (!target) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [target, onClose])

  if (!target) return null

  const handleProvinceChange = (prov: string): void => {
    setProvince(prov)
    if (prov) localStorage.setItem(PROVINCE_LS_KEY, prov)
    else localStorage.removeItem(PROVINCE_LS_KEY)
    refreshAddress(prov)
  }

  const handleOpen = async (): Promise<void> => {
    if (!address) return
    setOpening(true)
    const res = await window.api.paymentOpen({
      url: target.url,
      accountId: target.accountId,
      email: target.email,
      province: province || undefined,
      address
    })
    setOpening(false)
    if (res.success) {
      setOpened(true)
      setPhase('idle')
    } else {
      setPhase('error')
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative bg-background rounded-xl shadow-2xl w-full max-w-md animate-in fade-in zoom-in-95 duration-200">
        {/* 标题栏 */}
        <div className="flex items-center justify-between px-5 py-3 border-b">
          <div className="flex items-center gap-2 min-w-0">
            <CreditCard className="h-5 w-5 text-primary flex-shrink-0" />
            <h2 className="text-base font-semibold truncate" title={target.email || target.accountId}>
              {isEn ? 'Pay in app' : '应用内支付'}
              {target.email ? ` · ${target.email}` : ''}
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

        <div className="px-5 py-4 space-y-4">
          {/* 省份选择 */}
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground shrink-0">
              {isEn ? 'Province' : '账单省份'}
            </span>
            <select
              value={province}
              onChange={(e) => handleProvinceChange(e.target.value)}
              className="flex-1 rounded-lg border border-foreground/15 bg-[var(--glass-bg)] px-3 py-1.5 text-sm focus-visible:outline-none focus-visible:border-primary/50"
            >
              <option value="">{isEn ? 'Random' : '随机'}</option>
              {provinces.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>

          {/* 地址预览 */}
          <div className="rounded-lg border border-border/60 bg-muted/30 px-4 py-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-muted-foreground flex items-center gap-1">
                <MapPin className="h-3.5 w-3.5" />
                {isEn ? 'Billing address (auto-filled)' : '账单地址（自动填写）'}
              </span>
              <button
                onClick={() => refreshAddress(province)}
                className="p-1 rounded hover:bg-muted text-muted-foreground"
                title={isEn ? 'Regenerate' : '换一条'}
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </button>
            </div>
            {address ? (
              <p className="text-xs font-mono leading-5 whitespace-pre-line text-foreground/90">
                {`${address.name}\n${address.zip}\n${address.city}\n${address.district}\n${address.street}\n${address.provinceZh}`}
              </p>
            ) : (
              <div className="flex justify-center py-2">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
            )}
          </div>

          {/* 状态区 */}
          {opened && (
            <div className="text-xs">
              {phase === 'idle' && (
                <p className="text-muted-foreground flex items-center gap-1.5">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  {isEn ? 'Payment window opening…' : '支付窗口打开中…'}
                </p>
              )}
              {phase === 'filling' && (
                <p className="text-muted-foreground flex items-center gap-1.5">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  {isEn ? 'Auto-filling billing address…' : '正在自动填写账单地址…'}
                </p>
              )}
              {phase === 'filled' && (
                <p className="text-green-600 flex items-center gap-1.5">
                  <CheckCircle className="h-3.5 w-3.5" />
                  {isEn
                    ? 'Address filled — enter card details and pay in the window'
                    : '地址已填好，请在支付窗口填写卡号并点击 Pay'}
                </p>
              )}
              {phase === 'success' && (
                <p className="text-green-600 flex items-center gap-1.5">
                  <CheckCircle className="h-3.5 w-3.5" />
                  {isEn
                    ? 'Payment successful (subscription status updates via auto refresh)'
                    : '支付成功（订阅状态由自动刷新更新）'}
                </p>
              )}
              {phase === 'expired' && (
                <p className="text-amber-600 flex items-center gap-1.5">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  {isEn
                    ? 'Link expired — regenerate it, then reopen payment'
                    : '链接已过期，请重新获取后再打开支付'}
                </p>
              )}
              {phase === 'closed' && (
                <p className="text-muted-foreground flex items-center gap-1.5">
                  <X className="h-3.5 w-3.5" />
                  {isEn ? 'Payment window closed' : '支付窗口已关闭'}
                </p>
              )}
              {phase === 'error' && (
                <p className="text-red-500 flex items-center gap-1.5">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  {isEn ? 'Failed to open payment window' : '支付窗口打开失败'}
                </p>
              )}
            </div>
          )}

          {/* 操作 */}
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={onClose}>
              {isEn ? 'Close' : '关闭'}
            </Button>
            <Button
              size="sm"
              disabled={!address || opening}
              onClick={() => void handleOpen()}
            >
              {opening ? (
                <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
              ) : (
                <ExternalLink className="h-3.5 w-3.5 mr-1" />
              )}
              {isEn ? 'Open payment window' : '打开支付窗口'}
            </Button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}
