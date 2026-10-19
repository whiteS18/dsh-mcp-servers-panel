/**
 * Profile-patch storage for panel-managed MCP client rows.
 *
 * The panel does not implement MCP. It writes ordinary loader rows for the
 * official `@deepseek-ai/dsh-mcp-client` plugin into the active profile's
 * `cordis.patch.yml`; the official client owns transport, reconnects, tool
 * registration, resources and teardown.
 *
 * This module is the only place that touches YAML. It uses the Document API so
 * unrelated rows, comments and `!!js` tags survive a panel edit. Panel rows
 * are identified by their `dsh-mcp-panel-<serverName>` id.
 */

import { isMap, isSeq, parseDocument } from 'yaml'

export const MCP_CLIENT_PLUGIN_NAME = '@deepseek-ai/dsh-mcp-client'
export const PANEL_ENTRY_PREFIX = 'dsh-mcp-panel-'
export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60000
export const DEFAULT_MAX_INSTRUCTION_BYTES = 32768
export const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

const JS_TAG = { tag: 'tag:yaml.org,2002:js', resolve: (value) => value }
const PARSE_OPTIONS = { customTags: [JS_TAG] }
const PRINT_OPTIONS = { flowCollectionPadding: false, lineWidth: 0 }
const DEFAULT_RECONNECT = Object.freeze({
  enabled: true,
  initialDelayMs: 500,
  maxDelayMs: 30000,
  maxAttempts: 10,
})

function fail(message) {
  throw new Error(message)
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function panelEntryId(serverName) {
  return PANEL_ENTRY_PREFIX + String(serverName || '')
}

export function isPanelEntryId(entryId) {
  return typeof entryId === 'string' && entryId.startsWith(PANEL_ENTRY_PREFIX)
}

export function serverNameFromEntryId(entryId) {
  return isPanelEntryId(entryId) ? entryId.slice(PANEL_ENTRY_PREFIX.length) : ''
}

function stringValue(value) {
  return typeof value === 'string' ? value : value == null ? '' : String(value)
}

function stringMap(value) {
  const out = {}
  if (!isRecord(value)) return out
  for (const [key, item] of Object.entries(value)) {
    const name = String(key).trim()
    if (!name) continue
    out[name] = stringValue(item)
  }
  return out
}

function normalizeTransport(value) {
  const transport = stringValue(value).trim().toLowerCase()
  if (transport === 'stdio') return 'stdio'
  if (transport === 'streamable-http' || transport === 'streamable_http' || transport === 'http' || transport === 'sse') {
    return 'streamable-http'
  }
  return ''
}

function positiveNumber(value, fallback, label) {
  if (value === undefined || value === null || value === '') return fallback
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) fail(label + ' 必须是正数')
  return number
}

function booleanValue(value, label, fallback) {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') fail(label + ' 必须是布尔值')
  return value
}

function positiveInteger(value, fallback, label) {
  if (value === undefined || value === null || value === '') return fallback
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0 || !Number.isInteger(number)) {
    fail(label + ' 必须是正整数')
  }
  return number
}

/**
 * Validate and canonicalize one official `dsh-mcp-client` config.
 * Unknown input keys are ignored; defaults are omitted so the patch stays tidy.
 *
 * @param {string} name serverName supplied by the caller
 * @param {object} input raw server input (form payload or JSON entry)
 * @returns {{name: string, enabled: boolean, config: object}}
 */
