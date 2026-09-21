// 卡信息快捷解析 —— 粘贴文本智能识别，支持两类粘贴形态：
// 1. 多行、每行一项（卡号/有效期/安全码各占一行，行序不限）；
// 2. 每行一张卡：一行内用制表符/连续空格/逗号分隔（卡商常见导出格式），多行即多张卡。
//
// 各字段兼容的形态（按特征分类）：
// - 卡号：去空格/横线后 12–19 位纯数字（4234 1234 1234 9562 / 4234123412349562）
// - 有效期：MM/YY、MM-YY、MM YY、M/YY（9/34）、MMYYYY（取后两位）、裸 MMYY（0934）
// - 安全码：3–4 位纯数字
// 行首的标签前缀（卡号：/有效期:/card no.- 等）自动剥除；含字母的行（持卡人名等）
// 忽略。恰好三行且无法判别时退回「行序 = 卡号/有效期/CVC」。

export interface CardInfo {
  /** 纯数字卡号（无分隔） */
  number: string
  /** 有效期 MMYY（页面输入时让 Stripe 自己格式化成 MM/YY） */
  expiry: string
  /** 3–4 位安全码 */
  cvc: string
}

const digitsOnly = (s: string): string => s.replace(/[\s-]/g, '')

/** 剥掉行首的标签前缀（「卡号：」「有效期:」「card number -」等），只留值部分 */
const stripLabel = (line: string): string =>
  line.replace(/^[\u4e00-\u9fa5a-zA-Z\s]{0,12}[:：\-—]\s*/, '').trim()

/** 解析一行有效期 → MMYY；不合法返回 null */
function parseExpiryLine(line: string): string | null {
  const m = line.match(/^(\d{1,2})\s*[/\-. ]\s*(\d{2}|\d{4})$/)
  if (m) {
    const mm = m[1].padStart(2, '0')
    const yy = m[2].length === 4 ? m[2].slice(-2) : m[2]
    return validMmYy(mm, yy) ? mm + yy : null
  }
  if (/^\d{4}$/.test(line)) return validMmYy(line.slice(0, 2), line.slice(2)) ? line : null
  return null
}

function validMmYy(mm: string, yy: string): boolean {
  const m = Number(mm)
  return m >= 1 && m <= 12 && /^\d{2}$/.test(yy)
}

/**
 * 解析粘贴文本。识别失败返回 null。
 * 歧义规则：4 位纯数字行优先当有效期（MMYY 最常见）；若已另识别出有效期，
 * 该行退回当 4 位安全码（Amex）。
 */
export function parseCardInfo(text: string): CardInfo | null {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)

  let number: string | null = null
  let expiry: string | null = null
  let cvc: string | null = null
  const fourDigitFallback: string[] = []

  for (const raw of lines) {
    // 先剥标签前缀；剥完仍含字母的行（持卡人名等）忽略
    const line = stripLabel(raw)
    if (/[a-zA-Z]/.test(line)) continue
    const digits = digitsOnly(line)
    // 两段分隔形态（MM/YY、M-YY、MM YY、MM/YYYY）→ 有效期（优先于长卡号判定）
    if (/^\d{1,2}[/\-. ]\d{2,4}$/.test(line)) {
      const parsed = parseExpiryLine(line)
      if (parsed && !expiry) {
        expiry = parsed
        continue
      }
    }
    // 长数字（12–19 位，可含空格/横线分组）→ 卡号
    if (/^[\d\s-]{12,26}$/.test(line) && digits.length >= 12 && digits.length <= 19) {
      if (!number) number = digits
      continue
    }
    if (/^\d{3}$/.test(line)) {
      if (!cvc) cvc = line
      continue
    }
    if (/^\d{4}$/.test(line)) {
      fourDigitFallback.push(line)
      continue
    }
  }

  // 4 位行兜底：先当 MMYY 有效期，已有时则当 4 位 CVC
  for (const d of fourDigitFallback) {
    if (!expiry) {
      const parsed = parseExpiryLine(d)
      if (parsed) {
        expiry = parsed
        continue
      }
    }
    if (!cvc) cvc = d
  }

  // 三行标准序兜底（识别不齐时按用户常见粘贴顺序补位）
  if ((!number || !expiry || !cvc) && lines.length >= 3) {
    const [l1, l2, l3] = lines.map(stripLabel).filter((l) => !/[a-zA-Z]/.test(l))
    if (!number && l1 && /^[\d\s-]{12,26}$/.test(l1)) number = digitsOnly(l1)
    if (!expiry && l2) expiry = parseExpiryLine(l2)
    if (!cvc && l3 && /^\d{3,4}$/.test(l3)) cvc = l3
  }

  if (!number || !expiry || !cvc) return null
  return { number, expiry, cvc }
}

/** 掩码预览：尾 4 位卡号 + MM/YY + CVC 长度 */
export function maskCardInfo(c: CardInfo): string {
  return `**** ${c.number.slice(-4)} · ${c.expiry.slice(0, 2)}/${c.expiry.slice(2)} · ${'*'.repeat(c.cvc.length)}`
}

/**
 * 解析可能含多张卡的粘贴文本（每行一张卡的批量格式）。
 * 单行内的段（制表符/连续空格/逗号分隔）先尝试独立成卡；
 * 凑不成卡的行退回跨行组合（多行一项的旧形态）。
 */
export function parseCardInfos(text: string): CardInfo[] {
  const cards: CardInfo[] = []
  const leftovers: string[] = []

  for (const raw of text.split(/\r?\n/)) {
    const line = stripLabel(raw.trim())
    if (!line) continue
    // 行内多段（tab / 2+ 空格 / 逗号）→ 尝试整行组装一张卡
    const segs = line.split(/[\t,]|\s{2,}/).map((x) => x.trim()).filter(Boolean)
    if (segs.length >= 3) {
      let number: string | null = null
      let expiry: string | null = null
      let cvc: string | null = null
      for (const seg of segs) {
        const digits = digitsOnly(seg)
        if (!expiry && /^\d{1,2}[/\-. ]\d{2,4}$/.test(seg)) {
          const p = parseExpiryLine(seg)
          if (p) { expiry = p; continue }
        }
        if (!number && /^[\d\s-]{12,26}$/.test(seg) && digits.length >= 12 && digits.length <= 19) {
          number = digits
          continue
        }
        if (!cvc && /^\d{3}$/.test(seg)) { cvc = seg; continue }
        if (!expiry && /^\d{4}$/.test(seg)) {
          const p = parseExpiryLine(seg)
          if (p) { expiry = p; continue }
        }
        if (!cvc && /^\d{3,4}$/.test(seg)) { cvc = seg }
      }
      if (number && expiry && cvc) {
        cards.push({ number, expiry, cvc })
        continue
      }
    }
    leftovers.push(line)
  }

  // 凑不成整卡的行（含每行一项的旧形态）走跨行组合，最多凑一张
  const single = parseCardInfo(leftovers.join('\n'))
  if (single) cards.push(single)
  return cards
}
