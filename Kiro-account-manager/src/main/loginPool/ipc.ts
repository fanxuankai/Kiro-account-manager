// 号池 IPC：主进程为唯一数据源（login-pool.json + 执行状态），
// 渲染进程只持视图；所有变化经 'login-pool-update' 事件推送。

import { ipcMain, type BrowserWindow } from 'electron'
import { LoginPoolStore, type PoolEntryView } from './store'
import { LoginPoolRunner, type BatchOptions, type LoginPoolDeps, type ResultPayload } from './runner'
import { parseLoginPoolText } from './totp'

export type LoginPoolUpdate =
  | { kind: 'entry'; entry: PoolEntryView }
  | { kind: 'log'; line: { time: string; level: 'info' | 'ok' | 'err' | 'warn'; msg: string } }
  | { kind: 'batch'; state: { running: boolean; paused: boolean; cooldownSec: number; unused: number } }
  | { kind: 'result'; payload: ResultPayload }

export interface LoginPoolBatchState {
  running: boolean
  paused: boolean
  cooldownSec: number
  unused: number
}

export function registerLoginPoolIpc(opts: {
  userDataDir: string
  deps: LoginPoolDeps
  getMainWindow: () => BrowserWindow | null
}): void {
  const store = new LoginPoolStore(opts.userDataDir)

  const send = (update: LoginPoolUpdate): void => {
    const win = opts.getMainWindow()
    if (win && !win.isDestroyed()) win.webContents.send('login-pool-update', update)
  }

  // 页面级快照缓存：切页导致组件重挂时，进页面拉一次全量恢复
  // （渲染层组件状态随卸载清零，日志/批次状态必须由主进程持有）
  const recentLogs: Array<{ time: string; level: 'info' | 'ok' | 'err' | 'warn'; msg: string }> = []
  let lastBatch: { running: boolean; paused: boolean; cooldownSec: number; unused: number } = {
    running: false,
    paused: false,
    cooldownSec: 0,
    unused: 0
  }

  const runner = new LoginPoolRunner(store, opts.deps, {
    onEntry: (entry) => send({ kind: 'entry', entry }),
    onLog: (line) => {
      // 双写主进程 console：日志会随 proxyLogStore 落盘，问题诊断不依赖用户复制 UI 日志
      console.log(`[LoginPool ${line.level}] ${line.msg}`)
      recentLogs.push(line)
      if (recentLogs.length > 200) recentLogs.splice(0, recentLogs.length - 200)
      send({ kind: 'log', line })
    },
    onBatch: (state) => {
      lastBatch = state
      send({ kind: 'batch', state })
    },
    onResult: (payload) => send({ kind: 'result', payload })
  })

  const log = (level: 'info' | 'ok' | 'err' | 'warn', msg: string): void => {
    const line = { time: new Date().toTimeString().slice(0, 8), level, msg }
    console.log(`[LoginPool ${level}] ${msg}`)
    recentLogs.push(line)
    if (recentLogs.length > 200) recentLogs.splice(0, recentLogs.length - 200)
    send({ kind: 'log', line })
  }

  // 返回全量快照：条目 + 批次状态 + 最近日志（页面重挂时恢复用）
  ipcMain.handle('login-pool:list', () => ({
    entries: store.listViews(),
    batch: lastBatch,
    logs: [...recentLogs]
  }))

  ipcMain.handle('login-pool:add-text', (_e, text: string) => {
    const { items, bad } = parseLoginPoolText(text)
    const added = store.addMany(items)
    return { added, updated: items.length - added, bad }
  })

  ipcMain.handle('login-pool:mark-wasted', (_e, id: string) => {
    store.markWasted(id)
    const entry = store.get(id)
    if (entry) send({ kind: 'entry', entry: store.toView(entry) })
    return { success: true }
  })

  ipcMain.handle('login-pool:restore', (_e, id: string) => {
    store.restore(id)
    const entry = store.get(id)
    if (entry) send({ kind: 'entry', entry: store.toView(entry) })
    return { success: true }
  })

  ipcMain.handle('login-pool:remove', (_e, id: string) => {
    store.remove(id)
    return { success: true }
  })

  ipcMain.handle('login-pool:clear-finished', () => {
    store.clearFinished()
    return { success: true }
  })

  ipcMain.handle('login-pool:restore-all', () => {
    store.restoreAll()
    return { success: true }
  })

  // 批量删除勾选条目（running 条目由 store 跳过不删）
  ipcMain.handle('login-pool:remove-many', (_e, ids: string[]) => {
    const removed = store.removeMany(Array.isArray(ids) ? ids : [])
    return { success: true, removed }
  })

  /** 出口代理开关开启但配置不完整：启动即拒绝，别让批次逐号空转失败 */
  const proxyInvalid = (opts?: BatchOptions): string | null => {
    const proxy = opts?.proxy
    if (!proxy?.enabled) return null
    if (proxy.mode === 'api') {
      if (!(proxy.api?.url || '').trim()) {
        return '提链 API 模式需要在「代理池」页的动态提链源里配置接口地址'
      }
      return null
    }
    if (!proxy.entries || proxy.entries.length === 0) {
      return '已开启出口代理但代理池无可用条目（需在代理池页启用并验活）'
    }
    return null
  }

  ipcMain.handle('login-pool:start', (_e, batchOpts: BatchOptions) => {
    if (!store.countUnused()) {
      return { success: false, error: '池内没有未用账号' }
    }
    const proxyError = proxyInvalid(batchOpts)
    if (proxyError) return { success: false, error: proxyError }
    if (runner!.running && !runner!.paused) {
      return { success: false, error: '批次已在执行中' }
    }
    if (runner!.running && runner!.paused) {
      runner!.resume(batchOpts)
    } else {
      runner!.start(batchOpts)
    }
    return { success: true }
  })

  ipcMain.handle('login-pool:pause', () => {
    runner!.pause()
    return { success: true }
  })

  ipcMain.handle('login-pool:run-one', (_e, id: string, batchOpts?: BatchOptions) => {
    if (runner!.running) {
      return { success: false, error: '批次执行中，不能单跑' }
    }
    if (!store.get(id)) {
      return { success: false, error: '条目不存在' }
    }
    const proxyError = proxyInvalid(batchOpts)
    if (proxyError) return { success: false, error: proxyError }
    runner!.runOne(id, batchOpts)
    return { success: true }
  })

  ipcMain.handle('login-pool:focus-window', () => {
    runner!.focusWindow()
    return { success: true }
  })

  // 系统协议兜底：窗口内四路拦截万一漏掉、OS 把 kiro:// 转回本应用时，
  // 渲染进程从 social-auth-callback 转发到这里（state 匹配才生效）
  ipcMain.handle('login-pool:manual-callback', (_e, code: string, state: string) => {
    runner!.handleManualCallback(code, state)
    return { success: true }
  })

  // 渲染进程完成 verifyAccountCredentials + addAccount 后回填：step=8、Kiro 邮箱
  ipcMain.handle('login-pool:mark-stored', (_e, id: string, kiroEmail: string) => {
    store.patch(id, { step: 8, kiroEmail })
    const entry = store.get(id)
    if (entry) send({ kind: 'entry', entry: store.toView(entry) })
    return { success: true }
  })

  log('info', '号池模块已就绪')
}
