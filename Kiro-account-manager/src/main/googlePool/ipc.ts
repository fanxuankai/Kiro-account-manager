// Google 号池 IPC：主进程为唯一数据源（google-pool.json + 授权窗口状态），
// 渲染进程只持视图；所有变化经 'google-pool-update' 事件推送。
// 与 loginPool 分开的同名结构（无 batch 批次态——手动授权单窗口串行）。

import { ipcMain, type BrowserWindow } from 'electron'
import { GooglePoolStore, type GooglePoolEntryView } from './store'
import { GooglePoolRunner, type GooglePoolDeps, type GooglePoolResultPayload } from './runner'
import { parseGooglePoolText } from './parse'
import { totpNow } from '../loginPool/totp'

export type GooglePoolUpdate =
  | { kind: 'entry'; entry: GooglePoolEntryView }
  | { kind: 'log'; line: { time: string; level: 'info' | 'ok' | 'err' | 'warn'; msg: string } }
  | { kind: 'result'; payload: GooglePoolResultPayload }

export function registerGooglePoolIpc(opts: {
  userDataDir: string
  deps: GooglePoolDeps
  getMainWindow: () => BrowserWindow | null
}): void {
  const store = new GooglePoolStore(opts.userDataDir)

  const send = (update: GooglePoolUpdate): void => {
    const win = opts.getMainWindow()
    if (win && !win.isDestroyed()) win.webContents.send('google-pool-update', update)
  }

  // 页面级快照缓存：切页导致组件重挂时，进页面拉一次全量恢复
  const recentLogs: Array<{ time: string; level: 'info' | 'ok' | 'err' | 'warn'; msg: string }> = []

  const runner = new GooglePoolRunner(store, opts.deps, {
    onEntry: (entry) => send({ kind: 'entry', entry }),
    onLog: (line) => {
      // 双写主进程 console：问题诊断不依赖用户复制 UI 日志
      console.log(`[GooglePool ${line.level}] ${line.msg}`)
      recentLogs.push(line)
      if (recentLogs.length > 200) recentLogs.splice(0, recentLogs.length - 200)
      send({ kind: 'log', line })
    },
    onResult: (payload) => send({ kind: 'result', payload })
  })

  const log = (level: 'info' | 'ok' | 'err' | 'warn', msg: string): void => {
    const line = { time: new Date().toTimeString().slice(0, 8), level, msg }
    console.log(`[GooglePool ${level}] ${msg}`)
    recentLogs.push(line)
    if (recentLogs.length > 200) recentLogs.splice(0, recentLogs.length - 200)
    send({ kind: 'log', line })
  }

  // 返回全量快照：条目 + 最近日志（页面重挂时恢复用）
  ipcMain.handle('google-pool:list', () => ({
    entries: store.listViews(),
    running: runner.running,
    logs: [...recentLogs]
  }))

  ipcMain.handle('google-pool:add-text', (_e, text: string) => {
    const { items, bad } = parseGooglePoolText(text)
    const added = store.addMany(items)
    return { added, updated: items.length - added, bad }
  })

  ipcMain.handle('google-pool:mark-wasted', (_e, id: string) => {
    store.markWasted(id)
    const entry = store.get(id)
    if (entry) send({ kind: 'entry', entry: store.toView(entry) })
    return { success: true }
  })

  ipcMain.handle('google-pool:restore', (_e, id: string) => {
    store.restore(id)
    const entry = store.get(id)
    if (entry) send({ kind: 'entry', entry: store.toView(entry) })
    return { success: true }
  })

  ipcMain.handle('google-pool:remove', (_e, id: string) => {
    store.remove(id)
    return { success: true }
  })

  // 批量删除勾选条目（running 条目由 store 跳过不删）
  ipcMain.handle('google-pool:remove-many', (_e, ids: string[]) => {
    const removed = store.removeMany(Array.isArray(ids) ? ids : [])
    return { success: true, removed }
  })

  ipcMain.handle('google-pool:clear-finished', () => {
    store.clearFinished()
    return { success: true }
  })

  ipcMain.handle('google-pool:restore-all', () => {
    store.restoreAll()
    return { success: true }
  })

  // 发起单号授权（打开手动登录窗口）；代理参数由渲染层按当前下拉组装传入
  ipcMain.handle(
    'google-pool:authorize',
    (_e, id: string, proxyOpts?: Parameters<GooglePoolRunner['authorize']>[1]) => {
      const entry = store.get(id)
      if (!entry) {
        return { success: false, error: '条目不存在' }
      }
      runner.authorize(id, proxyOpts)
      return { success: true }
    }
  )

  ipcMain.handle('google-pool:focus-window', () => {
    runner.focusWindow()
    return { success: true }
  })

  // 本地算当前 6 位验证码（界面一键复制用；密钥不出主进程）
  ipcMain.handle('google-pool:totp', (_e, id: string) => {
    const entry = store.get(id)
    if (!entry) return { success: false, error: '条目不存在' }
    if (!entry.secret) {
      return { success: false, error: '该条目无 2FA 密钥（辅助邮箱版卡密）：如遇验证挑战，请到辅助邮箱收码' }
    }
    try {
      const { code, remainMs } = totpNow(entry.secret)
      return { success: true, code, remainSec: Math.max(1, Math.round(remainMs / 1000)) }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // 系统协议兜底：窗口内四路拦截万一漏掉、OS 把 kiro:// 转回本应用时，
  // 渲染进程从 social-auth-callback 转发到这里（state 匹配才生效）
  ipcMain.handle('google-pool:manual-callback', (_e, code: string, state: string) => {
    runner.handleManualCallback(code, state)
    return { success: true }
  })

  // 渲染进程完成 verifyAccountCredentials + addAccount 后回填：used + Kiro 邮箱
  ipcMain.handle('google-pool:mark-stored', (_e, id: string, kiroEmail: string) => {
    store.patch(id, { state: 'used', kiroEmail })
    const entry = store.get(id)
    if (entry) send({ kind: 'entry', entry: store.toView(entry) })
    return { success: true }
  })

  log('info', 'Google 号池模块已就绪')
}
