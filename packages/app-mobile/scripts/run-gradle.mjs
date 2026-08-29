import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const allowedTasks = new Set(['assembleDebug', 'bundleRelease'])
const task = process.argv[2]
if (!allowedTasks.has(task)) throw new Error(`Unsupported Gradle task: ${task}`)

const androidDirectory = fileURLToPath(new URL('../android/', import.meta.url))
const isWindows = process.platform === 'win32'
const result = spawnSync(isWindows ? 'gradlew.bat' : './gradlew', [task, '--no-daemon'], {
  cwd: androidDirectory,
  shell: isWindows,
  stdio: 'inherit',
})

if (result.error) throw result.error
process.exitCode = result.status ?? 1
