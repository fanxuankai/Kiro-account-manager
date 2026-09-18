// 用真实 hy2 节点验证代理桥全链路(手动工具,不在 CI 跑):
//   node test/hy2-verify.mjs 'hy2://auth@host:port/?sni=..&insecure=1&obfs=salamander&obfs-password=..'
// 与 hy2Bridge 的 parseHy2Url/buildSingboxConfig 同构:解析 → sing-box 客户端 → socks 出口探测 + 归属地。
//
// 前置:node scripts/fetch-singbox.mjs

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import tls from 'node:tls'
import { fileURLToPath } from 'node:url'
import { Agent, fetch as undiciFetch } from 'undici'
import { SocksClient } from 'socks'

const hy2Url = process.argv[2]
if (!hy2Url || !/^hy(2|steria2):\/\//i.test(hy2Url)) {
  console.error('用法: node test/hy2-verify.mjs "hy2://auth@host:port/?sni=..&insecure=1"')
  process.exit(1)
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const binDir = path.resolve(__dirname, '../resources/bin')
const suffix = process.platform === 'win32' ? '.exe' : ''
const bin = fs.existsSync(path.join(binDir, `sing-box-${process.arch}${suffix}`))
  ? path.join(binDir, `sing-box-${process.arch}${suffix}`)
  : path.join(binDir, `sing-box${suffix}`)
if (!fs.existsSync(bin)) {
  console.error('sing-box 内核不存在,先跑: node scripts/fetch-singbox.mjs')
  process.exit(1)
}

function fail(msg) {
  console.error(`✗ ${msg}`)
  process.exit(1)
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
        if (Date.now() > deadline) reject(new Error('本地入站未就绪'))
        else setTimeout(tryOnce, 200)
      })
    }
    tryOnce()
  })
}

function socksDispatcher(host, port) {
  return new Agent({
    connect: (options, callback) => {
      const targetHost = options.hostname || options.host || ''
      const targetPort = Number(options.port) || (options.protocol === 'https:' ? 443 : 80)
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

// ── 解析 hy2 URI(与 src/main/proxy/hy2Bridge.ts 的 parseHy2Url 同构)──
const u = new URL(hy2Url)
const q = u.searchParams
const outbound = {
  type: 'hysteria2',
  tag: 'hy2-out',
  server: u.hostname,
  server_port: Number(u.port) || 443
}
if (u.username) outbound.password = decodeURIComponent(u.username)
const mport = q.get('mport') || q.get('ports')
if (mport) {
  outbound.server_ports = mport.split(',').map((s) => {
    const t = s.trim()
    const m = t.match(/^(\d+)[-:](\d+)$/)
    return m ? `${m[1]}:${m[2]}` : /^\d+$/.test(t) ? `${t}:${t}` : null
  }).filter(Boolean)
  outbound.server_port = Number(outbound.server_ports[0].split(':')[0]) || outbound.server_port
}
const obfs = q.get('obfs')
if (obfs === 'salamander' && q.get('obfs-password')) {
  outbound.obfs = { type: 'salamander', password: q.get('obfs-password') }
}
outbound.tls = {
  enabled: true,
  server_name: q.get('sni') || u.hostname,
  insecure: ['1', 'true', 'yes'].includes((q.get('insecure') || '').toLowerCase()),
  alpn: ['h3']
}
const nodeTag = u.hash ? u.hash.slice(1) : `${u.hostname}:${u.port}`
console.log(`节点: ${nodeTag}`)
console.log(`参数: server=${outbound.server}:${outbound.server_port}` +
  `${outbound.password ? ' auth=***' : ''} sni=${outbound.tls.server_name}` +
  ` insecure=${outbound.tls.insecure}${outbound.obfs ? ' obfs=salamander' : ''}` +
  `${outbound.server_ports ? ` mport=${outbound.server_ports.join(',')}` : ''}`)

// ── 起客户端(与 hy2Bridge.ensureInstance 同构)──
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hy2-verify-'))
const port = await findFreePort()
const cfgPath = path.join(tmp, 'client.json')
fs.writeFileSync(cfgPath, JSON.stringify({
  log: { level: process.env.HY2_LOG || 'warn', timestamp: true },
  inbounds: [{ type: 'mixed', tag: 'in', listen: '127.0.0.1', listen_port: port }],
  outbounds: [outbound]
}, null, 2))

const proc = spawn(bin, ['run', '-c', cfgPath], { stdio: ['ignore', 'pipe', 'pipe'] })
let errTail = ''
proc.stderr.on('data', (d) => { errTail += d.toString(); if (process.env.HY2_LOG) process.stderr.write('[sing-box] ' + d) })
proc.stdout.on('data', (d) => { errTail += d.toString() })
try {
  await waitPortReady(port, 15_000)
} catch (e) {
  try { proc.kill() } catch { /* ignore */ }
  fail(`sing-box 启动失败: ${errTail.split('\n').filter(Boolean).slice(-3).join(' | ')}`)
}

// ── 经节点出口探测:延迟 + 出口 IP + 归属地 ──
const dispatcher = socksDispatcher('127.0.0.1', port)
try {
  const start = Date.now()
  const resp = await undiciFetch('http://ip-api.com/json/?fields=status,country,regionName,city,isp,query', {
    dispatcher,
    signal: AbortSignal.timeout(20_000)
  })
  const body = await resp.json()
  const ms = Date.now() - start
  if (resp.status === 200 && body.status === 'success') {
    console.log(`✓ 真实节点链路可用: socks5://127.0.0.1:${port} → hy2 → 出口 ${body.query}（${ms}ms）`)
    console.log(`  归属地: ${body.country} ${body.regionName} ${body.city}  ISP: ${body.isp}`)
    // 再走一次 https 验证 TLS 链(QUIC 之上的完整 HTTPS 请求)
    const start2 = Date.now()
    const r2 = await undiciFetch('https://api.ipify.org', {
      dispatcher,
      headers: { accept: 'text/plain' },
      signal: AbortSignal.timeout(20_000)
    })
    const ip2 = (await r2.text()).trim()
    console.log(`✓ HTTPS 链路: ${r2.status} 出口 ${ip2}（${Date.now() - start2}ms）`)
  } else {
    fail(`探测返回异常: HTTP ${resp.status} ${JSON.stringify(body).slice(0, 200)}`)
  }
} catch (e) {
  fail(`经节点请求失败(节点不可达/被墙/参数错): ${e.message}\n  sing-box 日志尾部: ${errTail.split('\n').filter(Boolean).slice(-3).join(' | ')}`)
} finally {
  try { proc.kill() } catch { /* ignore */ }
  fs.rmSync(tmp, { recursive: true, force: true })
}