export function normalizeServerInput(name, input = {}) {
  if (!isRecord(input)) fail('服务器配置必须是对象')
  const serverName = stringValue(name ?? input.serverName).trim()
  if (!serverName) fail('服务名称不能为空')
  if (!SERVER_NAME_PATTERN.test(serverName)) {
    fail('服务名称只能包含字母、数字、下划线和连字符（1-32 位）')
  }

  const transport = normalizeTransport(input.transport ?? input.type ?? (input.url ? 'streamable-http' : 'stdio'))
  if (!transport) fail('传输方式必须是 stdio 或 streamable-http')

  const enabled = booleanValue(input.enabled, 'enabled', true)
  const config = { serverName, transport }

  if (transport === 'stdio') {
    const command = stringValue(input.command).trim()
    if (!command) fail('stdio 传输方式必须指定执行命令 (command)')
    config.command = command
    if (Array.isArray(input.args)) {
      const args = input.args.map(stringValue)
      if (args.length > 0) config.args = args
    } else if (typeof input.args === 'string' && input.args.trim()) {
      config.args = input.args.trim().split(/\s+/)
    }
    const env = stringMap(input.env)
    if (Object.keys(env).length > 0) config.env = env
    if (typeof input.cwd === 'string' && input.cwd.trim()) config.cwd = input.cwd.trim()
  } else {
    const url = stringValue(input.url).trim()
    if (!url) fail('streamable-http 传输方式必须指定 URL')
    try {
      new URL(url)
    } catch {
      fail('streamable-http 的 URL 格式无效: ' + url)
    }
    config.url = url
    const headers = stringMap(input.headers)
    if (Object.keys(headers).length > 0) config.headers = headers
  }

  const timeout = positiveNumber(input.toolCallTimeoutMs, DEFAULT_TOOL_CALL_TIMEOUT_MS, 'toolCallTimeoutMs')
  if (timeout !== DEFAULT_TOOL_CALL_TIMEOUT_MS) config.toolCallTimeoutMs = timeout

  if (booleanValue(input.failOnStartupError, 'failOnStartupError', false)) config.failOnStartupError = true

  const maxInstructionBytes = positiveInteger(input.maxInstructionBytes, DEFAULT_MAX_INSTRUCTION_BYTES, 'maxInstructionBytes')
  if (maxInstructionBytes !== DEFAULT_MAX_INSTRUCTION_BYTES) config.maxInstructionBytes = maxInstructionBytes

  if (input.reconnect !== undefined) {
    if (!isRecord(input.reconnect)) fail('reconnect 必须是对象')
    const reconnect = {}
    for (const key of Object.keys(input.reconnect)) {
      if (!Object.hasOwn(DEFAULT_RECONNECT, key)) fail('reconnect.' + key + ' 不是支持的选项')
    }
    if (input.reconnect.enabled !== undefined) {
      reconnect.enabled = booleanValue(input.reconnect.enabled, 'reconnect.enabled', undefined)
    }
    if (input.reconnect.initialDelayMs !== undefined) {
      reconnect.initialDelayMs = positiveNumber(input.reconnect.initialDelayMs, DEFAULT_RECONNECT.initialDelayMs, 'reconnect.initialDelayMs')
    }
    if (input.reconnect.maxDelayMs !== undefined) {
      reconnect.maxDelayMs = positiveNumber(input.reconnect.maxDelayMs, DEFAULT_RECONNECT.maxDelayMs, 'reconnect.maxDelayMs')
    }
    if (input.reconnect.maxAttempts !== undefined) {
      reconnect.maxAttempts = positiveInteger(input.reconnect.maxAttempts, DEFAULT_RECONNECT.maxAttempts, 'reconnect.maxAttempts')
    }
    if (reconnect.initialDelayMs !== undefined && reconnect.maxDelayMs !== undefined && reconnect.initialDelayMs > reconnect.maxDelayMs) {
      fail('reconnect.initialDelayMs 不能大于 reconnect.maxDelayMs')
    }
    if (Object.keys(reconnect).length > 0) config.reconnect = reconnect
  }

  return { name: serverName, enabled, config }
}

/** Read the first nested object under one of the supported wrapper formats. */
export function normalizeIncomingList(raw) {
  if (!raw) return []
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw)
    } catch (error) {
      fail('JSON 解析失败: ' + error.message)
    }
  }
  if (!isRecord(raw) && !Array.isArray(raw)) fail('JSON 根元素必须是对象或数组')

  const out = []
  const push = (name, value) => {
    if (!isRecord(value)) return
    out.push(normalizeServerInput(name, value))
  }

  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!isRecord(item)) continue
      push(item.serverName ?? item.name, item)
    }
    return out
  }

  if (isRecord(raw.mcpServers)) {
    for (const [name, value] of Object.entries(raw.mcpServers)) push(name, value)
    return out
  }

  if (Array.isArray(raw.servers)) {
    for (const item of raw.servers) {
      if (!isRecord(item)) continue
      push(item.serverName ?? item.name, item)
    }
    return out
  }

  if (isRecord(raw.servers)) {
    for (const [name, value] of Object.entries(raw.servers)) push(name, value)
    return out
  }

  if (typeof raw.serverName === 'string' && raw.serverName.trim()) {
    push(raw.serverName, raw)
    return out
  }

  for (const [name, value] of Object.entries(raw)) {
    if (name === 'version' || name === '$schema') continue
    push(name, value)
  }
  return out
}

/** Read a YAML document and require a top-level sequence. */
function parsePatch(text) {
  const source = typeof text === 'string' && text.trim() ? text : '[]\n'
  const doc = parseDocument(source, PARSE_OPTIONS)
  const error = doc.errors[0]
  if (error !== undefined) fail('Profile patch YAML 解析失败: ' + error.message)
  if (doc.contents == null) {
    doc.contents = doc.createNode([])
  }
  if (!isSeq(doc.contents)) fail('Profile patch 必须是 YAML 序列（顶层数组）')
  // The shipped template is the flow sequence `[]`. Force block style so an
  // appended insert group reads like normal profile YAML.
  doc.contents.flow = false
  return doc
}

function nodeToJs(doc, node) {
  if (node === null || node === undefined) return undefined
  try {
    return typeof node.toJS === 'function' ? node.toJS(doc) : undefined
  } catch {
    return undefined
  }
}

function insertGroups(doc) {
  const groups = []
  const items = doc.contents.items
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]
    if (!isMap(item)) continue
    const insert = item.get('insert')
    if (!isSeq(insert)) continue
    groups.push({ group: item, groupIndex: index, insert })
  }
  return groups
}

