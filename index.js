/**
 * dsh-mcp-servers-panel — Host / Node half.
 *
 * The panel is a management plane only. It writes and toggles ordinary loader
 * rows for DSH's official `@deepseek-ai/dsh-mcp-client` plugin in the active
 * profile's `cordis.patch.yml`. The official client owns stdio/HTTP transport,
 * reconnects, tool registration, resources and teardown; the panel never
 * spawns a process, speaks MCP JSON-RPC or registers tools.
 */

import { readFile, writeFile, rename, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import {
  DEFAULT_TOOL_CALL_TIMEOUT_MS,
  PANEL_ENTRY_PREFIX,
  ProfilePatch,
  isPanelEntryId,
  normalizeIncomingList,
  normalizeServerInput,
  panelEntryId,
  serverNameFromEntryId,
} from './patch-store.js'
import {
  describeMcpEntry,
  getPluginManager,
  listMcpClientEntries,
  readMcpInventory,
  registeredMcpTools,
  setNativeServerEnabled,
} from './native-mcp.js'

export const name = 'dsh-mcp-servers-panel'
export const inject = ['tools']

export const RPC_CHANNEL = '/dsh-mcp-servers-panel'
export const WEB_API_PREFIX = '/api/dsh-mcp-servers-panel'

const MAX_BODY_BYTES = 256 * 1024

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

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/** Bounded retry for Windows rename-over-existing races. */
async function writeFileAtomic(filename, text) {
  const directory = dirname(filename)
  const temporary = join(directory, '.' + basename(filename) + '.' + process.pid + '.' + Date.now() + '.tmp')
  await writeFile(temporary, text, { encoding: 'utf8', mode: 0o600 })
  try {
    await rename(temporary, filename)
  } catch (error) {
    const retryable = error?.code === 'EPERM' || error?.code === 'EEXIST'
      || error?.code === 'ENOTEMPTY' || error?.code === 'EBUSY'
    if (!retryable) {
      try { await unlink(temporary) } catch {}
      throw error
    }
    try {
      await writeFile(filename, text, { encoding: 'utf8', mode: 0o600 })
    } finally {
      try { await unlink(temporary) } catch {}
    }
  }
}

function defaultConfig(raw) {
  const source = isRecord(raw) ? raw : {}
  const transport = source.transport === 'streamable-http' ? 'streamable-http' : 'stdio'
  return {
    transport,
    command: String(source.command || ''),
    args: Array.isArray(source.args) ? source.args.map(String) : [],
    env: isRecord(source.env) ? { ...source.env } : {},
    cwd: typeof source.cwd === 'string' ? source.cwd : '',
    url: String(source.url || ''),
    headers: isRecord(source.headers) ? { ...source.headers } : {},
    toolCallTimeoutMs: Number(source.toolCallTimeoutMs) || DEFAULT_TOOL_CALL_TIMEOUT_MS,
    reconnect: isRecord(source.reconnect) ? { ...source.reconnect } : undefined,
    failOnStartupError: source.failOnStartupError === true,
    maxInstructionBytes: Number(source.maxInstructionBytes) || undefined,
  }
}

function statusFromLive(entry) {
  if (!entry) return 'error'
  if (entry.fiberPhase === 'active') return 'connected'
  if (entry.fiberPhase === 'failed') return 'error'
  return 'connecting'
}

export class McpManager {
  constructor(ctx, options = {}) {
    this.ctx = ctx
    this.profileOverride = options.profile
    this.patchPathOverride = options.patchPath
    this.chain = Promise.resolve()
    this.disposed = false
  }

  get profile() {
    if (this.profileOverride !== undefined) return this.profileOverride
    return safeGet(this.ctx, 'profileContext') || null
  }

  get patchPath() {
    if (this.patchPathOverride) return this.patchPathOverride
    const profile = this.profile
    if (!profile) return ''
    return profile.patchPath || (profile.dir ? join(profile.dir, 'cordis.patch.yml') : '')
  }

  get canManage() {
    return !this.disposed && Boolean(this.profile && this.patchPath)
  }

  profileInfo() {
    const profile = this.profile
    return {
      name: String(profile?.name || ''),
      dir: String(profile?.dir || ''),
      path: this.patchPath,
      available: this.canManage,
    }
  }

  getHmr() {
    const hmr = safeGet(this.ctx, 'hmr')
    return hmr && typeof hmr.reconcileProfile === 'function' ? hmr : undefined
  }

  async readPatchText() {
    try {
      return await readFile(this.patchPath, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return '[]\n'
      throw error
    }
  }

  async readPatch() {
    if (!this.canManage) throw new Error('当前 DSH 运行环境没有提供 profileContext，无法管理 MCP 配置')
    const text = await this.readPatchText()
    return { text, patch: ProfilePatch.parse(text) }
  }

  enqueue(operation) {
    const run = this.chain.then(operation)
    this.chain = run.catch(() => {})
    return run
  }

  /**
   * Read-modify-write the profile patch inside the HMR queue, then let the
   * official loader apply it. A failed reconcile restores the previous text.
   */
  async transact(prepare, project) {
    return await this.enqueue(() => this.transactInner(prepare, project))
  }

  async transactInner(prepare, project) {
      if (this.disposed) throw new Error('MCP 面板已卸载')
      const hmr = this.getHmr()
      const run = async () => {
        const before = await this.readPatchText()
        const patch = ProfilePatch.parse(before)
        const prepared = await prepare(patch)
        const requiredIds = Array.isArray(prepared?.requiredIds) ? prepared.requiredIds : []
        const next = patch.toString()
        if (!patch.dirty || next === before) {
          const data = await project()
          return { ...data, application: 'applied' }
        }
        await writeFileAtomic(this.patchPath, next)
        if (!hmr) {
          const data = await project()
          return { ...data, application: 'restart-required', restartReason: 'no-hmr' }
        }
        try {
          const outcome = await hmr.reconcileProfile(requiredIds)
          const restart = outcome?.restartReason ?? outcome?.pending?.[0]?.reason
          const data = await project()
          return restart === undefined
            ? { ...data, application: 'applied' }
            : { ...data, application: 'restart-required', restartReason: String(restart) }
        } catch (error) {
          await writeFileAtomic(this.patchPath, before)
          try { await hmr.reconcileProfile([]) } catch {}
          throw new Error('应用 Profile 配置失败，已回滚: ' + messageOf(error))
        }
      }
      if (hmr && typeof hmr.runExclusive === 'function') return await hmr.runExclusive(run)
      return await run()
  }

  async foreignNameMap() {
    const rows = listMcpClientEntries(this.ctx)
    const map = new Map()
    for (const row of rows) {
      if (isPanelEntryId(row.patchId || row.entryId)) continue
      if (row.serverName) map.set(row.serverName, row)
    }
    return map
  }

  describePanelRow(row, liveEntry, duplicateForeign) {
    const entryId = row.entryId
    const serverName = row.serverName || serverNameFromEntryId(entryId)
    let normalized
    let invalid = ''
    try {
      normalized = normalizeServerInput(serverName, row.config)
    } catch (error) {
      invalid = messageOf(error)
      normalized = undefined
    }
    const config = normalized?.config ?? defaultConfig(row.config)
    const enabled = row.enabled !== false
    const liveEnabled = liveEntry ? liveEntry.disabled !== true : false
    const warnings = []
    let status = 'disabled'
    let error = invalid
    if (enabled) {
      if (invalid) {
        status = 'error'
      } else if (!liveEntry) {
        status = 'error'
        error = '该条目尚未被 Loader 加载；配置可能未生效，请检查 Profile patch 或重启 DSH。'
      } else {
        status = liveEnabled ? statusFromLive(liveEntry) : 'disabled'
        if (status === 'error') error = liveEntry.fiberError || '插件加载失败，请在 DSH 日志中查看原因。'
        if (!liveEnabled) {
          error = '该条目在运行时被禁用（可能被插件管理器覆盖），请重新启用。'
          warnings.push(error)
        }
      }
    }
    if (duplicateForeign) {
      warnings.push('插件清单中还存在同名条目（' + (duplicateForeign.entryId || duplicateForeign.serverName) + '），官方 MCP client 可能只加载其中一个；请删除或改名。')
    }
    const tools = enabled && liveEntry ? registeredMcpTools(this.ctx, serverName) : []
    const transport = config.transport === 'streamable-http' ? 'streamable-http' : 'stdio'
    return {
      name: serverName,
      entryId,
      source: 'panel',
      origin: 'panel',
      originLabel: '面板',
      patchEntryId: entryId,
      readonly: false,
      controllable: !this.disposed,
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
      configEnabled: enabled,
      runtimeEnabled: liveEnabled,
    }
  }

  async list() {
    const profile = this.profileInfo()
    const warnings = []
    let patch = null
    let patchError = ''
    if (this.canManage) {
      try {
        patch = (await this.readPatch()).patch
      } catch (error) {
        patchError = messageOf(error)
        warnings.push('Profile patch 读取失败：' + patchError)
      }
    } else {
      warnings.push('当前 DSH 运行环境没有提供 profileContext；面板只能查看插件清单条目。')
    }

    const inventory = await readMcpInventory(this.ctx)
    const liveById = new Map()
    for (const entry of inventory.entries) {
      liveById.set(entry.entryId, entry)
      if (entry.patchId) liveById.set(entry.patchId, entry)
    }
    const panelRows = patch ? patch.panelRows() : []
    const panelIds = new Set(panelRows.map((row) => row.entryId))
    const panelNames = new Set(panelRows.map((row) => row.serverName).filter(Boolean))
    const duplicateForeign = new Map()
    for (const entry of inventory.entries) {
      if (isPanelEntryId(entry.patchId || entry.entryId)) continue
      if (entry.serverName && panelNames.has(entry.serverName)) duplicateForeign.set(entry.serverName, entry)
    }

    const servers = []
    const seenPanelNames = new Set()
    for (const row of panelRows) {
      if (row.serverName && seenPanelNames.has(row.serverName)) {
        warnings.push('Profile patch 中存在重复的面板条目「' + row.serverName + '」，已忽略后一条；请手工清理。')
        continue
      }
      if (row.serverName) seenPanelNames.add(row.serverName)
      const live = liveById.get(row.entryId)
      servers.push(this.describePanelRow(row, live, duplicateForeign.get(row.serverName)))
    }
    const foreign = inventory.entries
      .filter((entry) => !isPanelEntryId(entry.patchId || entry.entryId))
      .filter((entry) => !(entry.serverName && panelNames.has(entry.serverName)))
      .map((entry) => describeMcpEntry(this.ctx, entry, inventory.rows.get(entry.entryId), {
        hasPluginManager: inventory.hasPluginManager,
      }))
      .sort((left, right) => left.name.localeCompare(right.name))
    servers.push(...foreign)

    return {
      servers,
      profile,
      nativeControlAvailable: inventory.hasPluginManager,
      canManage: this.canManage,
      ...warnings.length > 0 ? { warnings } : {},
    }
  }

  async saveServer(payload = {}) {
    if (!this.canManage) throw new Error('当前 DSH 运行环境没有提供 profileContext，无法保存 MCP 配置')
    let inputs
    if (payload.rawJson !== undefined && payload.rawJson !== null) {
      inputs = normalizeIncomingList(payload.rawJson)
    } else {
      inputs = [normalizeServerInput(payload.name, payload.server || {})]
    }
    if (inputs.length === 0) throw new Error('未在 JSON 中解析出任何有效的 MCP 服务器配置')

    const createOnly = payload.createOnly === true
    const replaceName = payload.replaceName ? String(payload.replaceName) : ''

    return await this.transact(async (patch) => {
      const seen = new Set()
      for (const input of inputs) {
        if (seen.has(input.name)) throw new Error('配置中包含重复的服务名「' + input.name + '」')
        seen.add(input.name)
      }

      const panelNames = new Set(patch.panelRows().map((row) => row.serverName))
      const foreignNames = await this.foreignNameMap()
      const foreignInPatch = new Map()
      for (const row of patch.rows()) {
        if (row.panelManaged || !row.serverName) continue
        foreignInPatch.set(row.serverName, row)
      }
      for (const input of inputs) {
        const replacing = replaceName !== '' && input.name === replaceName
        if (createOnly && !replacing && panelNames.has(input.name)) {
          throw new Error('已存在 MCP 服务「' + input.name + '」，不能重复添加。')
        }
        // A rename may only replace the row it names. Without this guard a
        // non-createOnly save could silently overwrite a different panel row
        // that already owns the new name.
        if (replaceName !== '' && input.name !== replaceName && panelNames.has(input.name)) {
          throw new Error('服务名「' + input.name + '」已被面板中的另一条 MCP 配置使用；重命名「' + replaceName + '」不能覆盖其他服务器。')
        }
        if (foreignNames.has(input.name) || foreignInPatch.has(input.name)) {
          const foreign = foreignNames.get(input.name) || foreignInPatch.get(input.name)
          throw new Error('服务名「' + input.name + '」已被插件清单中的条目 ' + (foreign.entryId || '') + ' 使用；请换一个名称，或先在 profile patch / DSH 插件设置中移除该条目。')
        }
      }

      if (replaceName && !inputs.some((input) => input.name === replaceName)) {
        if (!patch.removeServer(replaceName)) throw new Error('要替换的 MCP 服务「' + replaceName + '」不存在')
      }
      for (let index = 0; index < inputs.length; index += 1) {
        patch.upsertServer(inputs[index], { replaceName: index === 0 ? replaceName : '' })
      }
      return {
        requiredIds: inputs
          .filter((input) => input.enabled !== false)
          .map((input) => panelEntryId(input.name)),
      }
    }, () => this.list())
  }

  async deleteServer(payload = {}) {
    const serverName = String(payload.name || '').trim()
    if (!serverName) throw new Error('服务名称不能为空')
    if (!this.canManage) throw new Error('当前 DSH 运行环境没有提供 profileContext，无法删除 MCP 配置')
    return await this.transact(async (patch) => {
      if (!patch.removeServer(serverName)) {
        const foreign = (await this.foreignNameMap()).get(serverName)
          || patch.rows().find((row) => !row.panelManaged && row.serverName === serverName)
        if (foreign) {
          throw new Error('该服务器来自 DSH 插件清单（可能由 Magpie 等第三方工具写入），面板无法删除；请在 DSH 插件设置或 profile patch 中移除对应条目。')
        }
        throw new Error('未找到要删除的 MCP 服务器「' + serverName + '」')
      }
      return { requiredIds: [] }
    }, () => this.list())
  }

  async toggleServer(payload = {}) {
    const serverName = String(payload.name || '').trim()
    if (!serverName) throw new Error('服务名称不能为空')
    const enabled = payload.enabled !== false

    return await this.enqueue(async () => {
      if (this.canManage) {
        const { patch } = await this.readPatch()
        if (patch.hasServer(serverName)) {
          return await this.transactInner(async (current) => {
            if (!current.setEnabled(serverName, enabled)) {
              throw new Error('未找到面板管理的 MCP 服务器「' + serverName + '」')
            }
            return { requiredIds: enabled ? [panelEntryId(serverName)] : [] }
          }, () => this.list())
        }
      }

      const inventory = await readMcpInventory(this.ctx)
      const entry = inventory.entries.find((item) => !isPanelEntryId(item.patchId || item.entryId) && item.serverName === serverName)
      if (!entry) throw new Error('未找到 MCP 服务器「' + serverName + '」')
      const result = await setNativeServerEnabled(this.ctx, entry.loaderEntryId || entry.entryId, enabled)
      if (result?.application === 'failed') {
        throw new Error(result?.error?.message || '启停插件清单中的 MCP 条目失败')
      }
      const data = await this.list()
      const extraWarnings = result?.application === 'overridden'
        ? ['该条目的启停被更高优先级的配置覆盖，实际状态可能未改变。']
        : []
      const withWarnings = extraWarnings.length > 0
        ? { ...data, warnings: [...(data.warnings || []), ...extraWarnings] }
        : data
      const restart = result?.application === 'restart-required'
        || (!this.getHmr() && result?.application === undefined)
      return restart
        ? { ...withWarnings, application: 'restart-required', restartReason: result?.restartReason || 'no-hmr' }
        : { ...withWarnings, application: 'applied' }
    })
  }

  async reload() {
    return await this.enqueue(async () => {
      const hmr = this.getHmr()
      if (!this.canManage) {
        const data = await this.list()
        return { ...data, application: 'restart-required', restartReason: 'no-profile' }
      }
      const data = await this.list()
      if (!hmr) return { ...data, application: 'restart-required', restartReason: 'no-hmr' }
      const run = async () => hmr.reconcileProfile([])
      const outcome = typeof hmr.runExclusive === 'function' ? await hmr.runExclusive(run) : await run()
      const restart = outcome?.restartReason ?? outcome?.pending?.[0]?.reason
      const fresh = await this.list()
      return restart === undefined
        ? { ...fresh, application: 'applied' }
        : { ...fresh, application: 'restart-required', restartReason: String(restart) }
    })
  }

  dispose() {
    this.disposed = true
    return this.chain.catch(() => {})
  }
}

function ok(value) {
  return { ok: true, value }
}

function fail(error) {
  return {
    ok: false,
    error: {
      code: 'dsh-mcp-servers-panel/error',
      message: messageOf(error),
      details: {},
    },
  }
}

/** Validate that an incoming request is from a loopback address. */
export function isLoopbackRequest(req) {
  const address = req.socket?.remoteAddress
  if (typeof address !== 'string' || address === '') return false
  if (address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1') return true
  if (address.startsWith('::ffff:')) return address.slice(7).startsWith('127.')
  return address.startsWith('127.')
}

function registerRpc(ctx, manager) {
  ctx.inject(['connection'], (scoped) => {
    const connection = scoped.get('connection')
    if (!connection?.rpc) return

    scoped.effect(() => {
      return connection.rpc.handle(
        RPC_CHANNEL,
        async (endpoint, payload) => {
          try {
            switch (endpoint) {
              case 'list': return ok(await manager.list())
              case 'save': return ok(await manager.saveServer(payload || {}))
              case 'delete': return ok(await manager.deleteServer(payload || {}))
              case 'toggle': return ok(await manager.toggleServer(payload || {}))
              case 'reload': return ok(await manager.reload())
              default: return fail(new Error('未知 RPC 端点: ' + endpoint))
            }
          } catch (error) {
            return fail(error)
          }
        },
        { authority: 'loopback' },
      )
    }, 'dsh-mcp-servers-panel: /dsh-mcp-servers-panel rpc channel')
  })
}

function registerWebServer(ctx, manager) {
  ctx.inject(['webServer'], (scoped) => {
    const webServer = scoped.get('webServer')
    if (!webServer?.register) return

    const sendJson = (res, status, payload) => {
      const body = JSON.stringify(payload)
      res.writeHead(status, {
        'Content-Type': 'application/json;charset=UTF-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
      })
      res.end(body)
    }

    const readJson = async (req) => {
      const chunks = []
      let size = 0
      for await (const chunk of req) {
        size += chunk.length
        if (size > MAX_BODY_BYTES) throw new Error('请求体过大')
        chunks.push(chunk)
      }
      if (chunks.length === 0) return {}
      return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    }

    const routes = [
      ['list', (body) => manager.list(body || {})],
      ['save', (body) => manager.saveServer(body || {})],
      ['delete', (body) => manager.deleteServer(body || {})],
      ['toggle', (body) => manager.toggleServer(body || {})],
      ['reload', () => manager.reload()],
    ]

    for (const [route, action] of routes) {
      scoped.effect(() => {
        return webServer.register({
          kind: 'exact',
          path: WEB_API_PREFIX + '/' + route,
          handler: async (req, res) => {
            if (!isLoopbackRequest(req)) {
              return sendJson(res, 403, fail(new Error('仅允许本地回环访问')))
            }
            try {
              const body = req.method === 'POST' ? await readJson(req) : {}
              sendJson(res, 200, ok(await action(body)))
            } catch (error) {
              sendJson(res, 200, fail(error))
            }
          },
        })
      })
    }
  })
}

export function apply(ctx) {
  const manager = new McpManager(ctx)
  registerRpc(ctx, manager)
  registerWebServer(ctx, manager)
  if (manager.canManage) {
    ctx.logger?.info?.('[dsh-mcp-servers-panel] 管理 Profile patch: ' + manager.patchPath)
  } else {
    ctx.logger?.warn?.('[dsh-mcp-servers-panel] 未找到 profileContext，面板以只读模式运行')
  }
  ctx.effect(() => () => manager.dispose(), 'dsh-mcp-servers-panel: dispose')
  return async () => {
    await manager.dispose()
  }
}

export {
  PANEL_ENTRY_PREFIX,
  ProfilePatch,
  normalizeIncomingList,
  normalizeServerInput,
  panelEntryId,
}
