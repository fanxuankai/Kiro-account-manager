/**
 * mac 自研更新器：绕开 Squirrel.Mac 的代码签名校验
 *
 * 背景：没有 Apple 开发者证书（打包 identity: null），electron-updater 在 mac 上
 * 走 Squirrel.Mac，安装前对新包做签名校验必然失败（"代码不含资源，但签名指示
 * 这些资源必须存在"）。本模块改为自己完成：下载 → sha512 校验 → ditto 解压 →
 * 原子替换当前 .app（旧包备份，失败回滚）→ relaunch 重启。
 *
 * 可行性关键：应用自己下载的文件不带 quarantine 属性，替换后不会再次触发
 * Gatekeeper 拦截；用户自己安装的 app 对所在目录有写权限，可直接替换。
 */
import { app } from 'electron'
import { createHash } from 'crypto'
import { spawn, spawnSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import os from 'os'

const GITHUB_REPO = 'fanxuankai/Kiro-account-manager'

export interface MacUpdateFile {
  name: string
  url: string
  sha512: string
  size?: number
}

export interface MacUpdateInfo {
  version: string
  file: MacUpdateFile
}

/** 当前运行 app 的 bundle 路径（.../Kiro Account Manager.app） */
function currentAppBundle(): string {
  // execPath = <bundle>/Contents/MacOS/<name>
  return path.resolve(path.dirname(process.execPath), '..', '..')
}

/** semver 三段数字比较：a > b 返回 1，相等 0，小于 -1（非标准格式按字符串兜底） */
function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map(Number)
  const pb = b.replace(/^v/, '').split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const x = Number.isFinite(pa[i]) ? pa[i] : 0
    const y = Number.isFinite(pb[i]) ? pb[i] : 0
    if (x !== y) return x > y ? 1 : -1
  }
  return 0
}

/**
 * 解析 latest-mac.yml（electron-builder 生成，格式固定）。
 * files[].url 是相对 release 的文件名，直接用 GitHub API 的 asset 下载地址更稳。
 */
function parseLatestMacYml(text: string): { version: string; files: Array<{ name: string; sha512: string; size?: number }> } {
  const version = text.match(/^version:\s*(\S+)/m)?.[1] ?? ''
  const files: Array<{ name: string; sha512: string; size?: number }> = []
  // 逐块解析 "  - url: xxx" 与紧随的 sha512/size
  const blocks = text.split(/^\s*-\s+url:\s*/m)
  for (const block of blocks.slice(1)) {
    const name = block.split(/\r?\n/)[0].trim()
    const sha512 = block.match(/sha512:\s*(\S+)/)?.[1] ?? ''
    const size = Number(block.match(/size:\s*(\d+)/)?.[1] ?? 0) || undefined
    if (name && sha512) files.push({ name, sha512, size })
  }
  return { version, files }
}

