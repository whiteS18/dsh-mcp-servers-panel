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

import { createHash } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdir, readFile, writeFile, access } from 'node:fs/promises'
import { constants as fsConstants, existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, dirname, basename, extname, isAbsolute, join, resolve } from 'node:path'

import {
  describeNativeMcpServer,
  nativeMatchesServer,
  readNativeMcpServers,
  setNativeServerEnabled,
} from './native-mcp.js'

export const name = 'dsh-mcp-servers-panel'
export const inject = ['tools']

export const RPC_CHANNEL = '/dsh-mcp-servers-panel'
export const WEB_API_PREFIX = '/api/dsh-mcp-servers-panel'

const PROTOCOL_VERSION = '2024-11-05'
const DEFAULT_TIMEOUT_MS = 60000
const HANDSHAKE_TIMEOUT_MS = 8000
const MAX_BODY_BYTES = 256 * 1024

/** Bounded wait for a killed child to be reaped before we stop waiting. */
const CHILD_EXIT_TIMEOUT_MS = 1500
/** Bounded wait for taskkill to terminate a Windows process tree. */
const TASKKILL_TIMEOUT_MS = 2000
/** Total teardown budget; the host force-exits 5s after shutdown starts. */
const DISPOSE_BUDGET_MS = 3000
/** Delay (ms) before an app-ready native reconciliation runs. */
const APP_READY_SYNC_DELAY_MS = 50

const isWin = process.platform === 'win32'

function pathExts(env = process.env) {
  if (!isWin) return ['']
  const raw = String(env.PATHEXT || '.EXE;.CMD;.BAT;.COM')
  const preferred = ['.CMD', '.EXE', '.BAT']
  const rest = raw.split(';').map((item) => item.trim()).filter(Boolean)
    .map((item) => (item.startsWith('.') ? item : `.${item}`).toUpperCase())
    .filter((ext) => ext && !preferred.includes(ext) && ext !== '.COM' && ext !== '.CPL')
  return [...preferred, ...rest]
}

function extraBinDirs(home) {
  const dirs = [
    dirname(process.execPath),
    join(home, '.local', 'share', 'mise', 'shims'),
    join(home, '.cargo', 'bin'),
    join(home, '.local', 'bin'),
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/local/sbin',
    join(home, '.nvm', 'current', 'bin'),
    join(home, '.orbstack', 'bin'),
    join(home, '.volta', 'bin'),
    join(home, 'scoop', 'shims'),
    join(home, 'AppData', 'Roaming', 'npm'),
    join(home, 'AppData', 'Local', 'pnpm'),
    join(home, 'AppData', 'Local', 'pnpm', 'bin'),
    join(home, 'AppData', 'Local', 'Yarn', 'bin'),
    'C:\\Program Files\\nodejs',
    'C:\\Program Files (x86)\\nodejs',
    process.env.NVM_SYMLINK,
    process.env.NVM_HOME,
    process.env.npm_config_prefix,
  ]
  if (process.env.LOCALAPPDATA) {
    dirs.push(join(process.env.LOCALAPPDATA, 'pnpm'))
    dirs.push(join(process.env.LOCALAPPDATA, 'fnm_multishells'))
  }
  if (process.env.APPDATA) {
    dirs.push(join(process.env.APPDATA, 'npm'))
    dirs.push(join(process.env.APPDATA, 'fnm'))
  }
  return dirs.filter((p) => typeof p === 'string' && p && existsSync(p))
}

/**
 * Augment process.env.PATH with standard user bin directories so spawned
 * processes like `npx`, `uvx`, `node`, `python3` can be resolved even when
 * DSH is launched from a desktop GUI environment without a login-shell PATH.
 */
export function getAugmentedEnv(customEnv = {}) {
  const currentPath = process.env.PATH || process.env.Path || ''
  const extraPaths = extraBinDirs(homedir())
  const existingParts = new Set(currentPath.split(delimiter).filter(Boolean))
  const toAdd = extraPaths.filter((p) => !existingParts.has(p))
  let augmentedPath = toAdd.length > 0 ? `${toAdd.join(delimiter)}${delimiter}${currentPath}` : currentPath

  const custom = { ...(customEnv || {}) }
  const customPath = custom.PATH || custom.Path
  delete custom.PATH
  delete custom.Path
  if (typeof customPath === 'string' && customPath.trim()) {
    const customParts = customPath.split(delimiter).filter(Boolean)
    const known = new Set(augmentedPath.split(delimiter).filter(Boolean))
    const extraCustom = customParts.filter((p) => !known.has(p))
    if (extraCustom.length > 0) {
      augmentedPath = `${augmentedPath}${delimiter}${extraCustom.join(delimiter)}`
    }
  }

  return {
    ...process.env,
    PATH: augmentedPath,
    ...(isWin ? { Path: augmentedPath } : {}),
    ...custom,
  }
}

/**
 * Resolve a command name (`npx`) to a real file (`npx.cmd`) using PATH + PATHEXT.
 * Windows `spawn()` without `shell: true` cannot find extensionless `.cmd` shims.
 */
