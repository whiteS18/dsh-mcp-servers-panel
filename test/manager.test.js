import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import YAML from 'yaml'

import { McpManager } from '../index.js'
import { ProfilePatch, normalizeServerInput } from '../patch-store.js'
import { makeHost, makeTempProfile, MCP_CLIENT, toolMap } from './helpers/fake-host.js'

const YAML_OPTIONS = { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value) => value }] }

function rows(text) {
  return YAML.parse(text, YAML_OPTIONS)
    .filter((item) => item && item.insert)
    .flatMap((item) => item.insert)
    .filter((entry) => String(entry.id).startsWith('dsh-mcp-panel-'))
}

async function emptyProfile() {
  const profile = await makeTempProfile()
  await writeFile(profile.patchPath, '# profile\n[]\n', 'utf8')
  return profile
}

function panelPatch(entries) {
  const patch = ProfilePatch.parse('[]\n')
  for (const entry of entries) patch.upsertServer(normalizeServerInput(entry.name, entry.server))
  return patch.toString()
}

const foreignEntry = (id, config, disabled = false) => ({
  id,
  options: { name: MCP_CLIENT, config },
  disabled,
  fiber: disabled ? undefined : { state: 2 },
})

const FOREIGN = foreignEntry('magpie-mcp-native', {
  serverName: 'native',
  transport: 'stdio',
  command: 'npx',
  args: ['native-mcp'],
})

test('list merges panel rows with read-only foreign rows and their tools', async () => {
  const profile = await emptyProfile()
  await writeFile(profile.patchPath, panelPatch([{ name: 'panel', server: { transport: 'stdio', command: 'node' } }]), 'utf8')
  const host = makeHost({
    profile,
    foreign: [FOREIGN],
    tools: toolMap([
      ['mcp__panel__do', 'panel tool'],
      ['mcp__native__do', 'native tool'],
    ]),
  })
  await host.hmr.reconcileProfile([])
  const manager = new McpManager(host.ctx)

  const data = await manager.list()
  assert.equal(data.canManage, true)
  assert.equal(data.profile.name, '') // fake profile has no name; path is what matters
  const panel = data.servers.find((server) => server.name === 'panel')
  const native = data.servers.find((server) => server.name === 'native')
  assert.ok(panel)
  assert.equal(panel.source, 'panel')
  assert.equal(panel.status, 'connected')
  assert.equal(panel.toolCount, 1)
  assert.equal(panel.readonly, false)
  assert.ok(native)
  assert.equal(native.source, 'plugin')
  assert.equal(native.origin, 'magpie')
  assert.equal(native.originLabel, 'Magpie')
  assert.equal(native.readonly, true)
  assert.equal(native.controllable, true)
  assert.equal(native.toolCount, 1)
  assert.equal(data.nativeControlAvailable, true)
})

test('a panel row and a same-name foreign row do not duplicate; the panel row warns', async () => {
  const profile = await emptyProfile()
  await writeFile(profile.patchPath, panelPatch([{ name: 'native', server: { transport: 'stdio', command: 'node' } }]), 'utf8')
  const host = makeHost({ profile, foreign: [FOREIGN] })
  await host.hmr.reconcileProfile([])
  const manager = new McpManager(host.ctx)

  const data = await manager.list()
  assert.equal(data.servers.filter((server) => server.name === 'native').length, 1)
  const row = data.servers[0]
  assert.equal(row.source, 'panel')
  assert.match(row.warnings.join('\n'), /同名条目/)
})

test('saveServer writes one official client row and applies it through HMR', async () => {
  const profile = await emptyProfile()
  const host = makeHost({ profile })
  const manager = new McpManager(host.ctx)

  const data = await manager.saveServer({
    name: 'fast-context',
    server: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@sammysnake/fast-context-mcp'],
      env: { TOKEN: 'secret' },
    },
    createOnly: true,
  })

  assert.equal(data.application, 'applied')
  const written = rows(await readFile(profile.patchPath, 'utf8'))
  assert.equal(written.length, 1)
  assert.equal(written[0].id, 'dsh-mcp-panel-fast-context')
  assert.equal(written[0].name, MCP_CLIENT)
  assert.equal(written[0].config.serverName, 'fast-context')
  assert.deepEqual(written[0].config.args, ['-y', '@sammysnake/fast-context-mcp'])
  assert.deepEqual(host.state.calls.reconcile, [['dsh-mcp-panel-fast-context']])
  const row = data.servers.find((server) => server.name === 'fast-context')
  assert.equal(row.source, 'panel')
  assert.equal(row.status, 'connected')
})

