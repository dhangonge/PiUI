# PiUI 开发文档

## 目标

**Pi coding agent 的原生 server：数据零修改透传，能力自省生成 API，UI 直接消费 Pi 原生结构。**

- 运行时：`@earendil-works/pi-coding-agent` SDK 内嵌于 worker 进程（官方对 Node 宿主的推荐方式）
- 协议：registry/命令/响应/事件四段式，对齐官方 runtime registry 语义；Pi 数据不定义中间类型，JsonValue 透传
- 扩展：tool/command 运行时枚举自动生成 API，装扩展零协议改动
- 不调用真实模型做开发验收（mock driver + faux provider）

## 架构

```text
浏览器/客户端
  │  HTTP(registry + 命令口) / WS(事件订阅)
  ▼
packages/server     分发层:不感知 Pi 语义,只转发
  │  IPC(统一命令消息 + 事件 + hostCall)
  ▼
packages/pi-worker  唯一懂 Pi 的进程:命令表 → AgentSession
  │
  ▼
@earendil-works/pi-coding-agent   SDK 内嵌,配置/凭据/扩展/会话全走 ~/.pi/agent 原生路径
```

### 核心原则

1. **零数据转换**:worker→server→客户端的会话数据只做 JSON 结构化复制，不可序列化直接报错
2. **零协议发明**:命令对齐 SDK 方法语义（prompt/steer/followUp/compact/fork/…)，事件就是 Pi 原生事件
3. **零能力白名单**:Pi 能力注册进 registry，HTTP 只按 capability name 分发；扩展 tools/commands 由 Pi runtime 枚举
4. **SDK 可替换**:worker 经 sdk-host 动态加载 SDK，默认 bundle 验证版（版本号见 `packages/protocol/src/version.ts` 的 `PI_PARITY_SDK_VERSION`），`PIUI_SDK_PATH` 可指外部版本
5. **mock 在 worker 内**:server 不感知 driver;mock 会话写独立 JSONL 目录（PIUI_MOCK_DIR)，格式与 Pi 相同

### HTTP 面

```text
GET    /api/v1/pi/registry                       当前 Pi capability registry
POST   /api/v1/pi/commands/:name                 global command,如 models.list/settings.get/session.open
POST   /api/v1/pi/sessions/:id/commands/:name    session command,如 prompt/branch.get/registry.get/invokeTool

GET    /api/v1/host/health                       server 健康检查
GET    /api/v1/host/registry                     当前 host capability registry
POST   /api/v1/host/commands/:name               host command,如 workspaces.open/files.read/git.status
GET    /api/v1/host/commands/:id                 Pi session 命令生命周期查询

WS     /api/v1/events                            stream 订阅 + cursor/replay/resync
```

### 事件通道（WS envelope.channel)

- `pi.event`:payload = `{event: <裸 Pi 事件>, meta: {epoch, sequence, liveMessage?}}`
- `session.head`:entries/tree 变化后的 head(leafId/entryCount/revision)
- `registry.updated`:runtime 能力变化，payload 含 `{revision, sessionId, reason}`，客户端应重新拉 registry；worker 会对 session registry 做 digest 对比，兜底发现动态 extension tool/command 变化
- `command.updated`:命令生命周期（accepted/running/completed/failed/cancelled)
- `extension.ui` / `provider.auth` / `packages.progress` / `sessions.updated` / `resources.updated`
- `workspace.files` / `workspace.git`:host 区文件与 Git 变化

### 关键命令（capability name)

- global：`registry.describe, session.open, session.attached, session.list, session.listAll, session.delete, models.list, settings.get, settings.patch, trust.get, trust.set, providers.*, modelRuntime.*, packages.*`
- session：`prompt, steer, followUp, sendUserMessage, abort, newSession, switchSession, fork, clone, importSession, setSessionName, setModel, cycleModel, setScopedModels, setThinkingLevel, cycleThinkingLevel, setSteeringMode, setFollowUpMode, clearQueue, compact, abortCompaction, abortBranchSummary, setAutoCompaction, setAutoRetry, abortRetry, bash, abortBash, setActiveTools, invokeTool, invokeCommand, navigateTree, setLabel, sendCustomMessage, appendCustomEntry, exportHtml, exportJsonl, waitForIdle, reload, respondExtensionUi, setExtensionEditorState, state.get, entries.get, branch.get, tree.get, registry.get, attachment.get`

