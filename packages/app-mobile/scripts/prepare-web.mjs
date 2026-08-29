import { copyFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const source = fileURLToPath(new URL('../../workshop-frontend/public/logo.png', import.meta.url))
const destination = fileURLToPath(new URL('../web/logo.png', import.meta.url))

copyFileSync(source, destination)
