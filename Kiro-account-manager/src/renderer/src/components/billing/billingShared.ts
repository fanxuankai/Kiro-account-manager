// 账单页共享工具：计划归类、样式与格式化（账号视图 / 卡视图复用）。
// 独立成模块而非从组件文件导出，避免破坏 react-refresh 的纯组件文件约束。
import type { Account } from '@/types/account'

// ===== 计划归类（与账号筛选面板 / 订阅页徽章同一套口径） =====
export type PlanKind = 'Pro' | 'Pro_Plus' | 'Pro_Max' | 'Power' | 'Free'

export function planKindOf(acc: Account): PlanKind {
  const type = (acc.subscription?.type || '').toUpperCase()
  const title = (acc.subscription?.title || '').toUpperCase()
  const both = `${type} ${title}`
  if (both.includes('PRO_MAX') || both.includes('PRO MAX') || both.includes('PROMAX'))
    return 'Pro_Max'
  if (both.includes('PRO_PLUS') || both.includes('PRO+')) return 'Pro_Plus'
  if (both.includes('ENTERPRISE') || both.includes('POWER')) return 'Power'
  if (both.includes('PRO')) return 'Pro'
  return 'Free'
}

export const PLAN_STYLES: Record<PlanKind, string> = {
  Pro_Max: 'bg-rose-500/15 text-rose-700 dark:text-rose-300',
  Pro_Plus: 'bg-purple-500/15 text-purple-700 dark:text-purple-300',
  Power: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  Pro: 'bg-blue-500/15 text-blue-700 dark:text-blue-300',
  Free: 'bg-muted text-muted-foreground'
}

export const PLAN_LABELS: Record<PlanKind, string> = {
  Pro_Max: 'Pro Max',
  Pro_Plus: 'Pro+',
  Power: 'Power',
  Pro: 'Pro',
  Free: 'Free'
}

// ===== 显示工具 =====
export const formatMoney = (cents?: number, currency = 'usd'): string => {
  if (cents == null) return '-'
  const symbol = currency.toLowerCase() === 'usd' ? '$' : `${currency.toUpperCase()} `
  return `${symbol}${(cents / 100).toFixed(2)}`
}

export const formatShortDate = (ms?: number): string => {
  if (!ms) return '-'
  return new Date(ms).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' })
}
