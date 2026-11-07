#!/usr/bin/env node
// Writes the Orca plugin typings into the plugin's `.orca/types`, the way
// `orca plugin types` does. Tries the `orca` CLI first, then `orca-ide` (the
// Linux name); when neither can write the typings, downloads the same files
// from the Orca repository at the tag matching the installed version.
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const RAW = 'https://raw.githubusercontent.com/stablyai/orca'
const pkg = JSON.parse(await readFile('package.json', 'utf8'))

// Mirrors src/cli/plugin-authoring/plugin-type-files.ts in the Orca repository.
const MODULE_TYPINGS = [
  'orca.d.ts',
  'orca-components.d.ts',
  'orca-components-layout.d.ts',
  'orca-components-data.d.ts'
]
const SURFACE_TYPINGS = ['orca-host', 'orca-frame', 'orca-worker', 'orca-services', 'orca-testing']
const TYPES_TSCONFIG = {
  compilerOptions: {
    strict: true,
    noEmit: true,
    target: 'ES2022',
    module: 'ESNext',
    moduleResolution: 'Bundler',
    allowImportingTsExtensions: true,
    isolatedModules: true,
    jsx: 'react-jsx',
    jsxImportSource: 'orca',
    lib: ['ES2022', 'DOM'],
    preserveSymlinks: true,
    typeRoots: ['.'],
    types: ['orca', ...SURFACE_TYPINGS]
  }
}
const NOTE = '// Written by scripts/orca-types.mjs from the Orca repository. Do not edit.\n'

/** The installed Orca's version, else ORCA_VERSION, else `config.orcaVersion` in package.json. */
function orcaVersion() {
  for (const bin of ['orca', 'orca-ide']) {
    try {
      const out = execFileSync(bin, ['--version'], { encoding: 'utf8' }).trim()
      const version = out.match(/\d+\.\d+\.\d+/)?.[0]
      if (version) return { bin, version }
    } catch {
      // Not on PATH.
    }
  }
  const fallback = process.env.ORCA_VERSION ?? pkg.config?.orcaVersion
  if (!fallback) throw new Error('No orca CLI: set ORCA_VERSION or config.orcaVersion in package.json')
  return { bin: null, version: fallback }
}

function viaCli(dir) {
  for (const bin of ['orca', 'orca-ide']) {
    try {
      execFileSync(bin, ['plugin', 'types', dir, '--json'], { stdio: 'pipe' })
      return bin
    } catch {
      // Try the next name.
    }
  }
  return null
}

async function download(tag, path) {
  const response = await fetch(`${RAW}/${tag}/${path}`)
  if (!response.ok) throw new Error(`GET ${path} at ${tag}: HTTP ${response.status}`)
  return response.text()
}

async function fetchTypings(tag) {
  const modules = await Promise.all(
    MODULE_TYPINGS.map((file) => download(tag, `resources/plugins/declarative/${file}`))
  )
  const typings = { orca: modules.join('\n') }
  for (const name of SURFACE_TYPINGS) {
    typings[name] = await download(tag, `resources/plugins/types/${name}.d.ts`)
  }
  return typings
}

async function writeTypings(dir, typings) {
  await mkdir(join(dir, '.orca', 'types'), { recursive: true })
  await writeFile(join(dir, '.orca', '.gitignore'), '*\n')
  for (const [name, text] of Object.entries(typings)) {
    await mkdir(join(dir, '.orca', 'types', name), { recursive: true })
    await writeFile(join(dir, '.orca', 'types', name, 'index.d.ts'), NOTE + text)
  }
  await writeFile(
    join(dir, '.orca', 'types', 'tsconfig.json'),
    `${JSON.stringify(TYPES_TSCONFIG, null, 2)}\n`
  )
}

const cli = viaCli('.')
if (cli) {
  console.log(`typings from ${cli} plugin types`)
} else {
  const { version } = orcaVersion()
  const tag = `v${version}`
  console.log(`orca plugin types failed; downloading the ${tag} typings from GitHub`)
  await writeTypings('.', await fetchTypings(tag))
  console.log('typings written to .orca/types')
}
