import test from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeServerList,
  formatCanonicalConfig,
  McpManager,
  McpProcessRunner,
} from '../index.js'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('normalizeServerList handles array format', () => {
  const input = {
    version: 1,
    servers: [
      {
        name: 'test-server',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'my-pkg'],
        env: { FOO: 'bar' },
        enabled: true,
      },
    ],
  }
  const result = normalizeServerList(input, 'workspace')
  assert.equal(result.length, 1)
  assert.equal(result[0].name, 'test-server')
  assert.equal(result[0].transport, 'stdio')
  assert.equal(result[0].command, 'npx')
  assert.deepEqual(result[0].args, ['-y', 'my-pkg'])
  assert.deepEqual(result[0].env, { FOO: 'bar' })
  assert.equal(result[0].enabled, true)
  assert.equal(result[0].scope, 'workspace')
})

test('normalizeServerList handles mcpServers dictionary format', () => {
  const input = {
    mcpServers: {
      'github-mcp': {
        type: 'stdio',
        command: 'uvx',
        args: ['github-mcp-server'],
      },
      'remote-web': {
        type: 'sse',
        url: 'https://example.com/mcp',
      },
    },
  }
  const result = normalizeServerList(input, 'user')
  assert.equal(result.length, 2)
  const gh = result.find((s) => s.name === 'github-mcp')
  assert.ok(gh)
  assert.equal(gh.transport, 'stdio')
  assert.equal(gh.command, 'uvx')
  assert.deepEqual(gh.args, ['github-mcp-server'])
  assert.equal(gh.scope, 'user')

  const web = result.find((s) => s.name === 'remote-web')
  assert.ok(web)
  assert.equal(web.transport, 'streamable-http')
  assert.equal(web.url, 'https://example.com/mcp')
})

test('formatCanonicalConfig formats correctly', () => {
  const servers = [
    {
      name: 'srv1',
      transport: 'stdio',
      command: 'node',
      args: ['app.js'],
      env: { KEY: 'val' },
      enabled: true,
      toolCallTimeoutMs: 30000,
    },
  ]
  const canonical = formatCanonicalConfig(servers)
  assert.equal(canonical.version, 1)
  assert.equal(canonical.servers.length, 1)
  assert.equal(canonical.servers[0].name, 'srv1')
  assert.equal(canonical.servers[0].command, 'node')
  assert.deepEqual(canonical.servers[0].args, ['app.js'])
  assert.deepEqual(canonical.servers[0].env, { KEY: 'val' })
})

test('McpProcessRunner lifecycle and tool discovery with a mock stdio server', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-test-'))
  const mockServerScript = join(dir, 'mock-server.cjs')

  // Create a minimal mock MCP server over stdio
  await writeFile(
    mockServerScript,
    `
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });

rl.on('line', (line) => {
  try {
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'mock-test', version: '1.0.0' }
        }
      }) + '\\n');
    } else if (msg.method === 'notifications/initialized') {
      // noop
    } else if (msg.method === 'tools/list') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          tools: [
            {
              name: 'echo_tool',
              description: 'Echoes the input',
              inputSchema: {
                type: 'object',
                properties: { message: { type: 'string' } }
              }
            }
          ]
        }
      }) + '\\n');
    } else if (msg.method === 'tools/call') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          content: [{ type: 'text', text: 'Echo: ' + msg.params.arguments.message }]
        }
      }) + '\\n');
    }
  } catch (e) {}
});
`
  )

  const registeredTools = []
  const mockCtx = {
    tools: {
      register(def) {
        registeredTools.push(def)
        return () => {
          const idx = registeredTools.indexOf(def)
          if (idx >= 0) registeredTools.splice(idx, 1)
        }
      },
    },
  }

  const runner = new McpProcessRunner(
    mockCtx,
    {
      name: 'mock',
      transport: 'stdio',
      command: process.execPath,
      args: [mockServerScript],
      enabled: true,
    },
    dir
  )

  await runner.start()

  assert.equal(runner.status, 'connected')
  assert.equal(runner.tools.length, 1)
  assert.equal(runner.tools[0].name, 'mcp__mock__echo_tool')
  assert.equal(registeredTools.length, 1)
  assert.equal(registeredTools[0].name, 'mcp__mock__echo_tool')

  // Execute tool
  const result = await runner.callTool('echo_tool', { message: 'hello world' })
  assert.ok(result.content)
  assert.equal(result.content[0].text, 'Echo: hello world')

  // Stop runner and verify cleanup
  runner.stop()
  assert.equal(runner.status, 'disabled')
  assert.equal(registeredTools.length, 0)

  await rm(dir, { recursive: true, force: true })
})