test('saving a disabled row writes disabled:true without requiring it to activate', async () => {
  const profile = await emptyProfile()
  const host = makeHost({ profile })
  const manager = new McpManager(host.ctx)

  const data = await manager.saveServer({
    name: 'off',
    server: { transport: 'stdio', command: 'node', enabled: false },
    createOnly: true,
  })
  assert.equal(data.application, 'applied')
  assert.deepEqual(host.state.calls.reconcile, [[]])
  const written = rows(await readFile(profile.patchPath, 'utf8'))
  assert.equal(written[0].disabled, true)
  const row = data.servers.find((server) => server.name === 'off')
  assert.equal(row.enabled, false)
  assert.equal(row.status, 'disabled')
})

test('createOnly and foreign-name conflicts are rejected without touching the patch', async () => {
  const profile = await emptyProfile()
  const host = makeHost({ profile, foreign: [FOREIGN] })
  const manager = new McpManager(host.ctx)

  await manager.saveServer({ name: 'taken', server: { transport: 'stdio', command: 'node' }, createOnly: true })
  const before = await readFile(profile.patchPath, 'utf8')

  await assert.rejects(
    () => manager.saveServer({ name: 'taken', server: { transport: 'stdio', command: 'node' }, createOnly: true }),
    /不能重复添加/,
  )
  await assert.rejects(
    () => manager.saveServer({ name: 'native', server: { transport: 'stdio', command: 'node' }, createOnly: true }),
    /插件清单中的条目/,
  )
  assert.equal(await readFile(profile.patchPath, 'utf8'), before)
})

test('raw JSON batch import upserts and replaces names transactionally', async () => {
  const profile = await emptyProfile()
  const host = makeHost({ profile })
  const manager = new McpManager(host.ctx)

  await manager.saveServer({ rawJson: JSON.stringify({
    mcpServers: {
      alpha: { command: 'node', args: ['a.js'] },
      beta: { url: 'https://example.com/mcp' },
    },
  }) })
  let list = rows(await readFile(profile.patchPath, 'utf8'))
  assert.deepEqual(list.map((entry) => entry.config.serverName), ['alpha', 'beta'])

  await manager.saveServer({
    rawJson: JSON.stringify({
      mcpServers: {
        gamma: { command: 'node', args: ['g.js'] },
      },
    }),
    replaceName: 'alpha',
    createOnly: false,
  })
  list = rows(await readFile(profile.patchPath, 'utf8'))
  assert.deepEqual(list.map((entry) => entry.config.serverName).sort(), ['beta', 'gamma'])
})

test('renaming onto another panel name is rejected without overwriting it', async () => {
  const profile = await emptyProfile()
  const host = makeHost({ profile })
  const manager = new McpManager(host.ctx)

  await manager.saveServer({
    rawJson: JSON.stringify({
      mcpServers: {
        alpha: { command: 'node', args: ['alpha.js'] },
        beta: { command: 'node', args: ['beta.js'] },
      },
    }),
  })
  const before = await readFile(profile.patchPath, 'utf8')

  await assert.rejects(
    () => manager.saveServer({
      rawJson: JSON.stringify({ mcpServers: { beta: { command: 'node', args: ['renamed.js'] } } }),
      replaceName: 'alpha',
      createOnly: false,
    }),
    /不能覆盖其他服务器/,
  )
  assert.equal(await readFile(profile.patchPath, 'utf8'), before)

  const listed = await manager.list()
  const beta = listed.servers.find((server) => server.name === 'beta')
  assert.deepEqual(beta.args, ['beta.js'])
  assert.ok(listed.servers.find((server) => server.name === 'alpha'))
})

