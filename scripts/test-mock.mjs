import { spawn } from "node:child_process"

// NODE_ENV 固定为 test：vitest 默认会设，但如果调用方环境里已有
// NODE_ENV=production，React 会解析到 production 构建（没有 React.act），
// 整套用例报错。这里显式覆盖，让本地和 CI 行为一致。
const env = { ...process.env, PIUI_DRIVER: "mock", NODE_ENV: "test" }
const npmCli = process.env.npm_execpath

if (!npmCli) {
  throw new Error("npm_execpath is required to run the workspace test suite")
}

// CI 上 worker spawn 偶发挂起会拖死整个 validate；每个子命令设硬超时，
// 超时 kill 并明确报出卡住的命令，避免 job 挂到 runner 上限。
// 默认 600s：慢 runner（如 windows 或共享实例）上 vitest 偶发超过 300s，
// 阈值翻倍后只有真挂死才会触发；仍可用 PIUI_TEST_COMMAND_TIMEOUT_MS 覆盖。
const COMMAND_TIMEOUT_MS = Number(process.env.PIUI_TEST_COMMAND_TIMEOUT_MS) || 600_000

const withCoverage = process.argv.includes("--coverage") || process.env.PIUI_TEST_COVERAGE === "1"

// Node 侧三包用 node --test 内置覆盖率（度量范围校验与阈值写在
// scripts/node-coverage.mjs），app 用 vitest coverage-v8。
const testScript = withCoverage ? "test:coverage" : "test"

const commands = [
  ["run", "build", "-w", "@piui/protocol"],
  ["run", "build", "-w", "@piui/pi-worker"],
  ["run", "build", "-w", "@piui/server"],
  ["run", testScript, "-w", "@piui/protocol"],
  ["run", testScript, "-w", "@piui/pi-worker"],
  ["run", testScript, "-w", "@piui/server"],
  withCoverage
    ? ["run", "test:run", "-w", "@piui/app", "--", "--coverage"]
    : ["run", "test:run", "-w", "@piui/app"],
]

for (const args of commands) {
  const code = await new Promise(resolve => {
    const child = spawn(process.execPath, [npmCli, ...args], {
      cwd: process.cwd(),
      env,
      stdio: "inherit",
    })
    const timer = setTimeout(() => {
      console.error(`\n[test-mock] ${args.join(" ")} exceeded ${COMMAND_TIMEOUT_MS}ms; killing the command`)
      child.kill("SIGKILL")
    }, COMMAND_TIMEOUT_MS)
    child.on("exit", exitCode => {
      clearTimeout(timer)
      resolve(exitCode ?? 1)
    })
    child.on("error", () => {
      clearTimeout(timer)
      resolve(1)
    })
  })
  if (code !== 0) process.exit(code)
}
