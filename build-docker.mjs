import * as esbuild from 'esbuild'
import { mkdirSync, readdirSync, statSync, copyFileSync, existsSync } from 'fs'
import path from 'path'

const root = process.cwd()
const srcDir = path.join(root, 'src')
const outDir = path.join(root, 'dist')

function listTsFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listTsFiles(full))
    else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name) && !/\.(test|spec)\.(ts|tsx|js)$/.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

function copyNonTs(dir, dest) {
  mkdirSync(dest, { recursive: true })
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const from = path.join(dir, entry.name)
    const to = path.join(dest, entry.name)
    if (entry.isDirectory()) copyNonTs(from, to)
    else if (!/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)) {
      mkdirSync(path.dirname(to), { recursive: true })
      copyFileSync(from, to)
    }
  }
}

const entryPoints = listTsFiles(srcDir)
if (!entryPoints.length) {
  console.error('No TypeScript entry points found under src/')
  process.exit(1)
}

await esbuild.build({
  entryPoints,
  outdir: outDir,
  outbase: srcDir,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: false,
  bundle: false,
  packages: 'external',
  logLevel: 'info',
})

copyNonTs(srcDir, outDir)

const indexJs = path.join(outDir, 'index.js')
if (!existsSync(indexJs) || !statSync(indexJs).size) {
  console.error('dist/index.js was not produced')
  process.exit(1)
}

console.log(`Built ${entryPoints.length} files → dist/index.js (${statSync(indexJs).size} bytes)`)
