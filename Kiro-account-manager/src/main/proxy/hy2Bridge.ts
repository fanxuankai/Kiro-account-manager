// hy2(Hysteria2)代理桥:把 hy2:// 代理 URL 自动转成本地 socks5 入站。
//
// 背景:undici/socks 体系只认 TCP 代理(http/socks),而 Hysteria2 基于 QUIC(UDP),
// Node 侧无现成实现。方案是应用内嵌 sing-box 内核(单文件二进制,extraResources 打包),
// 每个 hy2:// URL 起一个 sing-box 实例:本地 mixed(socks5+http)入站 + hysteria2 出站。
// 对上层完全透明——safeCreateProxyAgent / ChainProxyRelay / Chromium proxyRules
// 看到的都是普通的 socks5://127.0.0.1:<port>。
//
// 生命周期:懒启动(resolve 时),崩溃自动重启(限频),app 退出统一回收。
// 二进制定位:打包后在 <resources>/bin/,开发模式在 <项目>/resources/bin/
// (scripts/fetch-singbox.mjs 下载)。

import { app } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import crypto from 'node:crypto'

/** hy2 URI 解析结果(sing-box hysteria2 outbound 的原料) */
export interface Hy2Params {
  server: string
  serverPort: number
  password: string
  sni?: string
  insecure: boolean
  obfsPassword?: string
  /** 端口跳跃(URI 的 mport/ports 参数),sing-box server_ports */
  serverPorts?: string[]
}

export function isHy2Url(url: string | null | undefined): boolean {
  if (!url) return false
  const m = url.match(/^\s*([a-zA-Z][\w+.-]*):/)
  if (!m) return false
  const proto = m[1].toLowerCase()
  return proto === 'hy2' || proto === 'hysteria2' || proto === 'hysteria'
}

/** 解析 hy2/hysteria2 URI(官方格式:hy2://auth@host:port/?sni=&insecure=&obfs=salamander&obfs-password=&mport=) */
function parseHy2Url(url: string): Hy2Params | null {
  let u: URL
  try {
    u = new URL(url.trim())
  } catch {
    return null
  }
  const host = u.hostname
  if (!host) return null
  const port = Number(u.port) || 443
  // auth 是单个密码串(可含 URL 编码的冒号);整段 userinfo 解码后交给 sing-box
  const password = u.username ? decodeURIComponent(u.username) : ''
  const q = u.searchParams
  const insecure = ['1', 'true', 'yes'].includes((q.get('insecure') || '').toLowerCase())
  const obfs = q.get('obfs')
  const obfsPassword = obfs === 'salamander' ? (q.get('obfs-password') || undefined) : undefined
  // mport 支持单端口、范围(a-b / a:b)、逗号列表;sing-box server_ports 收 "start:end" 格式
  // (实测 1.14:横杠和裸单端口都报 bad port range,统一归一成冒号)
  let serverPorts: string[] | undefined
  const mport = q.get('mport') || q.get('ports')
  if (mport) {
    serverPorts = mport
      .split(',')
      .map((s) => {
        const t = s.trim()
        const m = t.match(/^(\d+)[-:](\d+)$/)
        return m ? `${m[1]}:${m[2]}` : /^\d+$/.test(t) ? `${t}:${t}` : null
      })
      .filter((s): s is string => !!s)
  }
  return {
    server: host,
    serverPort: port,
    password,
    sni: q.get('sni') || undefined,
    insecure,
    obfsPassword,
    serverPorts
  }
}

/** 生成 sing-box 配置:唯一 mixed 入站(127.0.0.1:port)+ hysteria2 出站 */
export function buildSingboxConfig(p: Hy2Params, listenPort: number): string {
  const hy2Out: Record<string, unknown> = {
    type: 'hysteria2',
    tag: 'hy2-out',
    server: p.server,
    server_port: p.serverPort
  }
  if (p.password) hy2Out.password = p.password
  if (p.serverPorts) {
    hy2Out.server_ports = p.serverPorts
    // 端口跳跃时 server_port 仍是必填字段,取范围首个端口占位(实际由跳跃逻辑选)
    hy2Out.server_port = Number(p.serverPorts[0].split(':')[0]) || p.serverPort
  }
  if (p.obfsPassword) hy2Out.obfs = { type: 'salamander', password: p.obfsPassword }
  hy2Out.tls = {
    enabled: true,
    server_name: p.sni || p.server,
    insecure: p.insecure,
    alpn: ['h3']
  }
  return JSON.stringify(
    {
      log: { level: 'warn', timestamp: true },
      inbounds: [
        { type: 'mixed', tag: 'in', listen: '127.0.0.1', listen_port: listenPort }
      ],
      outbounds: [hy2Out]
    },
    null,
    2
  )
}

/** 一个 hy2 URL 对应的 sing-box 实例 */
interface Hy2Instance {
  proc: ChildProcess
  port: number
  configPath: string
  /** 本地 socks5 URL(resolve 的返回值) */
  localUrl: string
  /** 最近 stderr 尾巴,起不来时给用户看原因 */
  lastError: string
  stopping: boolean
  /** 60s 滑窗内的崩溃重启次数(超限判节点坏) */
  restarts: number[]
}

const instances = new Map<string, Hy2Instance>()
/** 进行中的启动 promise:并发 resolve 同一 URL 只起一个进程 */
const starting = new Map<string, Promise<string>>()