每个 capability 由 `registerPiCapability` 显式注册，registry 是唯一真相。返回字段包括：`name/scope/source/description/paramsSchema/resultSchema/queue/replacement/streaming/cancellable/idempotent/requiresRuntime/requiresTrust`。`paramsSchema` 是 JSON Schema 风格结构，供客户端生成表单和本地校验；result 保持 Pi 原生 JSON 透传，不重建中间模型。

### Host 命令

Host 区也使用 registry/dispatch，不保留 workspace/files/git REST shortcut。关键命令：

- server/commands：`commands.get`
- workspaces：`workspaces.list, workspaces.open, workspaces.close, workspaces.watch`
- files：`files.list, files.read, files.write, files.create, files.move, files.delete, files.searchName, files.searchText`
- git：`git.info, git.status, git.diff, git.fileDiff`

每个 host capability 由 `registerHostCapability` 显式注册，返回字段包括：`name/domain/description/paramsSchema/resultSchema/queue/idempotent/mutatesWorkspace/emits`。

扩展自省：

- `POST /api/v1/pi/sessions/:id/commands/registry.get` → tools(含 JSON Schema)/commands/extensions/eventHandlers，运行时枚举
- `POST /api/v1/pi/sessions/:id/commands/invokeTool` + `{name, arguments}` → 直接执行扩展 tool(ctx.ui 交互走 extension.ui 桥)
- `POST /api/v1/pi/sessions/:id/commands/invokeCommand` + `{name, args}` → 执行扩展 slash command

## 包职责

| 包                                | 职责                                                                                                                               |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `packages/protocol`               | 信封/命令名/宿主类型。**只有 type 没有 interface**(JsonValue 兼容需要）；不声明 Pi 数据结构                                        |
| `packages/pi-worker/src/runtime/` | real/mock runtime、catalog、pagination、extension UI、provider auth；唯一直接碰 Pi SDK runtime 的实现区                            |
| `packages/pi-worker/src/`         | worker 框架：sdk-host、IPC、命令表、参数校验、scheduler、entry                                                                     |
| `packages/server/src/pi/`         | Pi 面分发：worker-client、supervisor、session-host、executor、lease                                                                |
| `packages/server/src/host/`       | host 面能力：workspace 注册/监听、files、file-search、git、auth/security/path-safety                                               |
| `packages/server/src/`            | HTTP/WS/event-hub/shutdown/index 组装层                                                                                            |
| `packages/app`                    | 客户端（React + Tauri）：`src/pi` 消费协议、`src/features/pi-chat` 渲染 Pi 原生数据；`src/features/chat` 是上游 OCUI 视觉壳（GPL） |

## 工程规范

| 文件                            | 作用                                                                                                                                                                              |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tsconfig.base.json`            | 四个包共享的 TS 基线（strict、noUnusedLocals/Parameters、noImplicitOverride…）。只放所有包都同意的选项；`module`/`moduleResolution`/`lib`/`jsx`/`erasableSyntaxOnly` 由各包自己定 |
| `.editorconfig`                 | 行尾 LF、UTF-8、缩进 2 空格（Kotlin/Java 4 空格）                                                                                                                                 |
| `eslint.config.js`（根）        | Node 侧包（protocol / pi-worker / server）+ `scripts/` 的 lint 基线                                                                                                               |
| `packages/app/eslint.config.js` | app 自己的配置（React hooks / refresh 规则），继承同样的 warn 策略                                                                                                                |
| `.prettierrc.json`（根）        | 全仓唯一格式配置（无分号、单引号、printWidth 120）；`packages/app` 不再有自己的副本，`npm run format:check` 进 validate                                                           |
| `docs/app-architecture.md`      | app 的分层、依赖方向、新代码放哪、单文件行数上限（配 `npm run check:size`）                                                                                                       |
| `scripts/node-coverage.mjs`     | Node 侧三包的覆盖率阈值 + 度量范围校验（见「工程规范」下的门禁表）                                                                                                                |

门禁入口：

```bash
npm run validate        # check:docs → conformance:sdk:check → check:size → format:check → typecheck → lint → test → build
npm run check:docs      # 文档里声明的版本基线/CHANGELOG/workspace 版本一致性
npm run check:size      # packages/*/src 下单文件 1000 行上限（基线见 scripts/file-size-baseline.json）
npm run format:check    # prettier 全仓校验（`npm run format` 就地修复）
npm run lint            # app（eslint）+ 根（protocol/pi-worker/server/scripts）
npm run test:coverage   # 同 test，另收两套覆盖率并按门槛判定（见下）
npm run smoke           # 需先 build：两个 Chromium 冒烟（timeline 顺序 + 双后端移动 UI）
```

覆盖率两套门禁，同一开关 `--coverage` / `PIUI_TEST_COVERAGE=1` 一起开：

| 范围                          | 工具                     | 门槛位置                                                              |
| ----------------------------- | ------------------------ | --------------------------------------------------------------------- |
| `packages/app`                | vitest + coverage-v8     | `packages/app/vitest.config.ts`（include 全量 src，阈值 43/35/40/45） |
| protocol / pi-worker / server | node `--test` 内置覆盖率 | `scripts/node-coverage.mjs`（每包一组阈值）                           |

Node 侧那份还有一道额外的检查：Node 22 的内置覆盖率**只报告被测试加载过的文件**（`--test-coverage-include-all` 要 Node 25+），所以脚本把「应该被度量」的文件集合写明，跑完逐一核对——新加了源文件但没测试加载它会直接失败，不会偷偷把分母缩小。排除项（入口、barrel、纯类型）都写在脚本里并附理由。

格式：prettier 配置在根（`.prettierrc.json` + `.prettierignore`），一个配置覆盖四个包、`scripts/`、文档和 workflow。`packages/app/CHANGELOG.opencodeui.md`、`README.opencodeui.md` 是上游冻结快照，在 `.prettierignore` 里排除，保持原始字节。

CI：`.github/workflows/ci.yml` 在 ubuntu + windows 跑 `npm run validate`；ubuntu 那支带 `PIUI_TEST_COVERAGE=1`（避免两支重复跑一遍测试）+ Chromium 冒烟；`tauri-check` job 跑 `cargo clippy --all-targets -- -D warnings` + `cargo test --lib`。触发条件是 push 到 `main`、`v*` tag、以及所有 PR。

新增版本声明时写在可校验的位置：SDK 基线写成 ``Baseline: `@earendil-works/pi-coding-agent@x.y.z` ``（`docs/PI_SDK_API_MATRIX.md` 的模式），否则 `check:docs` 不管；本包版本号不要写进文档，只引用 `PI_PARITY_SDK_VERSION`。

## 本地跑

```bash
npm install
npm test                 # 三包 build + 全部测试(mock,不调模型)
npm run dev:server       # 127.0.0.1:8787,mock driver
npm run dev:server:pi    # 真 Pi(读 ~/.pi/agent 凭据,发消息消耗 token)
```

### 冒烟

```bash
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8787/api/v1/host/health
curl -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"rootPath":"/path/to/project"}' http://127.0.0.1:8787/api/v1/host/commands/workspaces.open
curl -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"cwd":"/path/to/project"}' http://127.0.0.1:8787/api/v1/pi/commands/session.open
curl -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"id":"c1","params":{"text":"hi"}}' \
  http://127.0.0.1:8787/api/v1/pi/sessions/$SID/commands/prompt
