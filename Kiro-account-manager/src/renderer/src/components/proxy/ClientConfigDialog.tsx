import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertCircle, Bot, Check, Code2, Cpu, FileCog, Loader2, Settings2, Terminal, X, Sparkles, Workflow, type LucideIcon } from 'lucide-react'
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Select } from '../ui'
import { useAccountsStore } from '../../store/accounts'
import { cn } from '@/lib/utils'

type ClientTarget = 'claudeCode' | 'opencode' | 'codex' | 'gemini' | 'hermes' | 'openclaw'

interface ModelInfo {
  id: string
  name: string
  description?: string
  inputTypes?: string[]
  maxInputTokens?: number | null
  maxOutputTokens?: number | null
}

interface ClientConfigDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  isEn: boolean
}

interface ClientOption {
  id: ClientTarget
  name: string
  description: string
  icon: LucideIcon
}

interface ConfigureResult {
  client: ClientTarget
  success: boolean
  paths: string[]
  backupPaths: string[]
  error?: string
}

const clientLabels: Record<ClientTarget, string> = {
  claudeCode: 'Claude Code',
  opencode: 'OpenCode',
  codex: 'Codex CLI',
  gemini: 'Gemini CLI',
  hermes: 'Hermes',
  openclaw: 'OpenClaw'
}

