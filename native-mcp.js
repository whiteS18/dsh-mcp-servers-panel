/**
 * MCP plugin-manifest bridge.
 *
 * DSH bundles the MCP client plugin `@deepseek-ai/dsh-mcp-client`. A profile
 * can load several instances of that plugin from its plugin manifest (the
 * "profile patch"). Third-party tools also write such entries: Magpie writes
 * entries with patch ids like `magpie-mcp-<serverName>`.
 *
 * Every plugin-manifest entry runs its own server process and registers
 * `mcp__<serverName>__<tool>` tools directly on the host, independently of
 * this panel. Real installations can therefore end up with the same MCP
 * server configured twice: once in this panel's mcp.json and once as a plugin
 * entry in the manifest.
 *
 * These helpers let the panel discover those plugin entries, present them in
 * the same list and control them through the DSH plugin manager, so an MCP
 * server disabled in the panel really stops being injected into the model
 * context.
 */

export const NATIVE_MCP_PLUGIN_NAME = '@deepseek-ai/dsh-mcp-client'
const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60000
const FIBER_PHASES = ['pending', 'loading', 'active', 'failed', null, 'unloading']

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read live native MCP plugin entries straight from the Cordis loader. */
export function listNativeMcpServers(ctx) {
  const servers = []
  if (!ctx || typeof ctx.get !== 'function') return servers
  let loader
  try {
    loader = ctx.get('loader')
  } catch {
    return servers
  }
  if (!loader || typeof loader.entries !== 'function') return servers
  let entries = []
  try {
    entries = [...loader.entries()]
  } catch {
    return servers
  }
  for (const entry of entries) {
    const options = entry?.options
    if (!options || options.name !== NATIVE_MCP_PLUGIN_NAME) continue
    const config = options.config
    if (!isRecord(config)) continue
    const serverName = String(config.serverName || '').trim()
    if (!serverName) continue
    const transport = config.transport === 'streamable-http' ? 'streamable-http' : 'stdio'
    const phase = typeof entry.fiber?.state === 'number' ? FIBER_PHASES[entry.fiber.state] ?? null : null
    servers.push({
      entryId: entry.id,
      serverName,
      transport,
      command: String(config.command || ''),
      args: Array.isArray(config.args) ? config.args.map(String) : [],
      env: isRecord(config.env) ? { ...config.env } : {},
      cwd: typeof config.cwd === 'string' ? config.cwd : '',
      url: String(config.url || ''),
      headers: isRecord(config.headers) ? { ...config.headers } : {},
      toolCallTimeoutMs: Number(config.toolCallTimeoutMs) || DEFAULT_TOOL_CALL_TIMEOUT_MS,
      enabled: entry.disabled !== true,
      fiberPhase: phase,
      patchId: '',
      readOnlyReason: '',
      warnings: [],
    })
  }
  return servers
}

/** Same snapshot plus plugin-manager addressability (patch id / read-only reason). */
export async function readNativeMcpServers(ctx) {
  const servers = listNativeMcpServers(ctx)
  if (servers.length === 0) return servers
  let pluginManager
  try {
    pluginManager = ctx?.get?.('pluginManager')
  } catch {}
  let rows
  if (pluginManager && typeof pluginManager.listPlugins === 'function') {
    try {
      rows = await pluginManager.listPlugins()
    } catch {}
  }
  if (!Array.isArray(rows)) {
    for (const server of servers) server.readOnlyReason = server.readOnlyReason || 'unaddressable'
    return servers
  }
  const byId = new Map(rows.map((row) => [row?.entryId, row]))
  for (const server of servers) {
    const row = byId.get(server.entryId)
    if (!row) {
      server.readOnlyReason = 'unaddressable'
      continue
    }
    if (typeof row.enabled === 'boolean') server.enabled = row.enabled
    if (row.fiberPhase !== undefined) server.fiberPhase = row.fiberPhase
    server.patchId = row.patchId || ''
    server.readOnlyReason = row.readOnlyReason || ''
  }
  return servers
}

/**
 * Classify one plugin-manifest MCP entry by its manifest id.
 * Magpie writes ids shaped like `magpie-mcp-<serverName>`; other writers use
 * their own ids. The origin label is shown in the panel so users can tell a
 * third-party entry apart from a panel-managed server.
 */
export function nativeEntryOrigin(native) {
  const patchId = String(native?.patchId || '')
  if (/^magpie-mcp-/i.test(patchId)) {
    return { origin: 'magpie', originLabel: 'Magpie', patchEntryId: patchId }
  }
  return { origin: 'plugin-manifest', originLabel: '插件清单', patchEntryId: patchId }
}

