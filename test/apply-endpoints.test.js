import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import YAML from 'yaml'

import { apply, RPC_CHANNEL, WEB_API_PREFIX } from '../index.js'
import { makeHost, makeTempProfile } from './helpers/fake-host.js'

const YAML_OPTIONS = { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value) => value }] }

function rows(text) {
  return YAML.parse(text, YAML_OPTIONS)
    .filter((item) => item && item.insert)
    .flatMap((item) => item.insert)
    .filter((entry) => String(entry.id).startsWith('dsh-mcp-panel-'))
}

function makeApplyContext(host) {
  const connection = { rpc: { handle(channel, handler, options) { this.channel = channel; this.handler = handler; this.options = options; return () => {} } } }
  const routes = new Map()
  const webServer = {
    register(options) {
      routes.set(options.path, options.handler)
      return () => routes.delete(options.path)
    },
  }
  const ctx = {
    ...host.ctx,
    connection,
    webServer,
    inject(names, callback) { callback(ctx) },
    effect(fn) { const dispose = fn(); return () => { try { dispose?.() } catch {} } },
  }
  ctx.get = (name) => {
    if (name === 'connection') return connection
    if (name === 'webServer') return webServer
    return host.ctx.get(name)
  }
  return { ctx, connection, routes }
}

function makeResponse() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers },
    end(body) { this.body = body },
  }
}

async function httpCall(handler, method, payload, remoteAddress = '127.0.0.1') {
  const body = payload === undefined ? [] : [Buffer.from(JSON.stringify(payload))]
  const req = {
    method,
    socket: { remoteAddress },
    async *[Symbol.asyncIterator]() { for (const chunk of body) yield chunk },
  }
  const res = makeResponse()
  await handler(req, res)
  return { res, json: res.body ? JSON.parse(res.body) : null }
}

test('apply registers loopback RPC and HTTP endpoints and serves the manager', async () => {
  const profile = await makeTempProfile()
  await writeFile(profile.patchPath, '[]\n', 'utf8')
  const host = makeHost({ profile })
  const { ctx, connection, routes } = makeApplyContext(host)
  const dispose = await apply(ctx)
  try {
    assert.equal(connection.rpc.channel, RPC_CHANNEL)
    assert.deepEqual(connection.rpc.options, { authority: 'loopback' })

    const saved = await connection.rpc.handler('save', {
      name: 'panel',
      server: { transport: 'stdio', command: 'node', args: ['server.js'] },
      createOnly: true,
    })
    assert.equal(saved.ok, true)
    assert.equal(saved.value.application, 'applied')
    assert.equal(rows(await readFile(profile.patchPath, 'utf8')).length, 1)

    const listed = await connection.rpc.handler('list', {})
    assert.equal(listed.ok, true)
    assert.equal(listed.value.servers[0].name, 'panel')
    assert.equal(listed.value.servers[0].source, 'panel')

    const unknown = await connection.rpc.handler('nope', {})
    assert.equal(unknown.ok, false)

    const listRoute = routes.get(WEB_API_PREFIX + '/list')
    assert.ok(listRoute)
    const ok = await httpCall(listRoute, 'GET', undefined, '127.0.0.1')
    assert.equal(ok.res.status, 200)
    assert.equal(ok.json.ok, true)

    const denied = await httpCall(listRoute, 'GET', undefined, '10.1.2.3')
    assert.equal(denied.res.status, 403)
    assert.equal(denied.json.ok, false)

    const toggleRoute = routes.get(WEB_API_PREFIX + '/toggle')
    const toggled = await httpCall(toggleRoute, 'POST', { name: 'panel', enabled: false })
    assert.equal(toggled.json.ok, true)
    assert.equal(toggled.json.value.servers[0].enabled, false)

    const deleted = await connection.rpc.handler('delete', { name: 'panel' })
    assert.equal(deleted.ok, true)
    assert.equal(rows(await readFile(profile.patchPath, 'utf8')).length, 0)
  } finally {
    await dispose()
  }
})
