import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

test('the sandboxed preload bridge is present in the compiled application', () => {
  const preload = fileURLToPath(new URL('./preload.cjs', import.meta.url))
  assert.equal(existsSync(preload), true)
})

test('Windows packaging uses the rounded multi-resolution icon', () => {
  const packageJsonPath = fileURLToPath(new URL('../package.json', import.meta.url))
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
    build?: {
      win?: { icon?: string }
      nsis?: { installerIcon?: string; uninstallerIcon?: string }
    }
  }
  assert.equal(packageJson.build?.win?.icon, 'build/icon.ico')
  assert.equal(packageJson.build?.nsis?.installerIcon, 'build/icon.ico')
  assert.equal(packageJson.build?.nsis?.uninstallerIcon, 'build/icon.ico')

  const iconPath = fileURLToPath(new URL('../build/icon.ico', import.meta.url))
  const icon = readFileSync(iconPath)
  assert.equal(icon.readUInt16LE(0), 0)
  assert.equal(icon.readUInt16LE(2), 1)
  const imageCount = icon.readUInt16LE(4)
  const sizes = Array.from({ length: imageCount }, (_, index) => {
    const width = icon[6 + index * 16]
    return width === 0 ? 256 : width
  })
  assert.deepEqual(sizes, [16, 20, 24, 32, 40, 48, 64, 128, 256])
})

test('the desktop shell bundles the rounded original logo', () => {
  const logoPath = fileURLToPath(new URL('../build/logo-rounded-3px.png', import.meta.url))
  const logo = readFileSync(logoPath)
  assert.equal(logo.subarray(1, 4).toString('ascii'), 'PNG')
})
