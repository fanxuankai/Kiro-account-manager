// 拟人输入/点击原语 —— 支付窗口专用，从 loginPool/runner.ts 复制的精简版。
//
// 与 runner 相同的思路：填表走页面原生编辑管线（execCommand insertText，
// 事件 isTrusted=true，React 受控组件认），点击走 sendInputEvent 输入管线 +
// 贝塞尔移动轨迹，按压优先系统级真鼠标。刻意不抽成共享模块：号池登录是核心
// 链路，复制一份独立演化保证零回归；两边的页面 DOM 与点击目标形态不同，
// 能共用的只有这些底层原语。
//
// 与 runner 版的差异（适配 Stripe Checkout）：
// - 可点元素候选扩展了 [role=option]/[role=menuitem]/li —— Stripe 的
//   国家/省份自定义下拉选项不是 button/a，runner 版的候选集点不到它们；
// - 填表脚本按「字段规则列表」批量填写，而不是 GitHub 登录框写死的选择器。

import { BrowserWindow, screen } from 'electron'
import { execFileSync } from 'node:child_process'

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export function randInt(a: number, b: number): number {
  return Math.floor(a + Math.random() * (b - a))
}

/**
 * 取可点元素视口坐标（先 scrollIntoView 再取 rect 中心）。
 * 候选集按规则数组依次尝试：字符串 = CSS 选择器；{ text } = 按可点元素
 * 文本包含匹配（大小写不敏感）。选项浮层里的 li/div 靠文本规则命中。
 */
export const PAY_CLICK_RECT_JS = `((rulesJson) => {
  const rules = JSON.parse(rulesJson)
  const clickables = [...document.querySelectorAll(
    'button, input[type="submit"], input[type="button"], a[href], [role="option"], [role="menuitem"], [role="combobox"], li, div[class*="Option" i]'
  )]
  const byText = (want) => {
    const w = String(want).toLowerCase()
    return clickables.find((b) => {
      const label = ((b.textContent || b.value || '') + '').trim().toLowerCase()
      return label.includes(w) && b.offsetParent !== null && label.length < 60
    })
  }
  for (const r of rules) {
    let el = null
    if (typeof r === 'string') {
      const cand = document.querySelector(r)
      if (cand && cand.offsetParent !== null) el = cand
    } else if (r && r.text) {
      el = byText(r.text)
    }
    if (el) {
      el.scrollIntoView({ block: 'center' })
      const rect = el.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) {
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
      }
    }
  }
  return null
})`

/**
 * 真人节奏逐字符填表（runner HUMAN_TYPE_JS 的 humanType 内核泛化版）。
 * fields: [{ key, rules, value }]，rules 同 PAY_CLICK_RECT_JS 的元素定位
 * 规则数组（一般用 CSS 选择器命中 input）。已有值的字段跳过不覆盖，
 * 逐字段返回结果供主进程判读。
 */
export const PAY_FILL_JS = `(async (payload) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const rand = (a, b) => Math.floor(a + Math.random() * (b - a))
  const vis = (el) => !!el && el.offsetParent !== null
  const findInput = (rules) => {
    for (const r of rules) {
      if (typeof r !== 'string') continue
      const el = document.querySelector(r)
      if (vis(el)) return el
    }
    return null
  }
  const humanType = async (el, text) => {
    el.focus()
    el.scrollIntoView({ block: 'center' })
    try { el.setSelectionRange(el.value.length, el.value.length) } catch (e) { /* 非 text input 忽略 */ }
    for (const ch of text) {
      document.execCommand('insertText', false, ch)
      await sleep(rand(80, 200))
    }
  }
  const results = []
  for (const f of payload.fields) {
    const el = findInput(f.rules)
    if (!el) {
      results.push({ key: f.key, ok: false, error: 'not-found' })
      continue
    }
    if ((el.value || '').trim().length > 0) {
      results.push({ key: f.key, ok: true, skipped: true })
      continue
    }
    await humanType(el, f.value)
    await sleep(rand(200, 600))
    results.push({ key: f.key, ok: !!el.value, value: el.value })
  }
  return results
})`

/**
 * 辅助功能权限探测（系统级真鼠标生效前提；首次调用探测后缓存）。
 * mac=System Events 需辅助功能授权；win=PowerShell 调 Win32 原生可用，仅探进程可执行。
 */
let realMouseOk: boolean | null = null

export function probeRealMouse(): boolean {
  if (realMouseOk !== null) return realMouseOk
  if (process.platform === 'win32') {
    try {
      execFileSync('powershell', ['-NoProfile', '-Command', 'Write-Output ok'], {
        timeout: 8000,
        stdio: 'ignore',
        windowsHide: true
      })
      realMouseOk = true
    } catch {
      realMouseOk = false
    }
  } else if (process.platform === 'darwin') {
    try {
      execFileSync(
        'osascript',
        ['-e', 'tell application "System Events" to get name of first process'],
        { timeout: 3000, stdio: 'ignore' }
      )
      realMouseOk = true
    } catch {
      realMouseOk = false
    }
  } else {
    realMouseOk = false
  }
  return realMouseOk
}

