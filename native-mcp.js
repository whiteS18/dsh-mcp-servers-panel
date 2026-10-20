/**
 * Read-only view of DSH's official MCP client entries.
 *
 * The panel does not own these plugin instances. It reads the Loader's live
 * `@deepseek-ai/dsh-mcp-client` rows, the plugin manager's addressability
 * metadata, and the tool registry, so the UI can show status, tools and
 * source. Rows written by other tools (for example Magpie) stay read-only and
 * are toggled through the official plugin manager.
 */

import { PANEL_ENTRY_PREFIX } from './patch-store.js'

export const NATIVE_MCP_PLUGIN_NAME = '@deepseek-ai/dsh-mcp-client'
export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60000

const FIBER_PHASES = ['pending', 'loading', 'active', 'failed', null, 'unloading']

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function safeGet(ctx, name) {
  try {
    return ctx?.get?.(name)
  } catch {
    return undefined
  }
}

/** The official plugin manager service, when this host provides it. */
export function getPluginManager(ctx) {
  const manager = safeGet(ctx, 'pluginManager')
  return manager && typeof manager.setPluginEnabled === 'function' ? manager : undefined
}

function stripIncludePrefix(id) {
  return String(id || '').replace(/^include:/, '')
}

function fiberPhase(entry) {
  const state = entry?.fiber?.state
  return typeof state === 'number' ? FIBER_PHASES[state] ?? null : null
}

function fiberError(entry) {
  // The fiber context is a Cordis service proxy: reading an uninjected property
  // from it throws. Only the fiber's own error slot, when this DSH build
  // exposes one, is safe to inspect.
  try {
    const candidate = entry?.fiber?.error
    if (candidate instanceof Error) return candidate.message
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
  } catch {}
  return ''
}

/** Every live loader entry for the official MCP client. */
export function listMcpClientEntries(ctx) {
  let loader
  try {
    loader = ctx?.get?.('loader') ?? ctx?.loader
  } catch {
    return []
  }
  if (!loader || typeof loader.entries !== 'function') return []
  let raw
  try {
    raw = [...loader.entries()]
  } catch {
    return []
  }
  const entries = []
  for (const entry of raw) {
    if (entry?.options?.name !== NATIVE_MCP_PLUGIN_NAME) continue
    const config = isRecord(entry.options.config) ? entry.options.config : {}
    entries.push({
      entryId: String(entry.id || ''),
      loaderEntryId: String(entry.id || ''),
      patchId: String(entry.options.id || stripIncludePrefix(entry.id)),
      serverName: String(config.serverName || '').trim(),
      config,
      disabled: entry.disabled === true,
      enabled: entry.disabled !== true,
      fiberPhase: fiberPhase(entry),
      fiberState: typeof entry.fiber?.state === 'number' ? entry.fiber.state : null,
      fiberError: fiberError(entry),
      options: entry.options,
    })
  }
  return entries
}

/** Plugin-manager rows keyed by loader entry id. */
export async function readPluginManagerRows(ctx) {
  const manager = getPluginManager(ctx)
  if (!manager || typeof manager.listPlugins !== 'function') return new Map()
  try {
    const rows = await manager.listPlugins()
    if (!Array.isArray(rows)) return new Map()
    return new Map(rows.map((row) => [row?.entryId, row]))
  } catch {
    return new Map()
  }
}

/** One inventory snapshot: live entries plus plugin-manager rows. */
export async function readMcpInventory(ctx) {
  const entries = listMcpClientEntries(ctx)
  const rows = await readPluginManagerRows(ctx)
  return {
    entries,
    rows,
    hasPluginManager: Boolean(getPluginManager(ctx)),
  }
}

/** Tools currently visible in the host registry under one MCP server namespace. */
export function registeredMcpTools(ctx, serverName) {
  if (!serverName) return []
  let tools
  try {
    tools = ctx?.get?.('tools') ?? ctx?.tools
  } catch {
    return []
  }
  let view
  try {
    view = tools?.view?.()
  } catch {
    return []
  }
  const visible = view?.visible
  if (!visible || typeof visible.entries !== 'function') return []
  const prefix = 'mcp__' + serverName + '__'
  const list = []
  for (const [toolName, definition] of visible.entries()) {
    if (typeof toolName !== 'string' || !toolName.startsWith(prefix)) continue
    list.push({
      name: toolName,
      rawName: toolName.slice(prefix.length),
      description: String(definition?.description || ''),
      inputSchema: definition?.parameters || { type: 'object' },
    })
  }
  return list
}

