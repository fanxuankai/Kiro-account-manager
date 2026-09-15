// 号池登录用 TOTP（RFC 6238：SHA-1 / 6 位 / 30s，GitHub 两步验证标准参数）。
// 移植自 github-signup 扩展 shared.js 的 totpNow/base32Decode（该实现经
// RFC 6238 官方向量验证），密钥纯本地计算、不出本机。

import { createHmac } from 'node:crypto'

/** RFC 4648 base32 解码（容忍大小写/空格/连字符/缺 padding） */
export function base32Decode(s: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of String(s || '').toUpperCase().replace(/[^A-Z2-7]/g, '')) {
    value = (value << 5) | alphabet.indexOf(ch)
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

/** 校验是否为合法 base32（入池解析用，与插件 parseLoginPoolText 同规则） */
export function isBase32(s: string): boolean {
  return /^[A-Za-z2-7]+=*$/.test(s.replace(/[\s-]/g, ''))
}

/** 算当前（或指定时刻）的 TOTP 码：{ code: '123456', remainMs: 有效余量 }。
 *  remainMs 供调用方在窗口尾部等下一个周期，避免码填完即过期。 */
export function totpNow(secret: string, nowMs: number = Date.now()): { code: string; remainMs: number } {
  const keyBytes = base32Decode(secret)
  if (!keyBytes.length) throw new Error('2FA 密钥不是合法 base32')

  const step = Math.floor(nowMs / 30000)
  // 8 字节大端计数器（当前 step ≈ 6e7，远未超 2^32，位运算安全）
  const msg = Buffer.alloc(8)
  let v = step
  for (let i = 7; i >= 0; i--) {
    msg[i] = v & 0xff
    v = Math.floor(v / 256)
  }

  const sig = createHmac('sha1', keyBytes).update(msg).digest()
  const off = sig[sig.length - 1] & 0x0f
  const num = ((sig[off] & 0x7f) << 24) | (sig[off + 1] << 16) | (sig[off + 2] << 8) | sig[off + 3]
  return { code: String(num % 1000000).padStart(6, '0'), remainMs: 30000 - (nowMs % 30000) }
}

/** 解析「账号----密码----2FA 密钥」文本块 → 条目数组（不落盘）。
 *  分隔符严格取 4 连字符：密码里 1–3 连字符很常见，宽松匹配会切错段。
 *  非法行整行跳过并在 bad 里带回原文，由界面提示人工修。 */
export function parseLoginPoolText(
  text: string
): { items: { username: string; password: string; secret: string }[]; bad: string[] } {
  const items: { username: string; password: string; secret: string }[] = []
  const bad: string[] = []
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim()
    if (!t) continue
    const parts = t.split('----')
    if (parts.length !== 3) {
      bad.push(t)
      continue
    }
    const [username, password, secret] = parts.map((s) => s.trim())
    const secretClean = secret.replace(/[\s-]/g, '')
    if (!username || !password || !isBase32(secretClean)) {
      bad.push(t)
      continue
    }
    items.push({ username, password, secret: secretClean.toUpperCase() })
  }
  return { items, bad }
}
