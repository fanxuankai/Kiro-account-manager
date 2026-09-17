// 下载 sing-box 内核到 resources/bin/（hy2/Hysteria2 代理桥的运行时依赖）。
//
// 用途：
//   - CI：构建前执行，把对应平台的 sing-box 放进 extraResources 一起打包
//   - 本地开发：npm run fetch:singbox，dev 模式下 hy2Bridge 从 resources/bin/ 读取
//
// 用法：node scripts/fetch-singbox.mjs [--version x.y.z] [--arch arm64|x64|all] [--force]
//   平台取当前 OS；mac 双架构打包用 --arch all（x64+arm64 各一份，按 arch 后缀命名）
//   默认：Windows/Linux 下当前架构；macOS 下 all（CI 一个 job 出双架构包）
// 已存在同版本二进制时跳过（--force 强制重下）。

import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SINGBOX_VERSION = '1.14.1'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const outDir = path.resolve(__dirname, '../resources/bin')

const args = process.argv.slice(2)
const versionFlag = args.indexOf('--version')
const version = versionFlag >= 0 ? args[versionFlag + 1] : SINGBOX_VERSION
const archFlag = args.indexOf('--arch')
let arch = archFlag >= 0 ? args[archFlag + 1] : ''
const force = args.includes('--force')

/** 当前 OS + 指定架构 → sing-box 发布资产的平台段
 *  @param {string} nodeArch
 *  @returns {string} */
function platformSegment(nodeArch) {
  const p = process.platform
  if (p === 'darwin') return nodeArch === 'arm64' ? 'darwin-arm64' : 'darwin-amd64'
  if (p === 'win32') return nodeArch === 'arm64' ? 'windows-arm64' : 'windows-amd64'
  if (p === 'linux') return nodeArch === 'arm64' ? 'linux-arm64' : 'linux-amd64'
  throw new Error(`不支持的平台: ${p}`)
}

// macOS 一个 CI job 打 x64+arm64 双包,默认两份都下;其余平台单架构
if (!arch) arch = process.platform === 'darwin' ? 'all' : process.arch
const archList = arch === 'all' ? ['arm64', 'x64'] : [arch]

const isWin = process.platform === 'win32'
const ext = isWin ? 'zip' : 'tar.gz'

for (const a of archList) {
  const seg = platformSegment(a)
  // 文件名带架构后缀:mac 双架构共存;hy2Bridge 运行时按 process.arch 挑选
  const binName = isWin ? `sing-box-${a}.exe` : `sing-box-${a}`
  const binPath = path.join(outDir, binName)
  const verPath = path.join(outDir, `${binName}.version`)
  const haveVersion = fs.existsSync(verPath) ? fs.readFileSync(verPath, 'utf8').trim() : ''

  if (fs.existsSync(binPath) && haveVersion === version && !force) {
    console.log(`[fetch-singbox] ${binName} (${version}) 已存在，跳过（--force 重下）`)
    continue
  }

  fs.mkdirSync(outDir, { recursive: true })
  const asset = `sing-box-${version}-${seg}.${ext}`
  const url = `https://github.com/SagerNet/sing-box/releases/download/v${version}/${asset}`

  console.log(`[fetch-singbox] 下载 ${url}`)
  // -L 处理 GitHub 的 302;失败重试 3 次(办公网/CI 抖动)
  execSync(`curl -fSL --retry 3 -o "${path.join(outDir, asset)}" "${url}"`, { stdio: 'inherit' })

  console.log(`[fetch-singbox] 解压 ${asset}`)
  const assetPath = path.join(outDir, asset)
  const inner = path.join(outDir, `sing-box-${version}-${seg}`, isWin ? 'sing-box.exe' : 'sing-box')
  if (isWin) {
    execSync(
      `powershell -NoProfile -Command "Expand-Archive -Force '${assetPath}' '${outDir}'"`,
      { stdio: 'inherit' }
    )
  } else {
    execSync(`tar -xzf "${assetPath}" -C "${outDir}"`, { stdio: 'inherit' })
  }
  fs.copyFileSync(inner, binPath)
  fs.rmSync(path.join(outDir, `sing-box-${version}-${seg}`), { recursive: true, force: true })
  fs.rmSync(assetPath, { force: true })
  if (!isWin) execSync(`chmod +x "${binPath}"`)
  fs.writeFileSync(verPath, version)

  const out = execSync(`"${binPath}" version`).toString().trim()
  console.log(`[fetch-singbox] 完成: ${out.split('\n')[0]}`)
}

// GPLv3 附加条款许可文本随包分发,合规(与架构无关,下一份即可)
const licensePath = path.join(outDir, 'LICENSE.sing-box')
if (!fs.existsSync(licensePath) || force) {
  const licenseUrl = `https://raw.githubusercontent.com/SagerNet/sing-box/v${version}/LICENSE`
  try {
    execSync(`curl -fSL --retry 2 -o "${licensePath}" "${licenseUrl}"`, { stdio: 'inherit' })
  } catch {
    console.warn('[fetch-singbox] LICENSE 下载失败（不影响功能），可手动补一份到 resources/bin/')
  }
}
