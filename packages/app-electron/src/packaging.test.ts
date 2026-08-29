import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

test('the sandboxed preload bridge is present in the compiled application', () => {
  const preload = fileURLToPath(new URL('./preload.cjs', import.meta.url))
  assert.equal(existsSync(preload), true)
})