/** 检查 mac 更新：读 GitHub Releases 的 latest-mac.yml，按当前架构选 zip */
export async function checkMacUpdate(): Promise<{ hasUpdate: boolean; version?: string; error?: string }> {
  try {
    const releaseRes = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
      headers: { 'User-Agent': 'kiro-account-manager-updater', Accept: 'application/vnd.github+json' }
    })
    if (!releaseRes.ok) return { hasUpdate: false, error: `GitHub API ${releaseRes.status}` }
    const release = (await releaseRes.json()) as {
      tag_name?: string
      assets?: Array<{ name: string; browser_download_url: string }>
    }
    const ymlAsset = release.assets?.find((a) => a.name === 'latest-mac.yml')
    if (!ymlAsset) return { hasUpdate: false, error: 'latest-mac.yml not found in latest release' }

    const ymlRes = await fetch(ymlAsset.browser_download_url, {
      headers: { 'User-Agent': 'kiro-account-manager-updater' }
    })
    if (!ymlRes.ok) return { hasUpdate: false, error: `latest-mac.yml ${ymlRes.status}` }
    const parsed = parseLatestMacYml(await ymlRes.text())
    if (!parsed.version) return { hasUpdate: false, error: 'latest-mac.yml parse failed' }

    const current = app.getVersion()
    const hasUpdate = compareVersions(parsed.version, current) > 0
    if (!hasUpdate) return { hasUpdate: false, version: parsed.version }

    // 按当前架构匹配 zip（electron-builder 命名 ...-{arch}-mac.zip）
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
    const match = parsed.files.find((f) => f.name.includes(`-${arch}-mac.zip`))
    const zipAsset = match
      ? release.assets?.find((a) => a.name === match.name)
      : undefined
    if (!match || !zipAsset) return { hasUpdate: false, error: `no ${arch} zip asset in release ${parsed.version}` }

    pendingUpdate = { version: parsed.version, file: { name: match.name, url: zipAsset.browser_download_url, sha512: match.sha512, size: match.size } }
    console.log(`[MacSelfUpdate] Update available: ${current} -> ${parsed.version} (${match.name})`)
    return { hasUpdate: true, version: parsed.version }
  } catch (err) {
    return { hasUpdate: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** 待安装更新与已解压的新包路径（download 后写入，install 消费） */
let pendingUpdate: MacUpdateInfo | null = null
let downloadedAppPath: string | null = null

/** 下载 + sha512 校验 + 解压，返回新 .app 路径；onProgress 上报百分比（0-100） */
export async function downloadMacUpdate(onProgress: (percent: number, transferred: number, total: number) => void): Promise<{ success: boolean; version?: string; error?: string }> {
  if (!pendingUpdate) return { success: false, error: 'no pending update (check first)' }
  const { version, file } = pendingUpdate
  try {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-am-update-'))
    const zipPath = path.join(workDir, file.name)

    // 流式下载（fetch web stream → 写文件 + 进度 + sha512）
    const res = await fetch(file.url, { headers: { 'User-Agent': 'kiro-account-manager-updater' } })
    if (!res.ok || !res.body) return { success: false, error: `download ${res.status}` }
    const total = Number(res.headers.get('content-length') ?? 0) || (file.size ?? 0)
    const hash = createHash('sha512')
    const out = fs.createWriteStream(zipPath)
    let transferred = 0
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      hash.update(value)
      out.write(value)
      transferred += value.byteLength
      if (total > 0) onProgress(Math.min(99, (transferred / total) * 100), transferred, total)
    }
    await new Promise<void>((resolve, reject) => {
      out.on('error', reject)
      out.end(() => resolve())
    })

    // 完整性校验：sha512（base64，与 electron-builder yml 一致）
    const digest = hash.digest('base64')
    if (digest !== file.sha512) {
      fs.rmSync(workDir, { recursive: true, force: true })
      return { success: false, error: 'sha512 mismatch (download corrupted)' }
    }

    // ditto 解压（保留 mac 元数据/权限，比 unzip 稳）
    const extractDir = path.join(workDir, 'extracted')
    fs.mkdirSync(extractDir, { recursive: true })
    await new Promise<void>((resolve, reject) => {
      const p = spawn('ditto', ['-x', '-k', zipPath, extractDir])
      p.on('error', reject)
      p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ditto exited ${code}`))))
    })

    // 定位解压出的 .app
    const appDir = fs.readdirSync(extractDir).find((n) => n.endsWith('.app'))
    if (!appDir) return { success: false, error: 'no .app found in update zip' }
    downloadedAppPath = path.join(extractDir, appDir)
    onProgress(100, transferred, total)
    console.log(`[MacSelfUpdate] Downloaded & verified v${version} -> ${downloadedAppPath}`)
    return { success: true, version }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * 安装：原子替换当前 .app 并重启。
 * 顺序：旧包 rename 到备份（同目录原子）→ ditto 新包到原位置 → 失败回滚 → relaunch。
 */
export function installMacUpdate(): { success: boolean; error?: string } {
  if (!downloadedAppPath || !fs.existsSync(downloadedAppPath)) {
    return { success: false, error: 'downloaded app missing (download first)' }
  }
  // App Translocation：从 Downloads 直接运行且带 quarantine 时，macOS 把 app 挂到
  // 只读随机路径，替换无效 —— 引导手动更新
  if (process.execPath.includes('AppTranslocation')) {
    return { success: false, error: 'app is running from a translocated (read-only) path — please move it to /Applications and retry' }
  }
  const appBundle = currentAppBundle()
  const parent = path.dirname(appBundle)
  try {
    fs.accessSync(parent, fs.constants.W_OK)
  } catch {
    return { success: false, error: `no write permission for ${parent}` }
  }

  const backup = path.join(parent, `${path.basename(appBundle)}.bak-${Date.now()}`)
  try {
    // 正在运行的进程已加载进内存，rename 旧包安全
    fs.renameSync(appBundle, backup)
    try {
      // 跨卷用 ditto 复制（保留签名/权限/元数据）
      const cp = spawnSync('ditto', [downloadedAppPath, appBundle], { stdio: 'ignore' })
      if (cp.status !== 0 || !fs.existsSync(path.join(appBundle, 'Contents', 'MacOS'))) {
        throw new Error(`ditto copy failed (status ${cp.status ?? 'n/a'})`)
      }
    } catch (e) {
      // 回滚
      fs.rmSync(appBundle, { recursive: true, force: true })
      fs.renameSync(backup, appBundle)
      throw e
    }
    console.log(`[MacSelfUpdate] Replaced ${appBundle} (backup: ${backup}), relaunching...`)
    // 退出后清理备份（detached，避免阻塞退出）
    spawn('sh', ['-c', `sleep 2; rm -rf ${JSON.stringify(backup)}`], { detached: true, stdio: 'ignore' }).unref()
    app.relaunch()
    app.exit(0)
    return { success: true }
  } catch (err) {
    console.error('[MacSelfUpdate] install failed:', err)
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** 启动时清理历史遗留的替换备份（正常路径已自动清理，兜底） */
export function cleanupMacUpdateBackups(): void {
  try {
    const parent = path.dirname(currentAppBundle())
    const prefix = `${path.basename(currentAppBundle())}.bak-`
    for (const name of fs.readdirSync(parent)) {
      if (name.startsWith(prefix)) {
        fs.rmSync(path.join(parent, name), { recursive: true, force: true })
        console.log(`[MacSelfUpdate] cleaned backup ${name}`)
      }
    }
  } catch {
    /* dev 环境或路径异常时忽略 */
  }
}