/**
 * Classify a non-panel MCP row.
 *
 * The panel deliberately does not try to recognise every third-party writer
 * (Magpie, other plugin manifests, external importers): all of them land in
 * one read-only bucket labelled 第三方导入, so a new importer never requires a
 * code change here.
 */
export function nativeEntryOrigin(patchEntryId, entryId = '') {
  const id = String(patchEntryId || entryId || '')
  return { origin: 'third-party', originLabel: '第三方导入', patchEntryId: id }
}

function normalizeStatus(phase, enabled) {
  if (!enabled) return 'disabled'
  if (phase === 'active') return 'connected'
  if (phase === 'failed') return 'error'
  return 'connecting'
}

/**
 * Describe one foreign (non-panel) official MCP client row for the UI.
 *
 * @param {object} ctx host context
 * @param {object} entry live loader entry snapshot from {@link listMcpClientEntries}
 * @param {object|undefined} row plugin-manager row
 * @param {{hasPluginManager: boolean}} options
 */
export function describeMcpEntry(ctx, entry, row, options = {}) {
  const config = isRecord(entry.config) ? entry.config : {}
  const enabled = typeof row?.enabled === 'boolean' ? row.enabled : entry.enabled !== false
  const phase = row?.fiberPhase !== undefined ? row.fiberPhase : entry.fiberPhase
  const status = normalizeStatus(phase, enabled)
  const patchEntryId = String(row?.patchId || entry.patchId || stripIncludePrefix(entry.entryId))
  const origin = nativeEntryOrigin(patchEntryId, entry.entryId)
  const readOnlyReason = String(row?.readOnlyReason || '')
  const controllable = Boolean(options.hasPluginManager) && !readOnlyReason
  const tools = enabled ? registeredMcpTools(ctx, entry.serverName) : []
  const warnings = []
  let error = ''
  if (status === 'error') error = entry.fiberError || '插件加载失败，请在 DSH 日志中查看原因。'
  if (enabled && !controllable) {
    warnings.push('该 MCP 由第三方导入，当前无法从本插件关闭；请在 DSH 插件设置中停用对应条目。')
  }
  if (!entry.serverName) warnings.push('该第三方条目缺少 serverName，官方 MCP client 无法注册工具。')

  const transport = config.transport === 'streamable-http' ? 'streamable-http' : 'stdio'
  return {
    name: entry.serverName || patchEntryId || entry.entryId,
    entryId: patchEntryId,
    loaderEntryId: entry.loaderEntryId || entry.entryId,
    source: 'third-party',
    origin: origin.origin,
    originLabel: origin.originLabel,
    patchEntryId: origin.patchEntryId,
    readonly: true,
    controllable,
    enabled,
    transport,
    command: String(config.command || ''),
    args: Array.isArray(config.args) ? config.args.map(String) : [],
    env: isRecord(config.env) ? { ...config.env } : {},
    cwd: typeof config.cwd === 'string' ? config.cwd : '',
    url: String(config.url || ''),
    headers: isRecord(config.headers) ? { ...config.headers } : {},
    toolCallTimeoutMs: Number(config.toolCallTimeoutMs) || DEFAULT_TOOL_CALL_TIMEOUT_MS,
    reconnect: isRecord(config.reconnect) ? { ...config.reconnect } : undefined,
    failOnStartupError: config.failOnStartupError === true,
    maxInstructionBytes: Number(config.maxInstructionBytes) || undefined,
    status,
    error,
    warnings,
    toolCount: tools.length,
    tools,
    pluginEntry: {
      entryId: entry.loaderEntryId || entry.entryId,
      patchEntryId: origin.patchEntryId,
      origin: origin.origin,
      originLabel: origin.originLabel,
      enabled,
      readOnlyReason,
    },
    configEnabled: enabled,
    runtimeEnabled: entry.disabled !== true,
  }
}

/** Ask the official plugin manager to enable or disable one manifest row. */
export async function setNativeServerEnabled(ctx, entryId, enabled) {
  const manager = getPluginManager(ctx)
  if (!manager) {
    throw new Error('当前 DSH 运行环境没有提供插件管理服务 (pluginManager)，无法启停第三方导入的 MCP 条目')
  }
  if (!entryId) throw new Error('未找到第三方导入条目的 ID')
  return await manager.setPluginEnabled(entryId, Boolean(enabled))
}

export { PANEL_ENTRY_PREFIX }
