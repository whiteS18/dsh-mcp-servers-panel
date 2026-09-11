import test from 'node:test'
import assert from 'node:assert/strict'
import {
  McpManager,
  normalizeServerList,
  isLoopbackRequest,
} from '../index.js'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('isLoopbackRequest detects local requests accurately', () => {
  assert.equal(isLoopbackRequest({ socket: { remoteAddress: '127.0.0.1' } }), true)
  assert.equal(isLoopbackRequest({ socket: { remoteAddress: '::1' } }), true)
  assert.equal(isLoopbackRequest({ socket: { remoteAddress: '::ffff:127.0.0.1' } }), true)
  assert.equal(isLoopbackRequest({ socket: { remoteAddress: '192.168.1.100' } }), false)
  assert.equal(isLoopbackRequest({ socket: { remoteAddress: '10.0.0.1' } }), false)
  assert.equal(isLoopbackRequest({ socket: { remoteAddress: '' } }), false)
  assert.equal(isLoopbackRequest({}), false)
})

test('McpManager batch save via rawJson in Cursor / ZCode format', async () => {
  const wsDir = await mkdtemp(join(tmpdir(), 'mcp-batch-ws-'))

  const mockCtx = {
    tools: { register() { return () => {} } },
    logger: { warn() {}, error() {}, info() {} },
  }

  const manager = new McpManager(mockCtx)
  manager.activeWorkspace = wsDir

  const rawJson = JSON.stringify({
    mcpServers: {
      'server-a': {
        command: 'echo',
        args: ['a'],
        env: { A: '1' },
      },
      'server-b': {
        type: 'streamable-http',
        url: 'https://example.com/sse',
        headers: { Authorization: 'Bearer token' },
      },
    },
  })

  await manager.saveServer({ rawJson, scope: 'workspace', workspacePath: wsDir })

  const wsFile = join(wsDir, '.dsh', 'mcp.json')
  const content = JSON.parse(await readFile(wsFile, 'utf8'))

  assert.equal(content.version, 1)
  assert.equal(content.servers.length, 2)

  const sA = content.servers.find((s) => s.name === 'server-a')
  assert.ok(sA)
  assert.equal(sA.command, 'echo')
  assert.deepEqual(sA.args, ['a'])
  assert.deepEqual(sA.env, { A: '1' })

  const sB = content.servers.find((s) => s.name === 'server-b')
  assert.ok(sB)
  assert.equal(sB.transport, 'streamable-http')
  assert.equal(sB.url, 'https://example.com/sse')
  assert.deepEqual(sB.headers, { Authorization: 'Bearer token' })

  manager.dispose()
  await rm(wsDir, { recursive: true, force: true })
})

test('JSON save with replaceName renames a server instead of leaving the old one', async () => {
  const wsDir = await mkdtemp(join(tmpdir(), 'mcp-rename-ws-'))

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
    server: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@sammysnake/fast-context-mcp@next'],
    },
  })

  await manager.saveServer({
    rawJson: JSON.stringify({
      mcpServers: {
        'fast-context-mcp': {
          command: 'npx',
          args: ['-y', '@sammysnake/fast-context-mcp@next'],
        },
      },
    }),
    scope: 'workspace',
    workspacePath: wsDir,
    replaceName: 'fast-context',
  })

  const wsFile = join(wsDir, '.dsh', 'mcp.json')
  const content = JSON.parse(await readFile(wsFile, 'utf8'))
  const names = content.servers.map((s) => s.name).sort()
  assert.deepEqual(names, ['fast-context-mcp'])

  const listed = await manager.list({ scope: 'workspace', workspacePath: wsDir })
  assert.equal(listed.servers.length, 1)
  assert.equal(listed.servers[0].name, 'fast-context-mcp')

  manager.dispose()
  await rm(wsDir, { recursive: true, force: true })
})

test('normalizeServerList handles DSH canonical servers object and array format', () => {
  const canonicalObj = {
    servers: {
      'my-srv': {
        command: 'node',
        args: ['index.js'],
      },
    },
  }
  const res1 = normalizeServerList(canonicalObj, 'workspace', '/tmp/demo')
  assert.equal(res1.length, 1)
  assert.equal(res1[0].name, 'my-srv')
  assert.equal(res1[0].command, 'node')
  assert.equal(res1[0].workspacePath, '/tmp/demo')

  const arrayObj = [
    {
      name: 'srv-1',
      command: 'python',
      args: ['main.py'],
    },
  ]
  const res2 = normalizeServerList(arrayObj, 'user')
  assert.equal(res2.length, 1)
  assert.equal(res2[0].name, 'srv-1')
  assert.equal(res2[0].scope, 'user')
})
