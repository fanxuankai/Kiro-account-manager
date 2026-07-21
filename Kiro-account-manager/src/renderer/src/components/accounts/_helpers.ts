/**
 * 账号视图共享工具 — AccountCard / AccountListRow 复用
 * 保证两种视图（卡片 / 列表）视觉系统一致
 */
import type { CSSProperties } from 'react'
import type { Account } from '@/types/account'

// ============ 颜色解析 ============

// 解析 ARGB 颜色转换为 CSS rgba（支持 #AARRGGBB 与 #RRGGBB）
export function toRgba(argbColor: string): string {
  let alpha = 255
  let rgb = argbColor
  if (argbColor.length === 9 && argbColor.startsWith('#')) {
    alpha = parseInt(argbColor.slice(1, 3), 16)
    rgb = '#' + argbColor.slice(3)
  }
  const hex = rgb.startsWith('#') ? rgb.slice(1) : rgb
  const r = parseInt(hex.slice(0, 2), 16)
  const g = parseInt(hex.slice(2, 4), 16)
  const b = parseInt(hex.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha / 255})`
}

// ============ 标签光环 ============

// 生成卡片版标签光环样式：单标签 → box-shadow；多标签 → 渐变 border
export function generateGlowStyle(tagColors: string[]): CSSProperties {
  if (tagColors.length === 0) return {}
  if (tagColors.length === 1) {
    const color = toRgba(tagColors[0])
    const colorTransparent = color.replace('1)', '0.15)')
    return {
      boxShadow: `0 0 0 1px ${color}, 0 4px 12px -2px ${colorTransparent}`
    }
  }
  const gradientColors = tagColors.map((c, i) => {
    const percent = (i / tagColors.length) * 100
    const nextPercent = ((i + 1) / tagColors.length) * 100
    return `${toRgba(c)} ${percent}%, ${toRgba(c)} ${nextPercent}%`
  }).join(', ')
  return {
    background: `linear-gradient(var(--card-solid), var(--card-solid)) padding-box, linear-gradient(135deg, ${gradientColors}) border-box`,
    border: '1.5px solid transparent',
    boxShadow: '0 4px 12px -2px rgba(0, 0, 0, 0.05)'
  }
}

// 列表行用：标签色带 — 只保留左边 3px 色带作为身份识别，不染色行背景避免多行列表花花绿绿
export function generateRowGlowStyle(tagColors: string[]): CSSProperties {
  if (tagColors.length === 0) return {}
  if (tagColors.length === 1) {
    return {
      borderLeftColor: toRgba(tagColors[0]),
      borderLeftWidth: '3px'
    }
  }
  // 多标签：垂直渐变左边色带（双层 backgroundClip trick，渐变只在 border-box 的 3px 区域显示）
  const gradientStops = tagColors.map((c, i) => {
    const percent = (i / (tagColors.length - 1)) * 100
    return `${toRgba(c)} ${percent}%`
  }).join(', ')
  return {
    borderLeftWidth: '3px',
    borderLeftColor: 'transparent',
    backgroundImage: `linear-gradient(var(--card-solid), var(--card-solid)), linear-gradient(180deg, ${gradientStops})`,
    backgroundOrigin: 'padding-box, border-box',
    backgroundClip: 'padding-box, border-box',
    backgroundRepeat: 'no-repeat'
  }
}

// ============ 封禁状态样式 ============

// 卡片版封禁背景样式（用 CSS 变量）
export const unauthorizedCardStyle: CSSProperties = {
  backgroundColor: 'var(--card-unauthorized-bg)',
  borderColor: 'var(--card-unauthorized-border)',
  boxShadow: `
    0 0 0 1px var(--card-unauthorized-ring),
    0 4px 12px -2px var(--card-unauthorized-shadow)
  `
}

// 列表行封禁背景样式（更轻量，不抢眼）
export const unauthorizedRowStyle: CSSProperties = {
  backgroundColor: 'var(--card-unauthorized-bg)',
  borderColor: 'var(--card-unauthorized-border)',
  boxShadow: `0 0 0 1px var(--card-unauthorized-ring)`
}

// ============ 订阅徽章配色 ============

export function getSubscriptionColor(type: string, title?: string): string {
  const text = (title || type).toUpperCase()
  // KIRO PRO MAX — 必须先于 PRO+/PRO 判断
  if (text.includes('PRO_MAX') || text.includes('PRO MAX') || text.includes('PROMAX') || text === 'PRO_MAX') return 'bg-rose-500'
  if (text.includes('PRO+') || text.includes('PRO_PLUS') || text.includes('PROPLUS')) return 'bg-purple-500'
  if (text.includes('POWER')) return 'bg-amber-500'
  if (text.includes('PRO')) return 'bg-blue-500'
  return 'bg-gray-500'
}

// ============ 状态文本 ============

export const StatusLabelsZh: Record<string, string> = {
  active: '正常',
  expired: '已过期',
  error: '错误',
  refreshing: '刷新中',
  unknown: '未知'
}

export const StatusLabelsEn: Record<string, string> = {
  active: 'Active',
  expired: 'Expired',
  error: 'Error',
  refreshing: 'Refreshing',
  unknown: 'Unknown'
}

// 状态徽章 Tailwind class
export function getStatusBadgeClass(status: string, isUnauthorized: boolean): string {
  if (isUnauthorized) return 'text-destructive bg-destructive/10'
  switch (status) {
    case 'active': return 'text-success bg-success/10'
    case 'error': return 'text-destructive bg-destructive/10'
    case 'expired': return 'text-warning bg-warning/10'
    case 'refreshing': return 'text-primary bg-primary/10'
    default: return 'text-muted-foreground bg-muted'
  }
}

// ============ 显示名 ============

export function getDisplayName(account: Account): string {
  if (account.nickname) return account.nickname
  if (account.email) return account.email
  if (account.userId) return account.userId
  return 'Unknown'
}

// ============ Token 过期格式化 ============

export function formatTokenExpiry(expiresAt: number, isEn: boolean): string {
  const now = Date.now()
  const diff = expiresAt - now
  if (diff <= 0) return isEn ? 'Expired' : '已过期'
  const minutes = Math.floor(diff / (60 * 1000))
  const hours = Math.floor(diff / (60 * 60 * 1000))
  if (minutes < 60) {
    return isEn ? `${minutes}m` : `${minutes} 分钟`
  } else if (hours < 24) {
    const remainingMinutes = minutes % 60
    return isEn
      ? (remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`)
      : (remainingMinutes > 0 ? `${hours} 小时 ${remainingMinutes} 分` : `${hours} 小时`)
  } else {
    const days = Math.floor(hours / 24)
    const remainingHours = hours % 24
    return isEn
      ? (remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`)
      : (remainingHours > 0 ? `${days} 天 ${remainingHours} 小时` : `${days} 天`)
  }
}

// ============ 封禁错误识别 ============

export function isBannedError(error: string | undefined): boolean {
  if (!error) return false
  const lower = error.toLowerCase()
  return (
    lower.includes('accountsuspendedexception') ||
    lower.includes('account suspended') ||
    lower.includes('temporarily_suspended') ||
    lower.includes('temporarily suspended') ||
    (lower.includes('user id is') && lower.includes('suspended')) ||
    lower.includes('账户已封禁') ||
    lower.includes('已封禁') ||
    /\b423\b/.test(lower)
  )
}

// ============ 日期格式化 ============

// 把 nextResetDate / freeTrialExpiry 等多种类型安全格式化为 YYYY-MM-DD
export function formatDateSafe(d: unknown): string {
  try {
    return (typeof d === 'string' ? d : new Date(d as Date).toISOString()).split('T')[0]
  } catch {
    return ''
  }
}