export function ClientConfigDialog({ open, onOpenChange, isEn }: ClientConfigDialogProps) {
  const accounts = useAccountsStore(state => state.accounts)
  const activeAccountId = useAccountsStore(state => state.activeAccountId)
  const [models, setModels] = useState<ModelInfo[]>([])
  const [selectedModelId, setSelectedModelId] = useState('')
  const [selectedClients, setSelectedClients] = useState<ClientTarget[]>(['claudeCode', 'opencode', 'codex', 'gemini', 'hermes', 'openclaw'])
  const [loadingModels, setLoadingModels] = useState(false)
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [results, setResults] = useState<ConfigureResult[]>([])
  const [proxyBase, setProxyBase] = useState('')

  const clientOptions: ClientOption[] = useMemo(() => [
    {
      id: 'claudeCode',
      name: 'Claude Code',
      description: isEn ? 'Writes ANTHROPIC_BASE_URL, API key and default model' : '写入 ANTHROPIC_BASE_URL、API Key 和默认模型',
      icon: Bot
    },
    {
      id: 'opencode',
      name: 'OpenCode',
      description: isEn ? 'Adds Kiro provider and model metadata to opencode.json' : '向 opencode.json 添加 Kiro provider 和模型元数据',
      icon: Code2
    },
    {
      id: 'codex',
      name: 'Codex CLI',
      description: isEn ? 'Adds Kiro OpenAI Responses provider' : '添加 Kiro OpenAI Responses provider',
      icon: Terminal
    },
    {
      id: 'gemini',
      name: 'Gemini CLI',
      description: isEn ? 'Writes .env and settings.json for Gemini v1beta' : '写入 .env 和 settings.json 配置 Gemini v1beta',
      icon: Sparkles
    },
    {
      id: 'hermes',
      name: 'Hermes',
      description: isEn ? 'Adds Kiro provider to config.yaml' : '向 config.yaml 添加 Kiro provider',
      icon: Workflow
    },
    {
      id: 'openclaw',
      name: 'OpenClaw',
      description: isEn ? 'Adds Kiro provider to openclaw.json' : '向 openclaw.json 添加 Kiro provider',
      icon: Settings2
    }
  ], [isEn])

  const selectedModel = models.find(model => model.id === selectedModelId)

  const loadModels = useCallback(async () => {
    setLoadingModels(true)
    setError(null)
    setResults([])
    try {
      // 优先从代理服务获取模型（与"查看模型"一致）
      const proxyModels = await window.api.proxyGetModels()
      if (proxyModels.success && proxyModels.models.length > 0) {
        setModels(proxyModels.models)
        setSelectedModelId(current => proxyModels.models.some(model => model.id === current) ? current : proxyModels.models[0].id)
        return
      }

      // 代理未启动或无模型时，回退到账号直连
      const activeAccount = activeAccountId ? accounts.get(activeAccountId) : undefined
      const account = activeAccount?.status === 'active' && activeAccount.credentials?.accessToken
        ? activeAccount
        : Array.from(accounts.values()).find(item => item.status === 'active' && item.credentials?.accessToken)
      if (account) {
        const accountModels = await window.api.accountGetModels(
          account.credentials.accessToken,
          account.credentials.region || 'us-east-1',
          account.profileArn,
          account.machineId,
          account.credentials.provider || account.idp,
          account.credentials.authMethod,
          account.id
        )
        if (accountModels.success && accountModels.models.length > 0) {
          setModels(accountModels.models)
          setSelectedModelId(current => accountModels.models.some(model => model.id === current) ? current : accountModels.models[0]?.id || '')
          return
        }
      }

      setModels([])
      setSelectedModelId('')
      setError(isEn ? 'No models were loaded. Please check whether the account is active and try reloading.' : '未加载到模型，请确认账号已激活后重新加载。')
    } catch (err) {
      setModels([])
      setSelectedModelId('')
      setError(err instanceof Error ? err.message : (isEn ? 'Failed to load models' : '加载模型失败'))
    } finally {
      setLoadingModels(false)
    }
  }, [accounts, activeAccountId, isEn])

  useEffect(() => {
    if (open) {
      loadModels()
    }
  }, [open, loadModels])

  if (!open) return null

  const toggleClient = (client: ClientTarget) => {
    setResults([])
    setSelectedClients(current => current.includes(client) ? current.filter(item => item !== client) : [...current, client])
  }

  const applyConfig = async () => {
    if (!selectedModelId) {
      setError(isEn ? 'Please select a model' : '请选择模型')
      return
    }
    if (selectedClients.length === 0) {
      setError(isEn ? 'Please select at least one client' : '请至少选择一个客户端')
      return
    }

    setApplying(true)
    setError(null)
    setResults([])
    try {
      const result = await window.api.proxyConfigureClients({
        clients: selectedClients,
        modelId: selectedModelId,
        modelName: selectedModel?.name,
        models: models.map(model => ({
          id: model.id,
          name: model.name,
          inputTypes: model.inputTypes,
          maxInputTokens: model.maxInputTokens,
          maxOutputTokens: model.maxOutputTokens
        }))
      })
      setProxyBase(result.openaiBaseUrl || result.proxyOrigin)
      setResults(result.results)
      if (!result.success) {
        setError(result.error || (isEn ? 'Some clients failed to configure' : '部分客户端配置失败'))
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : (isEn ? 'Failed to configure clients' : '配置客户端失败'))
    } finally {
      setApplying(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={() => onOpenChange(false)} />
      <Card className="relative w-[780px] max-h-[85vh] shadow-2xl border-0 overflow-hidden animate-in fade-in zoom-in-95 duration-200 glass-card-strong">
        <CardHeader className="pb-4 border-b sticky top-0 z-10">
          <div className="flex items-center justify-between">
            <CardTitle className="text-xl flex items-center gap-3">
              <div className="p-2 rounded-xl bg-primary/10">
                <Settings2 className="h-6 w-6 text-primary" />
              </div>
              <div>
                <span className="font-bold">{isEn ? 'One-Click Client Configuration' : '一键配置客户端'}</span>
                <div className="flex items-center gap-2 mt-1">
                  <Badge className="bg-primary/10 text-primary border-primary/20 font-semibold">
                    {selectedClients.length} {isEn ? 'selected' : '个已选择'}
                  </Badge>
                  {proxyBase && (
                    <Badge variant="secondary" className="text-xs border-0">
                      {proxyBase}
                    </Badge>
                  )}
                </div>
              </div>
            </CardTitle>
            <Button variant="ghost" size="icon" className="h-9 w-9 rounded-lg hover:bg-red-500 hover:text-white transition-colors" onClick={() => onOpenChange(false)}>
              <X className="h-5 w-5" />
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-4">
          <div className="max-h-[calc(85vh-140px)] overflow-y-auto pr-2 space-y-4">
            <div className="rounded-xl border bg-background p-4 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <Cpu className="h-4 w-4 text-primary" />
                  <span className="font-medium">{isEn ? 'Model' : '模型'}</span>
                </div>
                <Button variant="outline" size="sm" onClick={loadModels} disabled={loadingModels}>
                  {loadingModels ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileCog className="h-4 w-4" />}
                  {isEn ? 'Reload' : '重新加载'}
                </Button>
              </div>
              {loadingModels ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {isEn ? 'Loading models...' : '加载模型中...'}
                </div>
              ) : models.length > 0 ? (
                <div className="space-y-2">
                  <Select
                    value={selectedModelId}
                    options={models.map(model => ({
                      value: model.id,
                      label: model.id,
                      description: model.name && model.name !== model.id ? model.name : model.description
                    }))}
                    onChange={value => {
                      setSelectedModelId(value)
                      setResults([])
                    }}
                    placeholder={isEn ? 'Select model' : '选择模型'}
                  />
                  {selectedModel && (
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <Badge variant="secondary" className="border-0">{selectedModel.name || selectedModel.id}</Badge>
                      {selectedModel.inputTypes?.map(type => (
                        <Badge key={type} variant="secondary" className="border-0">{type}</Badge>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <div className="text-sm text-muted-foreground py-2">{isEn ? 'No models loaded' : '暂无模型'}</div>
              )}
            </div>

            <div className="grid grid-cols-3 gap-3">
              {clientOptions.map(option => {
                const Icon = option.icon
                const checked = selectedClients.includes(option.id)
                return (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => toggleClient(option.id)}
                    className={cn(
                      'text-left rounded-xl border p-4 transition-all hover:border-primary/50 hover:bg-primary/5',
                      checked ? 'border-primary/50 bg-primary/10 shadow-sm' : 'bg-background'
                    )}
                  >
                    <div className="flex items-start justify-between gap-2 mb-3">
                      <div className="p-2 rounded-lg bg-primary/10">
                        <Icon className="h-5 w-5 text-primary" />
                      </div>
                      <div className={cn('h-5 w-5 rounded-full border flex items-center justify-center', checked ? 'bg-primary border-primary text-primary-foreground' : 'border-muted-foreground/40')}>
                        {checked && <Check className="h-3.5 w-3.5" />}
                      </div>
                    </div>
                    <div className="font-semibold text-sm mb-1">{option.name}</div>
                    <div className="text-xs text-muted-foreground leading-relaxed">{option.description}</div>
                  </button>
                )
              })}
            </div>

            <div className="rounded-xl border border-warning/30 bg-warning/10 p-3 flex items-start gap-2 text-sm text-warning">
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
              <div>{isEn ? 'Existing client files are merged and backed up before writing.' : '写入时会合并原配置并先创建备份。'}</div>
            </div>

            {error && (
              <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-3 flex items-start gap-2 text-sm text-destructive">
                <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                <div>{error}</div>
              </div>
            )}

            {results.length > 0 && (
              <div className="space-y-2">
                {results.map(result => (
                  <div key={result.client} className={cn('rounded-xl border p-3 text-sm', result.success ? 'border-success/30 bg-success/10' : 'border-destructive/30 bg-destructive/10')}>
                    <div className="flex items-center justify-between gap-2 mb-2">
                      <span className="font-semibold">{clientLabels[result.client]}</span>
                      <Badge className={result.success ? 'bg-success/15 text-success border-success/20' : 'bg-destructive/15 text-destructive border-destructive/20'}>
                        {result.success ? (isEn ? 'Configured' : '已配置') : (isEn ? 'Failed' : '失败')}
                      </Badge>
                    </div>
                    {result.error ? (
                      <div className="text-xs text-destructive">{result.error}</div>
                    ) : (
                      <div className="space-y-1 text-xs text-muted-foreground">
                        {result.paths.map(path => <div key={path} className="font-mono break-all">{path}</div>)}
                        {result.backupPaths.length > 0 && <div>{isEn ? 'Backups created' : '已创建备份'}: {result.backupPaths.length}</div>}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={applying}>{isEn ? 'Close' : '关闭'}</Button>
              <Button onClick={applyConfig} disabled={loadingModels || applying || !selectedModelId || selectedClients.length === 0}>
                {applying ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                {applying ? (isEn ? 'Configuring...' : '配置中...') : (isEn ? 'Apply Configuration' : '应用配置')}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}