/** One row shaped like the official client's loader entry, from the patch file. */
function readRow(doc, entryNode, group, groupIndex, entryIndex) {
  const id = stringValue(entryNode.get('id'))
  const name = stringValue(entryNode.get('name'))
  if (name !== MCP_CLIENT_PLUGIN_NAME) return undefined
  const rawConfig = nodeToJs(doc, entryNode.get('config'))
  const config = isRecord(rawConfig) ? rawConfig : {}
  const disabledNode = entryNode.get('disabled')
  return {
    entryId: id,
    serverName: stringValue(config.serverName),
    enabled: disabledNode !== true,
    config,
    panelManaged: isPanelEntryId(id),
    node: entryNode,
    group,
    groupIndex,
    entryIndex,
    insert: group.get('insert'),
  }
}

/** Read all official MCP client rows from a patch document. */
export function readMcpRows(doc) {
  const rows = []
  for (const { group, groupIndex, insert } of insertGroups(doc)) {
    for (let entryIndex = 0; entryIndex < insert.items.length; entryIndex += 1) {
      const entryNode = insert.items[entryIndex]
      if (!isMap(entryNode)) continue
      const row = readRow(doc, entryNode, group, groupIndex, entryIndex)
      if (row !== undefined) rows.push(row)
    }
  }
  return rows
}

/**
 * A parsed profile patch with panel-row mutation helpers.
 * Create with {@link ProfilePatch.parse}; call {@link ProfilePatch#toString}
 * to get the next file text.
 */
export class ProfilePatch {
  constructor(doc) {
    this.doc = doc
    this.dirty = false
  }

  static parse(text) {
    return new ProfilePatch(parsePatch(text))
  }

  /** Every `@deepseek-ai/dsh-mcp-client` row in the patch. */
  rows() {
    return readMcpRows(this.doc)
  }

  /** Rows owned by the panel, in file order. */
  panelRows() {
    return this.rows().filter((row) => row.panelManaged)
  }

  findPanelRow(serverName) {
    const target = String(serverName || '')
    const rows = this.panelRows()
    return rows.find((row) => row.serverName === target)
      ?? rows.find((row) => row.entryId === panelEntryId(target))
  }

  hasServer(serverName) {
    return Boolean(this.findPanelRow(serverName))
  }

  /**
   * Insert or update one panel row.
   * @param {{name: string, enabled: boolean, config: object}} input canonical server input
   * @param {{replaceName?: string}} options rename source
   * @returns {{created: boolean}}
   */
  upsertServer(input, options = {}) {
    const replaceName = options.replaceName ? String(options.replaceName) : ''
    const name = input.name
    let row = this.findPanelRow(name)
    if (row === undefined && replaceName && replaceName !== name) {
      const oldRow = this.findPanelRow(replaceName)
      if (oldRow !== undefined) this.removeRow(oldRow)
      row = undefined
    }
    if (row !== undefined) {
      this.writeRow(row, input)
      return { created: false }
    }
    this.dirty = true

    const entry = this.createEntryNode(input)
    const panelGroup = insertGroups(this.doc).find(({ insert }) => (
      insert.items.some((item) => isMap(item) && isPanelEntryId(stringValue(item.get('id'))))
    ))
    if (panelGroup !== undefined) {
      panelGroup.insert.items.push(entry)
      return { created: true }
    }

    const group = this.doc.createNode({ insert: [entry] })
    group.commentBefore = ' dsh-mcp-servers-panel: MCP servers managed by the panel'
    this.doc.contents.items.push(group)
    return { created: true }
  }

  /** Remove one panel row. @returns {boolean} whether a row was removed */
  removeServer(serverName) {
    const row = this.findPanelRow(serverName)
    if (row === undefined) return false
    this.removeRow(row)
    return true
  }

  /** Set one panel row's desired enabled state. @returns {boolean} whether a row was found */
  setEnabled(serverName, enabled) {
    const row = this.findPanelRow(serverName)
    if (row === undefined) return false
    const next = enabled !== false
    const current = row.enabled !== false
    if (next === current) return true
    this.dirty = true
    if (next) row.node.delete('disabled')
    else row.node.set('disabled', true)
    return true
  }

  writeRow(row, input) {
    this.dirty = true
    const node = row.node
    node.set('id', panelEntryId(input.name))
    node.set('name', MCP_CLIENT_PLUGIN_NAME)
    node.set('config', this.doc.createNode(input.config))
    if (input.enabled === false) node.set('disabled', true)
    else node.delete('disabled')
  }

  createEntryNode(input) {
    const object = {
      id: panelEntryId(input.name),
      name: MCP_CLIENT_PLUGIN_NAME,
      ...input.enabled === false ? { disabled: true } : {},
      config: input.config,
    }
    return this.doc.createNode(object)
  }

  removeRow(row) {
    this.dirty = true
    row.insert.items.splice(row.entryIndex, 1)
    if (row.insert.items.length === 0) {
      this.doc.contents.items.splice(row.groupIndex, 1)
    }
  }

  toString() {
    let text = this.doc.toString(PRINT_OPTIONS)
    if (!text.endsWith('\n')) text += '\n'
    return text
  }
}

export { DEFAULT_RECONNECT }
