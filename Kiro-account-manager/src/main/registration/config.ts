import { randomFullName } from './browser-identity'

export interface RegistrationConfig {
  // AWS
  oidcBase: string
  signinBase: string
  profileBase: string
  viewBase: string
  portalBase: string
  directoryId: string
  startURL: string

  // 默认值
  password: string
  fullName: string

  // 运行时
  proxy: string
  /** 上游中转代理（可选，用于代理链）：让对 proxy(目标代理) 的连接经非大陆中转发起 */
  upstreamProxy: string
  /**
   * 严格代理模式：开启后任何「代理缺失/代理链失败/回退环境变量」情况都立即抛错中止注册，
   * 杜绝静默回退到本机真实 IP 直连。批量注册启用代理池时由前端强制开启。
   */
  strictProxy: boolean

  // MoEmail 配置
  moEmailBaseURL: string
  moEmailAPIKey: string

  // Outlook 模式
  useOutlook: boolean
  outlookData: string

  // TempMail.Plus + 自建域名
  useTempMailPlus: boolean
  tempMailPlusEmail: string  // tempmail.plus 用户名（不含 @mailto.plus）
  tempMailPlusEpin: string
  tempMailPlusDomain: string // 自建域名

  // Proton 点号别名（webview 借壳官方网页取码，需先在应用内登录 Proton）
  useProton: boolean
  protonEmail: string // 本次注册使用的 Proton 邮箱地址（母邮箱或其点号变体，由前端生成）

  // GPTmail (mail.chatgpt.org.uk) — 域名邮箱取码，支持两种玩法：
  //   A. 私有域名直收：MX 解析到 GPTmail，inboxEmail 留空（私有域名需密码解锁则填 privatePassword）
  //   B. CF Email Routing 转发：inboxEmail 填一个固定 GPTmail 邮箱
  useGptMail: boolean
  gptMailBaseURL: string      // 可选，默认 https://mail.chatgpt.org.uk；私有部署可改
  gptMailInboxEmail: string   // 可选：填了 = CF 转发模式（所有 prefix@domain 转发到此邮箱）；留空 = 私有域名直收
  gptMailDomain: string       // 必填：用户自己的域名池，多个用空格/逗号
  gptMailPrefix: string       // 可选：固定前缀，留空则 randomEmailPrefix() 生成
  gptMailPrivatePassword: string  // 可选：仅私有域名模式有效。在 GPTmail 设私有域名时设的密码

  // CF 自建邮箱 (dreamhunter2333/cloudflare_temp_email) — admin 模式
  //   走 GET /admin/mails?address= + x-admin-auth（admin 密码），无需 JWT/Turnstile/建地址。
  //   配合域名 catch-all：任意 prefix@domain 都会被收下，地址无需预先创建。
  useCfMail: boolean
  cfMailBaseURL: string       // 必填：worker 地址（不是前端 Pages 地址），如 https://temp-mail.xxx.workers.dev
  cfMailAdminPassword: string // 必填：admin 密码（x-admin-auth 头，对应 worker 的 ADMIN_PASSWORDS）
  cfMailDomain: string        // 必填：CF Email Routing 已配 catch-all 的域名（多个用空格/逗号分隔）
  cfMailPrefix: string        // 可选：固定前缀，留空则 randomEmailPrefix() 生成

  // 手动模式
  manualMode: boolean
}

export function genPassword(): string {
  const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  const lower = 'abcdefghijklmnopqrstuvwxyz'
  const digits = '0123456789'
  const special = '!@#$%^&*'

  let pw = ''
  for (let i = 0; i < 3; i++) pw += upper[Math.floor(Math.random() * upper.length)]
  for (let i = 0; i < 6; i++) pw += lower[Math.floor(Math.random() * lower.length)]
  for (let i = 0; i < 3; i++) pw += digits[Math.floor(Math.random() * digits.length)]
  for (let i = 0; i < 2; i++) pw += special[Math.floor(Math.random() * special.length)]

  const arr = pw.split('')
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr.join('')
}

export function newConfig(overrides?: Partial<RegistrationConfig>): RegistrationConfig {
  return {
    oidcBase: 'https://oidc.us-east-1.amazonaws.com',
    signinBase: 'https://us-east-1.signin.aws',
    profileBase: 'https://profile.aws.amazon.com',
    viewBase: 'https://view.awsapps.com',
    portalBase: 'https://portal.sso.us-east-1.amazonaws.com',
    directoryId: 'd-9067642ac7',
    startURL: 'https://view.awsapps.com/start',
    password: genPassword(),
    fullName: randomFullName(),
    proxy: '',
    upstreamProxy: '',
    strictProxy: false,
    moEmailBaseURL: '',
    moEmailAPIKey: '',
    useOutlook: false,
    outlookData: '',
    useTempMailPlus: false,
    tempMailPlusEmail: '',
    tempMailPlusEpin: '',
    tempMailPlusDomain: '',
    useProton: false,
    protonEmail: '',
    useGptMail: false,
    gptMailBaseURL: '',
    gptMailInboxEmail: '',
    gptMailDomain: '',
    gptMailPrefix: '',
    gptMailPrivatePassword: '',
    useCfMail: false,
    cfMailBaseURL: '',
    cfMailAdminPassword: '',
    cfMailDomain: '',
    cfMailPrefix: '',
    manualMode: false,
    ...overrides
  }
}
