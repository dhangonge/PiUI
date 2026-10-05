import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const [target, outputArg] = process.argv.slice(2)
if (!['linux-arm64', 'termux-arm64'].includes(target) || !outputArg) throw new Error('Usage: node scripts/build-offline.mjs <linux-arm64|termux-arm64> <new-output-directory>')
const repo = path.resolve(fileURLToPath(new URL('../', import.meta.url)))
const templates = path.join(repo, 'scripts/offline')
const lock = JSON.parse(fs.readFileSync(path.join(templates, 'lock.json'), 'utf8'))
const npmLock = JSON.parse(fs.readFileSync(path.join(repo, 'package-lock.json'), 'utf8'))
const output = path.resolve(outputArg)
const cache = path.resolve(process.env.PIUI_OFFLINE_CACHE || path.join(os.homedir(), '.cache/piui-offline'))
const app = path.join(output, 'lib/piui')
fs.mkdirSync(output) // Never overwrite an existing deployment or its data.
fs.mkdirSync(cache, { recursive: true })
const stage = fs.mkdtempSync(path.join(cache, 'assemble-'))
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
function run(exe, args, options = {}) {
  const result = spawnSync(exe, args, { cwd: repo, stdio: 'inherit', ...options })
  if (result.error || result.status !== 0) throw new Error(`Command failed: ${exe} (status ${result.status})`)
}
function copy(source, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.cpSync(source, dest, { recursive: true, verbatimSymlinks: true, force: false, errorOnExist: true })
}
function download(item) {
  const file = path.join(cache, item.file)
  if (!fs.existsSync(file)) run('curl', ['-fsSL', '--retry', '2', '--max-time', '180', item.url, '-o', file])
  if (hash(file) !== item.sha256) throw new Error(`Checksum mismatch: ${item.file}; inspect the cache, it was not overwritten`)
  return file
}
function untar(file, destination, strip = false) {
  fs.mkdirSync(destination, { recursive: true })
  run('tar', ['-xf', file, '-C', destination, ...(strip ? ['--strip-components=1'] : [])])
}
function debs(items, destination) {
  fs.mkdirSync(destination, { recursive: true })
  for (const item of items) {
    const file = download(item)
    const member = execFileSync('ar', ['t', file], { encoding: 'utf8' }).split('\n').find(name => name.startsWith('data.tar.'))
    if (!member) throw new Error(`No data archive in ${item.file}`)
    const archive = path.join(stage, `${item.name}.data.tar.${member.split('.').at(-1)}`)
    const fd = fs.openSync(archive, 'wx')
    try { run('ar', ['p', file, member], { stdio: ['ignore', fd, 'inherit'] }) } finally { fs.closeSync(fd) }
    untar(archive, destination)
  }
}
function resolvePackage(name, base) {
  for (let dir = base; dir.startsWith(repo); dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', name)
    if (fs.existsSync(path.join(candidate, 'package.json'))) return fs.realpathSync(candidate)
    if (dir === path.dirname(dir)) break
  }
  return undefined
}
const visited = new Set()
const inventory = []
function packageTree(source) {
  if (visited.has(source)) return
  const relative = path.relative(repo, source)
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Dependency resolves outside the repository')
  const manifest = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'))
  // This is a Node bundle; never copy the host's native PTY or Bun-only backend.
  if (manifest.name === 'bun-pty' || manifest.name.startsWith('@lydell/node-pty-')) return
  const installed = npmLock.packages[relative]
  if (installed && installed.version !== manifest.version) throw new Error(`Installed version differs from package-lock: ${manifest.name}`)
  visited.add(source)
  inventory.push({ name: manifest.name, version: manifest.version, path: relative })
  const dest = path.join(app, relative)
  fs.mkdirSync(dest, { recursive: true })
  const workspace = relative.startsWith('packages/')
  if (workspace) {
    copy(path.join(source, 'package.json'), path.join(dest, 'package.json'))
    copy(path.join(source, 'dist'), path.join(dest, 'dist'))
    const alias = path.join(app, 'node_modules', manifest.name)
    fs.mkdirSync(path.dirname(alias), { recursive: true })
    fs.symlinkSync(path.relative(path.dirname(alias), dest), alias)
  } else {
    for (const entry of fs.readdirSync(source)) if (entry !== 'node_modules' && entry !== '.git') copy(path.join(source, entry), path.join(dest, entry))
  }
  const required = Object.keys(manifest.dependencies || {})
  const optional = new Set(Object.keys(manifest.optionalDependencies || {}))
  for (const name of new Set([...required, ...optional, ...Object.keys(manifest.peerDependencies || {})])) {
    if (name === 'bun-pty' || name.startsWith('@lydell/node-pty-')) continue
    const resolved = resolvePackage(name, source)
    if (resolved) packageTree(resolved)
    else if (required.includes(name) && !optional.has(name)) throw new Error(`Missing installed dependency: ${manifest.name} -> ${name}`)
  }
}

