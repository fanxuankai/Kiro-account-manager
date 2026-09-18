// hy2 代理桥冒烟测试(不依赖真实 hy2 节点):
//   1) hy2 URI → sing-box 配置生成,sing-box check 验证 schema 合法
//   2) direct 出站实例:undici 走本地 mixed(socks5)入站真实拉一次 https,
//      验证「socks dispatcher → sing-box inbound → outbound」整条桥接链路
// 真实 hy2 节点的连通性属于端到端范畴,由应用内验活(proxy-pool:validate)覆盖。
//
// 前置:node scripts/fetch-singbox.mjs(内核已在 resources/bin/)
// 运行:node test/hy2-smoke.mjs

import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import tls from 'node:tls'
import { fileURLToPath } from 'node:url'
import { Agent, fetch as undiciFetch } from 'undici'
import { SocksClient } from 'socks'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// 与 hy2Bridge 同策略:优先 arch 后缀名,回退裸名
const binDir = path.resolve(__dirname, '../resources/bin')
const binSuffix = process.platform === 'win32' ? '.exe' : ''
const bin = fs.existsSync(path.join(binDir, `sing-box-${process.arch}${binSuffix}`))
  ? path.join(binDir, `sing-box-${process.arch}${binSuffix}`)
  : path.join(binDir, `sing-box${binSuffix}`)

function fail(msg) {
  console.error(`✗ ${msg}`)
  process.exit(1)
}

/** 与 src/main/proxy/hy2Bridge.ts 的 buildSingboxConfig 保持同构 */
function hy2Outbound(p) {
  const out = { type: 'hysteria2', tag: 'hy2-out', server: p.server, server_port: p.serverPort }
  if (p.password) out.password = p.password
  if (p.serverPorts) {
    out.server_ports = p.serverPorts
    out.server_port = Number(p.serverPorts[0].split(':')[0]) || p.serverPort
  }
  if (p.obfsPassword) out.obfs = { type: 'salamander', password: p.obfsPassword }
  out.tls = { enabled: true, server_name: p.sni || p.server, insecure: p.insecure, alpn: ['h3'] }
  return out
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })
}

function waitPortReady(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const sock = net.connect({ port, host: '127.0.0.1', timeout: 1500 })
      sock.once('connect', () => { sock.destroy(); resolve() })
      sock.once('error', () => {
        sock.destroy()
        if (Date.now() > deadline) reject(new Error('端口未就绪'))
        else setTimeout(tryOnce, 200)
      })
    }
    tryOnce()
  })
}

/** 与 src/main/proxy/systemProxy.ts 的 createSocksDispatcher 同构:验证桥接层对现有 socks 体系透明 */
function socksDispatcher(host, port) {
  return new Agent({
    connect: (options, callback) => {
      const targetHost = options.hostname || options.host || ''
      const targetPort = Number(options.port) || 443
      SocksClient.createConnection({
        proxy: { host, port, type: 5 },
        command: 'connect',
        destination: { host: targetHost, port: targetPort }
      }).then(({ socket }) => {
        if (options.protocol === 'https:') {
          const tlsSocket = tls.connect({
            socket,
            servername: options.servername || targetHost,
            rejectUnauthorized: false
          })
          tlsSocket.once('secureConnect', () => callback(null, tlsSocket))
          tlsSocket.once('error', (err) => callback(err, null))
        } else {
          callback(null, socket)
        }
      }).catch((err) => callback(err, null))
    }
  })
}

// ── 1) hy2 配置 schema 校验 ──
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hy2-smoke-'))
const cases = [
  {
    name: '基础(sni+insecure+obfs)',
    params: {
      server: 'hy2.example.com',
      serverPort: 443,
      password: 's3cret',
      sni: 'cdn.example.com',
      insecure: true,
      obfsPassword: 'obfspw'
    }
  },
  {
    name: '端口跳跃(mport)',
    params: {
      server: 'hy2.example.com',
      serverPort: 32000,
      password: 'pw',
      insecure: false,
      serverPorts: ['32000:32100', '443:443']
    }
  },
  {
    name: '无密码无参数',
    params: { server: '1.2.3.4', serverPort: 8443, password: '', insecure: true }
  }
]
for (const c of cases) {
  const cfg = path.join(tmp, `${c.name}.json`.replace(/[^\w.-]/g, '_'))
  fs.writeFileSync(cfg, JSON.stringify({
    log: { level: 'warn', timestamp: true },
    inbounds: [{ type: 'mixed', tag: 'in', listen: '127.0.0.1', listen_port: 10800 }],
    outbounds: [hy2Outbound(c.params)]
  }))
  try {
    execFileSync(bin, ['check', '-c', cfg], { stdio: 'pipe' })
    console.log(`✓ 配置校验通过: ${c.name}`)
  } catch (err) {
    fail(`配置校验失败(${c.name}): ${err.stderr?.toString() || err.message}`)
  }
}

