import { ProxyPanel } from '../proxy'
import { useTranslation } from '@/hooks/useTranslation'
import { Server } from 'lucide-react'

export function ProxyPage() {
  const { t } = useTranslation()
  const isEn = t('common.unknown') === 'Unknown'

  return (
    <div className="flex-1 p-6 space-y-6 overflow-auto">
      {/* 页面标题 - 与设置页面样式一致 */}
      <div className="page-hero p-6">
        <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-br from-primary/20 to-transparent rounded-full blur-2xl" />
        <div className="absolute bottom-0 left-0 w-24 h-24 bg-gradient-to-tr from-primary/20 to-transparent rounded-full blur-2xl" />
        <div className="relative flex items-center gap-4">
          <div className="p-3 rounded-xl bg-primary shadow-lg shadow-primary/25">
            <Server className="h-6 w-6 text-primary-foreground" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-primary">{isEn ? 'API Proxy Service' : 'API 反代服务'}</h1>
            <p className="text-muted-foreground">
              {isEn 
                ? 'Provide OpenAI and Claude compatible API endpoints with multi-account rotation'
                : '提供 OpenAI 和 Claude 兼容的 API 端点，支持多账号轮询'
              }
            </p>
          </div>
        </div>
      </div>
      <ProxyPanel />
    </div>
  )
}
