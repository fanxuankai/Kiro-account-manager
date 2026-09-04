// 安全备份：用 Electron safeStorage（OS 级加密：Windows DPAPI / macOS Keychain / Linux libsecret）
// 加密容灾备份文件，避免账号 token、代理账密以明文 JSON 落在磁盘上。
//
// 策略：
//   - 写：safeStorage 可用 → 写加密文件 *.backup.enc，并清理旧明文 *.backup.json
//          不可用（极少数 Linux 无 keyring）→ 退回明文 JSON，保证容灾不丢
//   - 读：优先解密 *.backup.enc；失败/不存在再读旧明文 *.backup.json（平滑迁移）
//
// fileBase 参数：主账号库为 'kiro-accounts'，闲置账号库为 'kiro-idle-accounts'，
// 两库备份文件物理分开。

import { safeStorage } from 'electron'
import * as fs from 'fs/promises'
import * as path from 'path'

const DEFAULT_FILE_BASE = 'kiro-accounts'

function encPath(dir: string, fileBase: string): string {
  return path.join(dir, `${fileBase}.backup.enc`)
}
function legacyPath(dir: string, fileBase: string): string {
  return path.join(dir, `${fileBase}.backup.json`)
}

/** safeStorage 是否真正可用（部分 Linux 环境无密钥环时返回 false） */
export function isSecureBackupAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

/** 写备份：优先加密；不可用则退回明文 JSON 以保证容灾不丢 */
export async function writeSecureBackup(dir: string, data: unknown, fileBase: string = DEFAULT_FILE_BASE): Promise<void> {
  const json = JSON.stringify(data)
  if (isSecureBackupAvailable()) {
    const enc = safeStorage.encryptString(json)
    await fs.writeFile(encPath(dir, fileBase), enc)
    // 清理旧的明文备份，避免明文长期残留
    try { await fs.unlink(legacyPath(dir, fileBase)) } catch { /* 不存在则忽略 */ }
    return
  }
  // 兜底：环境不支持加密时仍写明文，优先保证不丢数据
  await fs.writeFile(legacyPath(dir, fileBase), JSON.stringify(data, null, 2), 'utf-8')
}

/** 读备份：优先解密 .enc，失败再读旧明文 .json。返回 null 表示无可用备份 */
export async function readSecureBackup(dir: string, fileBase: string = DEFAULT_FILE_BASE): Promise<unknown | null> {
  // 1) 加密备份
  if (isSecureBackupAvailable()) {
    try {
      const buf = await fs.readFile(encPath(dir, fileBase))
      const json = safeStorage.decryptString(buf)
      return JSON.parse(json)
    } catch {
      /* .enc 不存在或解密失败 → 尝试明文 */
    }
  }
  // 2) 旧明文备份（平滑迁移）
  try {
    const content = await fs.readFile(legacyPath(dir, fileBase), 'utf-8')
    return JSON.parse(content)
  } catch {
    return null
  }
}
