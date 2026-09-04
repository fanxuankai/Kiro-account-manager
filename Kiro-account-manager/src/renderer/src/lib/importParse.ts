// 导入文件解析（账号管理与闲置账号库共用）
// 支持 JSON（完整导出数据）/ CSV / TXT（自动识别卡密格式或普通格式）。
// 解析与存储解耦：这里只产出结构化结果，入库由调用方选择 importAccounts / importFromExportData。

import type { AccountExportData, AccountImportItem } from '@/types/account'
import { splitCredentialLine } from '@/lib/utils'

export type ParsedImport =
  | { kind: 'export'; data: AccountExportData }
  | { kind: 'items'; items: AccountImportItem[]; format: 'csv' | 'kami' | 'txt' }
  | { kind: 'invalid'; message: string }

// 解析 CSV 行（处理引号和逗号）
function parseCSVLine(line: string): string[] {
  const result: string[] = []
  let current = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"'
        i++
      } else {
        inQuotes = !inQuotes
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim())
      current = ''
    } else {
      current += char
    }
  }
  result.push(current.trim())
  return result
}

/**
 * 解析导入文件内容。
 * @param content        文件文本内容
 * @param format         文件格式（json/csv/txt，由文件对话框识别）
 * @param currentGroupId 当前打开的分组 id（导入账号归入该分组；undefined 表示未分组）
 * JSON 解析失败会抛出异常，由调用方统一提示。
 */
export function parseImportContent(content: string, format: string, currentGroupId?: string): ParsedImport {
  if (format === 'json') {
    // JSON 格式：完整导出数据
    const data = JSON.parse(content) as AccountExportData
    if (data.version && data.accounts) {
      return { kind: 'export', data }
    }
    return { kind: 'invalid', message: '无效的 JSON 文件格式' }
  }

  if (format === 'csv') {
    // CSV 格式：邮箱,昵称,登录方式,RefreshToken,ClientId,ClientSecret,Region
    const lines = content.split('\n').filter(line => line.trim())
    if (lines.length < 2) {
      return { kind: 'invalid', message: 'CSV 文件为空或只有标题行' }
    }

    // 跳过标题行，解析数据行
    const items = lines.slice(1).map(line => {
      const cols = parseCSVLine(line)
      return {
        email: cols[0] || '',
        nickname: cols[1] || undefined,
        idp: cols[2] || 'Google',
        refreshToken: cols[3] || '',
        clientId: cols[4] || '',
        clientSecret: cols[5] || '',
        region: cols[6] || 'us-east-1',
        groupId: currentGroupId
      }
    }).filter(item => item.email && item.refreshToken)

    if (items.length === 0) {
      return { kind: 'invalid', message: '未找到有效的账号数据（需要邮箱和 RefreshToken）' }
    }
    return { kind: 'items', items, format: 'csv' }
  }

  if (format === 'txt') {
    // TXT 格式：自动识别卡密格式或普通格式
    const lines = content.split('\n').filter(line => line.trim() && !line.startsWith('#'))

    // 检测是否为卡密格式（包含 ---- 分隔符）
    const isKamiFormat = lines.some(line => line.includes('----'))

    if (isKamiFormat) {
      // 卡密格式：邮箱----密码----RefreshToken----ClientId----ClientSecret
      // 自动识别分隔符：----、\t、连续空格
      const items = lines.map(line => {
        const parts = splitCredentialLine(line)
        const rawPwd = parts[1]?.trim()
        const clientId = parts[3]?.trim() || undefined
        const clientSecret = parts[4]?.trim() || undefined
        // 第6字段为登录方式(idp)：新卡密直接带；旧卡密无此字段时按 ClientId/Secret 推断
        // social(Github/Google) 只有 refreshToken，IdC(BuilderId) 才有 ClientId/Secret
        const rawIdp = parts[5]?.trim()
        const idp = rawIdp || ((!clientId && !clientSecret) ? 'Google' : 'BuilderId')
        return {
          email: parts[0]?.trim() || '',
          password: (rawPwd && rawPwd !== 'no_password') ? rawPwd : undefined,
          refreshToken: parts[2]?.trim() || '',
          clientId,
          clientSecret,
          idp,
          groupId: currentGroupId
        }
      }).filter(item => item.email && item.refreshToken)

      if (items.length === 0) {
        return { kind: 'invalid', message: '未找到有效的卡密数据（格式：邮箱----密码----RefreshToken----ClientId----ClientSecret）' }
      }
      return { kind: 'items', items, format: 'kami' }
    }

    // 普通 TXT 格式：邮箱,RefreshToken 或 邮箱|RefreshToken
    const items = lines.map(line => {
      const parts = line.includes('|') ? line.split('|') : line.split(',')
      return {
        email: parts[0]?.trim() || '',
        refreshToken: parts[1]?.trim() || '',
        nickname: parts[2]?.trim() || undefined,
        idp: parts[3]?.trim() || 'Google',
        groupId: currentGroupId
      }
    }).filter(item => item.email && item.refreshToken)

    if (items.length === 0) {
      return { kind: 'invalid', message: '未找到有效的账号数据（格式：邮箱,RefreshToken 或 卡密格式：邮箱----密码----Token----ID----Secret）' }
    }
    return { kind: 'items', items, format: 'txt' }
  }

  return { kind: 'invalid', message: `不支持的文件格式：${format}` }
}
