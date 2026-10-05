// Read-only inventory: never imports extensions or copies settings/credentials.
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const [agentDirectory, destination] = process.argv.slice(2)
if (!agentDirectory || !destination) throw new Error('Usage: node scripts/capture-plugin-baseline.mjs <agent-dir> <new-output.json>')
const agentDir = resolve(agentDirectory)
const hash = data => createHash('sha256').update(data).digest('hex')
const settings = JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8'))

function treeDigest(directory) {
  const records = []
  function walk(relative = '') {
    const entries = readdirSync(join(directory, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      const name = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(name)
      else if (entry.isFile()) records.push([name, hash(readFileSync(join(directory, name)))])
      else throw new Error(`Unsupported non-regular package artifact: ${name}`)
    }
  }
  walk()
  return { files: records.length, sha256: hash(JSON.stringify(records)) }
}

const packages = []
for (const spec of settings.packages ?? []) {
  if (typeof spec !== 'string' || !spec.startsWith('npm:')) throw new Error('Only explicit npm package strings are supported; review other sources manually')
  const name = spec.slice(4).replace(/(?<!^)@[^/]*$/, '')
  if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(name)) throw new Error('Invalid npm package name')
  const directory = join(agentDir, 'npm/node_modules', name)
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
  if (manifest.name !== name || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(manifest.version)) throw new Error(`Invalid installed manifest: ${name}`)
  packages.push({ name, version: manifest.version, pinnedSpec: `npm:${name}@${manifest.version}`, sourceTree: treeDigest(directory) })
}
const extensions = readdirSync(join(agentDir, 'extensions'), { withFileTypes: true })
  .filter(entry => entry.isFile() && /\.[cm]?[jt]s$/.test(entry.name))
  .sort((a, b) => a.name.localeCompare(b.name, 'en'))
  .map(entry => ({ file: entry.name, sha256: hash(readFileSync(join(agentDir, 'extensions', entry.name))) }))
const baseline = {
  formatVersion: 1,
  sdkCandidate: '1.0.3',
  purpose: 'Read-only inventory, not an activation manifest or proof of compatibility. Package tree hashes exclude nested dependencies.',
  packages,
  extensions,
}
writeFileSync(resolve(destination), JSON.stringify(baseline, null, 2) + '\n', { flag: 'wx' })
console.log(`Captured ${packages.length} npm packages and ${extensions.length} local extensions; no plugin code executed`)
