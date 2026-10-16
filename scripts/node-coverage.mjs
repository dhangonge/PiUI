#!/usr/bin/env node
// Node 侧三包（protocol / pi-worker / server）的覆盖率门禁 + 度量范围校验。
//
// 为什么不直接在 package.json 里写 `node --test --experimental-test-coverage`：
// Node 22（CI 固定版本）的内置覆盖率**只报告被测试加载过的文件**，
// `--test-coverage-include-all` 要 Node 25+ 才有。也就是说，一个源文件只要没有
// 任何测试 import 它，它就从报告里消失，行覆盖率照样达标——分母被悄悄缩小。
// 这个脚本把「应该被度量」的文件集合显式列出来，跑完覆盖率后逐条核对报告：
// 少了（没有测试加载它）多了（范围外的文件混进来）都直接失败。
//
// 用法：
//   node scripts/node-coverage.mjs                # 三个包依次跑
//   node scripts/node-coverage.mjs @piui/server   # 只跑一个包
//   （在 packages/<pkg> 目录下无参数执行时，也只跑该包）
import { spawn } from "node:child_process"
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))

// 阈值比实测值低 2 个点，避免偶发抖动误报，同时挡住真实倒退。
// scope 只列出「src 下非测试、非 .d.ts」之外还要排除的文件，每条都要写清原因：
// 排除掉的代码没有任何自动化度量，理由必须站得住。
const PACKAGES = [
  {
    name: "@piui/protocol",
    dir: "packages/protocol",
    thresholds: { lines: 75, branches: 83, functions: 76 },
    scope: {},
  },
  {
    name: "@piui/pi-worker",
    dir: "packages/pi-worker",
    thresholds: { lines: 77, branches: 70, functions: 55 },
    scope: {
      "src/entry.ts": "worker 子进程入口，测试以 spawn 方式拉起（子进程覆盖不计入本进程报告）",
      "src/runtime.ts": "只有 interface/type 声明",
      "src/ipc.ts": "worker 协议常量与消息类型，运行时消费者是 entry.ts 与 server 的 worker-client",
      "src/index.ts": "barrel，只做 re-export",
    },
  },
  {
    name: "@piui/server",
    dir: "packages/server",
    thresholds: { lines: 87, branches: 70, functions: 80 },
    scope: {
      "src/bundle-entry.ts": "打包入口，条件式 import 各 CLI 入口",
      "src/index.ts": "进程入口，只调用 startPiUiServer()",
      "src/pi-cli-entry.ts": "CLI 入口（node 打包路径）",
      "src/pi-cli-bun-entry.ts": "CLI 入口（bun 打包路径）",
    },
  },
]

const FILE_RE = /\.(?:ts|tsx|mts|cts|js|mjs)$/

/** 与覆盖率报告同一坐标系：以包目录为基准、带 `src/` 前缀的相对路径。 */
function sourceFiles(pkgDir) {
  const found = []
  const walk = current => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (FILE_RE.test(entry.name)) found.push(path.relative(pkgDir, full).split(path.sep).join("/"))
    }
  }
  walk(path.join(pkgDir, "src"))
  return found
}

/** 报告是「目录标题 + 缩进文件名」的层级文本，缩进深度就是路径深度。 */
function parseReportedFiles(output) {
  const stack = []
  const files = []
  for (const raw of output.split("\n")) {
    if (!raw.startsWith("\u2139 ")) continue
    const columns = raw.slice(2).split("|")
    const name = columns[0].replace(/\s+$/, "")
    const trimmed = name.trim()
    if (!trimmed || /^-+$/.test(trimmed) || trimmed === "file" || trimmed === "all files") continue
    const depth = name.length - name.trimStart().length
    stack.length = depth
    if (FILE_RE.test(trimmed)) files.push([...stack, trimmed].join("/"))
    else stack.push(trimmed)
  }
  return files
}

function runPackage(pkg) {
  const cwd = path.join(root, pkg.dir)
  const src = path.join(cwd, "src")
  const excluded = new Set(Object.keys(pkg.scope))
  const expected = sourceFiles(cwd)
    .filter(file => !file.endsWith(".test.ts") && !file.endsWith(".d.ts"))
    .filter(file => !excluded.has(file))
    .sort()

  const args = [
    "--import",
    "tsx",
    "--test",
    "--experimental-test-coverage",
    "--test-coverage-include=src/**",
    "--test-coverage-exclude=src/**/*.test.ts",
    `--test-coverage-lines=${pkg.thresholds.lines}`,
    `--test-coverage-branches=${pkg.thresholds.branches}`,
    `--test-coverage-functions=${pkg.thresholds.functions}`,
    "src/**/*.test.ts",
  ]

  return new Promise(resolve => {
    const child = spawn(process.execPath, args, {
      cwd,
      env: { ...process.env, NODE_ENV: "test" },
      stdio: ["ignore", "pipe", "inherit"],
    })
    let output = ""
    child.stdout.on("data", chunk => {
      output += chunk
      process.stdout.write(chunk)
    })
    child.on("error", () => resolve({ pkg, expected, reported: [], code: 1 }))
    child.on("exit", code => {
      const reported = parseReportedFiles(output).sort()
      resolve({ pkg, expected, reported, code: code ?? 1 })
    })
  })
}

const requested = process.argv[2]
const cwdPackage = PACKAGES.find(pkg => path.join(root, pkg.dir) === process.cwd())
const targets = requested
  ? PACKAGES.filter(pkg => pkg.name === requested)
  : cwdPackage
    ? [cwdPackage]
    : PACKAGES

if (targets.length === 0) {
  console.error(`unknown package: ${requested}`)
  process.exit(1)
}

let failed = false
for (const pkg of targets) {
  const { expected, reported, code } = await runPackage(pkg)
  const missing = expected.filter(file => !reported.includes(file))
  const unexpected = reported.filter(file => !expected.includes(file))

  if (missing.length > 0 || unexpected.length > 0) {
    failed = true
    console.error(`\n${pkg.name}: coverage scope mismatch`)
    for (const file of missing) {
      console.error(`  - ${pkg.dir}/${file}: 没有被任何测试加载，等于没有度量`)
    }
    for (const file of unexpected) {
      console.error(`  - ${pkg.dir}/${file}: 出现在报告里但不在范围内（脚本配置需要更新？）`)
    }
    if (missing.length > 0) {
      console.error("  补测试，或在 scripts/node-coverage.mjs 的 scope 里登记排除原因")
    }
  }
  if (code !== 0) failed = true
  if (missing.length === 0 && unexpected.length === 0 && code === 0) {
    console.log(`${pkg.name}: coverage OK (${reported.length}/${expected.length} files measured)`)
  }
}

process.exit(failed ? 1 : 0)
