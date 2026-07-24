import { create } from 'zustand'

/**
 * 信用卡管理
 *
 * 维护信用卡的基本信息、额度使用情况、账单/还款周期、年费与减免进度。
 * 出于安全考虑：只保存卡号后四位，不保存完整卡号 / CVV。
 * 持久化方式沿用项目约定：zustand + localStorage（Map 存储）。
 */

/** 卡组织 */
export type CardNetwork = 'visa' | 'mastercard' | 'amex' | 'unionpay' | 'jcb' | 'discover' | 'other'

/** 卡片状态 */
export type CardStatus = 'active' | 'frozen' | 'closed'

export interface CreditCard {
  id: string
  /** 备注名（如"招行经典白"） */
  label: string
  /** 发卡行（如"招商银行"） */
  bank: string
  /** 卡组织 */
  network: CardNetwork
  /** 卡号后四位（不存完整卡号） */
  last4?: string
  /** 持卡人 */
  holder?: string
  /** 有效期（MM/YY） */
  expiry?: string

  /** 币种（如 CNY / USD / HKD） */
  currency: string
  /** 信用额度 */
  creditLimit: number
  /** 已用额度 */
  usedAmount: number

  /** 账单日（每月第几天，1-31） */
  statementDay?: number
  /** 还款日（每月第几天，1-31） */
  dueDay?: number

  /** 年费 */
  annualFee?: number
  /** 年费减免所需刷卡次数（消费达标免年费） */
  feeWaiverSwipes?: number
  /** 当前周期已刷卡次数（用于年费减免进度） */
  currentSwipes?: number

  /** 状态 */
  status: CardStatus
  /** 备注 */
  note?: string

  createdAt: number
  updatedAt: number
}

/** 卡组织选项（供 UI 渲染） */
export const CARD_NETWORKS: { value: CardNetwork; label: string; labelEn: string }[] = [
  { value: 'visa', label: 'Visa', labelEn: 'Visa' },
  { value: 'mastercard', label: 'Mastercard', labelEn: 'Mastercard' },
  { value: 'amex', label: '美国运通', labelEn: 'American Express' },
  { value: 'unionpay', label: '银联', labelEn: 'UnionPay' },
  { value: 'jcb', label: 'JCB', labelEn: 'JCB' },
  { value: 'discover', label: 'Discover', labelEn: 'Discover' },
  { value: 'other', label: '其他', labelEn: 'Other' }
]

/** 卡片状态选项（供 UI 渲染） */
export const CARD_STATUSES: { value: CardStatus; label: string; labelEn: string }[] = [
  { value: 'active', label: '正常', labelEn: 'Active' },
  { value: 'frozen', label: '冻结', labelEn: 'Frozen' },
  { value: 'closed', label: '已注销', labelEn: 'Closed' }
]

/** 派生：可用额度 */
export function availableCredit(card: Pick<CreditCard, 'creditLimit' | 'usedAmount'>): number {
  return Math.max(0, (card.creditLimit || 0) - (card.usedAmount || 0))
}

/** 派生：使用率（0-1） */
export function utilization(card: Pick<CreditCard, 'creditLimit' | 'usedAmount'>): number {
  if (!card.creditLimit || card.creditLimit <= 0) return 0
  return Math.min(1, Math.max(0, (card.usedAmount || 0) / card.creditLimit))
}

interface CreditCardsState {
  cards: Map<string, CreditCard>
}

interface CreditCardsActions {
  addCard: (input: Omit<CreditCard, 'id' | 'createdAt' | 'updatedAt'>) => string
  updateCard: (id: string, updates: Partial<Omit<CreditCard, 'id' | 'createdAt'>>) => void
  removeCard: (id: string) => void
  loadFromStorage: () => void
  saveToStorage: () => void
}

type CreditCardsStore = CreditCardsState & CreditCardsActions

const STORAGE_KEY = 'kiro-credit-cards'

export const useCreditCardsStore = create<CreditCardsStore>()((set, get) => ({
  cards: new Map(),

  addCard: (input) => {
    const id = crypto.randomUUID()
    const now = Date.now()
    const card: CreditCard = { ...input, id, createdAt: now, updatedAt: now }
    set((state) => {
      const next = new Map(state.cards)
      next.set(id, card)
      return { cards: next }
    })
    get().saveToStorage()
    return id
  },

  updateCard: (id, updates) => {
    set((state) => {
      const next = new Map(state.cards)
      const existing = next.get(id)
      if (existing) next.set(id, { ...existing, ...updates, updatedAt: Date.now() })
      return { cards: next }
    })
    get().saveToStorage()
  },

  removeCard: (id) => {
    set((state) => {
      const next = new Map(state.cards)
      next.delete(id)
      return { cards: next }
    })
    get().saveToStorage()
  },

  loadFromStorage: () => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (!raw) return
      const arr = JSON.parse(raw) as CreditCard[]
      if (!Array.isArray(arr)) return
      const map = new Map<string, CreditCard>()
      for (const c of arr) map.set(c.id, c)
      set({ cards: map })
    } catch (err) {
      console.warn('[CreditCards] Load failed:', err)
    }
  },

  saveToStorage: () => {
    try {
      const arr = Array.from(get().cards.values())
      localStorage.setItem(STORAGE_KEY, JSON.stringify(arr))
    } catch (err) {
      console.warn('[CreditCards] Save failed:', err)
    }
  }
}))
