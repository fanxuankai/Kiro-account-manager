/**
 * 账号数据库（SQLite，better-sqlite3）
 *
 * 取代 electron-store 的 accountData 单 JSON 存储（AES 全库加解密 + 全量写盘），
 * 解决账号规模上去后的写放大与启动开销：
 *  - 保存：与上次快照做行级 diff，只写变化的行（改一个账号 = 写一行）
 *  - 加载：启动时全量 SELECT 拼回 AccountData 形状，之后内存缓存读 O(1)
 *  - IPC 契约不变：仍是 loadAccounts() 全量 / saveAccounts(data) 全量，前端零改动
 *
 * 表设计：已知集合拆表（accounts 带筛选索引列），其余顶层键（标量/数组）进 meta KV——
 * 前端将来新增顶层字段自动落 meta，无需改表。
 * 旧 kiro-accounts.json 原样保留（迁移源 + 回退到旧版本的保险）。
 *
 * 集合形状（与 renderer store 的 saveToStorage 对齐）：
 *  - accounts:             Record<id, Account>            → accounts 表（+索引列）
 *  - groups / tags / proxyPool: Record<id, object>        → 对象值 KV 表
 *  - accountProxyBindings: Record<accountId, proxyId>     → bindings 表（字符串值）
 *  - accountMachineIds:    Record<accountId, machineId>   → account_machine_ids 表（字符串值）
 *  - 其它（activeAccountId / machineIdHistory / 设置项等）→ meta 表
 */
import path from 'path'
import fs from 'fs'
import Database from 'better-sqlite3'

type Rec = Record<string, unknown>

export interface SaveDiffStat {
  /** 变更/新增的行数（所有表合计） */
  changed: number
  /** 删除的行数 */
  deleted: number
  /** 本次耗时 ms */
  ms: number
}

/** 已知集合键 → 是否对象值表（bindings/machineIds 是字符串值，单独处理） */
const OBJECT_TABLES = {
  groups: 'groups',
  tags: 'tags',
  proxyPool: 'proxy_pool'
} as const

const STRING_TABLES = {
  accountProxyBindings: 'bindings',
  accountMachineIds: 'account_machine_ids'
} as const

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id         TEXT PRIMARY KEY,
  status     TEXT,
  group_id   TEXT,
  source     TEXT,
  created_at INTEGER,
  email      TEXT,
  data       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_accounts_status  ON accounts(status);
CREATE INDEX IF NOT EXISTS idx_accounts_group   ON accounts(group_id);
CREATE INDEX IF NOT EXISTS idx_accounts_source  ON accounts(source);
CREATE INDEX IF NOT EXISTS idx_accounts_created ON accounts(created_at DESC);

