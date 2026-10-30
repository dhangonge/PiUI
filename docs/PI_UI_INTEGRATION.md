# Pi 1.4.0 Native Parity Matrix

本文是 PiUI 能力状态的权威清单，基线固定为 `@earendil-works/pi-coding-agent@1.4.0`

支持等级：

- `完整`：SDK 能力、服务端协议、Web UI 和无网络测试均已完成
- `部分`：主路径可用，但原生语义、控制项或数据仍有缺失
- `后端`：worker/server 已有能力，前端尚未提供完整入口
- `缺失`：尚无可靠协议或实现
- `TUI-only`：无法在 Web 中等价承载，必须稳定降级或转到原生 Pi TUI

只有同时具备协议测试、真实 Pi SDK + faux provider 测试和 UI 测试，才能标记为 `完整`

## Session

| Pi 能力                         | 当前状态 | 下一阶段               |
| ------------------------------- | -------- | ---------------------- |
| list/listAll/create/open/resume | 完整     | R12：升级 conformance  |
| 持久删除 JSONL                  | 完整     | R12：故障注入扩展      |
| session name                    | 完整     | R12：升级 conformance  |
| entries/tree/leaf 读取          | 完整     | R12：大型 tree fixture |
| navigateTree/label              | 完整     | R12：大型 tree fixture |
| fork/clone/import               | 完整     | R12：更多故障注入      |
| branch summary 与取消           | 完整     | R12：升级 conformance  |
| stats/context usage             | 完整     | R12：升级 conformance  |
| HTML/JSONL export               | 完整     | R12：升级 conformance  |

> share 不属于 Pi 能力矩阵：Pi SDK 未暴露任何 share 语义（命令表与 AgentSession 均无），PiUI 不消费也不展示入口。

## Agent Control

| Pi 能力                  | 当前状态 | 下一阶段               |
| ------------------------ | -------- | ---------------------- |
| text prompt/stream/abort | 完整     | R12：故障注入扩展      |
| steer/followUp           | 完整     | R12：升级 conformance  |
| queue 内容与模式         | 完整     | R12：升级 conformance  |
| clear queue              | 完整     | R12：升级 conformance  |
| model select             | 完整     | R12：升级 conformance  |
| thinking level           | 完整     | R12：升级 conformance  |
| compact                  | 完整     | R12：大型会话 fixture  |
| auto compaction/retry    | 完整     | R12：故障注入扩展      |
| abort retry              | 完整     | R12：故障注入扩展      |
| user bash `!`/`!!`       | 完整     | R12：升级 conformance  |
| active tools 查询/切换   | 完整     | R7：dynamic tools 联动 |

## Multimodal And Tools

| Pi 能力                                    | 当前状态             | 下一阶段                                   |
| ------------------------------------------ | -------------------- | ------------------------------------------ |
| image prompt（图片附件）                   | 完整                 | R5：file/PDF 附件明确不提取（路径交给 Pi） |
| file/PDF prompt                            | 缺失（明确不做提取） | —                                          |
| text tool result                           | 完整                 | R12：升级 conformance                      |
| tool execution updates                     | 完整                 | R12：升级 conformance                      |
| image/details/patch/cwd/exitCode           | 完整                 | R12：升级 conformance                      |
| truncated/fullOutputPath                   | 完整                 | R12：升级 conformance                      |
| built-in read/bash/edit/write/grep/find/ls | 完整                 | R12：升级 conformance                      |

## Extensions And Resources

| Pi 能力                               | 当前状态 | 下一阶段                                                           |
| ------------------------------------- | -------- | ------------------------------------------------------------------ |
| Skills 元数据                         | 完整     | R12：升级 conformance                                              |
| Prompt templates                      | 完整     | R12：升级 conformance                                              |
| Extension commands                    | 完整     | R12：升级 conformance                                              |
| Dynamic tools/providers               | 完整     | R12：升级 conformance                                              |
| select/confirm/input/editor           | 完整     | R12：升级 conformance（真实 SDK 对话框 E2E 已加入）                |
| notify/status/widget/title            | 完整     | R12：升级 conformance（真实 SDK 状态事件 E2E 已加入）              |
| custom entries/renderers              | 部分     | R7：custom_message 已渲染，其余类型降级                            |
| arbitrary TUI Component/header/footer | TUI-only | R7：稳定降级与原生入口                                             |
| AGENTS/CLAUDE context                 | 完整     | R12：升级 conformance                                              |
| resource reload/diagnostics           | 完整     | R12：升级 conformance（reload 命令 + PiResourceManagement + 测试） |
| global/project settings               | 完整     | R12：升级 conformance                                              |
| packages install/update/remove        | 完整     | R12：升级 conformance                                              |
| Pi project trust                      | 完整     | R12：升级 conformance                                              |

