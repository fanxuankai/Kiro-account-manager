// 反代 HTTPS 自签证书生成器（不依赖外部 CA，单证书自签）
// 用于让用户一键启用反代 HTTPS，证书包含 SubjectAltName 覆盖常见绑定地址
import * as forge from 'node-forge'
import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'

export interface ProxySelfSignedCert {
  cert: string  // PEM 证书
  key: string   // PEM 私钥
  fingerprint: string  // SHA-256 指纹（hex）
  notBefore: number
  notAfter: number
  subject: string
  altNames: string[]
}

/**
 * 在指定目录生成（或加载）反代用的自签证书
 * - 文件位置：dataPath/proxy-tls/proxy.crt + proxy.key
 * - 过期前 30 天自动续期
 * - 默认 SAN 包含 localhost / 127.0.0.1 / ::1，以及调用方指定的 hostnames
 *
 * @param dataPath 应用数据目录（一般是 app.getPath('userData')）
 * @param hostnames 额外的 DNS / IP 名称（如配置的 proxy host）
 * @param forceRegen 强制重新生成
 */
export function ensureProxySelfSignedCert(
  dataPath: string,
  hostnames: string[] = [],
  forceRegen = false
): ProxySelfSignedCert {
  const certDir = path.join(dataPath, 'proxy-tls')
  const certPath = path.join(certDir, 'proxy.crt')
  const keyPath = path.join(certDir, 'proxy.key')

  if (!fs.existsSync(certDir)) fs.mkdirSync(certDir, { recursive: true })

  // 复用已有证书（未过期且 SAN 覆盖了请求的 hostnames）
  if (!forceRegen && fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    try {
      const certPem = fs.readFileSync(certPath, 'utf8')
      const keyPem = fs.readFileSync(keyPath, 'utf8')
      const cert = forge.pki.certificateFromPem(certPem)
      const now = new Date()
      const renewBefore = new Date(cert.validity.notAfter.getTime() - 30 * 86400_000)
      // SAN 覆盖检查
      const existingAlt = extractAltNames(cert)
      const requested = normalizeAltNames(hostnames)
      const missing = requested.filter(n => !existingAlt.includes(n))
      if (now < renewBefore && missing.length === 0) {
        return {
          cert: certPem,
          key: keyPem,
          fingerprint: computeFingerprint(certPem),
          notBefore: cert.validity.notBefore.getTime(),
          notAfter: cert.validity.notAfter.getTime(),
          subject: cert.subject.getField('CN')?.value || 'localhost',
          altNames: existingAlt
        }
      }
    } catch (err) {
      console.warn('[ProxyTLS] Failed to load existing cert, regenerating:', (err as Error).message)
    }
  }

  // 生成新证书
  const keys = forge.pki.rsa.generateKeyPair(2048)
  const cert = forge.pki.createCertificate()
  cert.publicKey = keys.publicKey
  cert.serialNumber = generateSerialNumber()
  cert.validity.notBefore = new Date()
  cert.validity.notAfter = new Date()
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 2)  // 2 年有效期

  const subject = [
    { name: 'commonName', value: 'Kiro Reverse Proxy' },
    { name: 'organizationName', value: 'Kiro Account Manager' },
    { name: 'countryName', value: 'CN' }
  ]
  cert.setSubject(subject)
  cert.setIssuer(subject)

  // 构造 SubjectAltName：DNS / IP 都列入，覆盖常见客户端访问场景
  const altNames = normalizeAltNames(hostnames)
  // node-forge 的 GeneralName 在 type defs 中不公开，用结构化对象直接传入
  const altList: Array<{ type: number; value?: string; ip?: string }> = []
  for (const name of altNames) {
    if (isIPv4(name) || isIPv6(name)) {
      altList.push({ type: 7, ip: name })  // type 7 = iPAddress
    } else {
      altList.push({ type: 2, value: name })  // type 2 = dNSName
    }
  }

  cert.setExtensions([
    { name: 'basicConstraints', cA: false, critical: true },
    {
      name: 'keyUsage',
      digitalSignature: true,
      keyEncipherment: true,
      critical: true
    },
    { name: 'extKeyUsage', serverAuth: true, clientAuth: true },
    { name: 'subjectAltName', altNames: altList }
  ])

  cert.sign(keys.privateKey, forge.md.sha256.create())
  const certPem = forge.pki.certificateToPem(cert)
  const keyPem = forge.pki.privateKeyToPem(keys.privateKey)

  fs.writeFileSync(certPath, certPem)
  fs.writeFileSync(keyPath, keyPem, { mode: 0o600 })  // 私钥仅 owner 可读

  console.log(`[ProxyTLS] Generated self-signed cert: ${certPath} (SAN=${altNames.join(',')})`)

  return {
    cert: certPem,
    key: keyPem,
    fingerprint: computeFingerprint(certPem),
    notBefore: cert.validity.notBefore.getTime(),
    notAfter: cert.validity.notAfter.getTime(),
    subject: 'Kiro Reverse Proxy',
    altNames
  }
}

/**
 * 标准化 SAN 列表：去重，确保始终包含本地访问地址
 */
function normalizeAltNames(extras: string[]): string[] {
  const set = new Set<string>(['localhost', '127.0.0.1', '::1'])
  for (const name of extras) {
    const trimmed = name?.trim()
    if (!trimmed) continue
    // 0.0.0.0 不是有效 cert SAN（客户端永远不会真访问 0.0.0.0），跳过
    if (trimmed === '0.0.0.0' || trimmed === '::') continue
    set.add(trimmed)
  }
  return Array.from(set)
}

function extractAltNames(cert: forge.pki.Certificate): string[] {
  const ext = cert.getExtension('subjectAltName') as { altNames?: Array<{ type: number; value?: string; ip?: string }> } | null
  if (!ext?.altNames) return []
  return ext.altNames.map(a => a.ip || a.value || '').filter(Boolean)
}

function isIPv4(host: string): boolean {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(host)
}

function isIPv6(host: string): boolean {
  return host.includes(':') && !host.includes('.')
}

function generateSerialNumber(): string {
  return crypto.randomBytes(16).toString('hex')
}

function computeFingerprint(certPem: string): string {
  // SHA-256 指纹：用 PEM body 的 DER 解码后哈希
  const m = certPem.match(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/)
  if (!m) return ''
  const der = Buffer.from(m[1].replace(/\s/g, ''), 'base64')
  return crypto.createHash('sha256').update(der).digest('hex').match(/.{2}/g)!.join(':').toUpperCase()
}
