# 插件宿主 P0/P1 交付记录

> 本文件记录 P0/P1 交付时的状态，其中 SDK 基线 `1.0.3` 已被后续升级取代（现为 `1.4.0`，见 `docs/PI_UI_INTEGRATION.md` 的《SDK 升级记录》）；`docs/plugin-baseline.json` 也已重抓到升级后的插件版本。其余实现描述仍是当前状态。

范围：执行插件适配方案的首批 P0 + P1。不包含 P2 原生问答/任务卡片、P3 远程评审/上下文视图、P4 个人输入栏迁移。

APK 代码基线：`c3751157`（包含以下提交）。后续探针断言加强及文档不改变 APK 代码。

| 提交       | 内容                                                           |
| ---------- | -------------------------------------------------------------- |
| `f24a1fb0` | SDK 家族固定为 1.0.3，隔离迁移探针，旧会话夹具，插件基线快照   |
| `7add2b3e` | 会话级稳定 Theme、按名查找与切换、RPC 降级诊断、前端控制符清理 |
| `0f688a7c` | 组件回调故障隔离、custom UI 生命周期、扩展错误上报和重载绑定   |
| `400ea0ce` | 修复 mock 预览空历史，持久化/分页回归与浏览器等待条件          |
| `c3751157` | Linux bubblewrap 真实插件隔离启动探针                          |

## 1. SDK 与个人配置边界

- app/worker 所需的 coding-agent、pi-ai、pi-agent-core、pi-tui 依赖均固定为精确 `1.0.3`；协议常量与 bundled SDK 常量同步，HTTP/WS 协议版本仍为 1。
- `scripts/sdk-conformance.mjs` 同时检查声明、常量、lockfile 和实际安装版本，不再只检查 coding-agent 单个包。
- 候选运行时探针用内存凭据、虚构 provider 和临时 agentDir，验证模块/会话契约、prompt 事件、取消、new/switch/fork/reload、重新绑定和持久化。分别验证过 0.84.2 与 1.0.3。
- 由 0.84.2 生成的合成会话夹具可在 1.0.3 中读取/追加，原夹具字节保持不变。这不是对所有真实会话的迁移认证，也不证明新版会话可无损交回旧 SDK。
- `docs/plugin-baseline.json` 记录 11 个 npm 插件的版本与包内容哈希、9 个本地扩展的内容哈希。包内容哈希不覆盖其嵌套 node_modules；该文件是审计快照，不是启用清单。
- 没有修改全局 Pi、个人 settings、凭据、真实会话或已安装插件；没有执行那 9 个本地扩展，也没有运行 auto-patch。
- 没有自动启动/更新常驻 server，也没有改变监听接口。已有 server 需由操作者更新并重启。

`PI_CODING_AGENT_DIR` 默认仍遵循 SDK 的 `~/.pi/agent`。独立测试并不改变这一默认值。试用新宿主应明确指定独立目录，逐项配置需要的插件；不要直接使用整套未经验证的个人配置。

## 2. Theme 与 RPC 契约

### 已实现

- 每个会话一个稳定的 Theme 代理；组件工厂与 `ctx.ui.theme` 使用同一引用。
- SDK 1.0.3 会复制 uiContext。即使插件保存旧的 theme 或 fg 函数，切换后调用仍访问本会话的新主题。
- `getTheme(name)` 查询已发现主题；不存在时返回 undefined。`setTheme` 仅在有效主题被选中后成功并触发重绘。
- 可用时从 SDK 加载内置主题，从 resource loader 获取自定义主题；缺失配置主题时显式提示 fallback。
- 不修改全局 SDK 主题状态、不写用户主题设置、不改变 Android 应用全局配色。
- 状态、标题、文本 widget 和通知反馈中的 ANSI/OSC/控制符在 React 文本出口清理，HTML 仍按文本呈现。

### 有限支持，不能冒充终端

| 能力                                             | 当前行为                                              |
| ------------------------------------------------ | ----------------------------------------------------- |
| `onTerminalInput`                                | 返回可重复调用的空取消函数，并提示 RPC 不提供终端监听 |
| `getEditorComponent`                             | 返回 undefined 并提示降级                             |
| `setEditorComponent` / `addAutocompleteProvider` | 不调用传入的终端工厂，提示降级                        |
| select/confirm/input/editor                      | 保留真实等待、回答、取消与超时逻辑，不自动批准        |
| footer 数据                                      | git/provider 相关占位能力会提示限制，不声称全部等价   |
| 动态 overlayOptions 工厂                         | 仅挂载时求值；明确提示不会在每次尺寸变化时重新计算    |
| 自动 light/dark 主题对                           | 尚无手机外观协商，选暗色分支                          |

