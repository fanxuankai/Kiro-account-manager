// 指纹实测对比工具(手动):号池登录窗口(Electron + 指纹对齐) vs 系统 Chrome 无痕。
//
// 用法:项目根目录执行  npx electron test/fp-compare/run.cjs
// 产物:/tmp/fp-electron.json 与 /tmp/fp-chrome.json(各含 TLS/H2 服务端指纹 + 页面 JS 信号)
// 两侧都直连(不走代理),同一网络出口,保证 TLS 对比公平。
//
// Chrome 侧经 --remote-debugging-port + CDP 驱动:采样本身会挂 debugger,
// 但采集的信号(几何/UA hints/权限/WebGL/TLS)不受 debugger 影响。

const { app, BrowserWindow, session } = require('electron')
const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { hardenSessionHeaders, applyWindowFingerprint, resolveFingerprintEnv } = require('./fp.cjs')

// 服务端视角 TLS/HTTP2 指纹(peet.ws 失败退 browserleaks)
const TLS_URLS = ['https://tls.peet.ws/api/all', 'https://tls.browserleaks.com/json']

// 页面 JS 信号采集脚本(两侧同一份,about:blank 上执行,避免页面环境干扰)
const COLLECT = `(async () => {
  const n = navigator
  const out = {}
  out.ua = n.userAgent
  out.webdriver = n.webdriver
  out.languages = Array.from(n.languages || [])
  out.hardwareConcurrency = n.hardwareConcurrency
  out.deviceMemory = n.deviceMemory
  out.platform = n.platform
  out.vendor = n.vendor
  try {
    out.uadHigh = await n.userAgentData.getHighEntropyValues(['architecture','bitness','fullVersionList','model','platformVersion','uaFullVersion','wow64'])
  } catch (e) { out.uadHigh = 'unsupported' }
  out.uadBrands = n.userAgentData ? Array.from(n.userAgentData.brands) : null
  out.tz = Intl.DateTimeFormat().resolvedOptions().timeZone
  out.tzOffsetMin = new Date().getTimezoneOffset()
  out.plugins = Array.from(n.plugins).map((p) => p.name)
  out.mimeLen = n.mimeTypes.length
  try {
    const pm = await n.permissions.query({ name: 'notifications' })
    out.permNotification = pm.state
  } catch (e) { out.permNotification = 'err:' + e.name }
  out.notifPermission = typeof Notification !== 'undefined' ? Notification.permission : 'no Notification'
  out.chromeKeys = window.chrome ? Object.keys(window.chrome).sort() : null
  out.chromeRuntimeId = !!(window.chrome && window.chrome.runtime && 'id' in window.chrome.runtime)
  out.outer = [window.outerWidth, window.outerHeight]
  out.inner = [window.innerWidth, window.innerHeight]
  out.chromeGap = [window.outerWidth - window.innerWidth, window.outerHeight - window.innerHeight]
  out.screen = [screen.width, screen.height, screen.availWidth, screen.availHeight, screen.colorDepth, screen.pixelDepth]
  out.dpr = window.devicePixelRatio
  out.screenXY = [window.screenX, window.screenY]
  const gl = document.createElement('canvas').getContext('webgl')
  const dbg = gl && gl.getExtension('WEBGL_debug_renderer_info')
  out.webgl = gl ? [
    dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
    dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)
  ] : null
  return JSON.stringify(out)
})()`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── Electron 侧:与 loginPool/runner.runEntry 完全同款流程 ──────────────

async function electronSide() {
  const partition = `fp-compare-${Date.now()}`
  const ses = session.fromPartition(partition, { cache: false })
  const fp = await resolveFingerprintEnv(null) // 直连:本机时区/语言
  hardenSessionHeaders(ses, fp)
  const win = new BrowserWindow({
    width: 1080,
    height: 840,
    autoHideMenuBar: true,
    webPreferences: { session: ses, contextIsolation: true, nodeIntegration: false, sandbox: true }
  })
  const applied = await applyWindowFingerprint(win, fp)
  if (!applied.ok) console.log('[warn] CDP 指纹对齐未生效:', applied.error)
  let tls = null
  let lastErr = null
  for (const url of TLS_URLS) {
    try {
      await win.loadURL(url)
      await sleep(1200)
      const text = await win.webContents.executeJavaScript('document.body.innerText')
      const parsed = JSON.parse(text)
      if (!(parsed.peetprint_hash || parsed.ja4 || parsed.ja3_hash || (parsed.http2 && parsed.http2.akamai_fingerprint_hash))) throw new Error('响应缺字段,重试')
      tls = parsed
      tls.__source = url
      break
    } catch (e) { lastErr = e }
  }
  if (!tls) throw new Error('TLS 指纹页均不可达: ' + (lastErr && lastErr.message))
  await win.loadURL('https://example.com/')
  await sleep(800)
  const js = JSON.parse(await win.webContents.executeJavaScript(COLLECT, true))
  win.destroy()
  return { tls, js }
}

