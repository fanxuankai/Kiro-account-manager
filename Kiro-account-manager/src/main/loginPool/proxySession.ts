// 号池出口代理的 session 注入（静态代理池模式专用）
//
// 与注册页（RegisterPage.tsx）的实现保持镜像：为代理 URL 注入「每号唯一 session」，
// 让同一个号整个登录流程走同一出口 IP、号池里不同号（不同窗口）用不同 IP——
// 参数化代理（bestproxy 等）即使池里只有一条 URL，也能靠 session 区分出逐号不同的出口。
// 改这里时同步检查注册页那份。

/** 随机 session 值（字母数字），用于代理「会话粘性」——同值保持同一出口 IP */
function randomSession(len = 8): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  let s = ''
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)]
  return s
}

/**
 * 为代理 URL 注入「每号唯一 session」：
 * 1) url 含 {session} 占位符 → 替换为随机值（通用，适配任意服务商）；
 * 2) 参数化用户名（bestproxy 等，含 _area-/_life-/_city-/_state- 等）且未写 _session- → 自动补一个；
 * 其余情况（普通代理、已写 session）原样返回，不干扰。
 */
export function injectProxySession(url: string): string {
  if (!url) return url
  const session = randomSession()
  if (url.includes('{session}')) {
    return url.replace(/\{session\}/g, session)
  }
  const m = url.match(/^(\w+:\/\/)([^@/]+)@(.+)$/)
  if (m) {
    const [, scheme, userinfo, hostpart] = m
    const ci = userinfo.indexOf(':')
    const username = ci >= 0 ? userinfo.slice(0, ci) : userinfo
    const password = ci >= 0 ? userinfo.slice(ci + 1) : ''
    const isParamStyle = /_(area|life|city|state|session|region|country)-/i.test(username)
    if (isParamStyle && !/_session-/i.test(username)) {
      const newUser = `${username}_session-${session}`
      return `${scheme}${newUser}${ci >= 0 ? ':' + password : ''}@${hostpart}`
    }
  }
  return url
}
