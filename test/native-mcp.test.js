import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { McpManager } from '../index.js'
import { makeCtx, makeTmpDir } from './helpers/mcp-fixtures.js'

const LIBTV_CONFIG = {
  serverName: 'LibTV',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', 'mcp-remote', 'https://mcp.liblib.tv/mcp'],
}

const MAGPIE_CONFIG = {
  serverName: 'magpie-image',
  transport: 'stdio',
  command: 'C:/tools/magpie.exe',
  args: ['mcp', 'image'],
}

/**
 * Minimal loader + plugin manager pair that behave like the DSH services the
 * panel talks to. Toggling updates the fake loader entry just like HMR would.
 */
function makeNativeServices(options = {}) {
  const state = {
    LibTV: { entryId: 'entry-libtv', enabled: true, patchId: 'magpie-mcp-LibTV' },
    'magpie-image': { entryId: 'entry-magpie', enabled: true, patchId: 'magpie-mcp-magpie-image' },
  }
  if (options.libtvDisabled) state.LibTV.enabled = false
  if (options.libtvReadOnly) state.LibTV.readOnlyReason = 'management-required'
  const calls = []
  const entryFor = (serverName, config) => {
    const row = state[serverName]
    return {
      id: row.entryId,
      disabled: !row.enabled,
      fiber: row.enabled ? { state: 2 } : undefined,
      options: {
        id: 'magpie-mcp-' + serverName,
        name: '@deepseek-ai/dsh-mcp-client',
        config,
      },
    }
  }
  const loader = {
    entries() {
      return [
        entryFor('LibTV', LIBTV_CONFIG),
        entryFor('magpie-image', MAGPIE_CONFIG),
      ]
    },
  }
  const pluginManager = {
    calls,
    async listPlugins() {
      return Object.entries(state).map(([serverName, row]) => ({
        entryId: row.entryId,
        moduleName: '@deepseek-ai/dsh-mcp-client',
        enabled: row.enabled,
        fiberPhase: row.enabled ? 'active' : null,
        patchId: row.patchId,
        ...(row.readOnlyReason === undefined ? {} : { readOnlyReason: row.readOnlyReason }),
        serverName,
      }))
    },
    async setPluginEnabled(entryId, enabled) {
      calls.push([entryId, enabled])
      for (const row of Object.values(state)) {
        if (row.entryId === entryId) row.enabled = enabled
      }
    },
  }
  return { loader, pluginManager, state, calls }
}

async function makeManager(extraServices = {}, servers = []) {
  const dir = await makeTmpDir('mcp-native-')
  const userFile = join(dir, 'mcp.json')
  await writeFile(userFile, JSON.stringify({ version: 1, servers }), 'utf8')
  const ctx = makeCtx(extraServices)
  ctx.tools.register({ name: 'mcp__LibTV__doctor', description: 'doctor', parameters: { type: 'object' } })
  ctx.tools.register({ name: 'mcp__magpie-image__generate_image', description: 'generate image', parameters: { type: 'object' } })
  const manager = new McpManager(ctx, { userConfigPath: userFile, activeWorkspace: dir })
  return { dir, userFile, ctx, manager }
}

const panelServer = (enabled) => ({
  name: 'LibTV',
  transport: 'stdio',
  enabled,
  command: 'npx',
  args: ['-y', 'mcp-remote', 'https://mcp.liblib.tv/mcp'],
})

