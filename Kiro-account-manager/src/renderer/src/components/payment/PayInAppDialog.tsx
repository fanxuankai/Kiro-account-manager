import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '../ui'
import { parseCardInfos, maskCardInfo, type CardInfo } from '../../lib/cardParse'
import {
  X,
  CreditCard,
  RefreshCw,
  ClipboardPaste,
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

type Phase = 'idle' | 'filling' | 'card-filled' | 'filled' | 'success' | 'expired' | 'closed' | 'error'

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
  const [cardText, setCardText] = useState('')
  const [cardFilled, setCardFilled] = useState(false)
  const [cardIdx, setCardIdx] = useState(0)
  // 粘贴即解析：支持每行一项与一行一张卡（tab/空格/逗号分隔）两种形态，可含多张卡
  const cards = parseCardInfos(cardText)
  const card: CardInfo | null = cards[cardIdx] ?? cards[0] ?? null
  const [phase, setPhase] = useState<Phase>('idle')
  const [errorDetail, setErrorDetail] = useState<string | undefined>()
  const [opened, setOpened] = useState(false)

  const refreshAddress = useCallback((prov?: string): void => {
    void window.api.paymentGenerateAddress(prov || undefined).then(setAddress)
  }, [])
  const handleFillCard = useCallback(async (): Promise<void> => {
    if (!card) return
    const res = await window.api.paymentFillCard(card)
    if (res.success) {
      setCardText('')
      setCardFilled(true)
    }
  }, [card])


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
    setErrorDetail(undefined)
    setOpened(false)
    setCardText('')
    setCardFilled(false)
    setCardIdx(0)
    // 依赖取原始值：父弹窗（待付款弹窗）随账号自动刷新频繁重渲染，
    // 若依赖 target 对象引用会不断重置本弹窗状态（闪烁/地址重生成）
  }, [target?.url, target?.accountId, refreshAddress])

  // 支付窗口状态回流（只认当前账号）
  useEffect(() => {
    if (!target) return
    const off = window.api.onPaymentUpdate((update) => {
      if (update.accountId !== target.accountId) return
      setPhase(update.phase)
      setErrorDetail(update.detail)
      if (update.phase === 'card-filled') {
        setCardFilled(true)
        if (cardIdx + 1 < cards.length) {
          setCardIdx(cardIdx + 1)
        } else {
          setCardText('')
          setCardIdx(0)
        }
      }
    })
    return off
  }, [target?.accountId])

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
      address,
      card: card || undefined
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
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
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

          {/* 卡信息快捷填入：粘贴解析后拟人填入支付窗口（仅内存，不落盘不保存） */}
          <div className="rounded-lg border border-border/60 bg-muted/30 px-4 py-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-muted-foreground flex items-center gap-1">
                <ClipboardPaste className="h-3.5 w-3.5" />
                {isEn ? 'Card quick fill (paste, not saved)' : '卡信息快捷填入（粘贴解析，不保存）'}
              </span>
              {card && (
                <span className="flex items-center gap-1.5">
                  {cards.length > 1 && (
                    <button
                      className="text-[10px] text-primary hover:underline"
                      onClick={() => { setCardIdx((cardIdx + 1) % cards.length); setCardFilled(false) }}
                      title={isEn ? 'Switch card' : '切换卡'}
                    >
                      {isEn ? `#${cardIdx + 1}/${cards.length}` : `第${cardIdx + 1}/${cards.length}张`}
                    </button>
                  )}
                  <span className="text-[10px] font-mono text-green-600">{maskCardInfo(card)}</span>
                </span>
              )}
            </div>
            <textarea
              value={cardText}
              onChange={(e) => { setCardText(e.target.value); setCardFilled(false); setCardIdx(0) }}
              rows={3}
              spellCheck={false}
              placeholder={isEn
                ? 'Paste card info, one per line:\n4234 1234 1234 9562\n09/34 (or 0934)\n123'
                : '粘贴卡信息，每行一项：\n4234 1234 1234 9562\n09/34（或 0934）\n123'}
              className="w-full rounded-lg border border-foreground/15 bg-[var(--glass-bg)] px-3 py-2 text-xs font-mono focus-visible:outline-none focus-visible:border-primary/50 resize-none"
            />
            {cardText && !card && (
              <p className="text-[10px] text-amber-600 mt-1.5">
                {isEn ? 'Cannot parse card number / expiry / CVC yet' : '还没识别出完整的卡号 / 有效期 / 安全码'}
              </p>
            )}
            {cardFilled && (
              <p className="text-[10px] text-green-600 mt-1.5">
                {isEn ? 'Card filled — verify in the payment window, then click Pay' : '卡信息已填入，请在支付窗口核对后点击 Pay'}
              </p>
            )}
            <div className="flex justify-end mt-2">
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                disabled={!card || !opened || cardFilled}
                onClick={() => void handleFillCard()}
                title={!opened ? (isEn ? 'Open the payment window first' : '请先打开支付窗口') : undefined}
              >
                <CreditCard className="h-3 w-3 mr-1" />
                {isEn ? 'Fill card' : '填入卡信息'}
              </Button>
            </div>
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
              {phase === 'card-filled' && (
                <p className="text-muted-foreground flex items-center gap-1.5">
                  <CheckCircle className="h-3.5 w-3.5 text-green-600" />
                  {isEn ? 'Card info filled, address filling…' : '卡信息已填入，地址填写中…'}
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
                  {errorDetail === 'new-page-load-failed'
                    ? (isEn
                        ? 'New payment page failed to load (js.stripe.com unreachable on this network). Switch network or proxy rule, then reopen.'
                        : '新版支付页加载失败：当前网络无法访问其依赖资源（js.stripe.com 直连不通），请换网络或调整代理规则后重开')
                    : (isEn ? 'Failed to open payment window' : '支付窗口打开失败')}
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