/** sing-box 二进制路径:打包后在 resources/bin,开发模式在项目 resources/bin。
 *  mac 双架构包里两份内核按 arch 后缀共存,优先精确匹配,再回退无后缀名。 */
export function singboxBinaryPath(): string {
  const suffix = process.platform === 'win32' ? '.exe' : ''
  const base = app.isPackaged ? path.join(process.resourcesPath, 'bin') : path.join(app.getAppPath(), 'resources', 'bin')
  const candidates = [`sing-box-${process.arch}${suffix}`, `sing-box${suffix}`]
  for (const name of candidates) {
    const p = path.join(base, name)
    if (fs.existsSync(p)) return p
  }
  return path.join(base, candidates[0])
}

/** 配置目录(userData 下按 URL 哈希落文件) */
function configDir(): string {
  const dir = path.join(app.getPath('userData'), 'hy2-bridge')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** 找一个空闲本地端口(listen(0) 让系统分配,极小窗口竞态可接受) */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo
      srv.close(() => resolve(port))
    })
  })
}

/** 端口可接受 TCP 连接即视为就绪(socks5 入站已监听) */
function waitPortReady(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const tryOnce = (): void => {
      const sock = net.connect({ port, host: '127.0.0.1', timeout: 1500 })
      sock.once('connect', () => {
        sock.destroy()
        resolve()
      })
      sock.once('error', () => {
        sock.destroy()
        if (Date.now() > deadline) {
          reject(new Error(`sing-box ${timeoutMs}ms 内未就绪`))
        } else {
          setTimeout(tryOnce, 200)
        }
      })
    }
    tryOnce()
  })
}

/** 启动(或复用)一个 hy2 URL 对应的本地 socks5 桥 */
async function ensureInstance(hy2Url: string): Promise<string> {
  const existing = instances.get(hy2Url)
  if (existing && !existing.proc.killed) return existing.localUrl

  const inflight = starting.get(hy2Url)
  if (inflight) return inflight

  const task = (async (): Promise<string> => {
    const params = parseHy2Url(hy2Url)
    if (!params) throw new Error('hy2 链接格式无效(需 hy2://[auth@]host:port)')

    const bin = singboxBinaryPath()
    if (!fs.existsSync(bin)) {
      throw new Error(
        'sing-box 内核不存在(hy2 支持需要):打包版请重装最新版本;开发模式执行 node scripts/fetch-singbox.mjs'
      )
    }

    const port = await findFreePort()
    const configPath = path.join(
      configDir(),
      `${crypto.createHash('sha1').update(hy2Url).digest('hex').slice(0, 12)}.json`
    )
    fs.writeFileSync(configPath, buildSingboxConfig(params, port))

    const proc = spawn(bin, ['run', '-c', configPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    const inst: Hy2Instance = {
      proc,
      port,
      configPath,
      localUrl: `socks5://127.0.0.1:${port}`,
      lastError: '',
      stopping: false,
      restarts: []
    }
    const onErr = (chunk: Buffer): void => {
      inst.lastError = (inst.lastError + chunk.toString()).slice(-2000)
    }
    proc.stderr?.on('data', onErr)
    proc.stdout?.on('data', onErr)
    proc.once('exit', (code) => {
      instances.delete(hy2Url)
      starting.delete(hy2Url)
      if (inst.stopping) return
      // 意外退出:限频重启(60s 内最多 3 次),超限判定节点不可用
      const now = Date.now()
      inst.restarts = inst.restarts.filter((t) => now - t < 60_000)
      if (inst.restarts.length >= 3) {
        console.warn(`[Hy2Bridge] ${params.server} 反复崩溃,放弃重启: ${inst.lastError.slice(-300)}`)
        return
      }
      inst.restarts.push(now)
      console.warn(`[Hy2Bridge] sing-box 意外退出(code=${code}),自动重启`)
      void ensureInstance(hy2Url).catch(() => {})
    })
    instances.set(hy2Url, inst)

    try {
      await waitPortReady(port, 15_000)
    } catch (err) {
      // 起不来:杀进程并抛出带内核日志的错误(验活/UI 能直接展示)
      inst.stopping = true
      try {
        proc.kill()
      } catch { /* ignore */ }
      instances.delete(hy2Url)
      const reason = inst.lastError
        ? inst.lastError.split('\n').filter(Boolean).slice(-2).join(' ')
        : (err instanceof Error ? err.message : String(err))
      throw new Error(`hy2 节点启动失败(${params.server}): ${reason}`)
    }
    return inst.localUrl
  })()

  starting.set(hy2Url, task)
  try {
    return await task
  } finally {
    starting.delete(hy2Url)
  }
}

/**
 * 代理 URL 统一解析入口:hy2/hysteria2 → 本地 socks5(按需起 sing-box);
 * 其余协议(http/socks 等)原样返回。空值透传。
 * hy2 启动失败会抛错,由调用方按"代理不可用"处理。
 */
export async function resolveProxyUrl(
  url: string | null | undefined
): Promise<string | null | undefined> {
  if (!url) return url
  const trimmed = url.trim()
  if (!isHy2Url(trimmed)) return url
  return ensureInstance(trimmed)
}

/** app 退出前回收全部 sing-box 子进程(will-quit 钩子调用) */
export function shutdownHy2Bridge(): void {
  for (const [key, inst] of instances) {
    inst.stopping = true
    try {
      inst.proc.kill()
    } catch { /* ignore */ }
    instances.delete(key)
  }
}