/**
 * 系统级真鼠标点击：不经过 Chromium 输入管线，浏览器侧与真人点击同源。
 *   mac  = System Events 屏幕坐标 AX click（需「辅助功能」授权；坐标为 points=DIP 直加）
 *   win  = PowerShell 调 user32 SetCursorPos+mouse_event（无需特权；坐标需 DIP×缩放比转物理像素）
 * 失败返回 false，调用方回退 sendInputEvent。
 */
export async function realMouseClick(
  win: BrowserWindow,
  pageX: number,
  pageY: number
): Promise<boolean> {
  if (!probeRealMouse()) return false
  try {
    const b = win.getContentBounds()
    if (process.platform === 'win32') {
      const sf = screen.getDisplayMatching(win.getBounds()).scaleFactor
      const gx = Math.round((b.x + pageX) * sf)
      const gy = Math.round((b.y + pageY) * sf)
      // mouse_event: LEFTDOWN=0x2, LEFTUP=0x4;间隔拟人按压节奏
      const ps = [
        "Add-Type -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool SetCursorPos(int x, int y); [DllImport(\"user32.dll\")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, System.UIntPtr e);' -Name M -Namespace W",
        `[W.M]::SetCursorPos(${gx}, ${gy})`,
        'Start-Sleep -Milliseconds 90',
        '[W.M]::mouse_event(2,0,0,0,0)',
        'Start-Sleep -Milliseconds 100',
        '[W.M]::mouse_event(4,0,0,0,0)'
      ].join('; ')
      execFileSync('powershell', ['-NoProfile', '-Command', ps], {
        timeout: 8000,
        stdio: 'ignore',
        windowsHide: true
      })
      return true
    }
    if (process.platform === 'darwin') {
      const gx = Math.round(b.x + pageX)
      const gy = Math.round(b.y + pageY)
      execFileSync(
        'osascript',
        ['-e', `tell application "System Events" to click at {${gx}, ${gy}}`],
        { timeout: 3000, stdio: 'ignore' }
      )
      return true
    }
    return false
  } catch {
    return false
  }
}

/**
 * 完整输入仿真点击：比 click 多一段鼠标移动历史——从窗口随机位置到目标
 * 的贝塞尔轨迹（15~24 个点）再按压。按压优先系统级真鼠标，不可用回退
 * sendInputEvent。
 */
export async function clickWithTrail(
  win: BrowserWindow,
  selectors: Array<string | { text: string }>
): Promise<boolean> {
  const size = win.getContentSize()
  const rect = (await win.webContents.executeJavaScript(
    `(${PAY_CLICK_RECT_JS})(${JSON.stringify(JSON.stringify(selectors))})`,
    true
  )) as { x: number; y: number } | null
  if (!rect) return false

  // 目标点（按钮内随机偏移，避免每次都点正中心）
  const tx = rect.x + (Math.random() * 10 - 5)
  const ty = rect.y + (Math.random() * 10 - 5)
  // 轨迹起点：窗口内随机位置（避开边缘）
  const sx = randInt(40, Math.max(60, size[0] - 40))
  const sy = randInt(40, Math.max(60, size[1] - 40))
  // 二次贝塞尔控制点：起终点中点附近大偏移，轨迹带弧度不走直线
  const cx = (sx + tx) / 2 + (Math.random() * 200 - 100)
  const cy = (sy + ty) / 2 + (Math.random() * 160 - 80)

  const steps = randInt(15, 24)
  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    // ease-out: 先快后慢（人移向目标时的减速）
    const e = 1 - (1 - t) * (1 - t)
    const px = Math.round((1 - e) * (1 - e) * sx + 2 * (1 - e) * e * cx + e * e * tx + (Math.random() * 2 - 1))
    const py = Math.round((1 - e) * (1 - e) * sy + 2 * (1 - e) * e * cy + e * e * ty + (Math.random() * 2 - 1))
    win.webContents.sendInputEvent({ type: 'mouseMove', x: px, y: py })
    await sleep(randInt(12, 38))
  }
  // 移到位后的小停顿，再按压（人的节奏）
  await sleep(randInt(90, 260))
  if (await realMouseClick(win, tx, ty)) return true
  win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(tx), y: Math.round(ty), button: 'left', clickCount: 1 })
  await sleep(randInt(70, 150))
  win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(tx), y: Math.round(ty), button: 'left', clickCount: 1 })
  return true
}
