import { writeFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'


/** Whether this test process runs under Electron's Node mode. */
export const isElectronNode = Boolean(process.versions.electron)

/** Env additions a spawned child needs to behave as plain Node. */
export function nodeChildEnv() {
  return isElectronNode ? { ELECTRON_RUN_AS_NODE: '1' } : {}
}

/** Create a minimal MCP stdio server script and return its absolute path. */
export async function createMockMcpServer(dir) {
  const file = join(dir, 'mock-mcp-server.cjs')
  const source = [
    "const readline = require('node:readline')",
    "const rl = readline.createInterface({ input: process.stdin })",
    "rl.on('line', (line) => {",
    "  let msg",
    "  try { msg = JSON.parse(line) } catch { return }",
    "  if (!msg || msg.id === undefined) return",
    "  const send = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n')",
    "  if (msg.method === 'initialize') {",
    "    send({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'mock', version: '1.0.0' } })",
    "  } else if (msg.method === 'tools/list') {",
    "    send({ tools: [",
    "      { name: 'echo', description: 'Echo text', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },",
    "      { name: 'ping', description: 'Ping', inputSchema: { type: 'object', properties: {} } }",
    "    ] })",
    "  } else if (msg.method === 'tools/call') {",
    "    send({ content: [{ type: 'text', text: 'ok' }] })",
    "  }",
    "})",
    "process.stdin.on('end', () => process.exit(0))",
    "process.on('SIGTERM', () => process.exit(0))",
    "process.on('SIGINT', () => process.exit(0))",
    ''
  ].join('\n')
  await writeFile(file, source, 'utf8')
  return file
}

/** A working directory with an isolated .dsh config. */
export async function makeTmpDir(prefix) {
  return await mkdtemp(join(tmpdir(), prefix))
}

/** In-memory tool registry shaped like the DSH tools service. */
export function makeToolRegistry() {
  const tools = new Map()
  return {
    tools,
    service: {
      register(definition) {
        if (tools.has(definition.name)) throw new Error('duplicate tool ' + definition.name)
        tools.set(definition.name, definition)
        return () => {
          if (tools.get(definition.name) === definition) tools.delete(definition.name)
        }
      },
      view() {
        return { visible: new Map(tools) }
      },
      restrict() { return () => {} },
    },
  }
}

/** Context stub covering the services the panel reaches with ctx.get(). */
export function makeCtx(extra = {}) {
  const registry = makeToolRegistry()
  const ctx = {
    tools: registry.service,
    registeredTools: registry.tools,
    logger: { warn() {}, error() {}, info() {} },
    on() {},
    effect() {},
    get(name) {
      if (Object.prototype.hasOwnProperty.call(extra, name)) return extra[name]
      return undefined
    },
    ...extra,
  }
  return ctx
}

