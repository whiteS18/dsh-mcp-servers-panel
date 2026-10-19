import { McpManager } from '../../index.js'

const userFile = process.env.MCP_TEST_CONFIG
const workspace = process.env.MCP_TEST_WORKSPACE

const tools = new Map()
const ctx = {
  tools: {
    register(definition) {
      tools.set(definition.name, definition)
      return () => {
        if (tools.get(definition.name) === definition) tools.delete(definition.name)
      }
    },
    view() {
      return { visible: new Map(tools) }
    },
  },
  logger: { warn() {}, error() {}, info() {} },
  get() { return undefined },
  on() {},
  effect() {},
}

const manager = new McpManager(ctx, { userConfigPath: userFile, activeWorkspace: workspace })
const pending = manager.reconcile()
// Shutdown immediately, mid-reconcile, like the desktop host does on update.
await manager.dispose()
await pending.catch(() => {})
if (tools.size !== 0) {
  console.error('tools still registered after dispose: ' + [...tools.keys()].join(','))
  process.exitCode = 3
} else {
  process.exitCode = 0
}
// Deliberately no process.exit(): the test observes whether the event loop
// drains on its own. A leaked child process keeps it alive.
