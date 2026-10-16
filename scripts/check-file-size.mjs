#!/usr/bin/env node
// 单文件行数门禁。
//
// 规则：packages/*/src 下的 .ts/.tsx 不得超过 LIMIT 行（含测试文件）。
// 已经超限的文件登记在 scripts/file-size-baseline.json 里，登记值就是它当前
// 的行数——这些文件只许变小，涨一行就会失败，避免「反正已经超了」继续堆。
// 拆到 LIMIT 以下后要把登记项删掉（脚本会提示哪些项已经过期）。
//
// 拆不动/确实需要临时加的，用 `npm run check:size -- --update` 刷新基线，
// 刷新的数字会出现在 diff 里，review 时能一眼看到是哪个文件又胖了。
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const LIMIT = 1000
const root = fileURLToPath(new URL("..", import.meta.url))
const baselinePath = path.join(root, "scripts", "file-size-baseline.json")

function walk(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, found)
    else if (/\.tsx?$/.test(entry.name)) found.push(full)
  }
  return found
}

function collect() {
  const packagesDir = path.join(root, "packages")
  const sizes = new Map()
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const src = path.join(packagesDir, entry.name, "src")
    try {
      if (!statSync(src).isDirectory()) continue
    } catch {
      continue
    }
    for (const file of walk(src)) {
      const lines = readFileSync(file, "utf8").split("\n").length - 1
      sizes.set(path.relative(root, file).split(path.sep).join("/"), lines)
    }
  }
  return sizes
}

const sizes = collect()
const oversized = [...sizes].filter(([, lines]) => lines > LIMIT).sort((a, b) => b[1] - a[1])
const baseline = JSON.parse(readFileSync(baselinePath, "utf8"))

if (process.argv.includes("--update")) {
  const next = Object.fromEntries(oversized)
  writeFileSync(baselinePath, JSON.stringify(next, null, 2) + "\n")
  console.log(`file size baseline updated: ${oversized.length} files over ${LIMIT} lines`)
  process.exit(0)
}

const problems = []

for (const [file, lines] of oversized) {
  const allowed = baseline[file]
  if (allowed === undefined) {
    problems.push(`${file}: ${lines} 行，超过 ${LIMIT} 行上限且不在基线里——请拆分，或 --update 登记后说明原因`)
  } else if (lines > allowed) {
    problems.push(`${file}: ${lines} 行，比基线（${allowed}）又长了 ${lines - allowed} 行——只许变小`)
  }
}

for (const [file, allowed] of Object.entries(baseline)) {
  const lines = sizes.get(file)
  if (lines === undefined) {
    problems.push(`${file}: 基线里的文件已不存在，请从 scripts/file-size-baseline.json 删除`)
  } else if (lines <= LIMIT) {
    problems.push(`${file}: 已降到 ${lines} 行（≤ ${LIMIT}），请从 scripts/file-size-baseline.json 删除该条目`)
  } else if (lines < allowed) {
    problems.push(`${file}: 已从 ${allowed} 行降到 ${lines} 行，请同步基线数字`)
  }
}

if (problems.length > 0) {
  console.error("file size check failed:\n" + problems.map(p => `  - ${p}`).join("\n"))
  process.exit(1)
}

console.log(
  `file size OK: ${sizes.size} files, 上限 ${LIMIT} 行, 基线内 ${Object.keys(baseline).length} 个待拆文件`,
)
