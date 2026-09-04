import { useState, useEffect } from 'react'
import { Card, CardContent, CardHeader, CardTitle, Button, Progress } from '../ui'
import { Github, Heart, Code, ExternalLink, User, Coffee, MessageCircle, X, RefreshCw, Download, CheckCircle, AlertCircle, Info, Zap, Loader2, Rocket } from 'lucide-react'
import kiroLogo from '@/assets/kiro-high-resolution-logo-transparent.png'
import alipayQR from '@/assets/支付宝支付.png'
import wechatQR from '@/assets/微信支付.png'
import groupQR from '@/assets/交流群.png'
import authorAvatar from '@/assets/author-avatar.png'
import { useAccountsStore } from '@/store/accounts'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/hooks/useTranslation'

interface UpdateInfo {
  hasUpdate: boolean
  currentVersion?: string
  latestVersion?: string
  releaseNotes?: string
  releaseName?: string
  releaseUrl?: string
  publishedAt?: string
  assets?: Array<{
    name: string
    downloadUrl: string
    size: number
  }>
  error?: string
}

export function AboutPage() {
  const [version, setVersion] = useState('...')
  const [showGroupQR, setShowGroupQR] = useState(false)
  const [isCheckingUpdate, setIsCheckingUpdate] = useState(false)
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null)
  const [showUpdateModal, setShowUpdateModal] = useState(false)
  // 在线更新（应用内下载并替换，mac 走自研更新器绕开签名校验）
  const [onlineStatus, setOnlineStatus] = useState<'idle' | 'downloading' | 'downloaded' | 'error'>('idle')
  const [dlPercent, setDlPercent] = useState(0)
  const [dlText, setDlText] = useState('')
  const [onlineError, setOnlineError] = useState<string | null>(null)
  const { darkMode } = useAccountsStore()
  const { t } = useTranslation()
  const isEn = t('common.unknown') === 'Unknown'

  useEffect(() => {
    window.api.getAppVersion().then(setVersion)
    // 不自动检查更新，避免 GitHub API 速率限制
    // 用户可以手动点击"检查更新"按钮
  }, [])

  // 订阅在线更新进度/完成/错误事件（下载期间弹窗保持打开）
  useEffect(() => {
    const unsubProgress = window.api.onUpdateDownloadProgress((p) => {
      setDlPercent(p.percent)
      setDlText(`${formatFileSize(p.transferred)} / ${formatFileSize(p.total)}`)
      setOnlineStatus('downloading')
    })
    const unsubDownloaded = window.api.onUpdateDownloaded(() => {
      setOnlineStatus('downloaded')
    })
    const unsubError = window.api.onUpdateError((err) => {
      setOnlineError(err)
      setOnlineStatus('error')
    })
    return () => {
      unsubProgress()
      unsubDownloaded()
      unsubError()
    }
  }, [])

  // 开始在线更新：先经主进程建立待更新目标，再下载（进度走事件）
  const startOnlineUpdate = async (): Promise<void> => {
    setOnlineError(null)
    setOnlineStatus('downloading')
    setDlPercent(0)
    setDlText('')
    const check = await window.api.checkForUpdates()
    if (!check.hasUpdate) {
      setOnlineError(check.error || (isEn ? 'No update pending' : '没有待安装的更新'))
      setOnlineStatus('error')
      return
    }
    const r = await window.api.downloadUpdate()
    if (!r.success) {
      setOnlineError(r.error || 'download failed')
      setOnlineStatus('error')
    }
  }

  const checkForUpdates = async (showModal = true) => {
    setIsCheckingUpdate(true)
    try {
      const result = await window.api.checkForUpdatesManual()
      setUpdateInfo(result)
      // 重置在线更新流程状态（新一轮检查从 idle 开始）
      setOnlineStatus('idle')
      setOnlineError(null)
      setDlPercent(0)
      if (showModal || result.hasUpdate) {
        setShowUpdateModal(true)
      }
    } catch (error) {
      console.error('Check update failed:', error)
    } finally {
      setIsCheckingUpdate(false)
    }
  }

  const openReleasePage = () => {
    if (updateInfo?.releaseUrl) {
      window.api.openExternal(updateInfo.releaseUrl)
    }
  }

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return bytes + ' B'
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
  }

  return (
    <div className="flex-1 p-6 space-y-6 overflow-auto">
      {/* Header */}
      <div className="page-hero p-8">
        <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-br from-primary/20 to-transparent rounded-full blur-2xl" />
        <div className="absolute bottom-0 left-0 w-24 h-24 bg-gradient-to-tr from-primary/20 to-transparent rounded-full blur-2xl" />
        <div className="relative text-center space-y-4">
          <img 
            src={kiroLogo} 
            alt="Kiro" 
            className={cn("h-20 w-auto mx-auto transition-all", darkMode && "invert brightness-0")} 
          />
          <div>
            <h1 className="text-2xl font-bold text-primary">{isEn ? 'Kiro Account Manager' : 'Kiro 账户管理器'}</h1>
            <p className="text-muted-foreground">{isEn ? `Version ${version}` : `版本 ${version}`}</p>
          </div>
        <div className="flex gap-2 justify-center flex-wrap">
          <Button
            variant="outline"
            size="sm"
            className="gap-2"
            onClick={() => checkForUpdates(true)}
            disabled={isCheckingUpdate}
          >
            <RefreshCw className={cn("h-4 w-4", isCheckingUpdate && "animate-spin")} />
            {isCheckingUpdate ? (isEn ? 'Checking...' : '检查中...') : (isEn ? 'Check Updates' : '检查更新')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="gap-2"
            onClick={() => setShowGroupQR(true)}
          >
            <MessageCircle className="h-4 w-4" />
            {isEn ? 'Join Group' : '加入交流群'}
          </Button>
        </div>
        
        {/* 更新提示 */}
        {updateInfo?.hasUpdate && !showUpdateModal && (
          <div 
            className="inline-flex items-center gap-2 px-3 py-1.5 bg-primary/10 text-primary rounded-full text-sm cursor-pointer hover:bg-primary/20"
            onClick={() => setShowUpdateModal(true)}
          >
            <Download className="h-4 w-4" />
            {isEn ? `New version v${updateInfo.latestVersion}` : `发现新版本 v${updateInfo.latestVersion}`}
          </div>
        )}
        </div>
      </div>

      {/* 更新弹窗 */}
      {showUpdateModal && updateInfo && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/50" onClick={() => { if (onlineStatus !== 'downloading') setShowUpdateModal(false) }} />
          <div className="relative bg-card rounded-xl p-6 shadow-xl z-10 max-w-md w-full mx-4 max-h-[80vh] overflow-y-auto">
            <button
              className="absolute top-3 right-3 text-muted-foreground hover:text-foreground disabled:opacity-40"
              disabled={onlineStatus === 'downloading'}
              onClick={() => setShowUpdateModal(false)}
            >
              <X className="h-5 w-5" />
            </button>
            
            <div className="space-y-4">
              {updateInfo.hasUpdate ? (
                <>
                  <div className="flex items-center gap-3">
                    <div className="p-2 rounded-full bg-success/10">
                      <Download className="h-6 w-6 text-success" />
                    </div>
                    <div>
                      <h3 className="font-semibold text-lg">{isEn ? 'New Version Available' : '发现新版本'}</h3>
                      <p className="text-sm text-muted-foreground">
                        {updateInfo.currentVersion} → {updateInfo.latestVersion}
                      </p>
                    </div>
                  </div>
                  
                  <div className="bg-muted/50 rounded-lg p-3">
                    <p className="text-sm font-medium mb-2">{updateInfo.releaseName}</p>
                    {updateInfo.publishedAt && (
                      <p className="text-xs text-muted-foreground">
                        {isEn ? `Released: ${new Date(updateInfo.publishedAt).toLocaleDateString('en-US')}` : `发布时间: ${new Date(updateInfo.publishedAt).toLocaleDateString('zh-CN')}`}
                      </p>
                    )}
                  </div>
                  
                  {updateInfo.releaseNotes && (
                    <div className="space-y-2">
                      <p className="text-sm font-medium">{isEn ? 'Release Notes:' : '更新内容:'}</p>
                      <div className="text-sm text-muted-foreground bg-muted/30 rounded-lg p-3 max-h-32 overflow-y-auto whitespace-pre-wrap">
                        {updateInfo.releaseNotes}
                      </div>
                    </div>
                  )}
                  
                  {updateInfo.assets && updateInfo.assets.length > 0 && (
                    <div className="space-y-2">
                      <p className="text-sm font-medium">{isEn ? 'Download Files:' : '下载文件:'}</p>
                      <div className="space-y-1 max-h-32 overflow-y-auto">
                        {updateInfo.assets.slice(0, 6).map((asset, i) => (
                          <div key={i} className="flex items-center justify-between text-xs bg-muted/30 rounded px-2 py-1">
                            <span className="truncate flex-1">{asset.name}</span>
                            <span className="text-muted-foreground ml-2">{formatFileSize(asset.size)}</span>
                          </div>
                        ))}
                        {updateInfo.assets.length > 6 && (
                          <p className="text-xs text-muted-foreground text-center">
                            {isEn ? `${updateInfo.assets.length - 6} more files...` : `还有 ${updateInfo.assets.length - 6} 个文件...`}
                          </p>
                        )}
                      </div>
                    </div>
                  )}
                  
                  {/* 在线更新（推荐）：应用内下载 → 校验 → 替换 → 重启 */}
                  {onlineStatus === 'idle' && (
                    <Button className="w-full gap-2" onClick={startOnlineUpdate}>
                      <Rocket className="h-4 w-4" />
                      {isEn ? 'Update in App (Recommended)' : '在线更新（推荐）'}
                    </Button>
                  )}
                  {onlineStatus === 'downloading' && (
                    <div className="space-y-2">
                      <Progress value={dlPercent} className="h-2" />
                      <p className="text-xs text-muted-foreground text-center tabular-nums">
                        {dlPercent.toFixed(0)}% · {dlText}
                      </p>
                    </div>
                  )}
                  {onlineStatus === 'downloaded' && (
                    <Button className="w-full gap-2" onClick={() => window.api.installUpdate()}>
                      <Rocket className="h-4 w-4" />
                      {isEn ? 'Restart to Finish' : '重启完成安装'}
                    </Button>
                  )}
                  {onlineStatus === 'error' && (
                    <div className="space-y-2">
                      <p className="text-xs text-red-500 break-all">{onlineError}</p>
                      <Button variant="outline" className="w-full gap-2" onClick={startOnlineUpdate}>
                        <Loader2 className="h-4 w-4" />
                        {isEn ? 'Retry' : '重试'}
                      </Button>
                    </div>
                  )}

                  <Button variant="outline" className="w-full gap-2" onClick={openReleasePage} disabled={onlineStatus === 'downloading'}>
                    <ExternalLink className="h-4 w-4" />
                    {isEn ? 'Manual Download (dmg)' : '手动下载（dmg）'}
                  </Button>
                </>
              ) : updateInfo.error ? (
                <>
                  <div className="flex items-center gap-3">
                    <div className="p-2 rounded-full bg-red-500/10">
                      <AlertCircle className="h-6 w-6 text-red-500" />
                    </div>
                    <div>
                      <h3 className="font-semibold text-lg">{isEn ? 'Check Failed' : '检查更新失败'}</h3>
                      <p className="text-sm text-muted-foreground">{updateInfo.error}</p>
                    </div>
                  </div>
                  <Button variant="outline" className="w-full" onClick={() => checkForUpdates(true)}>
                    {isEn ? 'Retry' : '重试'}
                  </Button>
                </>
              ) : (
                <>
                  <div className="flex items-center gap-3">
                    <div className="p-2 rounded-full bg-success/10">
                      <CheckCircle className="h-6 w-6 text-success" />
                    </div>
                    <div>
                      <h3 className="font-semibold text-lg">{isEn ? 'Up to Date' : '已是最新版本'}</h3>
                      <p className="text-sm text-muted-foreground">
                        {isEn ? `Version v${updateInfo.currentVersion} is the latest` : `当前版本 v${updateInfo.currentVersion} 已经是最新的了`}
                      </p>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 交流群弹窗 */}
      {showGroupQR && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/50" onClick={() => setShowGroupQR(false)} />
          <div className="relative bg-card rounded-xl p-6 shadow-xl z-10">
            <button
              className="absolute top-3 right-3 text-muted-foreground hover:text-foreground"
              onClick={() => setShowGroupQR(false)}
            >
              <X className="h-5 w-5" />
            </button>
            <div className="text-center space-y-3">
              <h3 className="font-semibold text-lg">{isEn ? 'Join Group' : '扫码加入交流群'}</h3>
              <div className="bg-[#07C160]/5 rounded-xl p-3 border border-[#07C160]/20">
                <img src={groupQR} alt="Group" className="w-48 h-48 object-contain" />
              </div>
              <p className="text-sm text-muted-foreground">{isEn ? 'Scan with WeChat' : 'QQ 扫码加入'}</p>
            </div>
          </div>
        </div>
      )}

      {/* Description */}
      <Card className="hover-lift">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-3">
            <div className="p-2 rounded-lg bg-primary/10">
              <Info className="h-4 w-4 text-primary" />
            </div>
            {isEn ? 'About' : '关于本应用'}
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground space-y-3">
          <p>
            {isEn 
              ? 'Kiro Account Manager is a powerful multi-account management tool for Kiro IDE. It supports quick account switching, auto token refresh, group/tag management, and machine ID management.'
              : 'Kiro 账户管理器是一个功能强大的 Kiro IDE 多账号管理工具。支持多账号快速切换、自动 Token 刷新、分组标签管理、机器码管理等功能，帮助你高效管理和使用多个 Kiro 账号。'}
          </p>
          <p>
            {isEn 
              ? 'Built with Electron + React + TypeScript, supporting Windows, macOS and Linux. All data is stored locally to protect your privacy.'
              : '本应用使用 Electron + React + TypeScript 开发，支持 Windows、macOS 和 Linux 平台。所有数据均存储在本地，保护你的隐私安全。'}
          </p>
        </CardContent>
      </Card>

      {/* Features */}
      <Card className="hover-lift">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-3">
            <div className="p-2 rounded-lg bg-primary/10">
              <Zap className="h-4 w-4 text-primary" />
            </div>
            {isEn ? 'Features' : '主要功能'}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2 text-sm text-muted-foreground">
            <li className="flex items-start gap-2">
              <span className="text-primary mt-0.5">✓</span>
              <strong>{isEn ? 'Multi-Account' : '多账号管理'}</strong>{isEn ? ': Add, edit, delete multiple accounts' : '：支持添加、编辑、删除多个 Kiro 账号'}
            </li>
            <li className="flex items-start gap-2">
              <span className="text-primary mt-0.5">✓</span>
              <strong>{isEn ? 'One-Click Switch' : '一键切换'}</strong>{isEn ? ': Quick account switching' : '：快速切换当前使用的账号'}
            </li>
            <li className="flex items-start gap-2">
              <span className="text-primary mt-0.5">✓</span>
              <strong>{isEn ? 'Auto Refresh' : '自动刷新'}</strong>{isEn ? ': Auto refresh tokens before expiry' : '：Token 过期前自动刷新，保持登录状态'}
            </li>
            <li className="flex items-start gap-2">
              <span className="text-primary mt-0.5">✓</span>
              <strong>{isEn ? 'Groups & Tags' : '分组与标签'}</strong>{isEn ? ': Batch set groups/tags' : '：多选账户批量设置分组/标签，支持多标签'}
            </li>
            <li className="flex items-start gap-2">
              <span className="text-primary mt-0.5">✓</span>
              <strong>{isEn ? 'Privacy Mode' : '隐私模式'}</strong>{isEn ? ': Hide sensitive info' : '：隐藏邮箱和账号敏感信息'}
            </li>
            <li className="flex items-start gap-2">
              <span className="text-primary mt-0.5">✓</span>
              <strong>{isEn ? 'Batch Import' : '批量导入'}</strong>{isEn ? ': SSO Token & OIDC batch import' : '：支持 SSO Token 和 OIDC 凭证批量导入'}
            </li>
            <li className="flex items-start gap-2">
              <span className="text-primary mt-0.5">✓</span>
              <strong>{isEn ? 'Machine ID' : '机器码管理'}</strong>{isEn ? ': Modify device identifier' : '：修改设备标识符，防止账号关联封禁'}
            </li>
            <li className="flex items-start gap-2">
              <span className="text-primary mt-0.5">✓</span>
              <strong>{isEn ? 'Auto Switch ID' : '自动换机器码'}</strong>{isEn ? ': Auto change ID on switch' : '：切换账号时自动更换机器码'}
            </li>
            <li className="flex items-start gap-2">
              <span className="text-primary mt-0.5">✓</span>
              <strong>{isEn ? 'ID Binding' : '账户机器码绑定'}</strong>{isEn ? ': Unique ID per account' : '：为每个账户分配唯一机器码'}
            </li>
            <li className="flex items-start gap-2">
              <span className="text-primary mt-0.5">✓</span>
              <strong>{isEn ? 'Auto Switch' : '自动换号'}</strong>{isEn ? ': Switch when balance low' : '：余额不足时自动切换可用账号'}
            </li>
            <li className="flex items-start gap-2">
              <span className="text-primary mt-0.5">✓</span>
              <strong>{isEn ? 'Proxy Support' : '代理支持'}</strong>{isEn ? ': HTTP/HTTPS/SOCKS5' : '：支持 HTTP/HTTPS/SOCKS5 代理'}
            </li>
            <li className="flex items-start gap-2">
              <span className="text-primary mt-0.5">✓</span>
              <strong>{isEn ? 'Themes' : '主题定制'}</strong>{isEn ? ': 32 colors, dark/light mode' : '：32 种主题颜色，深色/浅色模式'}
            </li>
          </ul>
        </CardContent>
      </Card>

      {/* Tech Stack */}
      <Card className="hover-lift">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-3">
            <div className="p-2 rounded-lg bg-primary/10">
              <Code className="h-4 w-4 text-primary" />
            </div>
            {isEn ? 'Tech Stack' : '技术栈'}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            {['Electron', 'React', 'TypeScript', 'Tailwind CSS', 'Zustand', 'Vite'].map((tech) => (
              <span 
                key={tech}
                className="px-2.5 py-1 text-xs bg-muted rounded-full text-muted-foreground"
              >
                {tech}
              </span>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Author */}
      <Card className="hover-lift">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-3">
            <div className="p-2 rounded-lg bg-primary/10">
              <User className="h-4 w-4 text-primary" />
            </div>
            {isEn ? 'Author' : '作者'}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <img 
                src={authorAvatar}
                alt="chaogei666"
                className="w-10 h-10 rounded-full"
              />
              <p className="font-medium">chaogei666</p>
            </div>
            <a 
              href="https://github.com/chaogei/Kiro-account-manager" 
              target="_blank" 
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors px-3 py-1.5 rounded-lg hover:bg-muted"
            >
              <Github className="h-4 w-4" />
              GitHub
              <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        </CardContent>
      </Card>

      {/* Sponsor */}
      <Card className="hover-lift">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-3">
            <div className="p-2 rounded-lg bg-primary/10">
              <Coffee className="h-4 w-4 text-primary" />
            </div>
            {isEn ? 'Sponsor' : '赞助支持'}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground mb-4">
            {isEn ? 'If this project helps you, buy me a coffee ☕' : '如果这个项目对你有帮助，可以请作者喝杯咖啡 ☕'}
          </p>
          <div className="grid grid-cols-2 gap-4">
            <div className="text-center space-y-2">
              <div className="bg-[#1677FF]/5 rounded-xl p-3 border border-[#1677FF]/20">
                <img src={alipayQR} alt="Alipay" className="w-full aspect-square object-contain rounded-lg" />
              </div>
              <p className="text-sm font-medium text-[#1677FF]">{isEn ? 'Alipay' : '支付宝'}</p>
            </div>
            <div className="text-center space-y-2">
              <div className="bg-[#07C160]/5 rounded-xl p-3 border border-[#07C160]/20">
                <img src={wechatQR} alt="WeChat Pay" className="w-full aspect-square object-contain rounded-lg" />
              </div>
              <p className="text-sm font-medium text-[#07C160]">{isEn ? 'WeChat Pay' : '微信支付'}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Footer */}
      <div className="text-center text-xs text-muted-foreground py-4">
        <p className="flex items-center justify-center gap-1">
          Made with <Heart className="h-3 w-3 text-primary" /> for Kiro users
        </p>
      </div>
    </div>
  )
}
