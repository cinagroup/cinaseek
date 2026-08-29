import assert from 'node:assert/strict'
import test from 'node:test'
import { parseDesktopMenuRequest } from './desktop-menu-protocol.js'

test('accepts and rounds a known desktop menu request', () => {
  assert.deepEqual(parseDesktopMenuRequest({
    menuId: 'file',
    anchor: { x: 12.4, y: 4.8, width: 30.1, height: 27.7 },
  }), {
    menuId: 'file',
    anchor: { x: 12, y: 5, width: 30, height: 28 },
  })
})

test('rejects unknown menus and malformed anchors', () => {
  assert.equal(parseDesktopMenuRequest({
    menuId: 'developer',
    anchor: { x: 0, y: 0, width: 20, height: 20 },
  }), null)
  assert.equal(parseDesktopMenuRequest({
    menuId: 'edit',
    anchor: { x: Number.NaN, y: 0, width: 20, height: 20 },
  }), null)
  assert.equal(parseDesktopMenuRequest({
    menuId: 'help',
    anchor: { x: 0, y: 0, width: -1, height: 20 },
  }), null)
})