export function resolveCommandOnPath(command, env = process.env) {
  if (!command || typeof command !== 'string') return command
  const trimmed = command.trim()
  if (!trimmed) return command

  const tryFile = (file) => (file && existsSync(file) ? file : '')
  const hasExt = Boolean(extname(trimmed))
  // Windows 官方 Node 安装同时提供无扩展名的 shebang 脚本（`npx`）和
  // `npx.cmd`。CreateProcess / cmd.exe 都不能把前者当可执行文件跑，
  // 因此无扩展名时只按 PATHEXT 查找（.CMD / .EXE / .BAT …）。
  const names = hasExt || !isWin
    ? [trimmed]
    : pathExts(env).filter(Boolean).map((ext) => trimmed + ext)

  if (isAbsolute(trimmed)) {
    for (const name of names) {
      const hit = tryFile(name)
      if (hit) return hit
    }
    return trimmed
  }

  const pathVal = env.PATH || env.Path || ''
  for (const dir of pathVal.split(delimiter)) {
    if (!dir) continue
    for (const name of names) {
      const hit = tryFile(join(dir, name))
      if (hit) return hit
    }
  }
  return trimmed
}

export function quoteWindowsCmdArg(value) {
  const text = String(value ?? '')
  if (text === '') return '""'
  if (!/[\s"&<>|^()%!]/.test(text)) return text
  return `"${text.replace(/"/g, '\\"')}"`
}

/**
 * Build spawn file/argv for stdio MCP servers.
 * On Windows, `.cmd` / `.bat` (and extensionless shims like `npx`) must go
 * through `cmd.exe`; CreateProcess cannot run them and reports ENOENT/EINVAL.
 */
export function buildStdioSpawnSpec(command, args = [], env = process.env) {
  const resolved = resolveCommandOnPath(command, env)
  const childArgs = Array.isArray(args) ? args.map(String) : []
  if (isWin) {
    const ext = extname(resolved).toLowerCase()
    if (ext === '.cmd' || ext === '.bat') {
      // cmd.exe /S /C 会剥掉整段的首尾引号，所以要再包一层：
      //   /c ""C:\Program Files\nodejs\npx.cmd" -y pkg"
      const line = [resolved, ...childArgs].map(quoteWindowsCmdArg).join(' ')
      return {
        file: process.env.ComSpec || 'cmd.exe',
        argv: ['/d', '/s', '/c', `"${line}"`],
        resolved,
      }
    }
  }
  return { file: resolved, argv: childArgs, resolved }
}

function formatSpawnError(command, resolved, err) {
  const raw = err?.message || String(err)
  if (err?.code === 'ENOENT' || /ENOENT/i.test(raw)) {
    const hint = isWin
      ? 'Windows 上 spawn 不能直接找到无扩展名的 npx/npm（实际是 .cmd）。请确认 Node.js 已安装并加入 PATH，或把 command 改成绝对路径（例如 C:\\Program Files\\nodejs\\npx.cmd）。'
      : '请确认该命令已安装，且 DSH 进程的 PATH 能找到它（从 Dock / 开始菜单启动时往往没有登录 shell 的 PATH）。'
    return `找不到可执行文件「${command}」${resolved && resolved !== command ? `（解析为 ${resolved}）` : ''}。${hint} 原始错误: ${raw}`
  }
  return raw
}

function waitForChildSpawn(child) {
  return new Promise((resolvePromise, reject) => {
    if (!child) return reject(new Error('进程未创建'))
    if (child.exitCode != null || child.signalCode != null) {
      return reject(new Error(`进程已退出 (code: ${child.exitCode}, signal: ${child.signalCode})`))
    }
    if (child.pid) return resolvePromise()
    const onError = (err) => {
      cleanup()
      reject(err)
    }
    const onSpawn = () => {
      cleanup()
      resolvePromise()
    }
    const onExit = (code, signal) => {
      cleanup()
      reject(new Error(`进程已退出 (code: ${code}, signal: ${signal})`))
    }
    const cleanup = () => {
      child.off('error', onError)
      child.off('spawn', onSpawn)
      child.off('exit', onExit)
    }
    child.once('error', onError)
    child.once('spawn', onSpawn)
    child.once('exit', onExit)
  })
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

function liveSessionRoots(ctx) {
  const roots = []
  try {
    const sessions = ctx?.get?.('sessions')
    for (const session of sessions?.list?.() || []) {
      const root = pickWorkspaceRoot(session?.header?.cwd)
      if (root && !roots.includes(root)) roots.push(root)
    }
  } catch {}
  return roots
}

export function defaultWorkspaceRoot(ctx) {
  try {
    const sandboxPolicy = ctx?.get?.('sandboxPolicy')
    const fromSandbox = pickWorkspaceRoot(sandboxPolicy?.workspaceRoot)
    if (fromSandbox) return fromSandbox
  } catch {}

  const [fromSession] = liveSessionRoots(ctx)
  if (fromSession) return fromSession

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

  // Current registry: ctx.workspaceRegistry. Records expose path/title directly.
  try {
    const registry = ctx?.get?.('workspaceRegistry')
    for (const item of registry?.list?.() || []) {
      const path = item?.path || item?.record?.path
      const title = item?.title || item?.record?.title
      const id = item?.id || path
      if (path && existsSync(path) && !sameResolvedPath(path, homedir())) {
        const resolved = resolve(path)
        map.set(resolved, {
          id,
          path: resolved,
          title: title || basename(resolved),
        })
      }
    }
  } catch {}

  // A live session can name a directory that is not registered yet.
  for (const path of liveSessionRoots(ctx)) {
    if (!map.has(path)) {
      map.set(path, {
        id: path,
        path,
        title: basename(path) || path,
      })
    }
  }

  // Active default workspace
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
 * Terminate one spawned MCP child and its descendants.
 *
 * On Windows a plain child.kill() only terminates the immediate wrapper
 * (command npx resolves to cmd.exe/npx.cmd), leaving the real MCP server as an
 * orphan that keeps running after the panel disabled the server. taskkill /T
 * removes the whole tree. Every wait is bounded and timer handles are unref'd
 * so a slow process teardown can never keep the DSH host alive.
 */
function terminateChildTree(child) {
  if (!child) return Promise.resolve()
  const pid = child.pid
  try { child.stdin?.end() } catch {}
  const exited = new Promise((resolveExit) => {
    if (child.exitCode != null || child.signalCode != null) {
      resolveExit()
      return
    }
    const timer = setTimeout(() => resolveExit(), CHILD_EXIT_TIMEOUT_MS)
    timer.unref?.()
    child.once('exit', () => {
      clearTimeout(timer)
      resolveExit()
    })
  })
  const killTree = () => {
    if (!pid) {
      try { child.kill() } catch {}
      return Promise.resolve()
    }
    if (!isWin) {
      try { child.kill('SIGTERM') } catch {}
      const force = setTimeout(() => {
        if (child.exitCode == null && child.signalCode == null) {
          try { child.kill('SIGKILL') } catch {}
        }
      }, 1500)
      force.unref?.()
      return Promise.resolve()
    }
    // Terminate the wrapper immediately, then remove descendants with
    // taskkill (a .cmd wrapper alone would leave the real server running).
    try { child.kill() } catch {}
    return new Promise((resolveKill) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        resolveKill()
      }
      const killer = execFile('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        timeout: TASKKILL_TIMEOUT_MS,
      }, () => finish())
      killer.on?.('error', finish)
      killer.unref?.()
    })
  }
  return killTree()
    .catch(() => {})
    .then(() => {
      try { child.stdout?.destroy() } catch {}
      try { child.stderr?.destroy() } catch {}
      child.unref?.()
      return exited
    })
}

/**
 * Resolve when the promise settles or the budget expires, whichever is first.
 * Never rejects. Used to keep host shutdown inside the desktop shell's grace
 * window even when a child or an HMR transaction is slow to settle.
 */
function settleWithin(promise, budgetMs) {
  return new Promise((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(finish, budgetMs)
    timer.unref?.()
    Promise.resolve(promise).then(finish, finish)
  })
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
    this.disposed = false
    this.stdoutRl = null
    this.stopPromise = null
    this.controllers = new Set()
  }

  get disposedOrStopped() {
    return this.stopped || this.disposed
  }

  async start() {
    if (this.disposedOrStopped) return
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
    const fallbackCwd = existsSync(process.cwd()) ? process.cwd() : tmpdir()
    const effectiveCwd = preferredCwd && existsSync(preferredCwd) ? preferredCwd : fallbackCwd
    const childEnv = getAugmentedEnv(env)
    const spawnSpec = buildStdioSpawnSpec(command, args || [], childEnv)
    const resolvedCommand = spawnSpec.resolved

    if (isWin && (isAbsolute(resolvedCommand) ? !existsSync(resolvedCommand) : resolvedCommand === command)) {
      this.status = 'error'
      this.error = `启动进程失败: ${formatSpawnError(command, resolvedCommand, Object.assign(new Error(`spawn ${command} ENOENT`), { code: 'ENOENT' }))}`
      return
    }

    try {
      this.child = spawn(spawnSpec.file, spawnSpec.argv, {
        cwd: effectiveCwd,
        env: childEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        windowsVerbatimArguments: isWin && spawnSpec.file !== resolvedCommand,
      })
    } catch (err) {
      this.status = 'error'
      this.error = `启动进程失败: ${formatSpawnError(command, resolvedCommand, err)}`
      return
    }

    const spawned = waitForChildSpawn(this.child)

    this.child.on('error', (err) => {
      if (this.disposedOrStopped) return
      this.status = 'error'
      this.error = `进程错误: ${formatSpawnError(command, resolvedCommand, err)}`
      this.cleanupPending(err)
      this.unregisterTools()
    })

    this.child.on('exit', (code, signal) => {
      if (this.disposedOrStopped) return
      this.status = 'error'
      this.error = `进程已退出 (code: ${code}, signal: ${signal})`
      this.cleanupPending(new Error(`MCP 进程 ${name} 意外退出`))
      this.unregisterTools()
    })

    if (this.child.stdout) {
      this.stdoutRl = createInterface({ input: this.child.stdout })
      this.stdoutRl.on('line', (line) => {
        this.handleLine(line)
      })
    }

    let stderrBuffer = ''
    this.child.stderr?.on('data', (data) => {
      stderrBuffer = (stderrBuffer + data.toString()).slice(-1000)
    })

    try {
      await spawned
      if (this.disposedOrStopped) {
        this.unregisterTools()
        return
      }

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
        name: publicToolName(this.config.name, t.name),
        rawName: t.name,
        description: t.description || '',
        inputSchema: t.inputSchema || { type: 'object' },
      }))

      if (this.disposedOrStopped) {
        this.unregisterTools()
        return
      }
      this.registerTools()
      this.status = 'connected'
      this.error = null
    } catch (err) {
      if (this.disposedOrStopped) {
        this.unregisterTools()
        return
      }
      this.status = 'error'
      const spawnDetail = formatSpawnError(command, resolvedCommand, err)
      this.error = `初始化失败: ${spawnDetail}${stderrBuffer ? ` (${stderrBuffer.trim().slice(-200)})` : ''}`
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
      }, HANDSHAKE_TIMEOUT_MS)

      const listResult = await this.httpCall('tools/list', {}, HANDSHAKE_TIMEOUT_MS)
      const tools = Array.isArray(listResult?.tools) ? listResult.tools : []
      this.tools = tools.map((t) => ({
        name: publicToolName(this.config.name, t.name),
        rawName: t.name,
        description: t.description || '',
        inputSchema: t.inputSchema || { type: 'object' },
      }))

      if (this.disposedOrStopped) {
        this.unregisterTools()
        return
      }
      this.registerTools()
      this.status = 'connected'
      this.error = null
    } catch (err) {
      if (this.disposedOrStopped) {
        this.unregisterTools()
        return
      }
      this.status = 'error'
      this.error = `HTTP 连接失败: ${err.message}`
      this.unregisterTools()
    }
  }

  async httpCall(method, params, timeoutMs) {
    const { url, headers, toolCallTimeoutMs } = this.config
    const id = this.nextRequestId++
    const body = { jsonrpc: '2.0', id, method, params }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs || toolCallTimeoutMs || DEFAULT_TIMEOUT_MS)
    timeout.unref?.()
    this.controllers.add(controller)

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
      this.controllers.delete(controller)
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
      if (this.disposedOrStopped) {
        return reject(new Error('MCP 服务已停止'))
      }
      if (!this.child || !this.child.stdin?.writable) {
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
      timer.unref?.()

      this.pending.set(id, { resolve, reject, timer })
      const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }) + '\n'
      this.child.stdin.write(payload)
    })
  }

  sendNotification(method, params) {
    if (!this.child || !this.child.stdin?.writable) return
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
    if (this.disposedOrStopped) return
    if (!this.ctx?.tools?.register) return

    for (const tool of this.tools) {
      if (this.disposedOrStopped) return
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
        } else if (dispose && typeof dispose.then === 'function') {
          // Async disposable: keep a synchronous unregister wrapper.
          this.disposers.set(tool.name, () => {
            Promise.resolve(dispose).then((fn) => {
              if (typeof fn === 'function') fn()
            }).catch(() => {})
          })
        }
      } catch (err) {
        this.ctx.logger?.warn?.(`[dsh-mcp-servers-panel] 注册工具 ${tool.name} 失败: ${err.message}`)
      }
    }
  }

  async callTool(rawName, args, signal) {
    if (this.disposedOrStopped) {
      throw new Error(`MCP 服务 ${this.config.name} 已停止`)
    }
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
    const entries = [...this.disposers.entries()]
    this.disposers.clear()
    for (const [, dispose] of entries) {
      try {
        const result = dispose()
        if (result && typeof result.catch === 'function') result.catch(() => {})
      } catch {}
    }
  }

  /**
   * Idempotent teardown. Resolves once the child (and on Windows its process
   * tree) is gone, or after a bounded wait; never rejects. Safe to call while
   * a connection attempt is still in flight: the pending handshake rejects,
   * start() sees the disposed flag and never registers tools.
   */
  stop() {
    if (this.stopPromise) return this.stopPromise
    this.stopped = true
    this.disposed = true
    this.unregisterTools()
    this.cleanupPending(new Error('MCP 服务已停止'))
    for (const controller of [...this.controllers]) {
      try { controller.abort() } catch {}
    }
    this.controllers.clear()

    if (this.stdoutRl) {
      try { this.stdoutRl.close() } catch {}
      this.stdoutRl = null
    }

    const child = this.child
    this.child = null
    this.status = 'disabled'

    this.stopPromise = terminateChildTree(child).catch(() => {})
    return this.stopPromise
  }

  describe() {
    return {
      name: this.config.name,
      scope: this.config.scope,
      workspacePath: this.config.workspacePath,
      source: 'panel',
      readonly: false,
      controllable: true,
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
    this.runners = new Map() // key: scope:workspacePath:name
    this.activeWorkspace = options.activeWorkspace || defaultWorkspaceRoot(ctx)
    this.userConfigPathOverride = options.userConfigPath || ''
    this.watchedWorkspaces = new Set()
    this.disposed = false
    this.disposePromise = null
    this.generation = 0
    this.reconcileChain = Promise.resolve()
    this.hasPluginManager = false
    this.nativeServers = []
    this.nativeByName = new Map()
    this.nativeSyncFailures = new Map()
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
      this.reconcile().catch((err) => this.logWarn('工作区切换后同步 MCP 失败: ' + err.message))
    }
  }

  logWarn(message) {
    this.ctx?.logger?.warn?.('[dsh-mcp-servers-panel] ' + message)
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

  /**
   * Serialized reconciliation. Every caller (startup, UI refresh, toggle,
   * save, delete, session workspace switch) joins one chain, so two runs can
   * never race: a stale run that started before a toggle could otherwise
   * spawn a server with the old enabled state after stop() released the tools.
   */
  reconcile(options = {}) {
    if (this.disposed) return Promise.resolve()
    const run = this.reconcileChain.then(() => this.reconcileOnce(options))
    this.reconcileChain = run.catch(() => {})
    return run
  }

  async readNativeServers() {
    let pluginManager
    try {
      pluginManager = this.ctx?.get?.('pluginManager')
    } catch {}
    this.hasPluginManager = Boolean(pluginManager && typeof pluginManager.setPluginEnabled === 'function')
    try {
      return await readNativeMcpServers(this.ctx)
    } catch {
      return []
    }
  }

  canControlNative(native) {
    return this.hasPluginManager && Boolean(native) && !native.readOnlyReason
  }

  /** Align one native MCP plugin row with the panel's enabled state. */
  async syncNativeServer(native, enabled) {
    if (!this.canControlNative(native)) return false
    if (native.enabled === enabled) return true
    const previous = this.nativeSyncFailures.get(native.entryId)
    if (previous && previous.enabled === enabled) return false
    try {
      await setNativeServerEnabled(this.ctx, native, enabled)
      native.enabled = enabled
      native.fiberPhase = enabled ? 'loading' : null
      this.nativeSyncFailures.delete(native.entryId)
      this.ctx?.logger?.info?.('[dsh-mcp-servers-panel] 已同步插件清单中的 MCP 条目 ' + native.serverName + ': ' + (enabled ? '启用' : '禁用'))
      return true
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // A reconcile triggered by plugin HMR can inherit the HMR async context
      // and refuse to nest another HMR transaction. That is transient: the next
      // UI refresh runs outside the transaction and may retry, so it must not
      // be cached as a permanent failure.
      if (/HMR transactions cannot be nested|HMR is disposed/.test(message)) {
        this.logWarn('待 HMR 空闲后重试同步插件清单 MCP 条目 ' + native.serverName)
        return false
      }
      this.nativeSyncFailures.set(native.entryId, { enabled, message })
      this.logWarn('同步插件清单 MCP 条目 ' + native.serverName + ' 失败: ' + message)
      return false
    }
  }

  async reconcileOnce(options = {}) {
    if (this.disposed) return
    const generation = this.generation
    const syncNative = options.syncNative === true
    const forceNativeSync = options.forceNativeSync === true
    const nativeServers = await this.readNativeServers()
    if (this.disposed || generation !== this.generation) return
    this.nativeServers = nativeServers
    this.nativeByName = new Map(nativeServers.map((server) => [server.serverName, server]))

    const { userServers } = await this.readScopeServers('user')
    if (this.disposed || generation !== this.generation) return
    const configs = []
    for (const server of userServers) {
      configs.push({
        key: makeRunnerKey('user', '', server.name),
        server,
        runnerWorkspace: this.activeWorkspace || undefined,
      })
    }

    this.watchWorkspace(this.activeWorkspace)
    for (const ws of [...this.watchedWorkspaces]) {
      const { wsServers } = await this.readScopeServers('workspace', ws)
      if (this.disposed || generation !== this.generation) return
      for (const server of wsServers) {
        configs.push({
          key: makeRunnerKey('workspace', ws, server.name),
          server,
          runnerWorkspace: pickWorkspaceRoot(server.workspacePath) || this.activeWorkspace,
        })
      }
    }

    const desired = new Map()
    for (const item of configs) {
      const native = this.nativeByName.get(item.server.name)
      if (!native) {
        desired.set(item.key, item)
        continue
      }
      const configEnabled = item.server.enabled !== false
      const identicalBeforeSync = nativeMatchesServer(native, item.server)
      // Automatic reconciliation only aligns exact duplicates. An explicit
      // user action (toggle/save/delete) can also take over a same-name
      // instance whose parameters differ: the panel owns the name, so the
      // stale native instance must go first or both would register the same
      // tool names.
      if (syncNative && forceNativeSync && !identicalBeforeSync) {
        if (native.enabled !== false) {
          await this.syncNativeServer(native, false)
          if (this.disposed || generation !== this.generation) return
        }
      } else if (syncNative && identicalBeforeSync) {
        await this.syncNativeServer(native, configEnabled)
        if (this.disposed || generation !== this.generation) return
      }
      const current = this.nativeByName.get(item.server.name) || native
      const nativeEnabled = current.enabled !== false
      const identical = nativeMatchesServer(current, item.server)
      const controllable = this.canControlNative(current)
      // A native instance owns the MCP namespace whenever it is enabled, and —
      // for exact duplicates — also while a deferred sync is about to switch it
      // on. Starting a second process in that window would collide on tool
      // names (the native plugin rolls its registrations back and ends with no
      // tools at all). Same-name-but-different configs keep the native instance
      // until an explicit panel action takes the server over.
      if (identical) {
        if (nativeEnabled || controllable) continue
      } else if (nativeEnabled && (configEnabled || !controllable)) {
        continue
      }
      desired.set(item.key, item)
    }

    // Stop runners no longer desired (disabled, deleted, or adopted by a
    // native instance). Await the tree kill so no process survives this pass.
    for (const [key, runner] of [...this.runners.entries()]) {
      if (desired.has(key)) continue
      this.runners.delete(key)
      await runner.stop()
      if (this.disposed) return
    }

    // Start or update the remaining runners.
    for (const [key, item] of desired.entries()) {
      if (this.disposed || generation !== this.generation) return
      const existing = this.runners.get(key)
      if (existing) {
        const unchanged = JSON.stringify(existing.config) === JSON.stringify(item.server)
        if (unchanged) continue
        this.runners.delete(key)
        await existing.stop()
        if (this.disposed) return
      }
      const runner = new McpProcessRunner(this.ctx, item.server, item.runnerWorkspace)
      this.runners.set(key, runner)
      try {
        await runner.start()
      } catch (err) {
        if (!runner.disposedOrStopped) {
          runner.status = 'error'
          runner.error = err instanceof Error ? err.message : String(err)
        }
      }
      if (this.disposed) {
        await runner.stop()
        return
      }
    }
  }

  /** Find one native MCP plugin instance by its server name (fresh snapshot). */
  async findNativeServer(name) {
    const servers = await this.readNativeServers()
    this.nativeServers = servers
    this.nativeByName = new Map(servers.map((server) => [server.serverName, server]))
    return this.nativeByName.get(name)
  }

  describePanelEntry(server, scope, workspacePath) {
    const key = makeRunnerKey(scope, workspacePath, server.name)
    const runner = this.runners.get(key)
    if (runner) return runner.describe()
    const native = this.nativeByName.get(server.name)
    if (native) return this.describeAdoptedEntry(native, server, scope, workspacePath)
    return {
      ...server,
      source: 'panel',
      readonly: false,
      controllable: true,
      status: server.enabled ? 'error' : 'disabled',
      error: server.enabled ? '未能启动 MCP 进程' : '',
      toolCount: 0,
      tools: [],
    }
  }

  describeAdoptedEntry(native, server, scope, workspacePath) {
    const configEnabled = server.enabled !== false
    const identical = nativeMatchesServer(native, server)
    const base = describeNativeMcpServer(this.ctx, native, {
      hasPluginManager: this.hasPluginManager,
      scope,
      workspacePath,
    })
    const warnings = [...base.warnings]
    const failure = this.nativeSyncFailures.get(native.entryId)
    if (!identical) warnings.push('面板配置与插件清单中同名条目的连接参数不同；保存面板配置后将由面板接管。')
    if (native.enabled !== configEnabled) {
      warnings.push(configEnabled
        ? '面板已启用，但插件清单中的同名条目当前未启用。'
        : '面板已禁用，但插件清单中的同名条目仍在运行。')
    }
    let error = base.error
    if (!error && failure) error = failure.message
    if (!error && native.enabled !== configEnabled && !this.canControlNative(native)) {
      error = '该 MCP 同时来自 DSH 插件清单（可能由 Magpie 等第三方工具写入）；面板无法启停该条目，请在 DSH 插件设置中操作。'
    }
    return {
      ...base,
      name: server.name,
      scope,
      workspacePath,
      // A panel entry is the user's own configuration, so it is the primary
      // row. The coincident plugin-manifest entry is reported through
      // pluginEntry and shown as a note, not as the row's source.
      source: 'panel',
      origin: 'panel',
      originLabel: '面板',
      patchEntryId: '',
      readonly: false,
      controllable: this.canControlNative(native),
      enabled: configEnabled,
      configEnabled,
      runtimeEnabled: native.enabled !== false,
      pluginEntry: {
        ...(base.pluginEntry || {}),
        enabled: native.enabled !== false,
      },
      identical,
      transport: server.transport,
      command: server.command,
      args: server.args,
      env: server.env,
      cwd: server.cwd,
      url: server.url,
      headers: server.headers,
      toolCallTimeoutMs: server.toolCallTimeoutMs,
      error,
      warnings,
    }
  }
  describeNativeOnlyEntry(native) {
    const base = describeNativeMcpServer(this.ctx, native, {
      hasPluginManager: this.hasPluginManager,
      scope: 'user',
    })
    const failure = this.nativeSyncFailures.get(native.entryId)
    if (!base.error && failure) base.error = failure.message
    return base
  }

  /**
   * Filtered list of servers based on query:
   * scope: 'all' | 'user' | 'workspace'
   * workspacePath: target directory
   */
  async list({ scope = 'all', workspacePath = '' } = {}) {
    const targetWs = pickWorkspaceRoot(workspacePath) || this.activeWorkspace
    if (scope === 'workspace' && targetWs) this.watchWorkspace(targetWs)
    await this.reconcile({ syncNative: true })
    const { userServers, wsServers, userPath, wsPath } = await this.readScopeServers(scope, targetWs)
    const knownWorkspaces = await getKnownWorkspaces(this.ctx)

    const list = []

    if (scope === 'workspace') {
      for (const s of wsServers) {
        list.push(this.describePanelEntry(s, 'workspace', targetWs))
      }
    } else if (scope === 'user') {
      for (const s of userServers) {
        list.push(this.describePanelEntry(s, 'user', ''))
      }
      const active = await this.readScopeServers('workspace', targetWs)
      this.appendNativeOnlyEntries(list, [...userServers, ...active.wsServers])
    } else {
      for (const s of wsServers) {
        list.push(this.describePanelEntry(s, 'workspace', targetWs))
      }
      for (const s of userServers) {
        list.push(this.describePanelEntry(s, 'user', ''))
      }
      this.appendNativeOnlyEntries(list, [...userServers, ...wsServers])
    }

    return {
      servers: list,
      activeWorkspace: this.activeWorkspace,
      currentScope: scope,
      currentWorkspacePath: targetWs,
      workspaces: knownWorkspaces,
      userConfigPath: userPath,
      workspaceConfigPath: wsPath,
      nativeControlAvailable: this.hasPluginManager,
    }
  }

  /** Native instances the panel has no mcp.json entry for are still exposed. */
  appendNativeOnlyEntries(list, knownServers) {
    const known = new Set((knownServers || []).map((server) => server.name))
    for (const native of this.nativeServers) {
      if (known.has(native.serverName)) continue
      list.push(this.describeNativeOnlyEntry(native))
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
        throw new Error('JSON 解析失败: ' + err.message)
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
    await this.reconcile({ syncNative: true, forceNativeSync: true })
    return await this.list({ scope: targetScope, workspacePath: targetWs })
  }

  async deleteServer({ name, scope, workspacePath }) {
    if (!name) throw new Error('服务名称不能为空')
    const { targetScope, targetWs, targetPath } = this.resolveTargetPath(scope, workspacePath)
    const currentData = await readJsonSafe(targetPath, null)
    const list = normalizeServerList(currentData || { version: 1, servers: [] }, targetScope, targetWs)
    const owned = list.some((s) => s.name === name)
    if (!owned) {
      const native = await this.findNativeServer(name)
      if (native) {
        throw new Error('该服务器来自 DSH 插件清单（可能由 Magpie 等第三方工具写入），面板无法删除；请在 DSH 插件设置中停用对应条目。')
      }
      return await this.list({ scope: targetScope, workspacePath: targetWs })
    }
    const filtered = list.filter((s) => s.name !== name)
    await writeJsonPretty(targetPath, formatCanonicalConfig(filtered))

    // Delete removes only the panel configuration. A same-name entry in the
    // DSH plugin manifest belongs to its writer (for example Magpie) and
    // keeps its own enabled state; the list then shows it as a plugin entry.
    await this.reconcile({ syncNative: true, forceNativeSync: true })
    return await this.list({ scope: targetScope, workspacePath: targetWs })
  }

  async toggleServer({ name, scope, enabled, workspacePath }) {
    if (!name) throw new Error('服务名称不能为空')
    const { targetScope, targetWs, targetPath } = this.resolveTargetPath(scope, workspacePath)
    const currentData = await readJsonSafe(targetPath, null)
    const list = normalizeServerList(currentData || { version: 1, servers: [] }, targetScope, targetWs)
    const target = list.find((s) => s.name === name)
    const native = await this.findNativeServer(name)
    const desired = Boolean(enabled)

    if (!target) {
      if (native) {
        await setNativeServerEnabled(this.ctx, native, desired)
        this.nativeSyncFailures.delete(native.entryId)
        this.nativeByName.set(native.serverName, { ...native, enabled: desired })
      }
      await this.reconcile({ syncNative: true, forceNativeSync: true })
      return await this.list({ scope: targetScope, workspacePath: targetWs })
    }

    target.enabled = desired
    await writeJsonPretty(targetPath, formatCanonicalConfig(list))
    if (native) {
      try {
        await setNativeServerEnabled(this.ctx, native, desired)
        this.nativeSyncFailures.delete(native.entryId)
      } catch (err) {
        this.logWarn('切换插件清单 MCP 条目 ' + name + ' 失败: ' + err.message)
      }
    }
    await this.reconcile({ syncNative: true, forceNativeSync: true })
    return await this.list({ scope: targetScope, workspacePath: targetWs })
  }

  /**
   * Async, idempotent disposal. The in-flight reconciliation is awaited so it
   * cannot spawn another MCP child after the plugin starts unloading, and
   * every child process tree is terminated before the promise settles.
   */
  dispose() {
    if (this.disposePromise) return this.disposePromise
    this.disposed = true
    this.generation += 1
    // Release tool registrations and initiate process teardown synchronously;
    // an un-awaited dispose() must already stop injecting MCP tools.
    const immediate = [...this.runners.values()]
    this.runners.clear()
    const pending = immediate.map((runner) => runner.stop())
    const cleanup = (async () => {
      await Promise.allSettled(pending)
      // An in-flight reconciliation may have created a runner between the
      // capture above and its own disposal check; drain it as well.
      await this.reconcileChain.catch(() => {})
      for (let pass = 0; pass < 4; pass += 1) {
        if (this.runners.size === 0) break
        const runners = [...this.runners.values()]
        this.runners.clear()
        await Promise.allSettled(runners.map((runner) => runner.stop()))
      }
    })()
    // Never let teardown outlive the host's grace window: kill requests are
    // already in flight and every handle they may leave behind is unref'd.
    this.disposePromise = settleWithin(cleanup, DISPOSE_BUDGET_MS)
    return this.disposePromise
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
      message: error instanceof Error ? error.message : String(error),
      details: {},
    },
  }
}

