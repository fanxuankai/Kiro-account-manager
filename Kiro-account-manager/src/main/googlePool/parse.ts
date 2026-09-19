// Google 号池卡密解析，两种格式（分隔符严格 4 连字符，与 loginPool 同规则：
// 密码里 1–3 连字符常见，宽松匹配会切错段）：
// ① 2FA 密钥版：  邮箱----密码----2FA密钥[----国家标记]
//    第三段是 Google 两步验证的 base32 密钥（常按 4 字符空格分组，如 "ivir rjuw …"），
//    normalize 后本地 totpNow 即可算 6 位码——不需要也不应贴到外部 2FA 网站。
// ② 辅助邮箱版：  邮箱----密码----辅助邮箱[----辅邮凭据[----国家标记]]
//    无 2FA 密钥；Google 可疑登录时发验证码到辅助邮箱（yopmail 等免登录收信）。
// 识别规则：第 3 段含 @ 即辅助邮箱版，否则按 2FA 密钥校验。
// 非法行整行跳过并在 bad 里带回原文，由界面提示人工修。

import { isBase32 } from '../loginPool/totp'

export interface GooglePoolParsedItem {
  email: string
  password: string
  secret?: string
  recoveryEmail?: string
  recoveryPassword?: string
  country?: string
}

export function parseGooglePoolText(
  text: string
): { items: GooglePoolParsedItem[]; bad: string[] } {
  const items: GooglePoolParsedItem[] = []
  const bad: string[] = []
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim()
    if (!t) continue
    const parts = t.split('----')
    const [email, password, third] = parts.map((s) => s.trim())
    if (!email.includes('@') || !password) {
      bad.push(t)
      continue
    }

    // ② 辅助邮箱版：邮箱----密码----辅助邮箱[----辅邮凭据[----国家标记]]
    if (third.includes('@')) {
      if (parts.length !== 3 && parts.length !== 4 && parts.length !== 5) {
        bad.push(t)
        continue
      }
      let recoveryPassword: string | undefined
      let country: string | undefined
      if (parts.length === 5) {
        recoveryPassword = parts[3].trim() || undefined
        country = parts[4].trim() || undefined
      } else if (parts.length === 4) {
        // 末段歧义：两位小写字母按惯例是国家标记（mx/pa…），其余视为辅邮凭据
        const seg = parts[3].trim()
        if (/^[a-z]{2}$/.test(seg)) country = seg
        else recoveryPassword = seg || undefined
      }
      items.push({
        email,
        password,
        recoveryEmail: third,
        recoveryPassword,
        country
      })
      continue
    }

    // ① 2FA 密钥版：邮箱----密码----2FA密钥[----国家标记]
    if (parts.length !== 3 && parts.length !== 4) {
      bad.push(t)
      continue
    }
    const secretClean = third.replace(/[\s-]/g, '')
    const country = parts[3]?.trim() || undefined
    if (!isBase32(secretClean)) {
      bad.push(t)
      continue
    }
    items.push({
      email,
      password,
      secret: secretClean.toUpperCase(),
      country
    })
  }
  return { items, bad }
}
