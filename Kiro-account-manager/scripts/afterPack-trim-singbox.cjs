// afterPack:裁剪 mac 包里异架构的 sing-box 内核。
// resources/bin 在 mac 双架构打包时是共享目录(arm64+x64 各一份),
// 而 dmg/zip 按架构分发,每个包只需要自己那份——不留着白增 ~85MB 下载量。
// win/linux 由 fetch-singbox.mjs 保证只下载当前架构,无需处理。

const fs = require('node:fs')
const path = require('node:path')

exports.default = async function (context) {
  if (context.electronPlatformName !== 'darwin') return
  // electron-builder ArchType:x64=1, arm64=3
  const arch = context.arch === 3 ? 'arm64' : context.arch === 1 ? 'x64' : null
  if (!arch) return
  const binDir = path.join(
    context.appOutDir,
    'Kiro Account Manager.app',
    'Contents',
    'Resources',
    'bin'
  )
  if (!fs.existsSync(binDir)) return
  const remove = arch === 'arm64' ? 'sing-box-x64' : 'sing-box-arm64'
  for (const f of fs.readdirSync(binDir)) {
    if (f.startsWith(remove)) {
      fs.rmSync(path.join(binDir, f), { force: true })
      console.log(`[afterPack] 已裁剪异架构内核: ${f} (${arch} 包)`)
    }
  }
}