const MAX_PUBLIC_NAME_LENGTH = 64
const NAME_HASH_LENGTH = 12

/**
 * Model-facing name accepted by the current tool runtime:
 * `mcp__<server>__<tool>`, at most 64 characters of [A-Za-z0-9_-].
 * A lossy normalization keeps a hash so distinct tools do not collapse.
 */
export function publicToolName(serverName, rawName) {
  const joined = `mcp__${serverName}__${rawName}`
  const normalized = joined.replace(/[^A-Za-z0-9_-]/g, '_')
  if (normalized === joined && normalized.length <= MAX_PUBLIC_NAME_LENGTH) return normalized
  const hash = createHash('sha256').update(`${serverName}\0${rawName}`).digest('hex').slice(0, NAME_HASH_LENGTH)
  return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - NAME_HASH_LENGTH - 1)}_${hash}`
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
    }, 'dsh-mcp-servers-panel: /dsh-mcp-servers-panel rpc channel')
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

  // Sessions are published on ctx.sessions; cwd lives on session.header.
  ctx.on?.('session/created', (session) => {
    try {
      const cwd = session?.header?.cwd
      if (cwd) manager.setWorkspaceRoot(cwd)
    } catch (err) {
      ctx.logger?.warn?.('[dsh-mcp-servers-panel] 工作区切换失败: ' + (err?.message || err))
    }
  })

  // Register RPC & WebServer routes
  registerRpc(ctx, manager)
  registerWebServer(ctx, manager)

  // Initial reconciliation on startup. Native-plugin adoption is intentionally
  // deferred: toggling another plugin through the plugin manager during this
  // plugin's own mount would contend with the HMR transaction that is loading
  // us.
  manager.reconcile().catch((err) => {
    ctx.logger?.error?.('[dsh-mcp-servers-panel] 初始加载失败: ' + (err?.message || err))
  })

  ctx.effect(() => {
    let timer
    let cancelReady
    let attempts = 0
    const MAX_ATTEMPTS = 4
    const clearTimer = () => {
      if (timer) clearTimeout(timer)
      timer = undefined
    }
    const run = () => {
      timer = undefined
      if (manager.disposed) return
      attempts += 1
      manager.reconcile({ syncNative: true }).then(() => {
        // Services may still be mounting right after boot (the app-ready
        // service and the plugin manager can arrive after this plugin is
        // mounted). Retry a few times when the plugin manager is not visible.
        if (!manager.disposed && !manager.hasPluginManager && attempts < MAX_ATTEMPTS) {
          timer = setTimeout(run, 1000)
          timer.unref?.()
        }
      }).catch((err) => {
        ctx.logger?.warn?.('[dsh-mcp-servers-panel] 同步插件清单 MCP 条目失败: ' + (err?.message || err))
      })
    }
    const schedule = () => {
      if (timer || manager.disposed) return
      timer = setTimeout(run, APP_READY_SYNC_DELAY_MS)
      timer.unref?.()
    }
    try {
      const ready = ctx.get('appReady')
      if (ready && typeof ready.onReady === 'function') cancelReady = ready.onReady(schedule)
      else schedule()
    } catch {
      schedule()
    }
    return () => {
      clearTimer()
      if (typeof cancelReady === 'function') {
        try { cancelReady() } catch {}
      }
    }
  }, 'dsh-mcp-servers-panel: native mcp reconciliation')

  return async () => {
    await manager.dispose()
  }
}