test('toggleServer writes disabled and skips a no-op write', async () => {
  const profile = await emptyProfile()
  await writeFile(profile.patchPath, panelPatch([{ name: 'panel', server: { transport: 'stdio', command: 'node' } }]), 'utf8')
  const host = makeHost({ profile })
  await host.hmr.reconcileProfile([])
  const manager = new McpManager(host.ctx)

  let data = await manager.toggleServer({ name: 'panel', enabled: false })
  assert.equal(data.application, 'applied')
  let list = rows(await readFile(profile.patchPath, 'utf8'))
  assert.equal(list[0].disabled, true)
  assert.equal(data.servers[0].status, 'disabled')
  assert.deepEqual(host.state.calls.reconcile.at(-1), [])

  const reconcileCount = host.state.calls.reconcile.length
  data = await manager.toggleServer({ name: 'panel', enabled: false })
  assert.equal(host.state.calls.reconcile.length, reconcileCount)
  assert.equal(data.application, 'applied')

  data = await manager.toggleServer({ name: 'panel', enabled: true })
  list = rows(await readFile(profile.patchPath, 'utf8'))
  assert.equal(list[0].disabled, undefined)
  assert.deepEqual(host.state.calls.reconcile.at(-1), ['dsh-mcp-panel-panel'])
})

test('deleteServer removes only panel rows; foreign rows are protected', async () => {
  const profile = await emptyProfile()
  await writeFile(profile.patchPath, panelPatch([{ name: 'panel', server: { transport: 'stdio', command: 'node' } }]), 'utf8')
  const host = makeHost({ profile, foreign: [FOREIGN] })
  await host.hmr.reconcileProfile([])
  const manager = new McpManager(host.ctx)

  await assert.rejects(() => manager.deleteServer({ name: 'native' }), /插件清单/)
  const data = await manager.deleteServer({ name: 'panel' })
  assert.equal(data.application, 'applied')
  assert.equal(rows(await readFile(profile.patchPath, 'utf8')).length, 0)
})

test('toggling a foreign row delegates to the official plugin manager', async () => {
  const profile = await emptyProfile()
  const host = makeHost({ profile, foreign: [FOREIGN] })
  const manager = new McpManager(host.ctx)

  const data = await manager.toggleServer({ name: 'native', enabled: false })
  assert.deepEqual(host.state.calls.setPluginEnabled, [['include:magpie-mcp-native', false]])
  assert.equal(data.servers.find((server) => server.name === 'native').enabled, false)
})

test('a foreign toggle overridden by a higher layer is reported as a warning, not applied silently', async () => {
  const profile = await emptyProfile()
  const host = makeHost({ profile, foreign: [FOREIGN] })
  host.pluginManager.setPluginEnabled = async () => ({ application: 'overridden' })
  const manager = new McpManager(host.ctx)

  const data = await manager.toggleServer({ name: 'native', enabled: false })
  assert.equal(data.application, 'applied')
  assert.match((data.warnings || []).join('\n'), /更高优先级的配置覆盖/)
})

test('without HMR a save reports restart-required but still persists', async () => {
  const profile = await emptyProfile()
  const host = makeHost({ profile, withHmr: false })
  const manager = new McpManager(host.ctx)

  const data = await manager.saveServer({ name: 'panel', server: { transport: 'stdio', command: 'node' } })
  assert.equal(data.application, 'restart-required')
  assert.equal(data.restartReason, 'no-hmr')
  assert.equal(rows(await readFile(profile.patchPath, 'utf8')).length, 1)
})

test('a failed reconcile restores the previous patch', async () => {
  const profile = await emptyProfile()
  const host = makeHost({ profile })
  const manager = new McpManager(host.ctx)
  const before = await readFile(profile.patchPath, 'utf8')
  host.state.failNextReconcile = new Error('boom')

  await assert.rejects(
    () => manager.saveServer({ name: 'panel', server: { transport: 'stdio', command: 'node' } }),
    /已回滚/,
  )
  assert.equal(await readFile(profile.patchPath, 'utf8'), before)
})

test('a missing profileContext leaves the panel read-only', async () => {
  const host = makeHost({ profile: undefined, foreign: [FOREIGN] })
  const manager = new McpManager(host.ctx)
  const data = await manager.list()
  assert.equal(data.canManage, false)
  assert.equal(data.servers.some((server) => server.name === 'native'), true)
  assert.match((data.warnings || []).join('\n'), /profileContext/)
  await assert.rejects(
    () => manager.saveServer({ name: 'x', server: { transport: 'stdio', command: 'node' } }),
    /profileContext/,
  )
})
