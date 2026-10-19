import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const clientPath = fileURLToPath(new URL('../client.js', import.meta.url))
const source = readFileSync(clientPath, 'utf8')

test('client.js passes node --check', () => {
  execFileSync(process.execPath, ['--check', clientPath], { stdio: 'pipe' })
})

test('client.js drops the user/segment management model', () => {
  const removed = [
    'parseScopeKey',
    'scopeOptions',
    'selectedScope',
    'defaultScopeKey',
    'filterScope',
    'workspaces',
    'activeWorkspace',
    'workspacePath',
    'scopeUser',
    'scopeWorkspacePrefix',
    'scopeBadge',
  ]

  for (const needle of removed) {
    assert.equal(source.includes(needle), false, `client.js still references ${needle}`)
  }

  assert.doesNotMatch(source, /\bscope\b/i, 'client.js still mentions scope')
  assert.doesNotMatch(source, /workspace/i, 'client.js still mentions workspace')
})

test('client.js sends the patch-backed host payloads', () => {
  const required = [
    "apiCall(rpc, 'list', {})",
    "apiCall(rpc, 'toggle', { name: server.name, enabled: !server.enabled })",
    "apiCall(rpc, 'delete', { name: server.name })",
    "apiCall(rpc, 'save', payload)",
    'rawJson: jsonText',
    'createOnly: !isEditing',
    'payload.replaceName = initialServer.name',
    "application === 'restart-required'",
    'restartReason',
    'canManage',
    'controllable',
    'readonly',
    'patchEntryId',
    'entryId',
    'originLabel',
    'toolCallTimeoutMs',
    'reconnect',
    'nativeControlAvailable',
    'profile',
  ]

  for (const needle of required) {
    assert.ok(source.includes(needle), `client.js is missing ${needle}`)
  }

  // JSON editing still accepts the legacy wrappers and batch imports.
  assert.match(source, /mcpServers/)
  assert.match(source, /looksLikeOfficialConfig/)
  assert.match(source, /replaceName/)
})

test('client.js exposes the selective legacy-config migration flow', () => {
  const required = [
    'legacyConfigs',
    "apiCall(rpc, 'legacy', {})",
    "apiCall(rpc, 'import'",
    'legacyDismissed',
    'legacyImportTitle',
    'legacyImportConfirm',
    'legacySourceProject',
  ]
  for (const needle of required) {
    assert.ok(source.includes(needle), `client.js is missing ${needle}`)
  }
})

test('client.js registers the settings section through the module loader', () => {
  const loaded = []
  const win = {
    __ModuleLoader__: {
      load: (definition) => {
        loaded.push(definition.factory((id) => ({})))
      },
    },
  }
  const factory = new Function('window', 'require', source)
  factory(win, (id) => ({}))

  assert.equal(loaded.length, 1)
  assert.equal(typeof loaded[0].apply, 'function')
  assert.ok(Array.isArray(loaded[0].inject))
  assert.ok(loaded[0].inject.includes('connection'))
})
