// 号池存储：userData/login-pool.json，主进程为唯一数据源（渲染进程只读视图）。
// 条目含明文密码与 2FA 密钥（与扩展 storage、账号库卡密密码同级的安全边界，
// 本机文件、不外发；文件属用户数据目录，随应用卸载/用户自行清理）。

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/** 条目状态机：unused 未用 → running 执行中 → used 成功入库 / failed 失败（可重试）；
 *  wasted 作废 = 人工标记失效（2FA 密钥错、账号被封等），不参与取号。 */
export type PoolEntryState = 'unused' | 'running' | 'used' | 'failed' | 'wasted'

export interface PoolEntry {
  id: string
  username: string
  password: string
  /** base32 TOTP 密钥 */
  secret: string
  state: PoolEntryState
  /** running 时的执行进度（0-8，对应 8 步链路） */
  step: number
  failReason?: string
  /** 激活成功后写入的 Kiro 账号邮箱（渲染进程入库回填） */
  kiroEmail?: string
  addedAt: number
  takenAt?: number
  doneAt?: number
}

/** 渲染进程视图条目：剥离明文凭据，只带打码展示位 */
export type PoolEntryView = Omit<PoolEntry, 'password' | 'secret'> & {
  passwordMasked: string
  secretMasked: string
}

const STATE_ORDER: PoolEntryState[] = ['running', 'unused', 'used', 'failed', 'wasted']

export class LoginPoolStore {
  private file: string
  private entries: PoolEntry[] = []
  private seq = 0

  constructor(userDataDir: string) {
    this.file = join(userDataDir, 'login-pool.json')
    try {
      if (existsSync(this.file)) {
        const data = JSON.parse(readFileSync(this.file, 'utf-8'))
        if (Array.isArray(data.entries)) this.entries = data.entries
      }
    } catch (err) {
      console.error('[LoginPool] 读取 login-pool.json 失败，按空池启动:', err)
    }
    // 异常退出的残留 running 归一为 unused（进程重启后不可能还在执行）
    for (const e of this.entries) {
      if (e.state === 'running') {
        e.state = 'unused'
        e.step = 0
      }
    }
    this.seq = this.entries.reduce((m, e) => Math.max(m, parseInt(e.id, 10) || 0), 0)
  }

  private save(): void {
    try {
      writeFileSync(this.file, JSON.stringify({ entries: this.entries }, null, 2))
    } catch (err) {
      console.error('[LoginPool] 写入 login-pool.json 失败:', err)
    }
  }

  /** 按执行优先级排序的视图（running 最前，其后未用，再按结果态） */
  listViews(): PoolEntryView[] {
    const views = this.entries.map((e) => this.toView(e))
    views.sort((a, b) => {
      const d = STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state)
      return d !== 0 ? d : a.id.localeCompare(b.id)
    })
    return views
  }

  toView(e: PoolEntry): PoolEntryView {
    const { password, secret, ...rest } = e
    return {
      ...rest,
      passwordMasked: '•'.repeat(Math.min(password.length, 10)),
      secretMasked: secret.slice(0, 4) + '••••'
    }
  }

  get(id: string): PoolEntry | undefined {
    return this.entries.find((e) => e.id === id)
  }

  /** 批量入池（已解析的条目）；同用户名重贴 = 覆盖凭据、保持原状态 */
  addMany(items: { username: string; password: string; secret: string }[]): number {
    let added = 0
    for (const item of items) {
      const existing = this.entries.find((e) => e.username === item.username)
      if (existing) {
        existing.password = item.password
        existing.secret = item.secret
        continue
      }
      this.seq += 1
      this.entries.push({
        id: String(this.seq),
        username: item.username,
        password: item.password,
        secret: item.secret,
        state: 'unused',
        step: 0,
        addedAt: Date.now()
      })
      added += 1
    }
    this.save()
    return added
  }

  /** 取下一个未用号（取号即标 running，防止批次重入重复消耗） */
  takeNext(): PoolEntry | null {
    const next = this.entries.find((e) => e.state === 'unused')
    if (!next) return null
    next.state = 'running'
    next.step = 0
    next.failReason = undefined
    next.takenAt = Date.now()
    this.save()
    return next
  }

  patch(id: string, patch: Partial<Pick<PoolEntry, 'state' | 'step' | 'failReason' | 'kiroEmail'>>): void {
    const e = this.get(id)
    if (!e) return
    Object.assign(e, patch)
    if (patch.state === 'used' || patch.state === 'failed') e.doneAt = Date.now()
    this.save()
  }

  /** 人工操作：作废 / 恢复未用 / 删除 */
  markWasted(id: string): void {
    const e = this.get(id)
    if (e && e.state !== 'running') this.patch(id, { state: 'wasted' })
  }

  restore(id: string): void {
    const e = this.get(id)
    if (e && e.state !== 'running') this.patch(id, { state: 'unused', step: 0, failReason: undefined })
  }

  remove(id: string): void {
    const e = this.get(id)
    if (e && e.state !== 'running') {
      this.entries = this.entries.filter((x) => x.id !== id)
      this.save()
    }
  }

  clearFinished(): void {
    this.entries = this.entries.filter((e) => e.state !== 'used')
    this.save()
  }

  restoreAll(): void {
    for (const e of this.entries) {
      if (e.state === 'used' || e.state === 'failed' || e.state === 'wasted') {
        e.state = 'unused'
        e.step = 0
        e.failReason = undefined
      }
    }
    this.save()
  }

  countUnused(): number {
    return this.entries.filter((e) => e.state === 'unused').length
  }
}
