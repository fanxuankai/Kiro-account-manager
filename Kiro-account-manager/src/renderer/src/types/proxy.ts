/**
 * 代理池数据模型
 *
 * 用途：注册批量任务时为每个账号轮换不同的出口 IP，降低风控关联风险。
 * 与 `proxy/kproxy` 不同——那两个是"反代/客户端代理"，这里是"出口代理池"。
 */

export type ProxyProtocol = 'http' | 'https' | 'socks5' | 'socks4' | 'hy2' | 'vless'

export type ProxyStatus =
  | 'untested'   // 未测试
  | 'testing'    // 测试中
  | 'alive'      // 可用
  | 'dead'       // 不可用
  | 'slow'       // 可用但延迟较高

/** 代理池条目 */
export interface ProxyEntry {
  id: string
  url: string            // 规范化后的完整 URL，如 http://user:pass@host:port
  protocol: ProxyProtocol
  host: string
  port: number
  username?: string
  password?: string

  // 元数据
  label?: string         // 用户标注的备注名
  source?: string        // 来源标记（手动 / 文件 / 订阅）
  tags?: string[]

  // 验活信息
  status: ProxyStatus
  latencyMs?: number     // 最近一次测试的延迟（毫秒）
  lastTestedAt?: number  // 时间戳
  lastError?: string     // 测试失败原因

  // 统计
  usedCount: number      // 累计使用次数
  failCount: number      // 累计失败次数
  lastUsedAt?: number
  lastBoundEmail?: string // 最近一次绑定的邮箱（用于关联追溯）

  // 配置
  enabled: boolean       // 是否启用（停用的代理不参与轮询）

  createdAt: number
}

/** 代理验活结果 */
export interface ProxyValidationResult {
  success: boolean
  latencyMs?: number
  externalIp?: string    // 通过代理出口看到的 IP
  error?: string
}

/** 代理池调度策略 */
export type ProxyPoolStrategy =
  | 'round_robin'  // 轮询
  | 'random'       // 随机
  | 'least_used'   // 最少使用优先
  | 'fastest'      // 延迟最低优先

/** 预设 IP 检测端点 */
export interface IpDetectEndpoint {
  id: string
  label: string
  url: string
  /** 响应格式：json 从字段提取 IP，text 用正则匹配 */
  format: 'json' | 'text'
  /** JSON 响应中 IP 所在的字段路径（如 'ip' / 'query' / 'origin'）*/
  ipField?: string
}

export const IP_DETECT_ENDPOINTS: IpDetectEndpoint[] = [
  { id: 'ipify',       label: 'ipify',        url: 'https://api.ipify.org?format=json',  format: 'json', ipField: 'ip' },
  { id: 'ip-api',      label: 'IP-API',        url: 'http://ip-api.com/json',             format: 'json', ipField: 'query' },
  { id: 'ipinfo',      label: 'IPinfo',        url: 'https://ipinfo.io/json',             format: 'json', ipField: 'ip' },
  { id: 'ip2location', label: 'IP2Location',   url: 'https://api.ip2location.io',         format: 'json', ipField: 'ip' },
  { id: 'httpbin',     label: 'httpbin',       url: 'https://httpbin.org/ip',             format: 'json', ipField: 'origin' },
  { id: 'ifconfig',    label: 'ifconfig.me',   url: 'https://ifconfig.me/ip',             format: 'text' },
  { id: 'icanhazip',   label: 'icanhazip',     url: 'https://icanhazip.com',              format: 'text' },
  { id: 'ipapi-co',    label: 'ipapi.co',      url: 'https://ipapi.co/json',              format: 'json', ipField: 'ip' },
]

/** 代理池配置 */
export interface ProxyPoolConfig {
  enabled: boolean              // 是否启用代理池（注册时自动取用）
  strategy: ProxyPoolStrategy
  validateOnStartup: boolean    // 启动时自动验活
  autoDisableDead: boolean      // 失败代理自动停用
  failureThreshold: number      // 累计失败 N 次后停用
  testUrl: string               // 验活测试 URL（默认 https://api.ipify.org）
  testTimeoutMs: number         // 单次验活超时
  /** 定时自动验活：分钟为单位，0 表示关闭 */
  autoValidateIntervalMin: number
  /** 定时验活的并发数 */
  autoValidateConcurrency: number
  /** 上游中转代理（可选）：配合"目标代理要求非大陆来源 IP"的场景串联代理链；支持 http/socks5 */
  upstreamProxy?: string
  /** 动态提链源接口地址：批量提取一次性端点（号池注册/批量订阅取链接可选接入）；空=未配置 */
  dynamicApiUrl?: string
  /** 提链端点与提链请求的本地中转；留空自动取系统代理 */
  dynamicViaProxy?: string
  /** 单次批量提取数量（num 参数），1~20 */
  dynamicBatchSize?: number
}

export const DEFAULT_PROXY_POOL_CONFIG: ProxyPoolConfig = {
  enabled: false,
  strategy: 'round_robin',
  validateOnStartup: false,
  autoDisableDead: true,
  failureThreshold: 3,
  testUrl: 'https://api.ipify.org?format=json',
  testTimeoutMs: 8000,
  autoValidateIntervalMin: 0,
  dynamicApiUrl: '',
  dynamicViaProxy: '',
  dynamicBatchSize: 5,
  autoValidateConcurrency: 5,
  upstreamProxy: ''
}
