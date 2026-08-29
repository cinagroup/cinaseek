import assert from 'node:assert/strict'
import test from 'node:test'
import { isCinaSeekAppUrl, isSafeExternalUrl, isSecureWebUrl } from './navigation-policy.js'

test('accepts only the exact CinaSeek production origin as application content', () => {
  assert.equal(isCinaSeekAppUrl('https://cinaseek.ai/workspaces'), true)
  assert.equal(isCinaSeekAppUrl('https://cinaseek.ai.evil.example/'), false)
  assert.equal(isCinaSeekAppUrl('http://cinaseek.ai/'), false)
})

test('sandboxed authentication windows only navigate to credential-free HTTPS URLs', () => {
  assert.equal(isSecureWebUrl('https://cinagroup.cloudflareaccess.com/cdn-cgi/access/login'), true)
  assert.equal(isSecureWebUrl('javascript:alert(1)'), false)
  assert.equal(isSecureWebUrl('file:///etc/passwd'), false)
  assert.equal(isSecureWebUrl('https://user:password@example.com/'), false)
})

test('external URLs exclude the application origin', () => {
  assert.equal(isSafeExternalUrl('https://docs.github.com/'), true)
  assert.equal(isSafeExternalUrl('https://cinaseek.ai/'), false)
})