/** 与 src/main/proxy/hy2Bridge.ts 的 buildVlessOutbound 保持同构 */
function vlessOutbound(p) {
  const out = { type: 'vless', tag: 'vless-out', server: p.server, server_port: p.serverPort, uuid: p.uuid }
  if (p.flow) out.flow = p.flow
  if (p.security !== 'none') {
    const tls = { enabled: true, server_name: p.sni || p.server }
    if (p.insecure) tls.insecure = true
    if (p.security === 'reality') {
      tls.utls = { enabled: true, fingerprint: p.fingerprint || 'chrome' }
      tls.reality = { enabled: true, public_key: p.publicKey || '', short_id: p.shortId || '' }
    } else if (p.fingerprint) {
      tls.utls = { enabled: true, fingerprint: p.fingerprint }
    }
    out.tls = tls
  }
  if (p.network === 'ws') {
    out.transport = { type: 'ws', ...(p.path ? { path: p.path } : {}), ...(p.host ? { headers: { Host: p.host } } : {}) }
  } else if (p.network === 'grpc') {
    out.transport = { type: 'grpc', service_name: p.serviceName || '' }
  }
  return out
}

const vlessCases = [
  {
    name: 'vless+tcp+tls',
    params: { server: 'v.example.com', serverPort: 443, uuid: 'b831381d-6324-4d53-ad4f-8cda48b30811', security: 'tls', sni: 'cdn.example.com', fingerprint: 'chrome', network: 'tcp' }
  },
  {
    name: 'vless+ws+tls(CDN)',
    params: { server: 'v.example.com', serverPort: 443, uuid: 'b831381d-6324-4d53-ad4f-8cda48b30811', security: 'tls', sni: 'cdn.example.com', network: 'ws', path: '/ray', host: 'cdn.example.com' }
  },
  {
    name: 'vless+reality+vision',
    params: { server: '1.2.3.4', serverPort: 8443, uuid: 'b831381d-6324-4d53-ad4f-8cda48b30811', security: 'reality', sni: 'www.microsoft.com', fingerprint: 'chrome', publicKey: 'SbVKOEMjK0sIlbwg4akyBg5mL5KZwwB-ed4eEE7YnRc', shortId: 'ab12', network: 'tcp', flow: 'xtls-rprx-vision' }
  },
  {
    name: 'vless+grpc',
    params: { server: 'v.example.com', serverPort: 443, uuid: 'b831381d-6324-4d53-ad4f-8cda48b30811', security: 'tls', network: 'grpc', serviceName: 'grpcSvc' }
  }
]
for (const c of vlessCases) {
  const cfg = path.join(tmp, `vless-${c.name}.json`.replace(/[^\w.-]/g, '_'))
  fs.writeFileSync(cfg, JSON.stringify({
    log: { level: 'warn', timestamp: true },
    inbounds: [{ type: 'mixed', tag: 'in', listen: '127.0.0.1', listen_port: 10800 }],
    outbounds: [vlessOutbound(c.params)]
  }))
  try {
    execFileSync(bin, ['check', '-c', cfg], { stdio: 'pipe' })
    console.log(`✓ 配置校验通过: ${c.name}`)
  } catch (err) {
    fail(`配置校验失败(${c.name}): ${err.stderr?.toString() || err.message}`)
  }
}

// ── 2) direct 出站全链路:undici socks → sing-box mixed 入站 → direct 出站 → https ──
const port = await findFreePort()
const cfgPath = path.join(tmp, 'direct.json')
fs.writeFileSync(cfgPath, JSON.stringify({
  log: { level: 'warn', timestamp: true },
  inbounds: [{ type: 'mixed', tag: 'in', listen: '127.0.0.1', listen_port: port }],
  outbounds: [{ type: 'direct', tag: 'out' }]
}))
const proc = spawn(bin, ['run', '-c', cfgPath], { stdio: ['ignore', 'pipe', 'pipe'] })
proc.stderr.on('data', (d) => process.stderr.write(`[sing-box] ${d}`))
try {
  await waitPortReady(port, 10_000)
  const resp = await undiciFetch('https://api.ipify.org', {
    dispatcher: socksDispatcher('127.0.0.1', port),
    headers: { accept: 'text/plain' },
    signal: AbortSignal.timeout(15_000)
  })
  const text = await resp.text()
  const ip = text.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/)?.[0]
  if (resp.status === 200 && ip) {
    console.log(`✓ 桥接链路可用: socks5://127.0.0.1:${port} → direct 出口 ${ip}`)
  } else {
    fail(`桥接链路异常: HTTP ${resp.status} body=${text.slice(0, 100)}`)
  }
} finally {
  proc.kill()
  fs.rmSync(tmp, { recursive: true, force: true })
}
