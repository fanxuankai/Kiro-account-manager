import { proxyFetch, abortableSleep, extractCode } from './email-service'
import { randomEmailPrefix } from './names'

/**
 * CF 自建邮箱取码源（dreamhunter2333/cloudflare_temp_email）—— admin 模式。
 *
 * 与 GPTmail/TempMail/Proton 同级，实现 TempEmailService 接口，作为注册流程的一个取码源。
 *
 * 为什么用 admin 模式而非标准 JWT 流程：
 *  标准 cloudflare_temp_email 查邮件要带"地址 JWT"，而 JWT 由 POST /api/new_address 创建地址时下发；
 *  当后端开启了 Turnstile（POST 被 CF 拦）或部署形态特殊（前端与 worker 分离）时，POST 建地址不可用。
 *  admin 模式走 GET /admin/mails?address=xxx（带 x-admin-auth），全程无 POST、无 JWT、无 Turnstile，
 *  且配合域名 catch-all（任意 prefix@domain 都会被收下），地址无需预先创建 —— 发到就能查到。
 *
 * 认证：单一请求头 x-admin-auth: <ADMIN_PASSWORDS[0]>（明文比对，见 worker/src/utils.ts checkIsAdmin）。
 *
 * 关键端点（GET，均带 x-admin-auth）：
 *  - GET /health_check                              -> "OK"
 *  - GET /admin/mails?address=&limit=&offset=        -> {results:[{id,source,address,raw,created_at}], count}
 *  - GET /admin/address?limit=&offset=               -> 地址列表（诊断用）
 *
 * raw 字段是完整 MIME 源文（含 headers + body），提码时从 Subject 头 + text/html 正文提取。
 */

export interface CfMailServiceOptions {
  /** 必填：worker 部署地址，如 https://temp-mail.xxx.workers.dev（注意：是 worker 地址，不是前端 Pages 地址） */
  baseURL: string
  /** 必填：admin 密码（x-admin-auth 头，对应 worker 的 ADMIN_PASSWORDS） */
  adminPassword: string
  /** 必填：CF Email Routing 已配 catch-all 的域名（多个用空格/逗号分隔，每次随机挑一个降低关联） */
  domain: string
  /** 可选：固定前缀，留空则 randomEmailPrefix() 生成 */
  prefix?: string
  /** 可选：日志回调（注册流程传入，与其它取码源保持一致的日志风格） */
  log?: (msg: string) => void
}

/** 测试入参（仅测试按钮用） */
export interface CfMailTestConfig {
  baseURL: string
  adminPassword: string
  domain: string
}

/** 建地址结果 */
export interface CfCreateAddressResult {
  ok: boolean
  address?: string
  error?: string
}

/** 轮询查码结果 */
export interface CfPollCodeResult {
  ok: boolean
  /** 收到的 6 位验证码（轮询超时则缺省，由前端手动填写兜底） */
  receivedCode?: string
  /** 本次查到的邮件数（供前端打日志，让用户知道有进展） */
  mailCount?: number
  note?: string
  error?: string
}

/**
 * 从一封 raw MIME 邮件提取 6 位验证码（独立函数，供实例方法和测试函数共用）。
 * 多策略兜底：Subject 头 → 结构化正文解析 + 上下文优先提码 → 暴力解码兜底。
 */
function extractOtpFromRaw(raw: string): string {
  if (!raw) return ''
  // 1. Subject 头
  const subj = CfMailService.parseMimeHeader(raw, 'subject')
  if (subj) {
    const m = subj.match(/(\d{6})/)
    if (m) return m[1]
  }
  // 2. 结构化解析正文
  const code = CfMailService.extractCfCode(CfMailService.parseMimeBody(raw))
  if (code) return code
  // 3. 暴力兜底
  return CfMailService.extractCfCode(CfMailService.bruteDecode(raw))
}

export class CfMailService {
  private readonly baseURL: string
  private readonly adminPassword: string
  private readonly domains: string[]
  private readonly fixedPrefix: string
  private readonly log: (msg: string) => void

  private address = ''
  /** 已查过的邮件 id 基线，轮询时跳过旧邮件（并发安全，不误取别人的码） */
  private checkedIds = new Set<number>()

