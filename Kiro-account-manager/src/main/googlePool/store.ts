// Google 号池存储：userData/google-pool.json，主进程为唯一数据源（渲染进程只读视图）。
// 条目含明文密码与 Google TOTP 密钥（与 login-pool.json 同级的安全边界：
// 本机文件、不外发；文件属用户数据目录，随应用卸载/用户自行清理）。

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/** 条目状态机：unused 未用 → running 授权窗口中 → used 成功入库 / failed 失败（可重试）；
 *  wasted 作废 = 人工标记失效（密码错、账号被封等），不参与授权。 */
export type GooglePoolEntryState = 'unused' | 'running' | 'used' | 'failed' | 'wasted'

export interface GooglePoolEntry {
  id: string
  /** Gmail 邮箱（同时也是登录账号） */
  email: string
  password: string
  /** Google 两步验证的 base32 TOTP 密钥（本地算 6 位码用）；辅助邮箱版卡密没有此段 */
  secret?: string
  /** 辅助邮箱（无 2FA 密钥版卡密的第 3 段；Google 可疑登录时发验证码到这里，经 yopmail 等免登录收信） */
  recoveryEmail?: string
  /** 辅助邮箱凭据（卡密第 4 段；商家给的辅邮密码/取信凭据，仅记录展示） */
  recoveryPassword?: string
  /** 卡密最后一段国家/注册地标记（如 mx/pa），仅记录，供人工选择对口代理参考 */
  country?: string
  state: GooglePoolEntryState
  failReason?: string
  /** 授权成功后写入的 Kiro 账号邮箱（渲染进程入库回填） */
  kiroEmail?: string
  /** 本次尝试实际使用的出口 IP（未启用出口代理时为空 = 直连） */
  exitIp?: string
  /** 本次尝试的出口来源：api=提链接口 / pool=静态代理池 / direct=直连 */
  proxyMode?: 'api' | 'pool' | 'direct'
  addedAt: number
  takenAt?: number
  doneAt?: number
}

/** 渲染进程视图条目：含明文凭据（表格「显示明文」开关用，本机自用无外发）+ 打码展示位 */
export type GooglePoolEntryView = Omit<GooglePoolEntry, 'password' | 'secret'> & {
  password: string
  secret?: string
  passwordMasked: string
  secretMasked?: string
}

const STATE_ORDER: GooglePoolEntryState[] = ['running', 'unused', 'used', 'failed', 'wasted']

export class GooglePoolStore {
  private file: string
  private entries: GooglePoolEntry[] = []
  private seq = 0

  constructor(userDataDir: string) {
    this.file = join(userDataDir, 'google-pool.json')
    try {
      if (existsSync(this.file)) {
        const data = JSON.parse(readFileSync(this.file, 'utf-8'))
        if (Array.isArray(data.entries)) this.entries = data.entries
      }
    } catch (err) {
      console.error('[GooglePool] 读取 google-pool.json 失败，按空池启动:', err)
    }
    // 异常退出的残留 running 归一为 unused（进程重启后不可能还有授权窗口）
    for (const e of this.entries) {
      if (e.state === 'running') {
        e.state = 'unused'
      }
    }
    this.seq = this.entries.reduce((m, e) => Math.max(m, parseInt(e.id, 10) || 0), 0)
  }

  private save(): void {
    try {
      writeFileSync(this.file, JSON.stringify({ entries: this.entries }, null, 2))
    } catch (err) {
      console.error('[GooglePool] 写入 google-pool.json 失败:', err)
    }
  }

  /** 按状态排序的视图：running 最前、未用次之（入池顺序），
   *  结果态（已入库/失败/作废）按完成时间倒序——最近完成的排最上 */
  listViews(): GooglePoolEntryView[] {
    const views = this.entries.map((e) => this.toView(e))
    views.sort((a, b) => {
      const d = STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state)
      if (d !== 0) return d
      if (a.state === 'unused') return a.addedAt - b.addedAt
      return (b.doneAt ?? b.takenAt ?? b.addedAt) - (a.doneAt ?? a.takenAt ?? a.addedAt)
    })
    return views
  }

  toView(e: GooglePoolEntry): GooglePoolEntryView {
    const { password, secret, ...rest } = e
    return {
      ...rest,
      password,
      secret,
      passwordMasked: '•'.repeat(Math.min(password.length, 10)),
      secretMasked: secret ? secret.slice(0, 4) + '••••' : undefined
    }
  }

  get(id: string): GooglePoolEntry | undefined {
    return this.entries.find((e) => e.id === id)
  }

  /** 批量入池（已解析的条目）；同邮箱重贴 = 覆盖凭据、保持原状态 */
  addMany(items: { email: string; password: string; secret?: string; recoveryEmail?: string; recoveryPassword?: string; country?: string }[]): number {
    let added = 0
    for (const item of items) {
      const existing = this.entries.find((e) => e.email.toLowerCase() === item.email.toLowerCase())
      if (existing) {
        existing.password = item.password
        existing.secret = item.secret
        existing.recoveryEmail = item.recoveryEmail
        existing.recoveryPassword = item.recoveryPassword
        existing.country = item.country
        continue
      }
      this.seq += 1
      this.entries.push({
        id: String(this.seq),
        email: item.email,
        password: item.password,
        secret: item.secret,
        recoveryEmail: item.recoveryEmail,
        recoveryPassword: item.recoveryPassword,
        country: item.country,
        state: 'unused',
        addedAt: Date.now()
      })
      added += 1
    }
    this.save()
    return added
  }

  patch(
    id: string,
    patch: Partial<
      Pick<GooglePoolEntry, 'state' | 'failReason' | 'kiroEmail' | 'exitIp' | 'proxyMode' | 'takenAt'>
    >
  ): void {
    const e = this.get(id)
    if (!e) return
    Object.assign(e, patch)
    if (patch.state === 'used' || patch.state === 'failed' || patch.state === 'wasted') {
      e.doneAt = Date.now()
    }
    this.save()
  }

  /** 人工操作：作废 / 恢复未用 / 删除 */
  markWasted(id: string): void {
    const e = this.get(id)
    if (e && e.state !== 'running') this.patch(id, { state: 'wasted' })
  }

  restore(id: string): void {
    const e = this.get(id)
    if (e && e.state !== 'running') this.patch(id, { state: 'unused', failReason: undefined })
  }

  remove(id: string): void {
    const e = this.get(id)
    if (e && e.state !== 'running') {
      this.entries = this.entries.filter((x) => x.id !== id)
      this.save()
    }
  }

  /** 批量删除（勾选的一键删除）；running 条目跳过不删，返回实际删除数 */
  removeMany(ids: string[]): number {
    const set = new Set(ids)
    const before = this.entries.length
    this.entries = this.entries.filter((e) => !set.has(e.id) || e.state === 'running')
    const removed = before - this.entries.length
    if (removed > 0) this.save()
    return removed
  }

  clearFinished(): void {
    this.entries = this.entries.filter((e) => e.state !== 'used')
    this.save()
  }

  restoreAll(): void {
    for (const e of this.entries) {
      if (e.state === 'used' || e.state === 'failed' || e.state === 'wasted') {
        e.state = 'unused'
        e.failReason = undefined
      }
    }
    this.save()
  }

  countUnused(): number {
    return this.entries.filter((e) => e.state === 'unused').length
  }
}
