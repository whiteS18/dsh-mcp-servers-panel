import test from 'node:test'
import assert from 'node:assert/strict'

import { isLoopbackRequest } from '../index.js'

test('isLoopbackRequest accepts only loopback addresses', () => {
  assert.equal(isLoopbackRequest({ socket: { remoteAddress: '127.0.0.1' } }), true)
  assert.equal(isLoopbackRequest({ socket: { remoteAddress: '127.4.5.6' } }), true)
  assert.equal(isLoopbackRequest({ socket: { remoteAddress: '::1' } }), true)
  assert.equal(isLoopbackRequest({ socket: { remoteAddress: '::ffff:127.0.0.1' } }), true)
  assert.equal(isLoopbackRequest({ socket: { remoteAddress: '192.168.1.100' } }), false)
  assert.equal(isLoopbackRequest({ socket: { remoteAddress: '10.0.0.1' } }), false)
  assert.equal(isLoopbackRequest({ socket: { remoteAddress: '' } }), false)
  assert.equal(isLoopbackRequest({}), false)
})