// ── Chrome 侧:系统 Chrome 无痕 + CDP 采样 ────────────────────────────

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.seq = 0
    this.pending = new Map()
    this.events = []
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id && this.pending.has(m.id)) {
        this.pending.get(m.id)(m)
        this.pending.delete(m.id)
      } else {
        this.events.push(m)
      }
    }
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq
      this.pending.set(id, (m) =>
        m.error ? reject(new Error(method + ': ' + m.error.message)) : resolve(m.result)
      )
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  waitEvent(name, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const t0 = Date.now()
      const poll = () => {
        const i = this.events.findIndex((e) => e.method === name)
        if (i >= 0) {
          this.events.splice(i, 1)
          resolve()
          return
        }
        if (Date.now() - t0 > timeoutMs) return reject(new Error('等待事件超时: ' + name))
        setTimeout(poll, 200)
      }
      poll()
    })
  }
}

async function chromeSide() {
  const bin = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  const port = 9333
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-chrome-'))
  const proc = spawn(
    bin,
    [
      '--incognito',
      `--user-data-dir=${tmpDir}`,
      `--remote-debugging-port=${port}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1100,900', '--window-position=120,120',
      'about:blank'
    ],
    { stdio: 'ignore' }
  )
  try {
    let version = null
    for (let i = 0; i < 40; i++) {
      try {
        version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
        break
      } catch {
        await sleep(500)
      }
    }
    if (!version) throw new Error('Chrome DevTools 端口未就绪')
    let target = null
    for (let i = 0; i < 20; i++) {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      target = list.find((t) => t.type === 'page')
      if (target) break
      await sleep(500)
    }
    if (!target) throw new Error('未找到 Chrome 页面 target')
    const ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((res, rej) => {
      ws.onopen = res
      ws.onerror = rej
    })
    const cdp = new Cdp(ws)
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    let tls = null
    let lastErr = null
    for (const url of TLS_URLS) {
      try {
        await cdp.send('Page.navigate', { url })
        await cdp.waitEvent('Page.loadEventFired')
        await sleep(1200)
        const text = (
          await cdp.send('Runtime.evaluate', {
            expression: 'document.body.innerText',
            returnByValue: true
          })
        ).result.value
        const parsed = JSON.parse(text)
        if (!(parsed.peetprint_hash || parsed.ja4 || parsed.ja3_hash || (parsed.http2 && parsed.http2.akamai_fingerprint_hash))) throw new Error('响应缺字段,重试')
        tls = parsed
        tls.__source = url
        break
      } catch (e) { lastErr = e }
    }
    if (!tls) throw new Error('TLS 指纹页均不可达: ' + (lastErr && lastErr.message))
    await cdp.send('Page.navigate', { url: 'https://example.com/' })
    await cdp.waitEvent('Page.loadEventFired')
    await sleep(600)
    const js = JSON.parse(
      (
        await cdp.send('Runtime.evaluate', {
          expression: COLLECT,
          awaitPromise: true,
          returnByValue: true
        })
      ).result.value
    )
    ws.close()
    return { chromeVersion: version.Browser, tls, js }
  } finally {
    proc.kill()
    await sleep(800)
    // 清理尽力而为:Chrome 退出中仍持有文件时不应吞掉采样结果
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
    } catch {
      /* 留给系统临时目录自动清理 */
    }
  }
}

app.whenReady().then(async () => {
  try {
    const chrome = await chromeSide()
    fs.writeFileSync('/tmp/fp-chrome.json', JSON.stringify(chrome, null, 2))
    console.log('[✓] Chrome 侧采样完成:', chrome.chromeVersion)
    const electron = await electronSide()
    fs.writeFileSync('/tmp/fp-electron.json', JSON.stringify(electron, null, 2))
    console.log('[✓] Electron 侧采样完成')
    console.log('结果:/tmp/fp-chrome.json 与 /tmp/fp-electron.json')
  } catch (e) {
    console.error('[✗]', e && e.stack ? e.stack : e)
    process.exitCode = 1
  } finally {
    app.quit()
  }
})
