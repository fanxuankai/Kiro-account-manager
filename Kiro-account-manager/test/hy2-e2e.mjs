// hy2 代理桥端到端测试:本机起真实 hysteria2 服务端(sing-box 自任),走完整链路——
//   hy2 URI 解析 → 生成客户端配置 → sing-box 客户端(QUIC/h3)→ 服务端 → 直连出网
// 不依赖外网 hy2 节点,却验证了 hy2Bridge 全部核心逻辑(除 Electron app 层)。
//
// 前置:node scripts/fetch-singbox.mjs
// 运行:node test/hy2-e2e.mjs

import { execFileSync, spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import tls from 'node:tls'
import { fileURLToPath } from 'node:url'
import { Agent, fetch as undiciFetch } from 'undici'
import { SocksClient } from 'socks'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const binDir = path.resolve(__dirname, '../resources/bin')
const suffix = process.platform === 'win32' ? '.exe' : ''
const bin = fs.existsSync(path.join(binDir, `sing-box-${process.arch}${suffix}`))
  ? path.join(binDir, `sing-box-${process.arch}${suffix}`)
  : path.join(binDir, `sing-box${suffix}`)

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hy2-e2e-'))
const procs = []

function fail(msg) {
  console.error(`✗ ${msg}`)
  for (const p of procs) try { p.kill() } catch { /* ignore */ }
  fs.rmSync(tmp, { recursive: true, force: true })
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
        if (Date.now() > deadline) reject(new Error('端口未就绪'))
        else setTimeout(tryOnce, 200)
      })
    }
    tryOnce()
  })
}

function runSingbox(config, name) {
  const cfgPath = path.join(tmp, `${name}.json`)
  fs.writeFileSync(cfgPath, JSON.stringify(config, null, 2))
  const proc = spawn(bin, ['run', '-c', cfgPath], { stdio: ['ignore', 'pipe', 'pipe'] })
  procs.push(proc)
  let errTail = ''
  proc.stderr.on('data', (d) => { errTail += d.toString() })
  proc.stdout.on('data', (d) => { errTail += d.toString() })
  proc.errTail = () => errTail
  return proc
}

/** 与 src/main/proxy/systemProxy.ts 的 createSocksDispatcher 同构 */
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

// ── 0) 自签证书(服务端 TLS 用) ──
const keyPath = path.join(tmp, 'server.key')
const crtPath = path.join(tmp, 'server.crt')
try {
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
    '-keyout', keyPath, '-out', crtPath, '-days', '1', '-nodes',
    '-subj', '/CN=hy2.local'
  ], { stdio: 'pipe' })
} catch {
  fail('openssl 生成自签证书失败')
}

// ── 1) hysteria2 服务端(端口 A,QUIC/UDP)──
// 就绪探测用旁路 TCP mixed 入站(同进程初始化完成即监听;UDP 端口无法 TCP 探测)
const AUTH = `e2e-${crypto.randomBytes(6).toString('hex')}`
const serverPort = await findFreePort()
const probePort = await findFreePort()
const server = runSingbox({
  log: { level: 'warn', timestamp: true },
  inbounds: [
    {
      type: 'hysteria2',
      tag: 'hy2-in',
      listen: '127.0.0.1',
      listen_port: serverPort,
      users: [{ name: 'e2e', password: AUTH }],
      tls: { enabled: true, certificate_path: crtPath, key_path: keyPath }
    },
    { type: 'mixed', tag: 'probe', listen: '127.0.0.1', listen_port: probePort }
  ],
  outbounds: [{ type: 'direct', tag: 'direct' }]
}, 'server')
try {
  await waitPortReady(probePort, 10_000)
  console.log(`✓ hysteria2 服务端就绪: 127.0.0.1:${serverPort}/udp(自签证书)`)
} catch (e) {
  fail(`服务端未就绪: ${server.errTail().slice(-500)}`)
}

// ── 2) 模拟 hy2Bridge:hy2 URI → 客户端配置(同 buildSingboxConfig 结构)──
const hy2Url = `hy2://${encodeURIComponent(AUTH)}@127.0.0.1:${serverPort}/?insecure=1&sni=hy2.local`
const u = new URL(hy2Url)
const clientPort = await findFreePort()
const client = runSingbox({
  log: { level: 'warn', timestamp: true },
  inbounds: [{ type: 'mixed', tag: 'in', listen: '127.0.0.1', listen_port: clientPort }],
  outbounds: [{
    type: 'hysteria2',
    tag: 'hy2-out',
    server: u.hostname,
    server_port: Number(u.port),
    password: decodeURIComponent(u.username),
    tls: { enabled: true, server_name: u.searchParams.get('sni'), insecure: true, alpn: ['h3'] }
  }]
}, 'client')
try {
  await waitPortReady(clientPort, 15_000)
} catch (e) {
  fail(`客户端(QUIC 握手)未就绪: ${client.errTail().slice(-500)}`)
}

// ── 3) undici socks5 → 客户端 mixed 入站 → hysteria2 → 服务端 → direct 出网 ──
try {
  const resp = await undiciFetch('https://api.ipify.org', {
    dispatcher: socksDispatcher('127.0.0.1', clientPort),
    headers: { accept: 'text/plain' },
    signal: AbortSignal.timeout(20_000)
  })
  const text = await resp.text()
  const ip = text.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/)?.[0]
  if (resp.status === 200 && ip) {
    console.log(`✓ hy2 端到端链路可用: hy2://…@127.0.0.1:${serverPort} → socks5://127.0.0.1:${clientPort} → 出口 ${ip}`)
    console.log('  (QUIC/h3 握手 + 鉴权 + 双跳转发全部通过)')
  } else {
    fail(`链路异常: HTTP ${resp.status} body=${text.slice(0, 100)}`)
  }
} catch (e) {
  fail(`链路请求失败: ${e.message}\n  server: ${server.errTail().slice(-300)}\n  client: ${client.errTail().slice(-300)}`)
} finally {
  for (const p of procs) try { p.kill() } catch { /* ignore */ }
  fs.rmSync(tmp, { recursive: true, force: true })
}