function nativeCommandIdentity(command) {
  return String(command || '').trim().replace(/\\/g, '/').toLowerCase()
}

/** Whether a native entry describes the same server as one panel config entry. */
export function nativeMatchesServer(native, server) {
  if (!isRecord(native) || !isRecord(server)) return false
  if (native.serverName !== server.name) return false
  if ((native.transport || 'stdio') !== (server.transport || 'stdio')) return false
  if (native.transport === 'stdio') {
    if (nativeCommandIdentity(native.command) !== nativeCommandIdentity(server.command)) return false
    return JSON.stringify((native.args || []).map(String)) === JSON.stringify((server.args || []).map(String))
  }
  return String(native.url || '').trim() === String(server.url || '').trim()
}

/** Tools currently visible in the host registry under one MCP server namespace. */
export function registeredMcpTools(ctx, serverName) {
  if (!serverName) return []
  let view
  try {
    view = ctx?.tools?.view?.()
  } catch {
    return []
  }
  const visible = view?.visible
  if (!visible || typeof visible.entries !== 'function') return []
  const prefix = 'mcp__' + serverName + '__'
  const tools = []
  for (const [toolName, definition] of visible.entries()) {
    if (typeof toolName !== 'string' || !toolName.startsWith(prefix)) continue
    tools.push({
      name: toolName,
      rawName: toolName.slice(prefix.length),
      description: String(definition?.description || ''),
      inputSchema: definition?.parameters || { type: 'object' },
    })
  }
  return tools
}

function nativeLifecycleStatus(native) {
  if (!native) return 'disabled'
  if (native.enabled === false) return 'disabled'
  switch (native.fiberPhase) {
    case 'active':
      return 'connected'
    case 'loading':
    case 'pending':
    case 'unloading':
      return 'connecting'
    case 'failed':
      return 'error'
    default:
      return 'connecting'
  }
}

/** Ask the DSH plugin manager to enable/disable one native MCP plugin row. */
export async function setNativeServerEnabled(ctx, native, enabled) {
  let pluginManager
  try {
    pluginManager = ctx?.get?.('pluginManager')
  } catch {}
  if (!pluginManager || typeof pluginManager.setPluginEnabled !== 'function') {
    throw new Error('当前 DSH 运行环境没有提供插件管理服务 (pluginManager)，无法启停插件清单中的 MCP 条目')
  }
  if (native.readOnlyReason) {
    throw new Error('该插件清单条目不可由面板修改（' + native.readOnlyReason + '）')
  }
  if (!native.entryId) throw new Error('未找到插件清单条目的 ID')
  return await pluginManager.setPluginEnabled(native.entryId, Boolean(enabled))
}

/** Describe one native MCP server for the panel list API. */
export function describeNativeMcpServer(ctx, native, options = {}) {
  const enabled = native.enabled !== false
  const tools = enabled ? registeredMcpTools(ctx, native.serverName) : []
  const status = nativeLifecycleStatus(native)
  const controllable = Boolean(options.hasPluginManager) && !native.readOnlyReason
  const warnings = Array.isArray(native.warnings) ? [...native.warnings] : []
  const origin = nativeEntryOrigin(native)
  if (enabled && !controllable) {
    warnings.push('该 MCP 来自 DSH 插件清单（可能由 Magpie 等第三方工具写入），当前无法从面板关闭；请在 DSH 插件设置中停用对应条目。')
  }
  let error = null
  if (status === 'error') error = '插件清单中的 MCP 条目加载失败，请在 DSH 插件设置中查看日志。'
  else if (options.conflict) error = options.conflict
  return {
    name: native.serverName,
    scope: options.scope || 'user',
    workspacePath: options.workspacePath || '',
    source: 'plugin',
    origin: origin.origin,
    originLabel: origin.originLabel,
    patchEntryId: origin.patchEntryId,
    nativeEntryId: native.entryId,
    nativePatchId: native.patchId || '',
    pluginEntry: {
      entryId: native.entryId,
      patchEntryId: origin.patchEntryId,
      origin: origin.origin,
      originLabel: origin.originLabel,
      enabled,
      readOnlyReason: native.readOnlyReason || '',
    },
    readonly: true,
    controllable,
    enabled,
    transport: native.transport,
    command: native.command,
    args: native.args,
    env: native.env,
    cwd: native.cwd,
    url: native.url,
    headers: native.headers,
    toolCallTimeoutMs: native.toolCallTimeoutMs,
    status,
    error,
    warnings,
    toolCount: tools.length,
    tools,
  }
}
