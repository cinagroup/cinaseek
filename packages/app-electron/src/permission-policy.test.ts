import assert from 'node:assert/strict'
import test from 'node:test'
import { mayUseCinaSeekPermission } from './permission-policy.js'

test('allows audio capture only for the trusted CinaSeek origin', () => {
  assert.equal(mayUseCinaSeekPermission('media', 'https://cinaseek.ai/chat', ['audio']), true)
  assert.equal(mayUseCinaSeekPermission('media', 'https://cinaseek.ai/chat', ['video']), false)
  assert.equal(mayUseCinaSeekPermission('media', 'https://cinaseek.ai/chat', ['audio', 'video']), false)
  assert.equal(mayUseCinaSeekPermission('media', 'https://evil.example/chat', ['audio']), false)
})

test('keeps the existing non-media permission allowlist narrow', () => {
  assert.equal(mayUseCinaSeekPermission('fullscreen', 'https://cinaseek.ai'), true)
  assert.equal(mayUseCinaSeekPermission('geolocation', 'https://cinaseek.ai'), false)
})
