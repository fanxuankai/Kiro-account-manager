// Google 号池 ↔ Chrome 扩展（google-signin）联动桥：
// 主进程起 127.0.0.1:17321 本地 HTTP 服务，扩展轮询领任务、上报窗口事件。
// 凭据仅走本机回环，不监听外网；任务完成由 kiro:// OS 协议回调判定（不经此桥）。

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

export interface BridgeTask {
  taskId: string
  entryId: string
  email: string
  password: string
  secret?: string
  recoveryEmail?: string
  /** 授权 URL（应用生成，含 PKCE state） */
  authUrl: string
}

export class GooglePoolBridge {
  private task: BridgeTask | null = null
  private claimed = false
  /** 扩展最近轮询时间（判断在线） */
  lastPollAt = 0
  /** 扩展是否已领取当前任务 */
  lastClaimedAt = 0
  private server: ReturnType<typeof createServer> | null = null
  /** 已完成任务标记（扩展轮询到 done 自动关无痕窗口；只留最近 50 条防泄漏） */
  private doneTasks = new Map<string, number>()

  markDone(taskId: string): void {
    this.doneTasks.set(taskId, Date.now())
    if (this.doneTasks.size > 50) {
      const oldest = [...this.doneTasks.entries()].sort((a, b) => a[1] - b[1]).slice(0, 25)
      for (const [k] of oldest) this.doneTasks.delete(k)
    }
  }
  /** 扩展报告任务被放弃（无痕窗口被关）时回调 runner */
  onAbandoned: ((taskId: string, detail: string) => void) | null = null

  get online(): boolean {
    return Date.now() - this.lastPollAt < 30_000
  }

  start(): void {
    if (this.server) return
    this.server = createServer((req, res) => void this.handle(req, res))
    this.server.on('error', (err) => {
      console.error('[GooglePoolBridge] 本地服务启动失败（端口被占？）:', err)
      this.server = null
    })
    this.server.listen(17321, '127.0.0.1')
  }

  postTask(task: BridgeTask): void {
    this.task = task
    this.claimed = false
  }

  clearTask(): void {
    this.task = null
    this.claimed = false
  }

  get currentTaskId(): string | null {
    return this.task?.taskId ?? null
  }

  get taskClaimed(): boolean {
    return !!this.task && this.claimed
  }

  private cors(res: ServerResponse): void {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.cors(res)
    const url = req.url || '/'
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204)
        res.end()
        return
      }
      if (req.method === 'GET' && url.startsWith('/task-status')) {
        this.lastPollAt = Date.now()
        const taskId = new URL(url, 'http://127.0.0.1').searchParams.get('taskId') || ''
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ done: this.doneTasks.has(taskId) }))
        return
      }
      if (req.method === 'GET' && url === '/next-task') {
        this.lastPollAt = Date.now()
        if (this.task && !this.claimed) {
          this.claimed = true
          this.lastClaimedAt = Date.now()
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(this.task))
        } else {
          res.writeHead(204)
          res.end()
        }
        return
      }
      if (req.method === 'POST' && url === '/report') {
        this.lastPollAt = Date.now()
        const chunks: Buffer[] = []
        for await (const c of req) chunks.push(c as Buffer)
        const body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}') as {
          taskId?: string
          event?: string
          detail?: string
        }
        if (body.event === 'abandoned' && body.taskId) {
          this.onAbandoned?.(body.taskId, body.detail || '')
        }
        res.writeHead(204)
        res.end()
        return
      }
      res.writeHead(404)
      res.end()
    } catch (err) {
      console.error('[GooglePoolBridge] 请求处理异常:', err)
      try {
        res.writeHead(500)
        res.end()
      } catch {
        /* 已响应则忽略 */
      }
    }
  }
}
