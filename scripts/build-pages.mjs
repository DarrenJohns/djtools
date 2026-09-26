import { cp, mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const pagesOutput = resolve(root, 'dist')
const appOutput = resolve(root, 'apps', 'image-to-webgl', 'dist')

await rm(pagesOutput, { recursive: true, force: true })
await mkdir(pagesOutput, { recursive: true })
await cp(resolve(root, 'site'), pagesOutput, { recursive: true })
await cp(appOutput, resolve(pagesOutput, 'image-to-webgl'), { recursive: true })
await rm(appOutput, { recursive: true, force: true })

console.log('Built GitHub Pages site in dist/.')