test('a panel entry with an identical plugin-manifest twin stays primary and reuses that twin', async () => {
  const services = makeNativeServices()
  const { dir, ctx, manager } = await makeManager(services, [panelServer(true)])

  const listed = await manager.list({ scope: 'user' })
  const libtv = listed.servers.find((server) => server.name === 'LibTV')
  assert.ok(libtv)
  // The user's panel entry is the primary row.
  assert.equal(libtv.source, 'panel')
  assert.equal(libtv.origin, 'panel')
  assert.equal(libtv.enabled, true)
  assert.equal(libtv.configEnabled, true)
  assert.equal(libtv.controllable, true)
  // The identical plugin-manifest twin is reported as a note.
  assert.ok(libtv.pluginEntry)
  assert.equal(libtv.pluginEntry.patchEntryId, 'magpie-mcp-LibTV')
  assert.equal(libtv.pluginEntry.origin, 'magpie')
  assert.equal(libtv.pluginEntry.originLabel, 'Magpie')
  assert.equal(libtv.pluginEntry.enabled, true)
  assert.equal(libtv.toolCount, 1)
  assert.equal(libtv.tools[0].rawName, 'doctor')
  assert.equal(manager.runners.size, 0)

  const nativeOnly = listed.servers.find((server) => server.name === 'magpie-image')
  assert.ok(nativeOnly)
  assert.equal(nativeOnly.source, 'plugin')
  assert.equal(nativeOnly.origin, 'magpie')
  assert.equal(nativeOnly.patchEntryId, 'magpie-mcp-magpie-image')
  assert.equal(nativeOnly.enabled, true)
  assert.equal(listed.nativeControlAvailable, true)
  // Opening the panel must not change native-only servers: no disable call.
  assert.deepEqual(services.calls, [])
  // And it must not add them to the panel config.
  const saved = JSON.parse(await readFile(join(dir, 'mcp.json'), 'utf8'))
  assert.deepEqual(saved.servers.map((server) => server.name), ['LibTV'])

  await manager.dispose()
  await rm(dir, { recursive: true, force: true })
})

test('a disabled panel server disables its enabled plugin-manifest twin so tools leave the context', async () => {
  const services = makeNativeServices()
  const { dir, ctx, manager } = await makeManager(services, [panelServer(false)])

  const listed = await manager.list({ scope: 'user' })
  assert.deepEqual(services.calls, [['entry-libtv', false]])
  const libtv = listed.servers.find((server) => server.name === 'LibTV')
  assert.equal(libtv.enabled, false)
  assert.equal(libtv.configEnabled, false)
  assert.equal(libtv.source, 'panel')
  assert.equal(libtv.pluginEntry.enabled, false)
  assert.equal(libtv.toolCount, 0)
  // The native instance is now off and the panel never started a duplicate.
  assert.equal(manager.runners.has('user::LibTV'), false)

  await manager.dispose()
  await rm(dir, { recursive: true, force: true })
})

test('saving a same-name server with different settings takes over from the plugin-manifest entry', async () => {
  const services = makeNativeServices()
  const { dir, ctx, manager } = await makeManager(services, [])
  const replacement = {
    transport: 'stdio',
    enabled: true,
    command: 'definitely-not-a-real-mcp-bin-xyz',
    args: ['different'],
  }

  await manager.saveServer({ name: 'LibTV', scope: 'user', server: replacement })

  assert.deepEqual(services.calls, [['entry-libtv', false]])
  assert.equal(services.state.LibTV.enabled, false)
  const listed = await manager.list({ scope: 'user' })
  const libtv = listed.servers.find((server) => server.name === 'LibTV')
  assert.equal(libtv.source, 'panel')
  const runner = manager.runners.get('user::LibTV')
  assert.ok(runner)
  assert.equal(runner.config.command, 'definitely-not-a-real-mcp-bin-xyz')

  await manager.dispose()
  await rm(dir, { recursive: true, force: true })
})

test('toggling a plugin-only server uses the plugin manager instead of spawning a process', async () => {
  const services = makeNativeServices()
  const { dir, ctx, manager } = await makeManager(services, [])

  await manager.toggleServer({ name: 'magpie-image', scope: 'user', enabled: false })
  assert.deepEqual(services.calls, [['entry-magpie', false]])
  let listed = await manager.list({ scope: 'user' })
  let native = listed.servers.find((server) => server.name === 'magpie-image')
  assert.equal(native.enabled, false)
  assert.equal(native.toolCount, 0)

  await manager.toggleServer({ name: 'magpie-image', scope: 'user', enabled: true })
  assert.deepEqual(services.calls, [['entry-magpie', false], ['entry-magpie', true]])
  listed = await manager.list({ scope: 'user' })
  native = listed.servers.find((server) => server.name === 'magpie-image')
  assert.equal(native.enabled, true)
  assert.equal(ctx.registeredTools.has('mcp__magpie-image__generate_image'), true)

  await manager.dispose()
  await rm(dir, { recursive: true, force: true })
})