## Providers And Auth

| Pi 能力                      | 当前状态 | 下一阶段              |
| ---------------------------- | -------- | --------------------- |
| `~/.pi/agent` 模型与认证读取 | 部分     | R10                   |
| provider auth status         | 完整     | R12：升级 conformance |
| API key/OAuth login/logout   | 完整     | R12：升级 conformance |
| catalog refresh              | 完整     | R12：升级 conformance |
| extension provider models    | 完整     | R12：升级 conformance |
| scoped models                | 完整     | R12：升级 conformance |

> llama.cpp 本地模型下载/加载/取消不属于 Pi 能力矩阵：Pi 官方仍在规划
> （[#3107 `/local` 命令](https://github.com/earendil-works/pi/issues/3107)、[#3567 llama.cpp provider](https://github.com/earendil-works/pi/issues/3567)、
> [#3357 本地 LLM 扩展](https://github.com/earendil-works/pi/issues/3357)），SDK 未暴露任何 API，PiUI 不消费也不展示入口。

## PiUI Host Capabilities

| 能力                     | 当前状态 | 说明                                                          |
| ------------------------ | -------- | ------------------------------------------------------------- |
| 文件读取、搜索、写入 API | 完整     | R12：升级 conformance                                         |
| Git status/diff          | 完整     | R12：升级 conformance（git/staged/unstaged/branch 四种 mode） |
| PTY（宿主终端）          | 完整     | R12：升级 conformance（terminals.* 命令 + ws e2e）            |
| workspace access         | 完整     | R12：升级 conformance                                         |
| WebSocket replay/resync  | 完整     | R12：完整故障注入矩阵                                         |

## SDK 升级记录

### 1.3.0 → 1.4.0

驱动原因：用户桌面 Pi 升到 1.4.0，`pi` 同时把已装插件整体升级（`pi-mcp-adapter` 5.3.1 → 7.0.0 跨大版本、`@plannotator/pi-extension` 0.28.22 → 0.28.38、`pi-context-view` 0.7.1 → 0.8.1、`pi-cache-optimizer` 2.8.25 → 2.10.4、`@juicesharp/rpiv-todo` 与 `rpiv-ask-user-question` 2.13.8 → 2.15.0、`pi-simple-web-tools` 0.2.0 → 0.3.0、`billion-context` 0.1.197 → 0.1.209、`@narumitw/pi-lsp` 0.49.10 → 0.49.11、`pi-subagents-lite` 1.17.0 → 1.17.1），本地扩展增至 9 个（新增 `agentrouter-responses-item-ids.ts`）。

代码改动为零：只改 `packages/{app,pi-worker}/package.json`、`packages/protocol/src/version.ts`、`packages/pi-worker/src/bundled-sdk-version.ts`、`packages/protocol/src/index.test.ts`、`docs/` 三处基线与 `package-lock.json`。

无需改动的兼容性事实：

- `dist/index.d.ts`、`dist/index.js`、`dist/core/session-manager.{js,d.ts}`、`dist/core/event-bus.*`、`dist/core/resource-loader.*` 与 1.3.0 **逐字节相同** —— 子代理子会话落盘桥（`packages/pi-worker/src/runtime/subagent-sessions.ts` 对 `SessionManager.inMemory` 的补丁）与 `createEventBus` 注入不受影响。
- `PI_SDK_MODULE_CONTRACT` 的 12 个符号在 1.4.0 全部存在；`core/extensions/types.d.ts`（插件可见的 Extension API 面）未变。
- 删除/改名的只有本仓未引用的部分：`AgentSession._lastAssistantToolResults`（私有）、pi-ai 的 `telemetryContext`（改为 `telemetry?: TelemetrySpan`）、`generateSummary` 的第二参数改名 `_reserveTokens`（位置与类型兼容）。
- `dist/core/extensions/loader.js` 只新增 `@earendil-works/pi-ai/models`、`@mariozechner/pi-ai/models` 两个 jiti 别名。
- 行为变更未触及 PiUI：交互模式扩展对话框改为栈式（TUI 专用）、classifier 图片输入、`pi update` BOM、pi-tui 的 markdown CJK 强调修复（正文由 app 自己的 `markdownHtmlRenderer.ts` 渲染）、provider 归属头改由 pi-ai client identity 提供（本机 9 个本地扩展均不监听 `before_provider_headers`）。
- 依赖新增一处：pi-tui 引入 `marked-cjk-friendly@0.1.2`，由 `npm install` 自动装入。

验证：`typecheck` 0 错误、`conformance:sdk` 通过、protocol 15 / pi-worker 96 / server 134(+2 skip) / app 149 文件 901 项通过、构建通过、`check:docs` 通过、沙箱插件探针 **11/11 通过**（含 `pi-mcp-adapter` 7.0.0 与 `@plannotator/pi-extension` 0.28.38）。未验证：插件深层行为、真机与真实模型调用。

### 1.0.3 → 1.3.0

驱动原因：用户桌面 Pi 升到 1.3.0 后，`pi` 同时把 11 个 npm 插件中的 9 个升到新版本，原插件基线（`sdkCandidate: 1.0.3`）失效；1.1–1.3 还包含中转网关重试（`Unable to forward upstream stream`、`The service is temporarily unavailable`、`The upstream provider returned an error`）、OpenAI 兼容流式的 reasoning 顺序、压缩时省略 thinking 等修复。

代码改动只有一处：pi-tui 1.1 给 `Terminal` 加了 `setProgramStatus()`（OSC 7501），离屏镜像 `VirtualTerminal` 需要一个空实现（`packages/pi-worker/src/runtime/extension-tui.ts`）。其余为版本常量、锁文件和文档。

无需改动的兼容性事实：

- 公开导出只有新增；移除的仅是未发布的 `./client`、`./experimental/plugin` 入口与 `pi-client`/`pi-protocol`/`pi-server` 包，PiUI 从未引用。
- `SessionEntry` 联合类型与 1.0.3 完全一致，pi-ai 消息/内容类型只新增可选字段，会话文件双向兼容。
- `readBuiltinThemes` 依赖的深路径 `loadThemeFromPath`/`getThemeByName` 仍存在；内置 dark/system 与用户自定义主题均可加载。
- 1.2.0 的两处破坏性变更未触及 PiUI：`before_agent_start` 事件联合（无人监听）与忙时 `sendUserMessage` 需 `deliverAs`（composer 路径始终显式传入）。

验证：typecheck 0 错误、lint 干净、protocol 15 / pi-worker 76 / server 126(+2 skip) / app 138 文件 781 项通过、`conformance:sdk` 通过、构建通过、两个浏览器冒烟（时间线顺序、412×915 双服务器）通过、刷新后的插件基线探针 11/11 通过。未验证：插件深层行为、真机与真实模型调用。

顺带修掉同一类陈旧字面量：`scripts/capture-plugin-baseline.mjs`、`scripts/build-offline.mjs`、`scripts/offline/runtime-check.mjs` 里的 SDK 版本改为从 `PI_PARITY_SDK_VERSION` / 包内 `manifest.json` 派生。

## Completion Gate

每个能力完成时必须同时满足：

1. Pi 1.4.0 来源 API 和语义已记录（见上方《SDK 升级记录》）
2. Protocol 使用判别联合，不以 `unknown` 掩盖已知数据
3. worker 保持 session 单写并处理 replacement generation
4. server 返回明确 capability、错误和 command 状态
5. UI 没有假成功、静默空数组或点了才报错的入口
6. 默认测试不调用真实模型
7. 至少有一条真实 Pi SDK + faux provider 的无网络测试
8. Pi 升级时重新运行 API diff、fixture replay 和本矩阵 —— 由 `npm run conformance:sdk`（scripts/sdk-conformance.mjs）自动校验协议/依赖/安装三处版本一致并重跑协议与 worker 测试
9. worker 心跳看门狗、崩溃与协议不匹配路径由 worker-client 故障注入矩阵覆盖（packages/server/src/pi/worker-client.test.ts）
