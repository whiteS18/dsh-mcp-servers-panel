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

test('client.js labels sources without enumerating third-party importers', () => {
  assert.match(source, /sourcePanel: '本插件'/)
  assert.match(source, /sourceThirdParty: '第三方导入'/)
  assert.equal(source.includes('sourceMagpie'), false)
  assert.equal(source.includes('sourcePluginEntry'), false)
  assert.doesNotMatch(source, /server\.origin === 'magpie'/)
  assert.match(source, /\{ id: 'third-party', label: translate\('sourceThirdParty'\) \}/)
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

const LOCALE_NS = 'settings.dsh-mcp-servers-panel'

function loadClientPlugin() {
  const loaded = []
  const win = {
    __ModuleLoader__: {
      load: (definition) => {
        loaded.push(definition.factory((id) => ({})))
      },
    },
  }
  new Function('window', 'require', source)(win, (id) => ({}))
  return loaded[0]
}

/** Mirror the real locale service: re-registering a namespace/locale pair throws. */
function fakeLocale() {
  const namespaces = new Map()
  return {
    namespaces,
    register(namespace, dictionaries) {
      const owner = namespaces.get(namespace) ?? new Map()
      namespaces.set(namespace, owner)
      for (const locale of Object.keys(dictionaries)) {
        if (owner.has(locale)) throw new Error(`locale namespace "${namespace}" already has locale "${locale}"`)
      }
      for (const [locale, entries] of Object.entries(dictionaries)) owner.set(locale, entries)
      return () => {
        for (const [locale, entries] of Object.entries(dictionaries)) {
          if (owner.get(locale) === entries) owner.delete(locale)
        }
      }
    },
  }
}

/** Apply the client half with a ctx that runs effects immediately and records their disposers. */
function applyClient(plugin, locale) {
  const effects = []
  plugin.apply({
    locale,
    effect(callback) {
      effects.push(callback())
    },
    get() {
      return undefined
    },
    slots: { inject() {}, register() {} },
  })
  return effects
}

test('client.js releases the locale namespace when the client half unloads', () => {
  const plugin = loadClientPlugin()
  const locale = fakeLocale()

  const effects = applyClient(plugin, locale)
  assert.deepEqual([...locale.namespaces.get(LOCALE_NS).keys()].sort(), ['en', 'zh'])
  assert.equal(
    effects.filter((disposer) => typeof disposer === 'function').length,
    1,
    'the locale effect must return the locale registration disposer'
  )

  for (const dispose of effects) if (typeof dispose === 'function') dispose()
  assert.equal(locale.namespaces.get(LOCALE_NS).size, 0, 'unload left the locale registration behind')

  // An HMR replacement tears down the old fiber and applies the new one on the
  // same page: without the disposer this second apply throws.
  assert.doesNotThrow(() => applyClient(plugin, locale))
  assert.deepEqual([...locale.namespaces.get(LOCALE_NS).keys()].sort(), ['en', 'zh'])
})

test('client.js still mounts when an older version leaked the namespace', () => {
  const plugin = loadClientPlugin()
  const locale = fakeLocale()

  // 0.2.2 and earlier never returned its registration disposer.
  locale.register(LOCALE_NS, { zh: {}, en: {} })
  assert.doesNotThrow(() => applyClient(plugin, locale))
})