```

### 环境变量

- `PIUI_DRIVER`: `mock`(默认,不调模型)| `pi`
- `PIUI_MOCK_DIR`: mock 会话目录（默认 `<tmpdir>/piui-mock`)
- `PIUI_SDK_PATH`: 外部 SDK 路径（目录或入口文件；版本与验证版不同时警告放行）
- `PIUI_USE_SYSTEM_PI=1`: 显式优先使用用户全局安装的 Pi SDK；默认优先使用 PiUI 自带的版本化 runtime
- `PIUI_SDK_STRICT=1`: 外部 SDK 版本不匹配时拒绝启动
- `PIUI_AUTH_TOKEN`: 覆盖本地 token（默认生成并持久化在数据目录）
- `PIUI_SESSION_IDLE_TTL_MS`: 非活动 Pi session runtime 的回收时间，默认 120000（至少 30000）

测试环境：`npm test` 自己会把 `NODE_ENV` 固定为 `test`（父进程带了 `NODE_ENV=production` 时，React 会加载 production 构建，测试会报 `React.act is not a function`）。单独跑 app 测试请用 `NODE_ENV=test npm run test:run -w @piui/app`。

开发环境可用 `npm run install:test-extension` 恢复 PiUI 面板测试扩展到
`~/.pi/agent/extensions/piui-panel-test.ts`。它只用于验证扩展状态、widget、命令和对话框桥接，不会自动装进正式产品。

## 当前状态

- 后端三包（protocol/pi-worker/server)：重构完成，99 测试全绿，含真实 SDK + faux provider 无网络集成测试
- app：未适配新协议，待后续处理
- 待办：invokeTool 的 onUpdate 流式进度、PTY、app 适配、发布门禁（R12 conformance)