## 3. 错误隔离与 custom UI

- 对宿主托管组件的 render、invalidate、键盘/鼠标输入、focus、dispose 设置回调边界。异常后只移除对应面板。
- 捕获发生在真正渲染回调处，而不仅是 `requestRender()` 调用处；失败移除延后到当前 Container 遍历结束。
- 限制异常 render 返回值与输出规模，按终端宽度截断，避免宽行使底层 TUI 在组件边界外抛错。
- custom UI 的永久 hide、reset、reload、session replacement 和 dispose 会结算取消；临时 setHidden 不会结束请求，可再次显示。
- 转发真实 overlay 的 focus/unfocus、隐藏状态和 bounds。延迟完成的 factory 会被清理，旧 done/旧 handle 不得关闭新面板。
- SDK module load、事件、手动命令/工具调用与组件错误进入持久 status + notify 通道。旧客户端无需识别新事件类型即可看到诊断。
- 新诊断只含净化后的来源、阶段与处理建议，不转发原始异常文本、凭据或堆栈；错误去重，代际变化后丢弃旧回调。
- SDK reload 自己会发 session_start；错误监听在 beforeSessionStart 重新绑定，避免重复初始化。回归断言 initial + reload 恰好两次。

边界：扩展仍是可执行代码。这不是 JavaScript/进程沙箱；插件绕过宿主回调直接创建的定时器、外部进程或全局副作用不受该组件错误边界保护。隔离探针的 OS 沙箱仅用于测试，没有默认包裹生产 worker。

## 4. 真实 npm 插件探针

使用 Linux bubblewrap：独立网络/PID 等命名空间、空环境、私有 HOME/agentDir、只读 Node/SDK/插件代码，不挂载个人 HOME、凭据、真实会话、仓库 .git 或 APK/签名目录。单插件 45 秒超时、2 MiB 输出限制；输出目录必须全新。

探针检查版本与审计基线一致、确实注册扩展、启动/清理正常；不能把内置的 read/bash 等 8 个工具计为插件注册成功。

| 插件                                      | 本轮实测                                                                 | 尚未验证                                      |
| ----------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------- |
| pi-cache-optimizer 2.8.19                 | 启动；cache-optimizer 命令注册                                           | 真实 provider 缓存统计、可选配置改写          |
| @plannotator/pi-extension 0.28.3          | 启动；2 个工具、4 个命令注册                                             | 手机评审页面、批注与确认闭环                  |
| pi-mcp-adapter 5.0.0                      | 启动；mcp 网关和管理命令注册                                             | 实际 MCP 服务、认证与远程调用                 |
| @narumitw/pi-lsp 0.49.9                   | 启动；diagnostics/fix 工具注册                                           | 个人语言服务器配置及真实项目修复              |
| pi-subagents-lite 1.15.1                  | 启动；3 个代理工具注册；终端监听降级可见                                 | 子代理模型执行、手机输出浏览/停止             |
| pi-simple-web-tools 0.2.0                 | 启动；搜索与抓取工具注册                                                 | 外网请求、长结果与取消                        |
| pi-context-view 0.6.0                     | 启动；context 命令注册                                                   | 原生上下文页面，TUI-only 视图未迁移           |
| pi-render-cache 1.4.0                     | 启动；rcstats 命令注册                                                   | 缓存收益或离屏副作用；不是 React 正文优化     |
| @juicesharp/rpiv-todo 2.12.0              | 创建隔离任务；捕获包含 Sandbox task 的真实 widget 渲染帧，无宿主诊断错误 | 原生卡片、所有任务操作和会话恢复              |
| @juicesharp/rpiv-ask-user-question 2.12.0 | RPC 多选往返保留 One、Two 两个答案                                       | 原生复选框、完整预览、多题回顾                |
| billion-context 0.1.185                   | 启动；acp/acp-cache/acp-rule 命令注册                                    | 该隔离配置未注册压缩工具；压缩/恢复能力未验收 |

