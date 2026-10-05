import { mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const [modulesArg, outputArg, ...selected] = process.argv.slice(2)
if (!modulesArg || !outputArg) throw new Error('Usage: node scripts/probe-installed-plugins.mjs <plugin-node_modules> <new-output-dir> [package ...]')
const modules = realpathSync(modulesArg)
const output = path.resolve(outputArg)
const repo = fileURLToPath(new URL('../', import.meta.url))
const baseline = JSON.parse(readFileSync(new URL('../docs/plugin-baseline.json', import.meta.url), 'utf8'))
const names = selected.length ? selected : baseline.packages.map(pkg => pkg.name)
if (names.some(name => !baseline.packages.some(pkg => pkg.name === name))) throw new Error('Package is not in the reviewed baseline')
mkdirSync(output) // Refuse to overwrite an earlier probe run.
const results = []
for (const name of names) {
  const expected = baseline.packages.find(pkg => pkg.name === name)
  const installed = JSON.parse(readFileSync(path.join(modules, name, 'package.json'), 'utf8'))
  if (installed.version !== expected.version) throw new Error(`Plugin version changed: ${name}; recapture and review the baseline first`)
  const args = [
    '--unshare-all', '--die-with-parent', '--new-session', '--ro-bind', '/usr', '/usr',
    '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib', '/lib64', '--symlink', 'usr/bin', '/bin',
    '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--tmpfs', '/fixture',
    '--ro-bind', path.join(repo, 'node_modules'), '/app/node_modules',
    '--ro-bind', path.join(repo, 'package.json'), '/app/package.json',
    '--ro-bind', path.join(repo, 'packages/pi-worker'), '/app/packages/pi-worker',
    '--ro-bind', path.join(repo, 'packages/protocol'), '/app/packages/protocol',
    '--ro-bind', path.join(repo, 'scripts/probe-installed-plugin.mjs'), '/app/scripts/probe-installed-plugin.mjs',
    '--ro-bind', modules, '/plugins/node_modules', '--clearenv',
    '--setenv', 'PATH', '/usr/bin:/bin', '--setenv', 'HOME', '/fixture',
    '--setenv', 'PI_CODING_AGENT_DIR', '/fixture/agent', '--setenv', 'PIUI_DATA_DIR', '/fixture/piui',
    '--setenv', 'PIUI_PLUGIN_SANDBOX', '1', '--chdir', '/app',
    '/usr/bin/node', '--import', 'tsx', 'scripts/probe-installed-plugin.mjs', name,
  ]
  const run = spawnSync('bwrap', args, { encoding: 'utf8', timeout: 45_000, maxBuffer: 2 * 1024 * 1024 })
  const stdout = run.stdout ?? ''
  const marker = stdout.split('\n').find(line => line.startsWith('PIUI_PLUGIN_PROBE '))
  const report = marker ? JSON.parse(marker.slice('PIUI_PLUGIN_PROBE '.length)) : undefined
  const valid = run.status === 0 && report?.name === name && report?.version === expected.version
  const result = { name, passed: valid, exitCode: run.status, signal: run.signal, error: run.error?.code, report }
  results.push(result)
  const filename = name.replace(/[^a-zA-Z0-9.-]/g, '_')
  writeFileSync(path.join(output, `${filename}.log`), stdout + (run.stderr ?? ''), { flag: 'wx' })
  console.log(`${valid ? 'PASS' : 'FAIL'} ${name}: ${report?.exercise ?? run.error?.code ?? run.signal ?? 'no report'}`)
}
writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2) + '\n', { flag: 'wx' })
if (results.some(result => !result.passed)) process.exitCode = 1
