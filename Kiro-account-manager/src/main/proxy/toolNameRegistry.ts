export class ToolNameRegistry {
  private readonly originalToKiro = new Map<string, string>()
  private readonly kiroToOriginal = new Map<string, string>()

  toKiroName(name: string): string {
    const existing = this.originalToKiro.get(name)
    if (existing) return existing

    const baseName = name.length <= 64 ? name : this.shorten(name)
    const kiroName = this.ensureUnique(baseName, name)
    this.originalToKiro.set(name, kiroName)
    this.kiroToOriginal.set(kiroName, name)
    return kiroName
  }

  toClientName(name: string): string {
    return this.kiroToOriginal.get(name) || name
  }

  restoreToolUse<T extends { name: string }>(toolUse: T): T {
    return {
      ...toolUse,
      name: this.toClientName(toolUse.name)
    }
  }

  restoreToolUses<T extends { name: string }>(toolUses: T[]): T[] {
    return toolUses.map(toolUse => this.restoreToolUse(toolUse))
  }

  private ensureUnique(baseName: string, originalName: string): string {
    const existing = this.kiroToOriginal.get(baseName)
    if (!existing || existing === originalName) return baseName

    const hash = this.hash(originalName)
    const suffix = `_${hash}`
    const candidate = baseName.substring(0, Math.max(1, 64 - suffix.length)) + suffix
    const candidateExisting = this.kiroToOriginal.get(candidate)
    if (!candidateExisting || candidateExisting === originalName) return candidate

    throw new Error(`Tool name collision after shortening: ${originalName}`)
  }

  private shorten(name: string): string {
    const hash = this.hash(name)
    const suffix = `_${hash}`
    const readable = name.replace(/[^a-zA-Z0-9_-]/g, '_')
    const maxPrefixLength = 64 - suffix.length
    return readable.substring(0, maxPrefixLength) + suffix
  }

  private hash(value: string): string {
    let hash = 2166136261
    for (let index = 0; index < value.length; index++) {
      hash ^= value.charCodeAt(index)
      hash = Math.imul(hash, 16777619)
    }
    return (hash >>> 0).toString(36)
  }
}