Todo 探针手动调用工具后，显式重放 SDK 的 tool_execution_end，以覆盖插件延迟加载 widget 的路径；它不是一次真实模型决策。问答也是隔离 API 夹具，不调用模型。

11/11 是本表所列范围内的探针通过，不是“11 个插件全部适配”。其余本地扩展只做基线快照和静态审计；input-bar 的通用主题阻断已由契约测试覆盖，但个人文件整体启动与 React 输入栏迁移仍未验收。

## 5. 验证结果

| 检查                         | 结果                                                                     |
| ---------------------------- | ------------------------------------------------------------------------ |
| 四包类型检查、app ESLint     | 通过                                                                     |
| protocol                     | 15 通过                                                                  |
| worker（含新 mock 预览回归） | 75 通过                                                                  |
| server                       | 126 通过，2 个既有跳过                                                   |
| app                          | 135 文件、757 测试通过                                                   |
| Rust                         | cargo check 通过；3 个 lib 测试通过                                      |
| LSP                          | 无错误，仅 4 条可选 async 写法提示                                       |
| build                        | 通过；原有大 chunk 提示仍存在                                            |
| Chromium 412×915             | 双服务器同 ID、发送隔离、分屏后台保留、首击切换 owner 通过；无未捕获异常 |
| Android                      | arm64-v8a 与 armeabi-v7a APK 构建、签名和 16 KiB ZIP 对齐验证通过        |

浏览器验证期间修复一个旧 mock 缺陷：previewSession 永远返回空历史，导致分屏刷新覆盖已持久化内容。现在读真实 mock JSONL 并沿 parentId 构造分支；回归验证分页及预览不写文件。浏览器也改为等待 assistant 持久化完成，不再依赖短暂 live message。

没有 Android 实机/IME/后台恢复/弱网验收；没有真实 provider、OAuth/MCP 网络认证或个人会话验收。浏览器移动视口不等于实机验证。

## 6. 复现

```bash
npm run conformance:sdk
npm run typecheck
npm run lint
npm test -w @piui/server
npm run test:run -w @piui/app -- --maxWorkers=1
npm run build
node --import tsx scripts/smoke-android-ui.mjs

# 对指定 SDK 安装进行无 LLM 迁移探针
node --import tsx scripts/probe-pi-sdk.mjs ./node_modules/@earendil-works/pi-coding-agent

# Linux + bubblewrap；只读已审计版本的插件，不加载个人设置
node scripts/probe-installed-plugins.mjs /path/to/plugin-node_modules /tmp/piui-plugin-probe-new
# 可在最后附包名，只验证选定插件
```

本机最近日志为 `/tmp/piui-p1-final-conformance.log`、`/tmp/piui-p1-final-server.log`、`/tmp/piui-p1-app.log`、`/tmp/piui-p1-browser.log`、`/tmp/piui-plugin-probes-p1-final/results.json`、`/tmp/piui-plugin-probes-p1-todo-frame/results.json`。临时目录可能被系统清理，复现以上命令可生成新记录。

## 7. 签名 APK 与回退

输出目录：`packages/app/src-tauri/target/apk-delivery-c3751157-p1/`。

| APK                                     |   字节数 | SHA-256                                                            |
| --------------------------------------- | -------: | ------------------------------------------------------------------ |
| piui-android-arm64-v8a-dev-signed.apk   | 14317640 | `6703148d658143e236cc582d9a5b2ecc722db9016e50d168445b0db8ad4b40df` |
| piui-android-armeabi-v7a-dev-signed.apk | 11429962 | `5d8bb4097a7bd9bbcac2f1a28d551ac8c5bada3e2c12ab2f1ab25d5c4e6d5129` |

沿用原 piui-development 开发证书，V2/V3 均验证通过；未生成新密钥、未读取/打印口令值。两个 ABI 先分别保存再构建下一个，避免 Tauri 同名输出覆盖交付物。unsigned、aligned 产物与校验记录同目录保留；旧 APK 目录不变。

SDK/主题/错误隔离需要更新 server/worker；APK 包含前端文字出口修复。两者应配套更新，不能仅装 APK 期待远端插件宿主改变。本轮没有自动部署服务。

升级生产配置/会话前保留旧 server 和配置、会话备份。回退应恢复对应版本的备份，不让旧 SDK 直接覆盖新版已写入的个人会话。本轮未触碰真实会话，因此不需要回滚个人数据。
