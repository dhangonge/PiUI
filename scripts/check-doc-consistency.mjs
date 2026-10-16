// 文档一致性门禁
//
//   node scripts/check-doc-consistency.mjs
//
// 目的：让"人类可读文档里的版本号"和代码里的版本常量不可能悄悄分叉。
// 校验四件事：
//   1. 声明式 SDK 基线（`Baseline: ...@x.y.z`）与 PI_PARITY_SDK_VERSION 一致
//   2. monorepo 各 workspace 的 package.json 版本与根 package.json 一致
//   3. 根 CHANGELOG.md 最高版本与 package.json 版本一致
//   4. 只有根 CHANGELOG.md 维护发版历史（workspace 不再有活的 CHANGELOG）
//
// 有意不做的检查：docs/universal-agent-pi-technical-design.md 等历史文档里
// 出现的旧版本号（沿革记录），以及文档正文中零散的版本提及——这类断言会
// 产生大量假阳性，且无法区分"引用历史"与"声称现状"。要新增声明，用
// `Baseline: \`@earendil-works/pi-coding-agent@x.y.z\`` 这一行，脚本会校验它。

import { readdirSync, readFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const rel = file => relative(root, file).split("\\").join("/")
const failures = []
const fail = message => failures.push(message)

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"))
}

// 代码侧权威版本 ------------------------------------------------

const versionSource = readFileSync(join(root, "packages/protocol/src/version.ts"), "utf8")
const parityVersion = versionSource.match(/PI_PARITY_SDK_VERSION = "([^"]+)"/)?.[1]
const bundledVersion = readFileSync(join(root, "packages/pi-worker/src/bundled-sdk-version.ts"), "utf8")
  .match(/BUNDLED_PI_SDK_VERSION = "([^"]+)"/)?.[1]

if (!parityVersion) {
  console.error("cannot read PI_PARITY_SDK_VERSION from packages/protocol/src/version.ts")
  process.exit(1)
}
if (bundledVersion !== parityVersion) {
  fail(`packages/pi-worker/src/bundled-sdk-version.ts: BUNDLED_PI_SDK_VERSION=${bundledVersion} != PI_PARITY_SDK_VERSION=${parityVersion}`)
}

const rootManifest = readJson(join(root, "package.json"))
const appVersion = rootManifest.version

// 1. 文档里的声明式 SDK 基线 ------------------------------------

const BASELINE = /Baseline:\s*`@earendil-works\/pi-coding-agent@([0-9][^`]*)`/g
const markdownFiles = []

function collectMarkdown(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist" || entry.name === "build" || entry.name === "target") continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      collectMarkdown(path)
      continue
    }
    if (entry.name.endsWith(".md")) markdownFiles.push(path)
  }
}

collectMarkdown(root)

const baselines = new Set()
for (const path of markdownFiles) {
  const text = readFileSync(path, "utf8")
  for (const match of text.matchAll(BASELINE)) {
    baselines.add(`${rel(path)}: ${match[1]}`)
    if (match[1] !== parityVersion) {
      fail(`${rel(path)}: baseline SDK ${match[1]} != PI_PARITY_SDK_VERSION ${parityVersion}`)
    }
  }
}

// 2. workspace 版本一致 ----------------------------------------

const workspaceVersions = new Map([["package.json", rootManifest.version]])
for (const pattern of rootManifest.workspaces ?? []) {
  const parent = join(root, dirname(pattern))
  const suffix = pattern.split("/").pop()
  const members = suffix === "*" || suffix === "**"
    ? readdirSync(parent, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name)
    : [suffix]
  for (const member of members) {
    const file = join(pattern.replace(/\*+$/, ""), member, "package.json")
    const manifest = readJson(file)
    workspaceVersions.set(rel(file), manifest.version)
  }
}
for (const [file, version] of workspaceVersions) {
  if (version !== appVersion) fail(`${file}: version ${version} != root package.json ${appVersion}`)
}

// 3. 根 CHANGELOG 版本 -----------------------------------------

const changelogPath = join(root, "CHANGELOG.md")
const changelog = readFileSync(changelogPath, "utf8")
const changelogVersion = changelog.match(/^##\s*\[v?([0-9]+\.[0-9]+\.[0-9]+[^\]]*)\]/m)?.[1]
if (!changelogVersion) {
  fail("CHANGELOG.md: no version heading (expected `## [vX.Y.Z] - YYYY-MM-DD`)")
} else if (changelogVersion !== appVersion) {
  fail(`CHANGELOG.md: latest entry v${changelogVersion} != package.json ${appVersion}（发版请走 packages/app/scripts/prepare-release.mjs）`)
}

// 4. 发版历史只有一份 ------------------------------------------

for (const [file] of workspaceVersions) {
  if (file === "package.json") continue
  const workspaceChangelog = join(root, dirname(file), "CHANGELOG.md")
  try {
    readFileSync(workspaceChangelog, "utf8")
    fail(`${rel(workspaceChangelog)}: workspace changelogs are frozen and renamed by the fork; the PiUI release history lives in the root CHANGELOG.md`)
  } catch {
    // absent is the expected state
  }
}

// 结果 ----------------------------------------------------------

if (failures.length > 0) {
  console.error("doc consistency FAILED:")
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}

console.log(
  `doc consistency OK: SDK baseline ${parityVersion} (` +
  `${[...baselines].join(", ") || "no baseline declaration found"}` +
  `), app version ${appVersion} across ${workspaceVersions.size} manifests + CHANGELOG`,
)