test('deleting a panel entry leaves its plugin-manifest entry enabled and visible', async () => {
  const services = makeNativeServices()
  const { dir, ctx, manager } = await makeManager(services, [panelServer(true)])

  await manager.deleteServer({ name: 'LibTV', scope: 'user' })
  // Delete removes only the panel configuration. The Magpie-written plugin
  // entry keeps its own state.
  assert.deepEqual(services.calls, [])
  assert.equal(services.state.LibTV.enabled, true)

  const listed = await manager.list({ scope: 'user' })
  const libtv = listed.servers.find((server) => server.name === 'LibTV')
  assert.ok(libtv)
  assert.equal(libtv.source, 'plugin')
  assert.equal(libtv.origin, 'magpie')
  assert.equal(libtv.patchEntryId, 'magpie-mcp-LibTV')
  assert.equal(libtv.readonly, true)
  assert.equal(libtv.enabled, true)
  assert.equal(libtv.toolCount, 1)
  assert.equal(ctx.registeredTools.has('mcp__LibTV__doctor'), true)

  await manager.dispose()
  await rm(dir, { recursive: true, force: true })
})

test('an unaddressable plugin-manifest entry is reported instead of silently injecting tools', async () => {
  const services = makeNativeServices({ libtvReadOnly: true })
  const { dir, ctx, manager } = await makeManager(services, [panelServer(false)])

  const listed = await manager.list({ scope: 'user' })
  const libtv = listed.servers.find((server) => server.name === 'LibTV')
  assert.equal(libtv.controllable, false)
  // The panel entry is primary and disabled; the still-running twin is reported.
  assert.equal(libtv.enabled, false)
  assert.equal(libtv.pluginEntry.enabled, true)
  assert.equal(libtv.runtimeEnabled, true)
  assert.match(String(libtv.error), /插件清单/)
  assert.equal(services.calls.length, 0)

  await manager.dispose()
  await rm(dir, { recursive: true, force: true })
})

test('a transient HMR nesting error is retried instead of cached as a failure', async () => {
  const services = makeNativeServices()
  const original = services.pluginManager.setPluginEnabled.bind(services.pluginManager)
  let attempts = 0
  services.pluginManager.setPluginEnabled = async (entryId, enabled) => {
    attempts += 1
    if (attempts === 1) throw new Error('HMR transactions cannot be nested')
    return await original(entryId, enabled)
  }
  const { dir, ctx, manager } = await makeManager(services, [panelServer(false)])

  const first = await manager.list({ scope: 'user' })
  const firstRow = first.servers.find((server) => server.name === 'LibTV')
  assert.equal(firstRow.enabled, false)
  assert.equal(firstRow.pluginEntry.enabled, true)
  assert.equal(manager.nativeSyncFailures.size, 0)

  const second = await manager.list({ scope: 'user' })
  assert.deepEqual(services.calls, [['entry-libtv', false]])
  const secondRow = second.servers.find((server) => server.name === 'LibTV')
  assert.equal(secondRow.enabled, false)
  assert.equal(secondRow.pluginEntry.enabled, false)

  await manager.dispose()
  await rm(dir, { recursive: true, force: true })
})

test('a server with no plugin-manifest twin still runs through the panel process path', async () => {
  const services = makeNativeServices()
  const { dir, ctx, manager } = await makeManager(services, [{
    name: 'panel-only',
    transport: 'stdio',
    enabled: false,
    command: process.execPath,
    args: ['does-not-matter.js'],
  }])

  const listed = await manager.list({ scope: 'user' })
  const server = listed.servers.find((entry) => entry.name === 'panel-only')
  assert.ok(server)
  assert.equal(server.source, 'panel')
  assert.equal(server.status, 'disabled')
  assert.equal(manager.runners.get('user::panel-only')?.status, 'disabled')

  await manager.dispose()
  await rm(dir, { recursive: true, force: true })
})
