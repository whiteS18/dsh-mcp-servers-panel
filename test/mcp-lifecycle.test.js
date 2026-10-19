import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

import { McpManager, McpProcessRunner } from '../index.js'
import {
  createMockMcpServer,
  makeCtx,
  makeTmpDir,
  nodeChildEnv,
} from './helpers/mcp-fixtures.js'

async function writeUserConfig(file, servers) {
  await writeFile(file, JSON.stringify({ version: 1, servers }), 'utf8')
}

function stdioServer(name, serverFile, extra = {}) {
  return {
    name,
    transport: 'stdio',
    enabled: true,
    command: process.execPath,
    args: [serverFile],
    env: nodeChildEnv(),
    toolCallTimeoutMs: 8000,
    ...extra,
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('dispose during an in-flight reconcile removes tools and never respawns', async () => {
  const dir = await makeTmpDir('mcp-race-')
  const serverFile = await createMockMcpServer(dir)
  const userFile = join(dir, 'mcp.json')
  await writeUserConfig(userFile, [stdioServer('mock', serverFile)])
  const ctx = makeCtx()
  const manager = new McpManager(ctx, { userConfigPath: userFile, activeWorkspace: dir })

  const pending = manager.reconcile()
  await manager.dispose()
  await pending.catch(() => {})
  await sleep(150)

  assert.equal(ctx.registeredTools.size, 0)
  assert.equal(manager.runners.size, 0)
  await rm(dir, { recursive: true, force: true })
})

test('concurrent reconciliations are serialized and register each tool once', async () => {
  const dir = await makeTmpDir('mcp-serial-')
  const serverFile = await createMockMcpServer(dir)
  const userFile = join(dir, 'mcp.json')
  await writeUserConfig(userFile, [stdioServer('mock', serverFile)])
  const ctx = makeCtx()
  const manager = new McpManager(ctx, { userConfigPath: userFile, activeWorkspace: dir })

  await Promise.all([manager.reconcile(), manager.reconcile(), manager.reconcile()])
  assert.equal(ctx.registeredTools.size, 2)
  assert.equal(manager.runners.size, 1)
  const runner = [...manager.runners.values()][0]
  assert.equal(runner.status, 'connected')

  await manager.dispose()
  assert.equal(ctx.registeredTools.size, 0)
  await rm(dir, { recursive: true, force: true })
})

test('disabling a server while it is still connecting leaves no tools behind', async () => {
  const dir = await makeTmpDir('mcp-toggle-')
  const serverFile = await createMockMcpServer(dir)
  const userFile = join(dir, 'mcp.json')
  await writeUserConfig(userFile, [stdioServer('mock', serverFile)])
  const ctx = makeCtx()
  const manager = new McpManager(ctx, { userConfigPath: userFile, activeWorkspace: dir })

  const connecting = manager.reconcile()
  await manager.toggleServer({ name: 'mock', scope: 'user', enabled: false })
  await connecting.catch(() => {})
  await sleep(200)

  assert.equal(ctx.registeredTools.size, 0)
  const saved = JSON.parse(await readFile(userFile, 'utf8'))
  assert.equal(saved.servers[0].enabled, false)
  const runner = [...manager.runners.values()][0]
  assert.ok(runner)
  assert.equal(runner.status, 'disabled')

  await manager.dispose()
  await rm(dir, { recursive: true, force: true })
})

test('a disabled server never starts a process or registers tools', async () => {
  const dir = await makeTmpDir('mcp-disabled-')
  const serverFile = await createMockMcpServer(dir)
  const userFile = join(dir, 'mcp.json')
  await writeUserConfig(userFile, [stdioServer('mock', serverFile, { enabled: false })])
  const ctx = makeCtx()
  const manager = new McpManager(ctx, { userConfigPath: userFile, activeWorkspace: dir })

  await manager.reconcile()
  assert.equal(ctx.registeredTools.size, 0)
  const runner = [...manager.runners.values()][0]
  assert.equal(runner.status, 'disabled')
  assert.equal(runner.child, null)

  await manager.dispose()
  await rm(dir, { recursive: true, force: true })
})

test('McpProcessRunner.stop is idempotent and waits for the child', async () => {
  const dir = await makeTmpDir('mcp-stop-')
  const serverFile = await createMockMcpServer(dir)
  const ctx = makeCtx()
  const runner = new McpProcessRunner(ctx, {
    name: 'mock',
    transport: 'stdio',
    enabled: true,
    command: process.execPath,
    args: [serverFile],
    env: nodeChildEnv(),
  }, dir)
  await runner.start()
  assert.equal(runner.status, 'connected')
  const first = runner.stop()
  const second = runner.stop()
  assert.equal(first, second)
  await first
  assert.equal(runner.status, 'disabled')
  assert.equal(runner.child, null)
  assert.equal(ctx.registeredTools.size, 0)
  await rm(dir, { recursive: true, force: true })
})

test('the host event loop drains after a reconcile/shutdown race', async () => {
  const dir = await makeTmpDir('mcp-exit-')
  const serverFile = await createMockMcpServer(dir)
  const userFile = join(dir, 'mcp.json')
  await writeUserConfig(userFile, [stdioServer('mock', serverFile)])
  const harness = new URL('./helpers/exit-harness.mjs', import.meta.url)

  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, [harness.pathname.replace(/^\//, '')], {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...nodeChildEnv(),
        MCP_TEST_CONFIG: userFile,
        MCP_TEST_WORKSPACE: dir,
      },
    })
    let out = ''
    let err = ''
    child.stdout?.on('data', (chunk) => { out += chunk })
    child.stderr?.on('data', (chunk) => { err += chunk })
    let killed = false
    const timer = setTimeout(() => {
      killed = true
      child.kill('SIGKILL')
    }, 10000)
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, killed, out, err })
    })
  })

  assert.equal(result.killed, false, 'host was kept alive by a leaked MCP child: ' + result.err)
  assert.equal(result.code, 0, result.err)
  await rm(dir, { recursive: true, force: true })
})
