import test from 'node:test'
import assert from 'node:assert/strict'
import {
  McpManager,
  defaultWorkspaceRoot,
  sameResolvedPath,
} from '../index.js'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

test('McpManager save, toggle, delete, and list operations with workspace scope', async () => {
  const wsDir = await mkdtemp(join(tmpdir(), 'mcp-ws-'))
  const userDir = await mkdtemp(join(tmpdir(), 'mcp-user-'))

  const mockCtx = {
    tools: {
      register(def) {
        return () => {}
      },
    },
    logger: {
      warn() {},
      error() {},
      info() {},
    },
  }

  const manager = new McpManager(mockCtx)
  manager.activeWorkspace = wsDir

  // Save server to workspace scope
  await manager.saveServer({
    name: 'test-ws-server',
    scope: 'workspace',
    workspacePath: wsDir,
    server: {
      transport: 'stdio',
      command: 'echo',
      args: ['hello'],
    },
  })

  // Verify file written to workspace .dsh/mcp.json
  const wsFile = join(wsDir, '.dsh', 'mcp.json')
  const wsContent = JSON.parse(await readFile(wsFile, 'utf8'))
  assert.equal(wsContent.version, 1)
  assert.equal(wsContent.servers.length, 1)
  assert.equal(wsContent.servers[0].name, 'test-ws-server')
  assert.equal(wsContent.servers[0].enabled, true)

  // List servers under that workspace
  const list1 = await manager.list({ scope: 'workspace', workspacePath: wsDir })
  const found = list1.servers.find((s) => s.name === 'test-ws-server')
  assert.ok(found)
  assert.equal(found.scope, 'workspace')
  assert.equal(found.workspacePath, wsDir)

  // Toggle server
  await manager.toggleServer({
    name: 'test-ws-server',
    scope: 'workspace',
    workspacePath: wsDir,
    enabled: false,
  })
  const wsContentToggled = JSON.parse(await readFile(wsFile, 'utf8'))
  assert.equal(wsContentToggled.servers[0].enabled, false)

  // Delete server
  await manager.deleteServer({
    name: 'test-ws-server',
    scope: 'workspace',
    workspacePath: wsDir,
  })
  const wsContentDeleted = JSON.parse(await readFile(wsFile, 'utf8'))
  assert.equal(wsContentDeleted.servers.length, 0)

  manager.dispose()
  await rm(wsDir, { recursive: true, force: true })
  await rm(userDir, { recursive: true, force: true })
})

test('createOnly rejects adding the same MCP name in the same workspace', async () => {
  const wsDir = await mkdtemp(join(tmpdir(), 'mcp-dup-ws-'))

  const mockCtx = {
    tools: { register() { return () => {} } },
    logger: { warn() {}, error() {}, info() {} },
  }

  const manager = new McpManager(mockCtx)
  manager.activeWorkspace = wsDir

  await manager.saveServer({
    name: 'fast-context',
    scope: 'workspace',
    workspacePath: wsDir,
    createOnly: true,
    server: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'pkg'],
    },
  })

  await assert.rejects(
    () => manager.saveServer({
      name: 'fast-context',
      scope: 'workspace',
      workspacePath: wsDir,
      createOnly: true,
      server: {
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'pkg'],
      },
    }),
    /当前工作区已添加过 MCP 服务「fast-context」，不能再次添加/,
  )

  await assert.rejects(
    () => manager.saveServer({
      rawJson: JSON.stringify({
        mcpServers: {
          'fast-context': {
            command: 'npx',
            args: ['-y', 'pkg'],
          },
        },
      }),
      scope: 'workspace',
      workspacePath: wsDir,
      createOnly: true,
    }),
    /当前工作区已添加过 MCP 服务「fast-context」，不能再次添加/,
  )

  // Editing the same name remains allowed
  await manager.saveServer({
    name: 'fast-context',
    scope: 'workspace',
    workspacePath: wsDir,
    server: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'pkg-updated'],
    },
  })

  const listed = await manager.list({ scope: 'workspace', workspacePath: wsDir })
  assert.equal(listed.servers.length, 1)
  assert.deepEqual(listed.servers[0].args, ['-y', 'pkg-updated'])

  manager.dispose()
  await rm(wsDir, { recursive: true, force: true })
})

