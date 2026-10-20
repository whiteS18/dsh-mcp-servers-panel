import test from 'node:test'
import assert from 'node:assert/strict'

import {
  describeMcpEntry,
  getPluginManager,
  listMcpClientEntries,
  readMcpInventory,
  registeredMcpTools,
  setNativeServerEnabled,
} from '../native-mcp.js'

function entry(id, config, { disabled = false, state = 2, error, patchId } = {}) {
  return {
    id,
    options: { id: patchId, name: '@deepseek-ai/dsh-mcp-client', config },
    disabled,
    fiber: state === null ? undefined : { state, ...error === undefined ? {} : { error } },
  }
}

function fakeCtx({ entries = [], tools = new Map(), pluginManager, listRows } = {}) {
  return {
    get(name) {
      if (name === 'loader') return { entries: () => entries }
      if (name === 'tools') return { view: () => ({ visible: tools }) }
      if (name === 'pluginManager') {
        if (!pluginManager) return undefined
        return {
          setPluginEnabled: pluginManager.setPluginEnabled,
          listPlugins: pluginManager.listPlugins || (async () => listRows || []),
        }
      }
      return undefined
    },
  }
}

const MAGPIE = entry('magpie-mcp-native', {
  serverName: 'native',
  transport: 'stdio',
  command: 'npx',
  args: ['native'],
}, { state: 2 })

test('listMcpClientEntries reads only official client rows', () => {
  const ctx = fakeCtx({
    entries: [
      MAGPIE,
      { id: 'other', options: { name: 'other-plugin', config: {} } },
      entry('panel-row', { serverName: 'panel', transport: 'streamable-http', url: 'https://example.com/mcp' }),
    ],
  })
  const entries = listMcpClientEntries(ctx)
  assert.deepEqual(entries.map((item) => item.entryId), ['magpie-mcp-native', 'panel-row'])
  assert.equal(entries[0].serverName, 'native')
  assert.equal(entries[1].config.transport, 'streamable-http')
})

test('loader include-prefixed ids map back to the profile patch id', () => {
  const nested = entry('include:magpie-mcp-native', {
    serverName: 'native',
    transport: 'stdio',
    command: 'npx',
  }, { patchId: 'magpie-mcp-native' })
  const ctx = fakeCtx({ entries: [nested] })
  const [parsed] = listMcpClientEntries(ctx)
  assert.equal(parsed.entryId, 'include:magpie-mcp-native')
  assert.equal(parsed.loaderEntryId, 'include:magpie-mcp-native')
  assert.equal(parsed.patchId, 'magpie-mcp-native')
  const row = describeMcpEntry(ctx, parsed, undefined, { hasPluginManager: true })
  assert.equal(row.entryId, 'magpie-mcp-native')
  assert.equal(row.loaderEntryId, 'include:magpie-mcp-native')
  assert.equal(row.patchEntryId, 'magpie-mcp-native')
})

test('registeredMcpTools filters by the public server namespace', () => {
  const tools = new Map([
    ['mcp__native__do', { description: 'do', parameters: { type: 'object' } }],
    ['mcp__native__extra', { description: 'extra', parameters: { type: 'object' } }],
    ['mcp__other__do', { description: 'other', parameters: { type: 'object' } }],
  ])
  const found = registeredMcpTools(fakeCtx({ tools }), 'native')
  assert.deepEqual(found.map((tool) => tool.rawName).sort(), ['do', 'extra'])
})

test('describeMcpEntry reports third-party source, status, tools and controllability', async () => {
  const tools = new Map([['mcp__native__do', { description: 'do', parameters: { type: 'object' } }]])
  const pluginManager = {
    async setPluginEnabled() {},
    async listPlugins() {
      return [{
        entryId: 'magpie-mcp-native',
        moduleName: '@deepseek-ai/dsh-mcp-client',
        enabled: true,
        fiberPhase: 'active',
        patchId: 'magpie-mcp-native',
      }]
    },
  }
  const ctx = fakeCtx({ entries: [MAGPIE], tools, pluginManager })
  const inventory = await readMcpInventory(ctx)
  const row = describeMcpEntry(ctx, inventory.entries[0], inventory.rows.get('magpie-mcp-native'), {
    hasPluginManager: inventory.hasPluginManager,
  })
  assert.equal(row.source, 'third-party')
  assert.equal(row.origin, 'third-party')
  assert.equal(row.originLabel, '第三方导入')
  assert.equal(row.patchEntryId, 'magpie-mcp-native')
  assert.equal(row.readonly, true)
  assert.equal(row.controllable, true)
  assert.equal(row.status, 'connected')
  assert.equal(row.toolCount, 1)
  assert.equal(row.pluginEntry.patchEntryId, 'magpie-mcp-native')
})

test('describeMcpEntry marks failed fibers and unaddressable rows', () => {
  const failed = entry('broken', { serverName: 'broken', transport: 'stdio', command: 'x' }, {
    state: 3,
    error: new Error('loader boom'),
  })
  const ctx = fakeCtx({ entries: [failed] })
  const row = describeMcpEntry(ctx, listMcpClientEntries(ctx)[0], undefined, { hasPluginManager: false })
  assert.equal(row.status, 'error')
  assert.match(row.error, /loader boom/)
  assert.equal(row.controllable, false)
  assert.match(row.warnings.join('\n'), /第三方导入/)
})

test('disabled foreign rows report disabled and no tools', () => {
  const disabled = entry('off', { serverName: 'off', transport: 'stdio', command: 'x' }, { disabled: true, state: null })
  const tools = new Map([['mcp__off__do', { description: 'do', parameters: { type: 'object' } }]])
  const ctx = fakeCtx({ entries: [disabled], tools })
  const row = describeMcpEntry(ctx, listMcpClientEntries(ctx)[0], undefined, { hasPluginManager: true })
  assert.equal(row.status, 'disabled')
  assert.equal(row.enabled, false)
  assert.equal(row.toolCount, 0)
})

test('setNativeServerEnabled delegates to the plugin manager', async () => {
  const calls = []
  const ctx = fakeCtx({
    pluginManager: { async setPluginEnabled(entryId, enabled) { calls.push([entryId, enabled]) } },
  })
  await setNativeServerEnabled(ctx, 'magpie-mcp-native', false)
  assert.deepEqual(calls, [['magpie-mcp-native', false]])
  assert.equal(getPluginManager(fakeCtx()), undefined)
  await assert.rejects(() => setNativeServerEnabled(fakeCtx(), 'x', true), /pluginManager|插件管理服务/)
})
