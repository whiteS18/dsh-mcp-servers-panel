import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { McpManager, detectLegacyConfigs } from '../index.js'
import { makeHost, makeTempProfile, MCP_CLIENT } from './helpers/fake-host.js'

async function legacyFixture() {
  const home = await mkdtemp(join(tmpdir(), 'mcp-legacy-home-'))
  const projectDir = await mkdtemp(join(tmpdir(), 'mcp-legacy-project-'))
  await mkdir(join(home, '.dsh'), { recursive: true })
  await mkdir(join(projectDir, '.dsh'), { recursive: true })
  const userFile = join(home, '.dsh', 'mcp.json')
  const projectFile = join(projectDir, '.dsh', 'mcp.json')
  await writeFile(userFile, JSON.stringify({
    version: 1,
    servers: [
      { name: 'alpha', transport: 'stdio', command: 'npx', args: ['-y', 'alpha'], env: { TOKEN: 'secret' }, enabled: true },
    ],
  }), 'utf8')
  await writeFile(projectFile, JSON.stringify({
    version: 1,
    servers: [
      { name: 'beta', transport: 'streamable-http', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer secret' }, enabled: false },
    ],
  }), 'utf8')
  return { home, projectDir, userFile, projectFile }
}

async function profileFixture() {
  const profile = await makeTempProfile('mcp-migration-')
  await writeFile(profile.patchPath, '# profile\n[]\n', 'utf8')
  return profile
}

function managerFor(profile, legacy) {
  const host = makeHost({ profile })
  const manager = new McpManager(host.ctx, {
    legacyHome: legacy.home,
    legacyProjects: [{ path: legacy.projectDir, title: 'project-a' }],
  })
  return { host, manager }
}

test('detectLegacyConfigs reads user and project files without changing them', async () => {
  const legacy = await legacyFixture()
  const before = await readFile(legacy.userFile, 'utf8')
  const configs = await detectLegacyConfigs({
    home: legacy.home,
    projects: [{ path: legacy.projectDir, title: 'project-a' }],
  })
  assert.equal(configs.length, 2)
  assert.equal(configs[0].kind, 'user')
  assert.equal(configs[0].servers[0].name, 'alpha')
  assert.equal(configs[0].servers[0].config.env.TOKEN, 'secret')
  assert.equal(configs[1].kind, 'project')
  assert.equal(configs[1].title, 'project-a')
  assert.equal(configs[1].servers[0].name, 'beta')
  assert.equal(await readFile(legacy.userFile, 'utf8'), before)
})

test('list returns legacy summaries without exposing env or headers', async () => {
  const legacy = await legacyFixture()
  const profile = await profileFixture()
  const { manager } = managerFor(profile, legacy)
  const data = await manager.list()
  assert.equal(data.legacyConfigs.length, 2)
  const user = data.legacyConfigs.find((item) => item.kind === 'user')
  assert.equal(user.count, 1)
  assert.deepEqual(user.names, ['alpha'])
  assert.equal(JSON.stringify(data.legacyConfigs).includes('secret'), false)
})

test('importLegacy writes selected servers disabled by default and keeps legacy files intact', async () => {
  const legacy = await legacyFixture()
  const profile = await profileFixture()
  const { manager } = managerFor(profile, legacy)
  const before = await readFile(legacy.userFile, 'utf8')

  const response = await manager.importLegacy({
    items: [{ name: 'alpha', server: { transport: 'stdio', command: 'npx', args: ['-y', 'alpha'] } }],
  })
  assert.equal(response.imported, 1)
  assert.equal(response.application, 'applied')

  const patchText = await readFile(profile.patchPath, 'utf8')
  assert.match(patchText, /dsh-mcp-panel-alpha/)
  assert.match(patchText, /disabled: true/)
  const alpha = response.servers.find((server) => server.name === 'alpha')
  assert.ok(alpha)
  assert.equal(alpha.enabled, false)
  assert.equal(await readFile(legacy.userFile, 'utf8'), before)
})

test('importLegacy enable writes an enabled row and asks HMR to load it', async () => {
  const legacy = await legacyFixture()
  const profile = await profileFixture()
  const { host, manager } = managerFor(profile, legacy)
  const response = await manager.importLegacy({
    enable: true,
    items: [{ name: 'beta', server: { transport: 'streamable-http', url: 'https://example.test/mcp' } }],
  })
  assert.equal(response.imported, 1)
  assert.equal(response.servers.find((server) => server.name === 'beta').enabled, true)
  const patchText = await readFile(profile.patchPath, 'utf8')
  assert.doesNotMatch(patchText, /disabled: true/)
  assert.deepEqual(host.state.calls.reconcile.at(-1), ['dsh-mcp-panel-beta'])
})

test('importLegacy refuses a name that already exists as a panel row', async () => {
  const legacy = await legacyFixture()
  const profile = await profileFixture()
  const { manager } = managerFor(profile, legacy)
  await manager.importLegacy({
    items: [{ name: 'alpha', server: { transport: 'stdio', command: 'npx' } }],
  })
  const before = await readFile(profile.patchPath, 'utf8')
  await assert.rejects(
    () => manager.importLegacy({
      items: [{ name: 'alpha', server: { transport: 'stdio', command: 'npx' } }],
    }),
    /已存在 MCP 服务/,
  )
  assert.equal(await readFile(profile.patchPath, 'utf8'), before)
})

test('importLegacy refuses a name owned by a foreign plugin row', async () => {
  const legacy = await legacyFixture()
  const profile = await profileFixture()
  const host = makeHost({
    profile,
    foreign: [{
      id: 'magpie-mcp-alpha',
      options: { name: MCP_CLIENT, config: { serverName: 'alpha', transport: 'stdio', command: 'npx' } },
      disabled: false,
      fiber: { state: 2 },
    }],
  })
  const manager = new McpManager(host.ctx, {
    legacyHome: legacy.home,
    legacyProjects: [{ path: legacy.projectDir, title: 'project-a' }],
  })
  await assert.rejects(
    () => manager.importLegacy({
      items: [{ name: 'alpha', server: { transport: 'stdio', command: 'npx' } }],
    }),
    /插件清单中的条目/,
  )
})

test('detectLegacyConfigs falls back to mcp-servers.json only when mcp.json is absent', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mcp-legacy-fallback-'))
  await mkdir(join(home, '.dsh'), { recursive: true })
  await writeFile(join(home, '.dsh', 'mcp-servers.json'), JSON.stringify({
    mcpServers: { legacy: { command: 'node', args: ['legacy.js'] } },
  }), 'utf8')
  const configs = await detectLegacyConfigs({ home, projects: [] })
  assert.equal(configs.length, 1)
  assert.equal(configs[0].servers[0].name, 'legacy')
})
