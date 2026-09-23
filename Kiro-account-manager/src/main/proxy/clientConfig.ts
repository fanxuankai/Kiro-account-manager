import { constants, existsSync } from 'fs'
import { access, copyFile, mkdir, readFile, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { homedir } from 'os'

export type ProxyClientTarget = 'claudeCode' | 'opencode' | 'codex' | 'gemini' | 'hermes' | 'openclaw'
type OpenCodeInputModality = 'text' | 'image' | 'pdf'

export interface ProxyClientModel {
  id: string
  name?: string
  inputTypes?: string[]
  maxInputTokens?: number | null
  maxOutputTokens?: number | null
}

export interface ConfigureProxyClientsInput {
  clients: ProxyClientTarget[]
  host: string
  port: number
  tlsEnabled?: boolean
  apiKey?: string
  modelId: string
  modelName?: string
  models?: ProxyClientModel[]
}

export interface ProxyClientConfigResult {
  client: ProxyClientTarget
  success: boolean
  paths: string[]
  backupPaths: string[]
  error?: string
}

interface ProxyClientContext {
  proxyOrigin: string
  openaiBaseUrl: string
  apiKey: string
  modelId: string
  models: ProxyClientModel[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseJsonObject(content: string, path: string): Record<string, unknown> {
  const parsed = JSON.parse(path.endsWith('.jsonc') ? stripJsonc(content) : content)
  if (!isRecord(parsed)) {
    throw new Error(`${path} root must be a JSON object`)
  }
  return parsed
}

function stripJsonc(content: string): string {
  let output = ''
  let inString = false
  let quote = ''
  let escaped = false

  for (let index = 0; index < content.length; index++) {
    const current = content[index]
    const next = content[index + 1]

    if (inString) {
      output += current
      if (escaped) {
        escaped = false
        continue
      }
      if (current === '\\') {
        escaped = true
        continue
      }
      if (current === quote) {
        inString = false
        quote = ''
      }
      continue
    }

    if (current === '"' || current === "'") {
      inString = true
      quote = current
      output += current
      continue
    }

    if (current === '/' && next === '/') {
      while (index < content.length && content[index] !== '\n') index++
      output += '\n'
      continue
    }

    if (current === '/' && next === '*') {
      index += 2
      while (index < content.length && !(content[index] === '*' && content[index + 1] === '/')) index++
      index++
      continue
    }

    output += current
  }

  return removeTrailingJsonCommas(output)
}

function removeTrailingJsonCommas(content: string): string {
  let output = ''
  let inString = false
  let escaped = false

  for (let index = 0; index < content.length; index++) {
    const current = content[index]

    if (inString) {
      output += current
      if (escaped) {
        escaped = false
        continue
      }
      if (current === '\\') {
        escaped = true
        continue
      }
      if (current === '"') inString = false
      continue
    }

    if (current === '"') {
      inString = true
      output += current
      continue
    }

    if (current === ',') {
      let nextIndex = index + 1
      while (/\s/.test(content[nextIndex] || '')) nextIndex++
      if (content[nextIndex] === '}' || content[nextIndex] === ']') continue
    }

    output += current
  }

  return output
}

function escapeTomlString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function outputLimit(model: ProxyClientModel): number {
  if (typeof model.maxOutputTokens === 'number' && model.maxOutputTokens > 0) return model.maxOutputTokens
  if (model.id.toLowerCase().includes('haiku')) return 8192
  return 32000
}

function contextLimit(model: ProxyClientModel): number {
  if (typeof model.maxInputTokens === 'number' && model.maxInputTokens > 0) return model.maxInputTokens
  return 200000
}

function inputModalities(model: ProxyClientModel): OpenCodeInputModality[] {
  const values = new Set<OpenCodeInputModality>(['text'])
  for (const item of model.inputTypes ?? []) {
    const lower = item.toLowerCase()
    if (lower.includes('image')) values.add('image')
    if (lower.includes('pdf') || lower.includes('document') || lower.includes('file')) values.add('pdf')
  }
  return Array.from(values)
}

function buildProxyOrigin(input: ConfigureProxyClientsInput): string {
  const host = input.host === '0.0.0.0' ? '127.0.0.1' : input.host === '::' ? '::1' : input.host
  const urlHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  return `${input.tlsEnabled ? 'https' : 'http'}://${urlHost}:${input.port}`
}

async function exists(path: string): Promise<boolean> {
  return access(path, constants.F_OK).then(() => true, () => false)
}

async function backupIfExists(path: string): Promise<string[]> {
  if (!(await exists(path))) return []
  const backupPath = `${path}.kiro-backup-${Date.now()}`
  await copyFile(path, backupPath)
  return [backupPath]
}

async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  if (!(await exists(path))) return {}
  return parseJsonObject(await readFile(path, 'utf-8'), path)
}

async function writeJsonObject(path: string, value: Record<string, unknown>): Promise<string[]> {
  await mkdir(dirname(path), { recursive: true })
  const backupPaths = await backupIfExists(path)
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8')
  return backupPaths
}

async function writeText(path: string, value: string): Promise<string[]> {
  await mkdir(dirname(path), { recursive: true })
  const backupPaths = await backupIfExists(path)
  await writeFile(path, value.endsWith('\n') ? value : `${value}\n`, 'utf-8')
  return backupPaths
}

function getClaudeSettingsPath(): string {
  const settingsPath = join(homedir(), '.claude', 'settings.json')
  const legacyPath = join(homedir(), '.claude', 'claude.json')
  return existsSync(settingsPath) || !existsSync(legacyPath) ? settingsPath : legacyPath
}

function getOpenCodeConfigPath(): string {
  const dir = join(homedir(), '.config', 'opencode')
  const candidates = [join(dir, 'opencode.jsonc'), join(dir, 'opencode.json'), join(dir, 'config.json')]
  return candidates.find(path => existsSync(path)) || candidates[1]
}

function getCodexAuthPath(): string {
  return join(homedir(), '.codex', 'auth.json')
}

function getCodexConfigPath(): string {
  return join(homedir(), '.codex', 'config.toml')
}

function ensureObjectField(target: Record<string, unknown>, key: string): Record<string, unknown> {
  if (!isRecord(target[key])) target[key] = {}
  return target[key] as Record<string, unknown>
}

async function configureClaudeCode(context: ProxyClientContext): Promise<Omit<ProxyClientConfigResult, 'client' | 'success' | 'error'>> {
  const path = getClaudeSettingsPath()
  const config = await readJsonObject(path)
  const env = ensureObjectField(config, 'env')
  env.ANTHROPIC_BASE_URL = context.proxyOrigin
  env.ANTHROPIC_AUTH_TOKEN = context.apiKey
  env.ANTHROPIC_API_KEY = context.apiKey
  env.ANTHROPIC_MODEL = context.modelId
  // 默认模型映射：让 Claude Code 的 haiku/opus/sonnet 快捷调用都走代理支持的模型
  const haikuModel = context.models.find(m => m.id.toLowerCase().includes('haiku'))?.id || 'claude-haiku-4.5'
  const opusModel = context.models.find(m => m.id.toLowerCase().includes('opus'))?.id || context.modelId
  env.ANTHROPIC_DEFAULT_HAIKU_MODEL = haikuModel
  env.ANTHROPIC_DEFAULT_OPUS_MODEL = opusModel
  env.ANTHROPIC_DEFAULT_SONNET_MODEL = context.modelId
  return { paths: [path], backupPaths: await writeJsonObject(path, config) }
}

function openCodeModelConfig(model: ProxyClientModel): Record<string, unknown> {
  const modalities = inputModalities(model)
  // opencode 1.15+ 使用 Effect Schema 严格校验：
  //   limit.context / limit.output 必须是有限数字（Schema.Finite，不接受 null/Infinity）
  //   modalities.input/output 必须是 "text"|"audio"|"image"|"video"|"pdf" 枚举
  const ctx = contextLimit(model)
  const out = outputLimit(model)
  return {
    name: model.name || model.id,
    attachment: modalities.some(item => item !== 'text'),
    reasoning: true,
    temperature: true,
    tool_call: true,
    limit: {
      context: Number.isFinite(ctx) ? ctx : 200000,
      output: Number.isFinite(out) ? out : 16384
    },
    modalities: {
      input: modalities,
      output: ['text']
    }
  }
}

async function configureOpenCode(context: ProxyClientContext): Promise<Omit<ProxyClientConfigResult, 'client' | 'success' | 'error'>> {
  const path = getOpenCodeConfigPath()
  const config = await readJsonObject(path)
  const provider = ensureObjectField(config, 'provider')
  provider.kiro = {
    npm: '@ai-sdk/openai-compatible',
    name: 'Kiro Proxy',
    options: {
      baseURL: context.openaiBaseUrl,
      apiKey: context.apiKey
    },
    models: Object.fromEntries(context.models.map(model => [model.id, openCodeModelConfig(model)]))
  }
  config.$schema = typeof config.$schema === 'string' ? config.$schema : 'https://opencode.ai/config.json'
  config.model = `kiro/${context.modelId}`
  if (typeof config.small_model !== 'string' || config.small_model.startsWith('kiro/')) {
    config.small_model = `kiro/${context.modelId}`
  }
  if (Array.isArray(config.enabled_providers) && !config.enabled_providers.includes('kiro')) {
    config.enabled_providers = [...config.enabled_providers, 'kiro']
  }
  return { paths: [path], backupPaths: await writeJsonObject(path, config) }
}

function upsertRootTomlString(content: string, key: string, value: string): string {
  const newline = content.includes('\r\n') ? '\r\n' : '\n'
  const lines = content.length === 0 ? [] : content.split(/\r?\n/)
  const sectionIndex = lines.findIndex(line => /^\s*\[/.test(line))
  const rootEnd = sectionIndex === -1 ? lines.length : sectionIndex
  const nextLines: string[] = []
  let written = false

  for (let index = 0; index < lines.length; index++) {
    if (index < rootEnd && new RegExp(`^\\s*${key}\\s*=`).test(lines[index])) {
      if (!written) {
        nextLines.push(`${key} = "${escapeTomlString(value)}"`)
        written = true
      }
      continue
    }
    if (!written && index === rootEnd) {
      nextLines.push(`${key} = "${escapeTomlString(value)}"`)
      written = true
    }
    nextLines.push(lines[index])
  }

  if (!written) nextLines.push(`${key} = "${escapeTomlString(value)}"`)
  return nextLines.join(newline)
}

function removeTomlSection(content: string, section: string): string {
  const newline = content.includes('\r\n') ? '\r\n' : '\n'
  const lines = content.length === 0 ? [] : content.split(/\r?\n/)
  const nextLines: string[] = []
  let skipping = false
  const escapedSection = section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

  for (const line of lines) {
    if (new RegExp(`^\\s*\\[${escapedSection}\\]\\s*$`).test(line)) {
      skipping = true
      continue
    }
    if (skipping && /^\s*\[/.test(line)) skipping = false
    if (!skipping) nextLines.push(line)
  }

  return nextLines.join(newline).trimEnd()
}

function upsertCodexConfig(content: string, context: ProxyClientContext): string {
  const newline = content.includes('\r\n') ? '\r\n' : '\n'
  const withProvider = upsertRootTomlString(upsertRootTomlString(content, 'model_provider', 'kiro'), 'model', context.modelId)
  const withoutKiro = removeTomlSection(removeTomlSection(withProvider, 'model_providers.kiro'), 'model_providers."kiro"')
  const separator = withoutKiro.trim() ? `${newline}${newline}` : ''
  return `${withoutKiro.trimEnd()}${separator}[model_providers.kiro]${newline}name = "Kiro Proxy"${newline}base_url = "${escapeTomlString(context.openaiBaseUrl)}"${newline}wire_api = "responses"${newline}`
}

async function configureCodex(context: ProxyClientContext): Promise<Omit<ProxyClientConfigResult, 'client' | 'success' | 'error'>> {
  const authPath = getCodexAuthPath()
  const configPath = getCodexConfigPath()
  const auth = await readJsonObject(authPath)
  auth.OPENAI_API_KEY = context.apiKey
  const authBackups = await writeJsonObject(authPath, auth)
  const config = (await exists(configPath)) ? await readFile(configPath, 'utf-8') : ''
  const configBackups = await writeText(configPath, upsertCodexConfig(config, context))
  return { paths: [authPath, configPath], backupPaths: [...authBackups, ...configBackups] }
}

// Gemini CLI: ~/.gemini/.env + ~/.gemini/settings.json
function getGeminiEnvPath(): string {
  return join(homedir(), '.gemini', '.env')
}

function getGeminiSettingsPath(): string {
  return join(homedir(), '.gemini', 'settings.json')
}

function buildEnvContent(entries: Record<string, string>): string {
  return Object.entries(entries).map(([k, v]) => `${k}=${v}`).join('\n') + '\n'
}

function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const idx = trimmed.indexOf('=')
    if (idx > 0) result[trimmed.substring(0, idx).trim()] = trimmed.substring(idx + 1).trim()
  }
  return result
}

async function configureGemini(context: ProxyClientContext): Promise<Omit<ProxyClientConfigResult, 'client' | 'success' | 'error'>> {
  const envPath = getGeminiEnvPath()
  const settingsPath = getGeminiSettingsPath()
  const allPaths = [envPath, settingsPath]
  const allBackups: string[] = []

  // .env
  const existingEnv = (await exists(envPath)) ? parseEnvFile(await readFile(envPath, 'utf-8')) : {}
  existingEnv.GEMINI_API_KEY = context.apiKey
  existingEnv.GOOGLE_GEMINI_BASE_URL = `${context.proxyOrigin}/v1beta`
  existingEnv.GEMINI_MODEL = context.modelId
  allBackups.push(...await writeText(envPath, buildEnvContent(existingEnv)))

  // settings.json
  const settings = await readJsonObject(settingsPath)
  const security = ensureObjectField(settings, 'security')
  const auth = ensureObjectField(security, 'auth')
  auth.selectedType = 'gemini-api-key'
  allBackups.push(...await writeJsonObject(settingsPath, settings))

  return { paths: allPaths, backupPaths: allBackups }
}

// Hermes: ~/.hermes/config.yaml
function getHermesConfigPath(): string {
  return join(homedir(), '.hermes', 'config.yaml')
}

async function configureHermes(context: ProxyClientContext): Promise<Omit<ProxyClientConfigResult, 'client' | 'success' | 'error'>> {
  const configPath = getHermesConfigPath()
  const existing = (await exists(configPath)) ? await readFile(configPath, 'utf-8') : ''
  const newline = existing.includes('\r\n') ? '\r\n' : '\n'

  // 构建 models dict
  const modelsYaml = context.models.map(m => {
    const ctx = typeof m.maxInputTokens === 'number' && m.maxInputTokens > 0 ? m.maxInputTokens : 200000
    return `      ${m.id}:${newline}        context_length: ${ctx}`
  }).join(newline)

  const providerBlock = [
    `  - name: kiro`,
    `    base_url: ${context.openaiBaseUrl}`,
    `    api_key: ${context.apiKey}`,
    `    model: ${context.modelId}`,
    `    models:`,
    modelsYaml
  ].join(newline)

  // 简单追加/替换 custom_providers 中的 kiro 条目
  let content = existing
  const kiroProviderRegex = /^\s*- name:\s*kiro\b[\s\S]*?(?=^\s*- name:|^[a-z]|$)/gm
  if (kiroProviderRegex.test(content)) {
    content = content.replace(kiroProviderRegex, providerBlock + newline)
  } else if (content.includes('custom_providers:')) {
    content = content.replace(/(custom_providers:\s*)/, `$1${newline}${providerBlock}${newline}`)
  } else {
    content = `${content.trimEnd()}${newline}${newline}custom_providers:${newline}${providerBlock}${newline}`
  }

  // 更新 model section
  const modelSection = `model:${newline}  default: "kiro/${context.modelId}"${newline}  provider: "kiro"${newline}`
  if (/^model:/m.test(content)) {
    content = content.replace(/^model:.*(?:\n(?=\s).*)*$/m, modelSection.trimEnd())
  } else {
    content = `${content.trimEnd()}${newline}${newline}${modelSection}`
  }

  const backups = await writeText(configPath, content)
  return { paths: [configPath], backupPaths: backups }
}

// OpenClaw: ~/.openclaw/openclaw.json
function getOpenClawConfigPath(): string {
  return join(homedir(), '.openclaw', 'openclaw.json')
}

async function configureOpenClaw(context: ProxyClientContext): Promise<Omit<ProxyClientConfigResult, 'client' | 'success' | 'error'>> {
  const configPath = getOpenClawConfigPath()
  const config = await readJsonObject(configPath)

  // models.providers.kiro
  const models = ensureObjectField(config, 'models')
  if (typeof models.mode !== 'string') models.mode = 'merge'
  const providers = ensureObjectField(models, 'providers')
  providers.kiro = {
    base_url: context.openaiBaseUrl,
    api_key: context.apiKey,
    api: 'openai-chat',
    models: context.models.map(m => ({ id: m.id, name: m.name || m.id, context_window: typeof m.maxInputTokens === 'number' && m.maxInputTokens > 0 ? m.maxInputTokens : 200000 }))
  }

  // agents.defaults.model
  const agents = ensureObjectField(config, 'agents')
  const defaults = ensureObjectField(agents, 'defaults')
  defaults.model = { primary: `kiro/${context.modelId}`, fallbacks: [] }

  const backups = await writeJsonObject(configPath, config)
  return { paths: [configPath], backupPaths: backups }
}

const ALL_CLIENT_TARGETS: ProxyClientTarget[] = ['claudeCode', 'opencode', 'codex', 'gemini', 'hermes', 'openclaw']

async function configureClient(client: ProxyClientTarget, context: ProxyClientContext): Promise<ProxyClientConfigResult> {
  try {
    const result = client === 'claudeCode' ? await configureClaudeCode(context)
      : client === 'opencode' ? await configureOpenCode(context)
      : client === 'codex' ? await configureCodex(context)
      : client === 'gemini' ? await configureGemini(context)
      : client === 'hermes' ? await configureHermes(context)
      : await configureOpenClaw(context)
    return { client, success: true, ...result }
  } catch (error) {
    return { client, success: false, paths: [], backupPaths: [], error: error instanceof Error ? error.message : 'Unknown error' }
  }
}

export async function configureProxyClients(input: ConfigureProxyClientsInput): Promise<{ success: boolean; proxyOrigin: string; openaiBaseUrl: string; results: ProxyClientConfigResult[] }> {
  const modelId = input.modelId.trim()
  const apiKey = input.apiKey?.trim()
  if (!Array.isArray(input.clients)) throw new Error('Client targets are required')
  const clients = Array.from(new Set(input.clients))
  if (!modelId) throw new Error('Model is required')
  if (!apiKey) throw new Error('API Key is required')
  if (clients.length === 0) throw new Error('At least one client is required')
  if (clients.some(client => !ALL_CLIENT_TARGETS.includes(client))) throw new Error('Unsupported client target')

  const proxyOrigin = buildProxyOrigin(input)
  const modelMap = new Map((input.models?.length ? input.models : [{ id: modelId, name: input.modelName || modelId }]).map(model => [model.id, model]))
  if (!modelMap.has(modelId)) modelMap.set(modelId, { id: modelId, name: input.modelName || modelId })
  const context: ProxyClientContext = {
    proxyOrigin,
    openaiBaseUrl: `${proxyOrigin.replace(/\/$/, '')}/v1`,
    apiKey,
    modelId,
    models: Array.from(modelMap.values())
  }
  const results: ProxyClientConfigResult[] = []
  for (const client of clients) {
    results.push(await configureClient(client, context))
  }
  return { success: results.every(result => result.success), proxyOrigin, openaiBaseUrl: context.openaiBaseUrl, results }
}