test('defaultWorkspaceRoot never treats the home directory as a workspace', () => {
  const home = homedir()
  const root = defaultWorkspaceRoot({
    get(name) {
      if (name === 'sandboxPolicy') return { workspaceRoot: home }
      if (name === 'session') return { header: { cwd: home } }
      return undefined
    },
  })
  assert.equal(sameResolvedPath(root, home), false)
})

test('user and workspace MCP configs are isolated: list and delete do not cross scopes', async () => {
  const wsDir = await mkdtemp(join(tmpdir(), 'mcp-iso-ws-'))
  const userDir = await mkdtemp(join(tmpdir(), 'mcp-iso-user-'))
  const userFile = join(userDir, 'mcp.json')

  const mockCtx = {
    tools: { register() { return () => {} } },
    logger: { warn() {}, error() {}, info() {} },
  }

  const manager = new McpManager(mockCtx, {
    activeWorkspace: wsDir,
    userConfigPath: userFile,
  })

  await manager.saveServer({
    name: 'fast-context',
    scope: 'user',
    createOnly: true,
    server: { transport: 'stdio', command: 'npx', args: ['-y', 'global-pkg'] },
  })

  await manager.saveServer({
    name: 'fast-context',
    scope: 'workspace',
    workspacePath: wsDir,
    createOnly: true,
    server: { transport: 'stdio', command: 'npx', args: ['-y', 'workspace-pkg'] },
  })

  const userList = await manager.list({ scope: 'user' })
  assert.equal(userList.servers.length, 1)
  assert.equal(userList.servers[0].scope, 'user')
  assert.deepEqual(userList.servers[0].args, ['-y', 'global-pkg'])

  const wsList = await manager.list({ scope: 'workspace', workspacePath: wsDir })
  assert.equal(wsList.servers.length, 1)
  assert.equal(wsList.servers[0].scope, 'workspace')
  assert.deepEqual(wsList.servers[0].args, ['-y', 'workspace-pkg'])

  await manager.deleteServer({
    name: 'fast-context',
    scope: 'workspace',
    workspacePath: wsDir,
  })

  const wsAfter = await manager.list({ scope: 'workspace', workspacePath: wsDir })
  assert.equal(wsAfter.servers.length, 0)

  const userAfter = await manager.list({ scope: 'user' })
  assert.equal(userAfter.servers.length, 1)
  assert.equal(userAfter.servers[0].name, 'fast-context')
  assert.equal(userAfter.servers[0].scope, 'user')

  const userContent = JSON.parse(await readFile(userFile, 'utf8'))
  assert.equal(userContent.servers.length, 1)
  assert.equal(userContent.servers[0].name, 'fast-context')

  manager.dispose()
  await rm(wsDir, { recursive: true, force: true })
  await rm(userDir, { recursive: true, force: true })
})

test('saving a workspace MCP starts a runner even if it is not the active workspace', async () => {
  const wsDir = await mkdtemp(join(tmpdir(), 'mcp-watch-ws-'))
  const otherDir = await mkdtemp(join(tmpdir(), 'mcp-watch-other-'))
  const userDir = await mkdtemp(join(tmpdir(), 'mcp-watch-user-'))

  const mockCtx = {
    tools: { register() { return () => {} } },
    logger: { warn() {}, error() {}, info() {} },
  }

  const manager = new McpManager(mockCtx, {
    activeWorkspace: otherDir,
    userConfigPath: join(userDir, 'mcp.json'),
  })

  await manager.saveServer({
    name: 'ws-only',
    scope: 'workspace',
    workspacePath: wsDir,
    server: {
      transport: 'stdio',
      command: 'echo',
      args: ['hello'],
      enabled: false,
    },
  })

  const key = `workspace:${resolve(wsDir)}:ws-only`
  assert.equal(manager.runners.has(key), true)
  assert.equal(manager.runners.get(key).status, 'disabled')

  const listed = await manager.list({ scope: 'workspace', workspacePath: wsDir })
  assert.equal(listed.servers.length, 1)
  assert.equal(listed.servers[0].name, 'ws-only')
  assert.notEqual(listed.servers[0].status, 'connecting')
  assert.equal(listed.servers[0].status, 'disabled')

  manager.dispose()
  await rm(wsDir, { recursive: true, force: true })
  await rm(otherDir, { recursive: true, force: true })
  await rm(userDir, { recursive: true, force: true })
})