CREATE TABLE IF NOT EXISTS groups        (id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tags          (id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS proxy_pool    (id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS bindings      (account_id TEXT PRIMARY KEY, proxy_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS account_machine_ids (account_id TEXT PRIMARY KEY, machine_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS meta          (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`

/** 从 Account 对象提取筛选索引列；字段缺失时列置 NULL，不影响 data 列完整性 */
function accountIndexColumns(v: Rec): { status: unknown; group_id: unknown; source: unknown; created_at: unknown; email: unknown } {
  return {
    status: typeof v.status === 'string' ? v.status : null,
    group_id: typeof v.groupId === 'string' ? v.groupId : null,
    source: typeof v.source === 'string' ? v.source : null,
    created_at: typeof v.createdAt === 'number' ? v.createdAt : null,
    email: typeof v.email === 'string' ? v.email : null
  }
}

export class AccountDb {
  private db: Database.Database
  /** 完整 AccountData 缓存（loadAll 的结果；saveAll 后同步替换） */
  private cache: Rec | null = null
  /** 行级 diff 缓存：表名 → (行键 → 行 JSON 文本)。与库内容一致时 diff 为空操作 */
  private rowText = new Map<string, Map<string, string>>()

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = NORMAL')
    this.db.exec(SCHEMA)
    for (const t of ['accounts', ...Object.values(OBJECT_TABLES), ...Object.values(STRING_TABLES), 'meta']) {
      this.rowText.set(t, new Map())
    }
  }

  /** 库内是否有账号数据（迁移判定用） */
  hasAccounts(): boolean {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }
    return row.n > 0
  }

  /** 首次迁移：把旧 accountData（electron-store JSON 或加密备份恢复出的数据）整库导入 */
  migrateFrom(legacy: unknown): void {
    if (this.hasAccounts()) return
    if (!legacy || typeof legacy !== 'object') return
    const data = legacy as Rec
    if (!data.accounts || typeof data.accounts !== 'object') return
    const stat = this.saveAll(data)
    console.log(`[AccountDb] 迁移完成: accounts=${Object.keys(data.accounts).length} 行，写入 changed=${stat.changed} deleted=${stat.deleted} 耗时 ${stat.ms}ms`)
  }

  /** 全量加载并缓存。之后重复调用返回同一对象（零开销） */
  loadAll(): Rec {
    if (this.cache) return this.cache
    const data: Rec = { accounts: {} }

    for (const row of this.db.prepare('SELECT id, data FROM accounts').all() as Array<{ id: string; data: string }>) {
      ;(data.accounts as Rec)[row.id] = JSON.parse(row.data)
    }
    for (const [key, table] of Object.entries(OBJECT_TABLES)) {
      const obj: Rec = {}
      for (const row of this.db.prepare(`SELECT id, data FROM ${table}`).all() as Array<{ id: string; data: string }>) {
        obj[row.id] = JSON.parse(row.data)
      }
      data[key] = obj
    }
    for (const [key, table] of Object.entries(STRING_TABLES)) {
      const obj: Rec = {}
      const [idCol, valCol] = table === 'bindings' ? ['account_id', 'proxy_id'] : ['account_id', 'machine_id']
      for (const row of this.db.prepare(`SELECT ${idCol} AS k, ${valCol} AS v FROM ${table}`).all() as Array<{ k: string; v: string }>) {
        obj[row.k] = row.v
      }
      data[key] = obj
    }
    for (const row of this.db.prepare('SELECT key, value FROM meta').all() as Array<{ key: string; value: string }>) {
      try { data[row.key] = JSON.parse(row.value) } catch { data[row.key] = row.value }
    }

    this.cache = data
    this.rebuildRowText(data)
    return data
  }

  /**
   * 行级 diff 保存：只对变化的行 upsert、消失的行 delete，其余不动。
   * 全程内存比对（行 JSON 文本），写盘量 = 实际变化量。
   */
  saveAll(next: Rec): SaveDiffStat {
    const t0 = Date.now()
    const stat: SaveDiffStat = { changed: 0, deleted: 0, ms: 0 }

    const upsertAccount = this.db.prepare(
      'INSERT INTO accounts (id, status, group_id, source, created_at, email, data) VALUES (?, ?, ?, ?, ?, ?, ?)\n' +
      'ON CONFLICT(id) DO UPDATE SET status=excluded.status, group_id=excluded.group_id, source=excluded.source, created_at=excluded.created_at, email=excluded.email, data=excluded.data'
    )
    const deleteAccount = this.db.prepare('DELETE FROM accounts WHERE id = ?')
    this.diffObjectTable('accounts', next.accounts as Rec | undefined, stat,
      (id, text, v) => {
        const idx = accountIndexColumns(v)
        upsertAccount.run(id, idx.status, idx.group_id, idx.source, idx.created_at, idx.email, text)
      },
      (id) => deleteAccount.run(id)
    )

    for (const [key, table] of Object.entries(OBJECT_TABLES)) {
      const upsert = this.db.prepare(`INSERT INTO ${table} (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`)
      const del = this.db.prepare(`DELETE FROM ${table} WHERE id = ?`)
      this.diffObjectTable(table, next[key] as Rec | undefined, stat,
        (id, text) => upsert.run(id, text),
        (id) => del.run(id))
    }

    for (const [key, table] of Object.entries(STRING_TABLES)) {
      const valCol = table === 'bindings' ? 'proxy_id' : 'machine_id'
      const upsert = this.db.prepare(
        `INSERT INTO ${table} (account_id, ${valCol}) VALUES (?, ?) ON CONFLICT(account_id) DO UPDATE SET ${valCol}=excluded.${valCol}`)
      const del = this.db.prepare(`DELETE FROM ${table} WHERE account_id = ?`)
      this.diffStringTable(table, next[key] as Rec | undefined, stat,
        (id, v) => upsert.run(id, v),
        (id) => del.run(id))
    }

    // 其余顶层键 → meta（含标量与数组如 machineIdHistory）
    this.diffMeta(next, stat)

    stat.ms = Date.now() - t0
    this.cache = next
    return stat
  }

  /** 对象值集合 diff：值序列化文本变化才写 */
  private diffObjectTable(
    table: string,
    next: Rec | undefined,
    stat: SaveDiffStat,
    upsert: (id: string, text: string, v: Rec) => void,
    del: (id: string) => void
  ): void {
    const cache = this.rowText.get(table)!
    const seen = new Set<string>()
    if (next && typeof next === 'object') {
      for (const [id, v] of Object.entries(next)) {
        if (!v || typeof v !== 'object') continue // 非法行跳过（保持库内干净）
        const text = JSON.stringify(v)
        seen.add(id)
        if (cache.get(id) !== text) {
          upsert(id, text, v as Rec)
          cache.set(id, text)
          stat.changed++
        }
      }
    }
    for (const id of Array.from(cache.keys())) {
      if (!seen.has(id)) {
        del(id)
        cache.delete(id)
        stat.deleted++
      }
    }
  }

  /** 字符串值集合 diff（bindings / accountMachineIds） */
  private diffStringTable(
    table: string,
    next: Rec | undefined,
    stat: SaveDiffStat,
    upsert: (id: string, v: string) => void,
    del: (id: string) => void
  ): void {
    const cache = this.rowText.get(table)!
    const seen = new Set<string>()
    if (next && typeof next === 'object') {
      for (const [id, v] of Object.entries(next)) {
        if (typeof v !== 'string' || !v) continue
        seen.add(id)
        if (cache.get(id) !== v) {
          upsert(id, v)
          cache.set(id, v)
          stat.changed++
        }
      }
    }
    for (const id of Array.from(cache.keys())) {
      if (!seen.has(id)) {
        del(id)
        cache.delete(id)
        stat.deleted++
      }
    }
  }

  /** meta diff：已知集合之外的顶层键，JSON 序列化后按 key 比对 */
  private diffMeta(next: Rec, stat: SaveDiffStat): void {
    const cache = this.rowText.get('meta')!
    const known = new Set<string>(['accounts', ...Object.keys(OBJECT_TABLES), ...Object.keys(STRING_TABLES)])
    const upsert = this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    const del = this.db.prepare('DELETE FROM meta WHERE key = ?')
    const seen = new Set<string>()
    for (const [key, v] of Object.entries(next)) {
      if (known.has(key)) continue
      if (v === undefined) continue
      const text = JSON.stringify(v) ?? 'null'
      seen.add(key)
      if (cache.get(key) !== text) {
        upsert.run(key, text)
        cache.set(key, text)
        stat.changed++
      }
    }
    // 旧的 meta 键在新数据里消失 → 删除（与集合行为一致）
    for (const key of Array.from(cache.keys())) {
      if (!seen.has(key)) {
        del.run(key)
        cache.delete(key)
        stat.deleted++
      }
    }
  }

  /** 从当前库内容重建行文本缓存（loadAll 后调用） */
  private rebuildRowText(data: Rec): void {
    const accounts = this.rowText.get('accounts')!
    accounts.clear()
    for (const [id, v] of Object.entries(data.accounts as Rec)) {
      accounts.set(id, JSON.stringify(v) ?? 'null')
    }
    for (const [key, table] of Object.entries(OBJECT_TABLES)) {
      const m = this.rowText.get(table)!
      m.clear()
      for (const [id, v] of Object.entries((data[key] as Rec) || {})) {
        m.set(id, JSON.stringify(v) ?? 'null')
      }
    }
    for (const [key, table] of Object.entries(STRING_TABLES)) {
      const m = this.rowText.get(table)!
      m.clear()
      for (const [id, v] of Object.entries((data[key] as Rec) || {})) {
        if (typeof v === 'string') m.set(id, v)
      }
    }
    const meta = this.rowText.get('meta')!
    meta.clear()
    const known = new Set<string>(['accounts', ...Object.keys(OBJECT_TABLES), ...Object.keys(STRING_TABLES)])
    for (const [key, v] of Object.entries(data)) {
      if (known.has(key) || v === undefined) continue
      meta.set(key, JSON.stringify(v) ?? 'null')
    }
  }

  close(): void {
    try { this.db.close() } catch { /* ignore */ }
  }
}

// ============ 主进程单例接口（index.ts 使用） ============

let accountDb: AccountDb | null = null

/**
 * 初始化账号数据库并执行首次迁移。
 * @param userDataDir  Electron userData 目录
 * @param legacyData   旧 accountData（electron-store JSON；为空则空库起步）
 */
export function initAccountDb(userDataDir: string, legacyData: unknown): AccountDb {
  if (accountDb) return accountDb
  accountDb = new AccountDb(path.join(userDataDir, 'kiro-accounts.db'))
  accountDb.migrateFrom(legacyData)
  accountDb.loadAll()
  return accountDb
}

/** 读取完整 AccountData（内存缓存）。未初始化返回 null（跟随原 store.get 行为） */
export function getAccountData(): Rec | null {
  if (!accountDb) return null
  return accountDb.loadAll()
}

/** 行级 diff 保存。未初始化时抛错（save-accounts 不应早于 initStore） */
export function saveAccountData(data: Rec): SaveDiffStat {
  if (!accountDb) throw new Error('账号数据库未初始化')
  return accountDb.saveAll(data)
}

export function isAccountDbReady(): boolean {
  return accountDb !== null
}

export function closeAccountDb(): void {
  accountDb?.close()
  accountDb = null
}
