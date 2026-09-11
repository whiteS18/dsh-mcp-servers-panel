/**
 * dsh-mcp-servers-panel — Host / Node half.
 *
 * Manages MCP servers across User (Global) and Workspace scopes:
 * - User scope: ~/.dsh/mcp.json
 * - Workspace scope: <workspacePath>/.dsh/mcp.json
 *
 * Supports discovering all configured workspaces from DSH storages/runtime.
 * Launches MCP servers, communicates via standard JSON-RPC 2.0 (stdio or streamable-http),
 * registers discovered tools to `ctx.tools`, and provides loopback RPC/HTTP endpoints.
 */

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdir, readFile, writeFile, access } from 'node:fs/promises'
import { constants as fsConstants, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, dirname, basename } from 'node:path'

export const name = 'dsh-mcp-servers-panel'
export const inject = ['tools']

export const RPC_CHANNEL = '/dsh-mcp-panel'
export const WEB_API_PREFIX = '/api/dsh-mcp-panel'

const PROTOCOL_VERSION = '2024-11-05'
const DEFAULT_TIMEOUT_MS = 60000
const MAX_BODY_BYTES = 256 * 1024

/**
 * Augment process.env.PATH with standard user bin directories on macOS/Linux
 * so spawned processes like `npx`, `uvx`, `node`, `python3` can be resolved
 * even when DSH is launched from a desktop GUI environment without shell PATH.
 */
function getAugmentedEnv(customEnv = {}) {
  const currentPath = process.env.PATH || ''
  const home = homedir()
  const extraPaths = [
    join(home, '.local', 'share', 'mise', 'shims'),
    join(home, '.cargo', 'bin'),
    join(home, '.local', 'bin'),
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/local/sbin',
    join(home, '.nvm', 'current', 'bin'),
    join(home, '.orbstack', 'bin'),
  ].filter((p) => {
    try {
      return existsSync(p)
    } catch {
      return false
    }
  })

  const existingParts = new Set(currentPath.split(':'))
  const toAdd = extraPaths.filter((p) => !existingParts.has(p))
  const augmentedPath = toAdd.length > 0 ? `${toAdd.join(':')}:${currentPath}` : currentPath

  return {
    ...process.env,
    PATH: augmentedPath,
    ...(customEnv || {}),
  }
}

/**
 * Validate that incoming request is from a loopback address to prevent RCE.
 */