  constructor(opts: CfMailServiceOptions) {
    this.baseURL = CfMailService.normalizeBaseURL(opts.baseURL)
    if (!opts.adminPassword || !opts.adminPassword.trim()) {
      throw new Error('CF 邮箱 admin 密码为空（对应 worker 的 ADMIN_PASSWORDS）')
    }
    this.adminPassword = opts.adminPassword.trim()
    this.domains = (opts.domain || '')
      .split(/[\s,;]+/)
      .map((d) => d.trim().replace(/^@/, ''))
      .filter(Boolean)
    if (this.domains.length === 0) {
      throw new Error('CF 邮箱域名为空（填 CF Email Routing 已配 catch-all 的域名）')
    }
    this.fixedPrefix = (opts.prefix || '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '')
    this.log = opts.log || ((m: string) => console.log(m))
  }

  /** admin 模式：地址无需"创建"，catch-all 下任意 prefix@domain 都能收。这里只是拼一个地址。 */
  async create(): Promise<string> {
    const domain = this.domains[Math.floor(Math.random() * this.domains.length)]
    const prefix = this.fixedPrefix || randomEmailPrefix()
    this.address = `${prefix}@${domain}`
    if (this.domains.length > 1) {
      this.log(`[CfMail] 使用邮箱: ${this.address}  (域名池 ${this.domains.length} 个)`)
    } else {
      this.log(`[CfMail] 使用邮箱: ${this.address}`)
    }
    return this.address
  }

  getAddress(): string {
    return this.address
  }

  /** 轮询收件箱取 6 位验证码，与 TempMailPlusService 逻辑同构 */
  async waitForCode(timeoutSec: number, intervalSec: number, signal?: AbortSignal): Promise<string> {
    if (!this.address) throw new Error('CF 邮箱地址为空，请先 create()')
    const maxRetries = Math.floor(timeoutSec / intervalSec)

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      if (signal?.aborted) throw new Error('注册已取消')
      await abortableSleep(intervalSec * 1000, signal)
      try {
        const mails = await this.fetchMails()
        if (attempt === 1 || attempt % 5 === 0) {
          this.log(`[CfMail] [${attempt}/${maxRetries}] 邮件数: ${mails.length}`)
        }
        for (const mail of mails) {
          const id = Number(mail.id)
          if (!Number.isFinite(id) || this.checkedIds.has(id)) continue
          this.checkedIds.add(id)

          const code = this.extractOtp(mail)
          if (code) {
            this.log(`[CfMail] 验证码: ${code}`)
            return code
          }
        }
      } catch (err) {
        if (signal?.aborted) throw new Error('注册已取消')
        this.log(`[CfMail] [${attempt}/${maxRetries}] 查询失败: ${CfMailService.errText(err)}`)
      }
      if (attempt % 5 === 0) this.log(`[CfMail] [${attempt}/${maxRetries}] 暂无验证码...`)
    }
    throw new Error(`CF 邮箱等待验证码超时 (${timeoutSec}s)`)
  }