try {
  for (const name of ['protocol', 'pi-worker', 'server']) packageTree(path.join(repo, 'packages', name))
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ private: true, type: 'module' }) + '\n')
  copy(path.join(repo, 'packages/app/dist'), path.join(app, 'web'))
  copy(path.join(repo, 'packages/app/LICENSE'), path.join(output, 'LICENSE'))
  const runtime = path.join(output, 'runtime')
  const linuxNode = path.join(stage, 'node-linux')
  untar(download(lock.linuxNode), linuxNode, true)
  if (target === 'linux-arm64') {
    copy(linuxNode, runtime)
    const debRoot = path.join(stage, 'debian')
    debs(lock.linuxLibs, debRoot)
    for (const [from, to] of [['usr/bin/rg', 'bin/rg'], ['usr/bin/fdfind', 'bin/fd']]) copy(fs.realpathSync(path.join(debRoot, from)), path.join(runtime, to))
    for (const directory of ['lib/aarch64-linux-gnu', 'usr/lib/aarch64-linux-gnu']) {
      const dir = path.join(debRoot, directory)
      if (fs.existsSync(dir)) for (const name of fs.readdirSync(dir)) copy(path.join(dir, name), path.join(runtime, 'lib', name))
    }
    copy(path.join(debRoot, 'usr/share/doc'), path.join(runtime, 'debian-licenses'))
    for (const name of ['node', 'rg', 'fd']) run('patchelf', ['--page-size', '65536', '--set-rpath', '$ORIGIN/../lib', path.join(runtime, 'bin', name)])
    untar(download(lock.linuxPty), path.join(app, 'node_modules/@lydell/node-pty-linux-arm64'), true)
  } else {
    const termuxRoot = path.join(stage, 'termux')
    debs(lock.termux, termuxRoot)
    copy(path.join(termuxRoot, 'data/data/com.termux/files/usr'), runtime)
    fs.writeFileSync(path.join(runtime, 'termux-runtime'), 'Android ARM64, Termux bionic runtime\n')
    copy(path.join(linuxNode, 'lib/node_modules/npm'), path.join(runtime, 'lib/node_modules/npm'))
    for (const [name, script] of [['npm', 'npm-cli.js'], ['npx', 'npx-cli.js']]) {
      fs.writeFileSync(path.join(runtime, 'bin', name), `#!/data/data/com.termux/files/usr/bin/sh\nD=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)\nexport LD_LIBRARY_PATH="$D/../lib\${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"\nexec "$D/node" "$D/../lib/node_modules/npm/bin/${script}" "$@"\n`, { mode: 0o755 })
    }
    const source = path.join(stage, 'pty-source'), headers = path.join(stage, 'addon-headers')
    untar(download(lock.ptySource), source, true)
    untar(download(lock.addonHeaders), headers, true)
    const dest = path.join(app, 'node_modules/@lydell/node-pty-android-arm64')
    copy(source, dest)
    fs.mkdirSync(path.join(dest, 'prebuilds/android-arm64'), { recursive: true })
    if (!process.env.NDK_HOME) throw new Error('NDK_HOME is required to build Android PTY')
    run(path.join(process.env.NDK_HOME, 'toolchains/llvm/prebuilt/linux-x86_64/bin/aarch64-linux-android24-clang++'), ['-std=c++17', '-shared', '-fPIC', '-O2', '-DNAPI_CPP_EXCEPTIONS', '-DNAPI_VERSION=8', '-DNODE_GYP_MODULE_NAME=pty', '-I' + headers, '-I' + path.join(runtime, 'include/node'), '-static-libstdc++', path.join(source, 'src/unix/pty.cc'), '-o', path.join(dest, 'prebuilds/android-arm64/pty.node')])
  }
  fs.mkdirSync(path.join(output, 'deploy'))
  for (const name of ['launcher.mjs', 'runtime-check.mjs']) copy(path.join(templates, name), path.join(output, 'deploy', name))
  for (const name of ['pi', 'piui', 'deploy.sh']) {
    let text = fs.readFileSync(path.join(templates, name === 'deploy.sh' ? 'deploy.sh' : 'entry.sh'), 'utf8')
    if (target === 'termux-arm64') text = text.replace('#!/bin/sh', '#!/data/data/com.termux/files/usr/bin/sh')
    fs.writeFileSync(path.join(output, name), text, { mode: 0o755 })
  }
  copy(path.join(templates, 'README.md'), path.join(output, 'README.md'))
  copy(path.join(templates, 'lock.json'), path.join(output, 'runtime-lock.json'))
  fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify({ target, sdkVersion: '1.0.3', revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(), sourceDirty: !!execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim(), packageLockSha256: hash(path.join(repo, 'package-lock.json')), packages: inventory }, null, 2) + '\n')
  // Include tracked sources for the modified GPL UI/server; no working-tree credentials.
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: repo })
  const list = path.join(stage, 'source-files')
  fs.writeFileSync(list, tracked)
  run('tar', ['-czf', path.join(output, 'piui-source.tar.gz'), '--null', '-T', list])
  function verifyLinks(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) verifyLinks(file)
      else if (entry.isSymbolicLink()) {
        const resolved = fs.realpathSync(file)
        if (!resolved.startsWith(output + path.sep)) throw new Error(`Bundle link points outside output: ${path.relative(output, file)}`)
      }
    }
  }
  verifyLinks(output)
  console.log(`Built ${target}: ${output} (${inventory.length} runtime packages; all symlinks resolve internally)`)
} finally {
  fs.rmSync(stage, { recursive: true, force: true })
}