export function isLoopbackRequest(req) {
  const address = req.socket?.remoteAddress
  if (typeof address !== 'string' || address === '') return false
  if (address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1') return true
  if (address.startsWith('::ffff:')) return address.slice(7).startsWith('127.')
  return address.startsWith('127.')
}

export function sameResolvedPath(a, b) {
  if (!a || !b) return false
  try {
    return resolve(a) === resolve(b)
  } catch {
    return false
  }
}

export function makeRunnerKey(scope, workspacePath, name) {
  if (scope === 'user') return `user::${name}`
  const ws = pickWorkspaceRoot(workspacePath) || ''
  return `workspace:${ws}:${name}`
}

function pickWorkspaceRoot(candidate) {
  if (typeof candidate !== 'string' || !candidate.trim()) return ''
  const resolved = resolve(candidate)
  if (sameResolvedPath(resolved, homedir())) return ''
  return resolved
}

export function defaultWorkspaceRoot(ctx) {
  try {
    const sandboxPolicy = ctx?.get?.('sandboxPolicy')
    const fromSandbox = pickWorkspaceRoot(sandboxPolicy?.workspaceRoot)
    if (fromSandbox) return fromSandbox
  } catch {}

  try {
    const session = ctx?.get?.('session')
    const fromSession = pickWorkspaceRoot(session?.header?.cwd)
    if (fromSession) return fromSession
  } catch {}

  if (process.env.DSH_WORKSPACE) {
    const fromEnv = pickWorkspaceRoot(process.env.DSH_WORKSPACE)
    if (fromEnv && existsSync(fromEnv)) return fromEnv
  }

  const fromCwd = pickWorkspaceRoot(process.cwd())
  if (fromCwd && (existsSync(join(fromCwd, '.dsh', 'mcp.json')) || existsSync(join(fromCwd, '.dsh')))) {
    return fromCwd
  }

  return fromCwd
}

/**
 * Read known workspaces from ~/.dsh/storages/workspace.json if present
 */
export async function getKnownWorkspaces(ctx) {
  const map = new Map()

  // 1. Storage file ~/.dsh/storages/workspace.json
  const storagePath = join(homedir(), '.dsh', 'storages', 'workspace.json')
  try {
    if (existsSync(storagePath)) {
      const data = JSON.parse(await readFile(storagePath, 'utf8'))
      const workspaces = data?.tables?.workspaces || {}
      for (const [id, item] of Object.entries(workspaces)) {
        if (item?.path && existsSync(item.path) && !sameResolvedPath(item.path, homedir())) {
          map.set(item.path, {
            id,
            path: item.path,
            title: item.title || basename(item.path),
          })
        }
      }
    }
  } catch {}

  // 2. Active default workspace
  const current = defaultWorkspaceRoot(ctx)
  if (current && !map.has(current)) {
    map.set(current, {
      id: 'active',
      path: current,
      title: basename(current) || current,
    })
  }

  return Array.from(map.values())
}

export function userConfigPath() {
  const p1 = join(homedir(), '.dsh', 'mcp.json')
  const p2 = join(homedir(), '.dsh', 'mcp-servers.json')
  if (existsSync(p1)) return p1
  if (existsSync(p2)) return p2
  return p1
}

export function workspaceConfigPath(workspacePath, ctx) {
  const root = pickWorkspaceRoot(workspacePath) || defaultWorkspaceRoot(ctx)
  if (!root) return ''
  return join(root, '.dsh', 'mcp.json')
}

async function fileExists(path) {
  try {
    await access(path, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

async function readJsonSafe(path, fallback = null) {
  try {
    const raw = await readFile(path, 'utf8')
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

async function writeJsonPretty(path, data) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(data, null, 2) + '\n', 'utf8')
}

/**
 * Normalizes various MCP configuration structures into a standard array:
 * Supports:
 * - { version: 1, servers: [ { name, ... } ] }
 * - { mcpServers: { "name": { ... } } }
 * - { servers: { "name": { ... } } }
 * - [ { name, ... } ]
 * - { "name": { command, ... } }
 */
export function normalizeServerList(raw, scope = 'workspace', workspacePath = '') {
  if (!raw) return []
  const list = []
  const normalizedScope = scope === 'user' ? 'user' : 'workspace'

  if (Array.isArray(raw?.servers)) {
    for (const item of raw.servers) {
      if (!item || typeof item !== 'object') continue
      const name = String(item.name || '').trim()
      if (!name) continue
      list.push(normalizeServerItem(name, item, normalizedScope, workspacePath))
    }
    return list
  }

  if (raw?.servers && typeof raw.servers === 'object' && !Array.isArray(raw.servers)) {
    for (const [key, value] of Object.entries(raw.servers)) {
      if (!value || typeof value !== 'object') continue
      const name = String(key).trim()
      if (!name) continue
      list.push(normalizeServerItem(name, value, normalizedScope, workspacePath))
    }
    return list
  }

  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue
      const name = String(item.name || '').trim()
      if (!name) continue
      list.push(normalizeServerItem(name, item, normalizedScope, workspacePath))
    }
    return list
  }

  const map = raw?.mcpServers && typeof raw.mcpServers === 'object' ? raw.mcpServers : raw
  if (typeof map === 'object' && map !== null) {
    for (const [key, value] of Object.entries(map)) {
      if (key === 'version' || key === '$schema') continue
      if (!value || typeof value !== 'object') continue
      const name = String(key).trim()
      if (!name) continue
      list.push(normalizeServerItem(name, value, normalizedScope, workspacePath))
    }
  }

  return list
}

function normalizeServerItem(name, item, scope, workspacePath = '') {
  const transport = item.transport || item.type || (item.url ? 'streamable-http' : 'stdio')
  return {
    name,
    scope: item.scope || (scope === 'user' ? 'user' : 'workspace'),
    workspacePath: scope === 'workspace' ? (item.workspacePath || workspacePath) : '',
    enabled: item.enabled !== false,
    transport: transport === 'sse' || transport === 'http' ? 'streamable-http' : transport,
    command: String(item.command || '').trim(),
    args: Array.isArray(item.args) ? item.args.map(String) : [],
    env: typeof item.env === 'object' && item.env !== null ? { ...item.env } : {},
    cwd: typeof item.cwd === 'string' ? item.cwd : '',
    url: String(item.url || '').trim(),
    headers: typeof item.headers === 'object' && item.headers !== null ? { ...item.headers } : {},
    toolCallTimeoutMs: Number(item.toolCallTimeoutMs) || DEFAULT_TIMEOUT_MS,
  }
}

export function duplicateServerError(names, scope = 'workspace') {
  const label = [...new Set((names || []).filter(Boolean).map(String))].join('、')
  if (scope === 'user') {
    return `全局已添加过 MCP 服务「${label}」，不能再次添加。`
  }
  return `当前工作区已添加过 MCP 服务「${label}」，不能再次添加。`
}

/**
 * Formats a server list into canonical `{ version: 1, servers: [...] }`
 */
export function formatCanonicalConfig(servers) {
  return {
    version: 1,
    servers: servers.map((s) => ({
      name: s.name,
      transport: s.transport,
      enabled: s.enabled !== false,
      toolCallTimeoutMs: s.toolCallTimeoutMs || DEFAULT_TIMEOUT_MS,
      ...(s.transport === 'stdio'
        ? {
            command: s.command,
            args: s.args,
            ...(Object.keys(s.env || {}).length > 0 ? { env: s.env } : {}),
            ...(s.cwd ? { cwd: s.cwd } : {}),
          }
        : {
            url: s.url,
            ...(Object.keys(s.headers || {}).length > 0 ? { headers: s.headers } : {}),
          }),
    })),
  }
}

/**
 * Single MCP Process Runner & Tool Bridge
 */
export class McpProcessRunner {
  constructor(ctx, config, workspaceRoot) {
    this.ctx = ctx
    this.config = config
    this.workspaceRoot = workspaceRoot
    this.status = 'connecting' // 'connecting' | 'connected' | 'error' | 'disabled'
    this.error = null
    this.tools = []
    this.disposers = new Map()
    this.child = null
    this.nextRequestId = 1
    this.pending = new Map()
    this.stopped = false
  }

  async start() {
    if (this.config.enabled === false) {
      this.status = 'disabled'
      return
    }

    if (this.config.transport === 'stdio') {
      await this.startStdio()
    } else {
      await this.startHttp()
    }
  }

  async startStdio() {
    const { command, args, env, cwd, name } = this.config
    if (!command) {
      this.status = 'error'
      this.error = '未配置可执行命令 (command)'
      return
    }

    const preferredCwd = cwd
      ? resolve(this.workspaceRoot || process.cwd(), cwd)
      : this.workspaceRoot
    const effectiveCwd = preferredCwd && existsSync(preferredCwd) ? preferredCwd : undefined

    try {
      this.child = spawn(command, args || [], {
        ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
        env: getAugmentedEnv(env),
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (err) {
      this.status = 'error'
      this.error = `启动进程失败: ${err.message}`
      return
    }

    this.child.on('error', (err) => {
      this.status = 'error'
      this.error = `进程错误: ${err.message}`
      this.cleanupPending(err)
      this.unregisterTools()
    })

    this.child.on('exit', (code, signal) => {
      if (this.stopped) return
      this.status = 'error'
      this.error = `进程已退出 (code: ${code}, signal: ${signal})`
      this.cleanupPending(new Error(`MCP 进程 ${name} 意外退出`))
      this.unregisterTools()
    })

    const rl = createInterface({ input: this.child.stdout })
    rl.on('line', (line) => {
      this.handleLine(line)
    })

    let stderrBuffer = ''
    this.child.stderr.on('data', (data) => {
      stderrBuffer = (stderrBuffer + data.toString()).slice(-1000)
    })

    try {
      // 1. Send initialize
      await this.sendRequest('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'dsh-mcp-servers-panel', version: '0.1.0' },
      })

      // 2. Send initialized notification
      this.sendNotification('notifications/initialized', {})

      // 3. Request tools/list
      const listResult = await this.sendRequest('tools/list', {})
      const tools = Array.isArray(listResult?.tools) ? listResult.tools : []
      this.tools = tools.map((t) => ({
        name: `mcp__${this.config.name}__${t.name}`,
        rawName: t.name,
        description: t.description || '',
        inputSchema: t.inputSchema || { type: 'object' },
      }))

      this.registerTools()
      this.status = 'connected'
      this.error = null
    } catch (err) {
      this.status = 'error'
      this.error = `初始化失败: ${err.message}${stderrBuffer ? ` (${stderrBuffer.trim().slice(-200)})` : ''}`
      this.unregisterTools()
    }
  }

  async startHttp() {
    const { url } = this.config
    if (!url) {
      this.status = 'error'
      this.error = '未配置服务端点 URL'
      return
    }

    try {
      await this.httpCall('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'dsh-mcp-servers-panel', version: '0.1.0' },
      })

      const listResult = await this.httpCall('tools/list', {})
      const tools = Array.isArray(listResult?.tools) ? listResult.tools : []
      this.tools = tools.map((t) => ({
        name: `mcp__${this.config.name}__${t.name}`,
        rawName: t.name,
        description: t.description || '',
        inputSchema: t.inputSchema || { type: 'object' },
      }))

      this.registerTools()
      this.status = 'connected'
      this.error = null
    } catch (err) {
      this.status = 'error'
      this.error = `HTTP 连接失败: ${err.message}`
      this.unregisterTools()
    }
  }

  async httpCall(method, params) {
    const { url, headers, toolCallTimeoutMs } = this.config
    const id = this.nextRequestId++
    const body = { jsonrpc: '2.0', id, method, params }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), toolCallTimeoutMs || DEFAULT_TIMEOUT_MS)

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          ...(headers || {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`)
      const json = await response.json()
      if (json.error) throw new Error(json.error.message || `RPC Error: ${JSON.stringify(json.error)}`)
      return json.result
    } finally {
      clearTimeout(timeout)
    }
  }

  handleLine(line) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return
    try {
      const msg = JSON.parse(trimmed)
      if (typeof msg.id === 'number' || typeof msg.id === 'string') {
        const handler = this.pending.get(msg.id)
        if (handler) {
          this.pending.delete(msg.id)
          clearTimeout(handler.timer)
          if (msg.error) {
            handler.reject(new Error(msg.error.message || `MCP Error: ${JSON.stringify(msg.error)}`))
          } else {
            handler.resolve(msg.result)
          }
        }
      }
    } catch {}
  }

  sendRequest(method, params) {
    return new Promise((resolve, reject) => {
      if (!this.child || !this.child.stdin.writable) {
        return reject(new Error('MCP 进程不可写或未就绪'))
      }
      const id = this.nextRequestId++
      const timeoutMs = this.config.toolCallTimeoutMs || DEFAULT_TIMEOUT_MS
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`调用超时 (${timeoutMs}ms): ${method}`))
        }
      }, timeoutMs)

      this.pending.set(id, { resolve, reject, timer })
      const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }) + '\n'
      this.child.stdin.write(payload)
    })
  }

  sendNotification(method, params) {
    if (!this.child || !this.child.stdin.writable) return
    const payload = JSON.stringify({ jsonrpc: '2.0', method, params: params || {} }) + '\n'
    this.child.stdin.write(payload)
  }

  cleanupPending(err) {
    for (const [, item] of this.pending.entries()) {
      clearTimeout(item.timer)
      item.reject(err)
    }
    this.pending.clear()
  }

  registerTools() {
    this.unregisterTools()
    if (!this.ctx?.tools?.register) return

    for (const tool of this.tools) {
      try {
        const inputSchema = tool.inputSchema && typeof tool.inputSchema === 'object'
          ? { ...tool.inputSchema }
          : { type: 'object', properties: {} }
        delete inputSchema.$schema

        const definition = {
          name: tool.name,
          description: tool.description || `MCP 工具 (${this.config.name})`,
          parameters: inputSchema,
          output: {
            schema: {
              type: 'object',
              properties: {
                content: { type: 'array', items: {} },
              },
            },
            render: (_args, result) => {
              if (result && Array.isArray(result.content)) {
                return result.content
              }
              return [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }]
            },
          },
          presentCall: (args) => ({
            card: 'generic',
            title: `${tool.name}: ${JSON.stringify(args || {}).slice(0, 60)}`,
          }),
          presentResult: (_args, result) => ({
            card: 'generic',
            content: Array.isArray(result?.content) ? result.content.filter((b) => b.type === 'text') : [],
          }),
          execute: async (args, exec) => {
            return await this.callTool(tool.rawName, args, exec?.signal)
          },
        }

        const dispose = this.ctx.tools.register(definition)
        if (typeof dispose === 'function') {
          this.disposers.set(tool.name, dispose)
        }
      } catch (err) {
        this.ctx.logger?.warn?.(`[dsh-mcp-servers-panel] 注册工具 ${tool.name} 失败: ${err.message}`)
      }
    }
  }

  async callTool(rawName, args, signal) {
    if (this.status !== 'connected') {
      throw new Error(`MCP 服务 ${this.config.name} 当前处于不可用状态 (${this.status}): ${this.error || '未连接'}`)
    }

    if (signal?.aborted) {
      throw new Error('操作已中止')
    }

    let result
    if (this.config.transport === 'stdio') {
      result = await this.sendRequest('tools/call', {
        name: rawName,
        arguments: args || {},
      })
    } else {
      result = await this.httpCall('tools/call', {
        name: rawName,
        arguments: args || {},
      })
    }

    if (!result) return { content: [] }
    if (result.isError) {
      const errText = Array.isArray(result.content)
        ? result.content.map((c) => c.text || JSON.stringify(c)).join('\n')
        : 'MCP 工具执行返回错误'
      throw new Error(errText)
    }

    if (Array.isArray(result.content)) {
      return { content: result.content }
    }
    return { content: [{ type: 'text', text: JSON.stringify(result) }] }
  }

  unregisterTools() {
    for (const dispose of this.disposers.values()) {
      try {
        dispose()
      } catch {}
    }
    this.disposers.clear()
  }

  stop() {
    this.stopped = true
    this.unregisterTools()
    this.cleanupPending(new Error('MCP 服务已停止'))

    if (this.child) {
      try {
        this.child.kill('SIGTERM')
        this.child.unref?.()
        setTimeout(() => {
          if (this.child && !this.child.killed) {
            this.child.kill('SIGKILL')
          }
        }, 3000)
      } catch {}
      this.child = null
    }
    this.status = 'disabled'
  }

  describe() {
    return {
      name: this.config.name,
      scope: this.config.scope,
      workspacePath: this.config.workspacePath,
      transport: this.config.transport,
      enabled: this.config.enabled !== false,
      command: this.config.command,
      args: this.config.args,
      env: this.config.env,
      cwd: this.config.cwd,
      url: this.config.url,
      headers: this.config.headers,
      toolCallTimeoutMs: this.config.toolCallTimeoutMs,
      status: this.status,
      error: this.error,
      toolCount: this.tools.length,
      tools: this.tools,
    }
  }
}

/**
 * MCP Manager Core: coordinates persistence, reconciliation, and queries.
 */
export class McpManager {
  constructor(ctx, options = {}) {
    this.ctx = ctx
    this.runners = new Map() // key: `${scope}:${workspacePath || ''}:${name}`
    this.activeWorkspace = options.activeWorkspace || defaultWorkspaceRoot(ctx)
    this.userConfigPathOverride = options.userConfigPath || ''
    this.watchedWorkspaces = new Set()
    this.watchWorkspace(this.activeWorkspace)
  }

  resolveUserConfigPath() {
    return this.userConfigPathOverride || userConfigPath()
  }

  resolveWorkspaceConfigPath(workspacePath = '') {
    const wsPath = workspaceConfigPath(workspacePath || this.activeWorkspace, this.ctx)
    if (wsPath && sameResolvedPath(wsPath, this.resolveUserConfigPath())) return ''
    return wsPath
  }

  watchWorkspace(workspacePath) {
    const ws = pickWorkspaceRoot(workspacePath)
    if (ws && this.resolveWorkspaceConfigPath(ws)) this.watchedWorkspaces.add(ws)
    return ws
  }

  setWorkspaceRoot(root) {
    const next = this.watchWorkspace(root)
    if (next && next !== this.activeWorkspace) {
      this.activeWorkspace = next
      this.reconcile()
    }
  }

  /**
   * Reads user servers and workspace servers.
   * If workspacePath is specified, reads that workspace.
   */
  async readScopeServers(scope = 'all', workspacePath = '') {
    const wsTarget = pickWorkspaceRoot(workspacePath) || this.activeWorkspace
    const userPath = this.resolveUserConfigPath()
    const wsPath = this.resolveWorkspaceConfigPath(wsTarget)

    let userServers = []
    let wsServers = []

    if (scope === 'all' || scope === 'user') {
      const userRaw = await readJsonSafe(userPath, null)
      userServers = normalizeServerList(userRaw, 'user', '')
    }

    if ((scope === 'all' || scope === 'workspace') && wsPath) {
      const wsRaw = await readJsonSafe(wsPath, null)
      wsServers = normalizeServerList(wsRaw, 'workspace', wsTarget)
    }

    return { userServers, wsServers, userPath, wsPath, workspacePath: wsTarget }
  }

  async reconcile() {
    const { userServers } = await this.readScopeServers('user')
    const desired = new Map()

    for (const s of userServers) {
      desired.set(makeRunnerKey('user', '', s.name), s)
    }

    this.watchWorkspace(this.activeWorkspace)
    const workspaceRoots = new Set(this.watchedWorkspaces)
    for (const ws of workspaceRoots) {
      const { wsServers } = await this.readScopeServers('workspace', ws)
      for (const s of wsServers) {
        desired.set(makeRunnerKey('workspace', ws, s.name), s)
      }
    }

    // Stop removed runners
    for (const [key, runner] of this.runners.entries()) {
      if (!desired.has(key)) {
        runner.stop()
        this.runners.delete(key)
      }
    }

    // Start or update runners
    for (const [key, config] of desired.entries()) {
      const existing = this.runners.get(key)
      const runnerWorkspace = config.scope === 'workspace'
        ? (pickWorkspaceRoot(config.workspacePath) || this.activeWorkspace)
        : (this.activeWorkspace || undefined)
      if (!existing) {
        const runner = new McpProcessRunner(this.ctx, config, runnerWorkspace)
        this.runners.set(key, runner)
        try {
          await runner.start()
        } catch (err) {
          runner.status = 'error'
          runner.error = err.message
        }
      } else {
        const currentSnap = JSON.stringify(existing.config)
        const newSnap = JSON.stringify(config)
        if (currentSnap !== newSnap) {
          existing.stop()
          const runner = new McpProcessRunner(this.ctx, config, runnerWorkspace)
          this.runners.set(key, runner)
          try {
            await runner.start()
          } catch (err) {
            runner.status = 'error'
            runner.error = err.message
          }
        }
      }
    }
  }

  /**
   * Filtered list of servers based on query:
   * scope: 'all' | 'user' | 'workspace'
   * workspacePath: target directory
   */
  async list({ scope = 'all', workspacePath = '' } = {}) {
    const targetWs = pickWorkspaceRoot(workspacePath) || this.activeWorkspace
    if (scope === 'workspace' && targetWs) this.watchWorkspace(targetWs)
    await this.reconcile()
    const { userServers, wsServers, userPath, wsPath } = await this.readScopeServers(scope, targetWs)
    const knownWorkspaces = await getKnownWorkspaces(this.ctx)

    const list = []

    if (scope === 'workspace') {
      for (const s of wsServers) {
        const key = makeRunnerKey('workspace', targetWs, s.name)
        const runner = this.runners.get(key)
        list.push(
          runner
            ? runner.describe()
            : { ...s, status: s.enabled ? 'error' : 'disabled', error: s.enabled ? '未能启动 MCP 进程' : '', toolCount: 0, tools: [] }
        )
      }
    } else if (scope === 'user') {
      for (const s of userServers) {
        const key = makeRunnerKey('user', '', s.name)
        const runner = this.runners.get(key)
        list.push(
          runner
            ? runner.describe()
            : { ...s, status: s.enabled ? 'error' : 'disabled', error: s.enabled ? '未能启动 MCP 进程' : '', toolCount: 0, tools: [] }
        )
      }
    } else {
      for (const s of wsServers) {
        const key = makeRunnerKey('workspace', targetWs, s.name)
        const runner = this.runners.get(key)
        list.push(
          runner
            ? runner.describe()
            : { ...s, status: s.enabled ? 'error' : 'disabled', error: s.enabled ? '未能启动 MCP 进程' : '', toolCount: 0, tools: [] }
        )
      }
      for (const s of userServers) {
        const key = makeRunnerKey('user', '', s.name)
        const runner = this.runners.get(key)
        list.push(
          runner
            ? runner.describe()
            : { ...s, status: s.enabled ? 'error' : 'disabled', error: s.enabled ? '未能启动 MCP 进程' : '', toolCount: 0, tools: [] }
        )
      }
    }

    return {
      servers: list,
      activeWorkspace: this.activeWorkspace,
      currentScope: scope,
      currentWorkspacePath: targetWs,
      workspaces: knownWorkspaces,
      userConfigPath: userPath,
      workspaceConfigPath: wsPath,
    }
  }

  resolveTargetPath(scope, workspacePath = '') {
    const targetScope = scope === 'user' ? 'user' : 'workspace'
    const targetWs = targetScope === 'workspace' ? (pickWorkspaceRoot(workspacePath) || this.activeWorkspace) : ''
    if (targetScope === 'user') {
      return { targetScope, targetWs: '', targetPath: this.resolveUserConfigPath() }
    }
    const targetPath = this.resolveWorkspaceConfigPath(targetWs)
    if (!targetWs || !targetPath) {
      throw new Error('未选择有效的项目工作区，无法操作工作区 MCP 配置')
    }
    return { targetScope, targetWs, targetPath }
  }

  async saveServer({ name, server, scope, rawJson, workspacePath, replaceName, createOnly }) {
    const { targetScope, targetWs, targetPath } = this.resolveTargetPath(scope, workspacePath)
    if (targetScope === 'workspace') this.watchWorkspace(targetWs)

    if (rawJson) {
      let parsed
      try {
        parsed = typeof rawJson === 'string' ? JSON.parse(rawJson) : rawJson
      } catch (err) {
        throw new Error(`JSON 解析失败: ${err.message}`)
      }
      const list = normalizeServerList(parsed, targetScope, targetWs)
      if (list.length === 0) {
        throw new Error('未在 JSON 中解析出任何有效的 MCP 服务器配置')
      }
      const incomingNames = new Set(list.map((s) => s.name))
      const currentData = (await readJsonSafe(targetPath, null)) || { version: 1, servers: [] }
      const existingNames = new Set(normalizeServerList(currentData, targetScope, targetWs).map((s) => s.name))
      const duplicates = list
        .map((s) => s.name)
        .filter((itemName) => existingNames.has(itemName) && itemName !== replaceName)
      if ((createOnly || replaceName) && duplicates.length > 0) {
        throw new Error(duplicateServerError(duplicates, targetScope))
      }
      if (replaceName && !incomingNames.has(String(replaceName))) {
        await this.deleteServer({ name: replaceName, scope: targetScope, workspacePath: targetWs })
      }
      for (const s of list) {
        await this.saveServer({ name: s.name, server: s, scope: targetScope, workspacePath: targetWs })
      }
      return await this.list({ scope: targetScope, workspacePath: targetWs })
    }

    if (!name || typeof name !== 'string') throw new Error('服务名称不能为空')
    const cleanName = name.trim()
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(cleanName)) {
      throw new Error('服务名称只能包含字母、数字、下划线和连字符 (1-64位)')
    }

    const currentData = (await readJsonSafe(targetPath, null)) || { version: 1, servers: [] }
    let list = normalizeServerList(currentData, targetScope, targetWs)

    const index = list.findIndex((s) => s.name === cleanName)
    if (createOnly && index >= 0) {
      throw new Error(duplicateServerError([cleanName], targetScope))
    }

    const normalized = normalizeServerItem(cleanName, { ...server, name: cleanName }, targetScope, targetWs)
    if (index >= 0) {
      list[index] = normalized
    } else {
      list.push(normalized)
    }

    await writeJsonPretty(targetPath, formatCanonicalConfig(list))
    await this.reconcile()
    return await this.list({ scope: targetScope, workspacePath: targetWs })
  }

  async deleteServer({ name, scope, workspacePath }) {
    if (!name) throw new Error('服务名称不能为空')
    const { targetScope, targetWs, targetPath } = this.resolveTargetPath(scope, workspacePath)
    const currentData = await readJsonSafe(targetPath, null)
    if (!currentData) return await this.list({ scope: targetScope, workspacePath: targetWs })

    let list = normalizeServerList(currentData, targetScope, targetWs)
    list = list.filter((s) => s.name !== name)

    await writeJsonPretty(targetPath, formatCanonicalConfig(list))
    await this.reconcile()
    return await this.list({ scope: targetScope, workspacePath: targetWs })
  }

  async toggleServer({ name, scope, enabled, workspacePath }) {
    if (!name) throw new Error('服务名称不能为空')
    const { targetScope, targetWs, targetPath } = this.resolveTargetPath(scope, workspacePath)
    const currentData = await readJsonSafe(targetPath, null)
    if (!currentData) return await this.list({ scope: targetScope, workspacePath: targetWs })

    const list = normalizeServerList(currentData, targetScope, targetWs)
    const target = list.find((s) => s.name === name)
    if (target) {
      target.enabled = Boolean(enabled)
      await writeJsonPretty(targetPath, formatCanonicalConfig(list))
      await this.reconcile()
    }
    return await this.list({ scope: targetScope, workspacePath: targetWs })
  }

  dispose() {
    for (const runner of this.runners.values()) {
      runner.stop()
    }
    this.runners.clear()
  }
}

function ok(value) {
  return { ok: true, value }
}

function fail(error) {
  return {
    ok: false,
    error: {
      message: error instanceof Error ? error.message : String(error),
    },
  }
}

/**
 * Registers RPC channel handler on connection.rpc
 */
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
              case 'list': {
                const data = await manager.list(payload || {})
                return ok(data)
              }
              case 'save': {
                const data = await manager.saveServer(payload || {})
                return ok(data)
              }
              case 'delete': {
                const data = await manager.deleteServer(payload || {})
                return ok(data)
              }
              case 'toggle': {
                const data = await manager.toggleServer(payload || {})
                return ok(data)
              }
              case 'reload': {
                await manager.reconcile()
                const data = await manager.list(payload || {})
                return ok(data)
              }
              default:
                return fail(new Error(`未知 RPC 端点: ${endpoint}`))
            }
          } catch (err) {
            return fail(err)
          }
        },
        { authority: 'loopback' },
      )
    }, 'dsh-mcp-servers-panel: /dsh-mcp-panel rpc channel')
  })
}

/**
 * Registers loopback HTTP webServer fallback
 */
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

    const endpoints = [
      {
        path: `${WEB_API_PREFIX}/list`,
        handler: async (req, res) => {
          const body = req.method === 'POST' ? await readJson(req) : {}
          const data = await manager.list(body || {})
          sendJson(res, 200, ok(data))
        },
      },
      {
        path: `${WEB_API_PREFIX}/save`,
        handler: async (req, res) => {
          const body = await readJson(req)
          const data = await manager.saveServer(body)
          sendJson(res, 200, ok(data))
        },
      },
      {
        path: `${WEB_API_PREFIX}/delete`,
        handler: async (req, res) => {
          const body = await readJson(req)
          const data = await manager.deleteServer(body)
          sendJson(res, 200, ok(data))
        },
      },
      {
        path: `${WEB_API_PREFIX}/toggle`,
        handler: async (req, res) => {
          const body = await readJson(req)
          const data = await manager.toggleServer(body)
          sendJson(res, 200, ok(data))
        },
      },
      {
        path: `${WEB_API_PREFIX}/reload`,
        handler: async (req, res) => {
          const body = await readJson(req)
          await manager.reconcile()
          const data = await manager.list(body || {})
          sendJson(res, 200, ok(data))
        },
      },
    ]

    for (const ep of endpoints) {
      scoped.effect(() => {
        return webServer.register({
          kind: 'exact',
          path: ep.path,
          handler: async (req, res) => {
            if (!isLoopbackRequest(req)) {
              return sendJson(res, 403, fail(new Error('仅允许本地回环访问')))
            }
            try {
              await ep.handler(req, res)
            } catch (err) {
              sendJson(res, 200, fail(err))
            }
          },
        })
      })
    }
  })
}

export function apply(ctx) {
  const manager = new McpManager(ctx)

  // Track session cwd changes if session service is mounted
  ctx.inject(['session'], (sessionCtx) => {
    sessionCtx.effect(() => {
      return sessionCtx.session?.on?.('change', (session) => {
        const cwd = session?.header?.cwd
        if (cwd) manager.setWorkspaceRoot(cwd)
      })
    })
  })

  // Register RPC & WebServer routes
  registerRpc(ctx, manager)
  registerWebServer(ctx, manager)

  // Initial reconciliation on startup
  manager.reconcile().catch((err) => {
    ctx.logger?.error?.(`[dsh-mcp-servers-panel] 初始加载失败: ${err.message}`)
  })

  return () => {
    manager.dispose()
  }
}