  /** GET /admin/mails?address=&limit=&offset= 查指定地址的邮件列表 */
  private async fetchMails(): Promise<Array<Record<string, unknown>>> {
    const url = `${this.baseURL}/admin/mails?address=${encodeURIComponent(this.address)}&limit=20&offset=0`
    const resp = await proxyFetch(url, {
      method: 'GET',
      headers: this.buildHeaders(),
      signal: AbortSignal.timeout(15000)
    })
    if (resp.status === 401) {
      throw new Error('admin 密码错误（x-admin-auth 校验失败）')
    }
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`)
    }
    const data = (await resp.json().catch(() => ({}))) as Record<string, unknown>
    return (data.results as Array<Record<string, unknown>>) || []
  }

  private buildHeaders(): Record<string, string> {
    return {
      'accept': 'application/json, text/plain, */*',
      'x-admin-auth': this.adminPassword
    }
  }

  /**
   * 从单封邮件提取 6 位验证码 —— 委托给 extractOtpFromRaw（多策略兜底）。
   */
  private extractOtp(mail: Record<string, unknown>): string {
    const raw = String(mail.raw || '')
    if (!raw) {
      return extractCode(String(mail.source || ''))
    }
    return extractOtpFromRaw(raw)
  }

  /**
   * 从文本中智能提取 6 位验证码（上下文优先）。
   *
   * 优先返回"验证码/code/verification"等关键词附近的 6 位数字，
   * 避免误匹配 HTML 颜色值（#000000）、日期片段等噪声。
   * 关键词没命中时，退化为取最后一个独立 6 位数字。
   */
  static extractCfCode(text: string): string {
    if (!text) return ''
    // 上下文优先：关键词后紧跟（允许少量中间字符）的 6 位数字
    // 中英文关键词：验证码 / code / verification / otp / pin / 授权码 / 动态码
    const ctxRe = /(?:验证码|verification\s*code|code|otp|pin|授权码|动态码|密码)[^\d]{0,20}(\d{6})\b/i
    const ctxMatch = text.match(ctxRe)
    if (ctxMatch) return ctxMatch[1]
    // 也匹配 "数字 是验证码" 的反向语序
    const revRe = /\b(\d{6})[^\d]{0,10}(?:验证码|verification|code|otp|授权码)/i
    const revMatch = text.match(revRe)
    if (revMatch) return revMatch[1]
    // 兜底：最后一个独立的 6 位数字（跳过全 0 的噪声值）
    const all = text.match(/\b(\d{6})\b/g)
    if (all) {
      const filtered = all.filter((c) => !/^0{6}$/.test(c))
      if (filtered.length > 0) return filtered[filtered.length - 1]
    }
    return ''
  }

  /**
   * 暴力解码兜底：当结构化 MIME 解析（parseMimeBody）因各种原因失败时，
   * 对 raw 里所有"看起来像 base64 编码的连续块"和"quoted-printable 段"解码，
   * 拼成文本返回。验证码是 ASCII 数字，即使 charset 错也能提到。
   */
  static bruteDecode(raw: string): string {
    const chunks: string[] = []
    // base64 块：连续 40+ 字符的 base64 字符集
    const b64Matches = raw.match(/[A-Za-z0-9+/]{40,}={0,2}/g)
    if (b64Matches) {
      for (const b of b64Matches) {
        try {
          const decoded = Buffer.from(b, 'base64').toString('utf-8')
          // 只保留解码后含可读文本的（排除二进制）
          if (/[\x20-\x7e]/.test(decoded) && decoded.length > 4) {
            chunks.push(decoded)
          }
        } catch { /* ignore */ }
      }
    }
    // quoted-printable 段：含 =XX 模式的段
    if (/=[0-9a-fA-F]{2}/.test(raw)) {
      const qpDecoded = raw
        .replace(/=\r?\n/g, '')
        .replace(/=([0-9a-fA-F]{2})/g, (_h, hex: string) => String.fromCharCode(parseInt(hex, 16)))
      chunks.push(qpDecoded)
    }
    // 也把 raw 原文加入（万一验证码在未编码的明文里）
    chunks.push(raw)
    return chunks.join('\n')
  }

  // ============ 静态工具 ============

  static normalizeBaseURL(raw: string): string {
    const trimmed = (raw || '').trim().replace(/\/+$/, '')
    if (!trimmed) throw new Error('CF 邮箱 Worker 地址为空')
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
    let u: URL
    try {
      u = new URL(withScheme)
    } catch {
      throw new Error(`CF 邮箱 Worker 地址格式无效: ${raw}`)
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      throw new Error(`CF 邮箱 Worker 地址协议不支持 (仅支持 http/https): ${u.protocol}`)
    }
    return withScheme
  }

  /** 从 MIME 源文里取某个 header 的值（处理折行 + 解码 =?UTF-8?Q?...?= / =?UTF-8?B?...?=） */
  static parseMimeHeader(raw: string, name: string): string {
    // header 在第一个空行之前；折行以缩进续接
    const headerEnd = raw.indexOf('\r\n\r\n')
    const headerBlock = headerEnd >= 0 ? raw.slice(0, headerEnd) : raw
    const re = new RegExp(`^${name}:\\s*([\\s\\S]*?)(?=\\r?\\n[^ \\t]|$)`, 'im')
    const m = headerBlock.match(re)
    if (!m) return ''
    let val = m[1].replace(/\r?\n[ \t]+/g, ' ').trim() // 展开折行
    // 解码 RFC 2047 encoded-word：=?charset?Q?text?= 或 =?charset?B?text?=
    val = val.replace(/=\?([^?]+)\?([qQbB])\?([^?]*)\?=/g, (_full, _charset: string, enc: string, text: string) => {
      try {
        if (enc.toUpperCase() === 'B') {
          return Buffer.from(text, 'base64').toString('utf-8')
        }
        // Q-encoding：=XX 十六进制，_ 表示空格
        return text.replace(/_/g, ' ').replace(/=([0-9a-fA-F]{2})/g, (_h: string, hex: string) =>
          String.fromCharCode(parseInt(hex, 16))
        )
      } catch {
        return text
      }
    })
    // 二次解码：Q-encoding 解出的是字节序列，若是 UTF-8 多字节需整体解码
    try {
      const buf = Buffer.from(val.split('').map((c) => c.charCodeAt(0)))
      const decoded = buf.toString('utf-8')
      return decoded
    } catch {
      return val
    }
  }

  /**
   * 从 MIME 源文解析出全部正文文本（用于提码）—— 通用 MIME 解析器。
   *
   * 不针对任何特定邮件服务商，递归处理所有格式：
   *  - multipart/mixed、multipart/alternative 等：按 boundary 拆分递归
   *  - text/plain、text/html：去 HTML 标签后取文本
   *  - Content-Transfer-Encoding：quoted-printable / base64 / 7bit / 8bit 自动解码
   *
   * 直接对 raw 跑正则会匹配到 HTML 颜色值（#000000）等噪声，必须先正确解码。
   */
  static parseMimeBody(raw: string): string {
    return CfMailService.extractTextFromMime(raw).trim()
  }

  /** 递归从一段 MIME（可能是顶层或某个 part）提取所有文本内容 */
  private static extractTextFromMime(mime: string): string {
    // 拆分 header / body
    const { headers, body } = CfMailService.splitMime(mime)
    const contentType = CfMailService.getHeader(headers, 'content-type') || 'text/plain'
    const encoding = (CfMailService.getHeader(headers, 'content-transfer-encoding') || '').toLowerCase()
    const charset = CfMailService.getParam(contentType, 'charset')

    // multipart：按 boundary 拆分，递归处理每个 part
    const boundary = CfMailService.getParam(contentType, 'boundary')
    if (boundary && /multipart\//i.test(contentType)) {
      const parts = CfMailService.splitMultipart(body, boundary)
      return parts.map((p) => CfMailService.extractTextFromMime(p)).filter(Boolean).join('\n')
    }

    // 叶子节点：按编码 + charset 解码
    const decoded = CfMailService.decodeBody(body, encoding, charset)

    // text/html：去标签；text/plain：直接用；其它也尝试去标签兜底
    if (/text\/html/i.test(contentType) || /<[a-z!][^>]*>/i.test(decoded)) {
      return CfMailService.stripHtml(decoded)
    }
    return decoded
  }

  /** 拆分 MIME 的 header 块和 body */
  private static splitMime(mime: string): { headers: string; body: string } {
    const m = mime.match(/^([\s\S]*?)\r?\n\r?\n([\s\S]*)$/)
    if (!m) return { headers: '', body: mime }
    return { headers: m[1], body: m[2] }
  }

  /** 从 header 块取某个 header 值（不区分大小写，处理折行续接）。
   *  MIME header 折行：下一行以空格或 tab 开头表示续接上一行。
   *  匹配到以下任一位置结束：换行后非空白（下一个 header）、空行（header 块结束）、字符串结尾。
   *  注意：不用 ^ + m flag（大 header 块里回溯异常），改用 (?:^|\r?\n) 匹配行首。 */
  private static getHeader(headers: string, name: string): string {
    const re = new RegExp(`(?:^|\\r?\\n)${name}:([\\s\\S]*?)(?=\\r?\\n(?:[^ \\t]|\\r?\\n)|$)`, 'i')
    const m = headers.match(re)
    if (!m) return ''
    // 去掉开头的 \n（来自 (?:^|\r?\n)），展开折行
    let val = m[1].replace(/\r?\n[ \t]+/g, ' ').trim()
    return val
  }

  /** 从 Content-Type 值里取某个参数（如 boundary / charset）。
   *  注意 RFC 2046 的 boundary 值可含 '='（如 ----=_NextPart_xxx），不能排除它。 */
  private static getParam(contentType: string, param: string): string {
    const re = new RegExp(`${param}\\s*=\\s*"?([^";\\s]+=?[^";\\s]*)"?`, 'i')
    const m = contentType.match(re)
    return m ? m[1] : ''
  }

  /** 按 boundary 拆分 multipart body，返回各 part（含各自 header） */
  private static splitMultipart(body: string, boundary: string): string[] {
    const delim = `--${boundary}`
    // 去掉 preamble（boundary 前）和 epilogue（closing boundary 后）
    const rawParts = body.split(delim).slice(1)
    const parts: string[] = []
    for (const p of rawParts) {
      const trimmed = p.replace(/^\r?\n/, '').replace(/\r?\n$/, '')
      if (trimmed === '--' || trimmed.startsWith('--')) continue // closing boundary
      if (trimmed.trim()) parts.push(trimmed)
    }
    return parts
  }

  /** 按 Content-Transfer-Encoding 解码 body，并按 charset 转为 UTF-8 */
  private static decodeBody(body: string, encoding: string, charset?: string): string {
    let buf: Buffer
    if (encoding === 'base64') {
      try {
        buf = Buffer.from(body.replace(/\s+/g, ''), 'base64')
      } catch {
        return body
      }
    } else if (encoding === 'quoted-printable') {
      const bytes: number[] = []
      for (let i = 0; i < body.length; i++) {
        if (body[i] === '=' && body[i + 1] === '\n') { i++ ; continue }
        if (body[i] === '=' && body[i + 1] === '\r' && body[i + 2] === '\n') { i += 2 ; continue }
        if (body[i] === '=' && /[0-9a-fA-F]{2}/.test(body.slice(i + 1, i + 3))) {
          bytes.push(parseInt(body.slice(i + 1, i + 3), 16))
          i += 2
        } else {
          bytes.push(body.charCodeAt(i) & 0xff)
        }
      }
      buf = Buffer.from(bytes)
    } else {
      // 7bit / 8bit / 无编码
      buf = Buffer.from(body, 'utf-8')
    }
    // charset 转码：Node 内置支持 utf-8/utf8/ascii/latin1；
    // GBK/GB2312/GB18030 等 Node 不内置，iconv 可能未装 —— 尝试常见别名，失败则按 latin1 兜底
    const cs = (charset || 'utf-8').toLowerCase().trim()
    if (cs === 'utf-8' || cs === 'utf8' || cs === 'us-ascii' || cs === 'ascii') {
      return buf.toString('utf-8')
    }
    if (cs === 'iso-8859-1' || cs === 'latin1') {
      return buf.toString('latin1')
    }
    // 尝试动态 require iconv（若装了）
    try {
      const iconv = require('iconv-lite')
      return iconv.decode(buf, cs)
    } catch {
      // 没装 iconv：GBK 内容按 utf-8 解大概率乱码，但验证码是 ASCII 数字不受影响
      return buf.toString('utf-8')
    }
  }

  /** 去 HTML 标签，解码常见实体，折叠空白 */
  private static stripHtml(html: string): string {
    return html
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ') // 去 <style>
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ') // 去 <script>
      .replace(/<[^>]+>/g, ' ') // 去所有标签
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#(\d+);/g, (_h, dec: string) => String.fromCharCode(parseInt(dec, 10)))
      .replace(/\s+/g, ' ')
      .trim()
  }

  /** 从 fetch 异常或 API 错误响应里提取可读文本 */
  private static errText(data: unknown): string {
    if (data instanceof Error) return data.message
    if (data && typeof data === 'object') {
      const obj = data as Record<string, unknown>
      return String(obj.error || obj.message || obj.msg || JSON.stringify(data).slice(0, 200))
    }
    return String(data ?? '')
  }
}

/**
/**
 * CF 邮箱测试 · 第一步：建测试地址（供测试按钮"生成测试地址"调用）。
 *
 * 全程只打 worker 的 admin API（x-admin-auth），**不创建 Registrar、不碰 AWS 注册接口**。
 *
 * 流程：
 *  1. health_check 探活（确认是 worker 而非前端 Pages）
 *  2. POST /admin/new_address 建测试地址 kiro-cftest-xxxx@domain
 *  3. 返回地址 —— 用户从外部邮箱（Gmail/QQ 等）手动发一封带验证码的邮件到该地址
 *
 * 为什么不自发自收：CF 的 send_email 发到自己域名会被循环检测丢弃，
 * 所以测试必须用外部邮箱发件，这才与真实注册（AWS 发 OTP）通路一致。
 */
export async function createCfTestAddress(cfg: CfMailTestConfig): Promise<CfCreateAddressResult> {
  const baseURL = CfMailService.normalizeBaseURL(cfg.baseURL)
  const adminPassword = (cfg.adminPassword || '').trim()
  if (!adminPassword) {
    return { ok: false, error: 'admin 密码为空' }
  }
  const domains = (cfg.domain || '')
    .split(/[\s,;]+/).map((d) => d.trim().replace(/^@/, '')).filter(Boolean)
  if (domains.length === 0) {
    return { ok: false, error: '域名为空' }
  }
  const domain = domains[0]
  const headers: Record<string, string> = {
    'accept': 'application/json, text/plain, */*',
    'content-type': 'application/json',
    'x-admin-auth': adminPassword
  }

  // 1. 探活
  try {
    const r = await proxyFetch(`${baseURL}/health_check`, { method: 'GET', signal: AbortSignal.timeout(10000) })
    const body = (await r.text()).trim()
    if (!r.ok || body.toLowerCase().includes('<!doctype') || body.toLowerCase().includes('<html')) {
      return { ok: false, error: '该地址返回的是前端页面而非 worker（请确认填的是 worker 地址，不是 Pages 地址）' }
    }
  } catch (e) {
    return { ok: false, error: `后端不可达: ${e instanceof Error ? e.message : String(e)}` }
  }

  // 2. admin 建地址
  const localPart = `kiro-cftest-${Math.random().toString(36).slice(2, 8)}`
  try {
    const r = await proxyFetch(`${baseURL}/admin/new_address`, {
      method: 'POST', headers,
      body: JSON.stringify({ name: localPart, domain, enablePrefix: false }),
      signal: AbortSignal.timeout(15000)
    })
    if (r.status === 401) {
      return { ok: false, error: 'admin 密码错误（x-admin-auth 校验失败）' }
    }
    if (!r.ok) {
      const t = (await r.text().catch(() => '')).slice(0, 200)
      return { ok: false, error: `建地址失败: HTTP ${r.status} ${t}` }
    }
    const d = (await r.json().catch(() => ({}))) as Record<string, unknown>
    const address = String(d.address || `${localPart}@${domain}`)
    return { ok: true, address }
  } catch (e) {
    return { ok: false, error: `建地址失败: ${e instanceof Error ? e.message : String(e)}` }
  }
}

/**
 * CF 邮箱测试 · 第二步：轮询查码（供测试按钮"查询验证码"调用）。
 *
 * 用户从外部邮箱发件后，点"查询"轮询 GET /admin/mails?address= 提码。
 * 查到则返回 receivedCode（前端自动填入）；超时则返回空，由前端手动填写兜底。
 *
 * @param timeoutSec 轮询超时秒数，默认 90（留足外部邮件投递时间）
 */
export async function pollCfTestCode(cfg: CfMailTestConfig, address: string, timeoutSec = 90): Promise<CfPollCodeResult> {
  const baseURL = CfMailService.normalizeBaseURL(cfg.baseURL)
  const adminPassword = (cfg.adminPassword || '').trim()
  if (!adminPassword) {
    return { ok: false, error: 'admin 密码为空' }
  }
  if (!address) {
    return { ok: false, error: '地址为空' }
  }
  const headers: Record<string, string> = { 'accept': 'application/json, text/plain, */*', 'x-admin-auth': adminPassword }
  const checkedIds = new Set<number>()
  // 至少查一次；前端以小 timeoutSec（如 1）调用时 maxAttempts=1，查完立即返回
  const maxAttempts = Math.max(1, Math.floor(timeoutSec / 3))

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // 首次不等待（前端已 sleep 过）；后续轮询间隔 3s
    if (attempt > 1) {
      await new Promise((resolve) => setTimeout(resolve, 3000))
    }
    try {
      const r = await proxyFetch(`${baseURL}/admin/mails?address=${encodeURIComponent(address)}&limit=20&offset=0`, {
        method: 'GET', headers, signal: AbortSignal.timeout(15000)
      })
      if (!r.ok) continue
      const d = (await r.json().catch(() => ({}))) as Record<string, unknown>
      const mails = (d.results as Array<Record<string, unknown>>) || []
      for (const mail of mails) {
        const id = Number(mail.id)
        if (!Number.isFinite(id) || checkedIds.has(id)) continue
        checkedIds.add(id)
        const raw = String(mail.raw || '')
        if (raw) {
          // 复用 extractOtp 的多策略提取（Subject 优先 → 上下文优先 → 暴力兜底）
          const got = extractOtpFromRaw(raw)
          if (got) {
            return { ok: true, receivedCode: got, mailCount: mails.length, note: '已收到验证码' }
          }
        }
      }
      // 这一轮查到了邮件但没提到码 —— 返回邮件数让前端打日志
      if (mails.length > 0) {
        return { ok: false, mailCount: mails.length, error: `查到 ${mails.length} 封邮件但未提取到 6 位验证码` }
      }
    } catch { /* 重试 */ }
  }
  return { ok: false, mailCount: 0, error: `${timeoutSec}s 内未查到邮件` }
}
