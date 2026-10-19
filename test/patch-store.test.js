import test from 'node:test'
import assert from 'node:assert/strict'
import YAML from 'yaml'

import {
  ProfilePatch,
  panelEntryId,
  normalizeIncomingList,
  normalizeServerInput,
} from '../patch-store.js'

const YAML_OPTIONS = { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value) => value }] }

function panelEntries(text) {
  return YAML.parse(text, YAML_OPTIONS)
    .filter((item) => item && item.insert)
    .flatMap((item) => item.insert)
    .filter((entry) => String(entry.id).startsWith('dsh-mcp-panel-'))
}

test('normalizeServerInput validates the official serverName contract', () => {
  assert.deepEqual(
    normalizeServerInput('fast-context', { transport: 'stdio', command: 'npx' }).config,
    { serverName: 'fast-context', transport: 'stdio', command: 'npx' },
  )
  assert.throws(() => normalizeServerInput('bad name', { transport: 'stdio', command: 'npx' }), /1-32/)
  assert.throws(() => normalizeServerInput('x'.repeat(33), { transport: 'stdio', command: 'npx' }), /1-32/)
  assert.throws(() => normalizeServerInput('', { transport: 'stdio', command: 'npx' }), /不能为空/)
})

test('normalizeServerInput canonicalizes transports and omits defaults', () => {
  const stdio = normalizeServerInput('srv', {
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@scope/pkg'],
    env: { TOKEN: 7 },
    cwd: 'C:/work',
    toolCallTimeoutMs: 60000,
  })
  assert.equal(stdio.enabled, true)
  assert.deepEqual(stdio.config, {
    serverName: 'srv',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@scope/pkg'],
    env: { TOKEN: '7' },
    cwd: 'C:/work',
  })

  const http = normalizeServerInput('web', {
    transport: 'sse',
    url: 'https://example.com/mcp',
    headers: { Accept: 'application/json' },
    toolCallTimeoutMs: 9000,
  })
  assert.deepEqual(http.config, {
    serverName: 'web',
    transport: 'streamable-http',
    url: 'https://example.com/mcp',
    headers: { Accept: 'application/json' },
    toolCallTimeoutMs: 9000,
  })

  assert.throws(() => normalizeServerInput('srv', { transport: 'stdio' }), /执行命令/)
  assert.throws(() => normalizeServerInput('srv', { transport: 'streamable-http' }), /URL/)
  assert.throws(() => normalizeServerInput('srv', { transport: 'streamable-http', url: 'not a url' }), /URL 格式无效/)
})

test('normalizeServerInput validates reconnect options', () => {
  const input = normalizeServerInput('srv', {
    transport: 'stdio',
    command: 'node',
    reconnect: { enabled: false, maxAttempts: 3 },
  })
  assert.deepEqual(input.config.reconnect, { enabled: false, maxAttempts: 3 })
  assert.throws(() => normalizeServerInput('srv', {
    transport: 'stdio',
    command: 'node',
    reconnect: { maxAttempts: 0 },
  }), /正整数/)
  assert.throws(() => normalizeServerInput('srv', {
    transport: 'stdio',
    command: 'node',
    reconnect: { initialDelayMs: 900, maxDelayMs: 100 },
  }), /不能大于/)
  assert.throws(() => normalizeServerInput('srv', {
    transport: 'stdio',
    command: 'node',
    reconnect: { nope: 1 },
  }), /不是支持的选项/)
})

test('boolean fields reject string coercions', () => {
  assert.throws(() => normalizeServerInput('srv', {
    transport: 'stdio',
    command: 'node',
    enabled: 'false',
  }), /enabled 必须是布尔值/)
  assert.throws(() => normalizeServerInput('srv', {
    transport: 'stdio',
    command: 'node',
    failOnStartupError: 'false',
  }), /failOnStartupError 必须是布尔值/)
  assert.throws(() => normalizeServerInput('srv', {
    transport: 'stdio',
    command: 'node',
    reconnect: { enabled: 'false' },
  }), /reconnect\.enabled 必须是布尔值/)
  assert.equal(normalizeServerInput('srv', {
    transport: 'stdio',
    command: 'node',
    enabled: false,
    reconnect: { enabled: false },
  }).config.reconnect.enabled, false)
})

test('normalizeIncomingList accepts common wrapper shapes and enabled:false', () => {
  const fromMcpServers = normalizeIncomingList({
    mcpServers: {
      a: { command: 'node', args: ['a.js'] },
      b: { url: 'https://example.com/mcp' },
    },
  })
  assert.equal(fromMcpServers.length, 2)
  assert.equal(fromMcpServers[0].name, 'a')
  assert.equal(fromMcpServers[0].config.transport, 'stdio')
  assert.equal(fromMcpServers[1].config.transport, 'streamable-http')

  const fromArray = normalizeIncomingList([
    { serverName: 'x', transport: 'stdio', command: 'node' },
    { name: 'y', transport: 'stdio', command: 'node', enabled: false },
  ])
  assert.equal(fromArray.length, 2)
  assert.equal(fromArray[1].enabled, false)

  const single = normalizeIncomingList({ serverName: 'z', transport: 'stdio', command: 'node' })
  assert.equal(single.length, 1)
  assert.equal(single[0].name, 'z')

  const bareMap = normalizeIncomingList({ q: { transport: 'stdio', command: 'node' } })
  assert.equal(bareMap[0].name, 'q')
})

test('ProfilePatch writes block-style official client rows into an empty patch', () => {
  const patch = ProfilePatch.parse('# header\n[]\n')
  patch.upsertServer(normalizeServerInput('fast-context', {
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@sammysnake/fast-context-mcp'],
    env: { WINDSURF_API_KEY: 'token value' },
  }))
  const text = patch.toString()
  assert.match(text, /# header/)
  assert.match(text, /- insert:/)
  assert.match(text, /id: dsh-mcp-panel-fast-context/)
  assert.match(text, /name: "@deepseek-ai\/dsh-mcp-client"/)
  assert.doesNotMatch(text, /^\[\]$/m)

  const entries = panelEntries(text)
  assert.equal(entries.length, 1)
  assert.deepEqual(entries[0], {
    id: 'dsh-mcp-panel-fast-context',
    name: '@deepseek-ai/dsh-mcp-client',
    config: {
      serverName: 'fast-context',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@sammysnake/fast-context-mcp'],
      env: { WINDSURF_API_KEY: 'token value' },
    },
  })
})

test('ProfilePatch preserves unrelated entries, comments and !!js tags', () => {
  const original = [
    '# profile header',
    '- id: agent-default-model',
    '  config:',
    '    provider: !!js process.env.PROVIDER',
    '',
    '- insert:',
    '    # magpie',
    '    - id: magpie-mcp-yunxiao',
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        serverName: yunxiao',
    '        transport: streamable-http',
    '        url: https://example.com/mcp',
    '',
    '- id: other',
    '  disabled: true',
    '',
  ].join('\n')
  const patch = ProfilePatch.parse(original)
  patch.upsertServer(normalizeServerInput('panel', { transport: 'stdio', command: 'node' }))
  const text = patch.toString()
  assert.match(text, /provider: !!js process\.env\.PROVIDER/)
  assert.match(text, /# magpie/)
  assert.match(text, /magpie-mcp-yunxiao/)
  assert.match(text, /- id: other\n  disabled: true/)
  const parsed = YAML.parse(text, YAML_OPTIONS)
  assert.equal(parsed.filter((item) => item && item.insert).length, 2)
  assert.equal(panelEntries(text).length, 1)
})

test('ProfilePatch updates, toggles, renames and removes panel rows', () => {
  const patch = ProfilePatch.parse('[]\n')
  patch.upsertServer(normalizeServerInput('alpha', { transport: 'stdio', command: 'node' }))
  patch.upsertServer(normalizeServerInput('beta', { transport: 'stdio', command: 'node' }))
  assert.equal(patch.dirty, true)

  patch.upsertServer(normalizeServerInput('alpha', { transport: 'stdio', command: 'node', args: ['v2'] }))
  let entries = panelEntries(patch.toString())
  assert.equal(entries.length, 2)
  assert.deepEqual(entries[0].config.args, ['v2'])

  patch.setEnabled('alpha', false)
  entries = panelEntries(patch.toString())
  assert.equal(entries[0].disabled, true)
  patch.setEnabled('alpha', true)
  entries = panelEntries(patch.toString())
  assert.equal(entries[0].disabled, undefined)

  patch.upsertServer(
    normalizeServerInput('gamma', { transport: 'stdio', command: 'node' }),
    { replaceName: 'beta' },
  )
  entries = panelEntries(patch.toString())
  assert.deepEqual(entries.map((entry) => entry.config.serverName), ['alpha', 'gamma'])

  assert.equal(patch.removeServer('gamma'), true)
  assert.deepEqual(panelEntries(patch.toString()).map((entry) => entry.config.serverName), ['alpha'])
  assert.equal(patch.removeServer('missing'), false)
})

test('a no-op toggle does not mark the patch dirty', () => {
  const patch = ProfilePatch.parse('[]\n')
  patch.upsertServer(normalizeServerInput('alpha', { transport: 'stdio', command: 'node' }))
  patch.dirty = false
  assert.equal(patch.setEnabled('alpha', true), true)
  assert.equal(patch.dirty, false)
  assert.equal(patch.setEnabled('alpha', false), true)
  assert.equal(patch.dirty, true)
})

test('panel entry ids are derived from the server name', () => {
  assert.equal(panelEntryId('fast-context'), 'dsh-mcp-panel-fast-context')
})
