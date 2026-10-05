# PiUI（Android 客户端）

PiUI 是 Pi 原生 coding agent 的 Android 客户端。界面、session 浏览和扩展 UI 由 PiUI 提供，agent 执行由 Pi SDK 提供。

> 本仓是从上游 PiUI 剔除非安卓部分后的二次开发分支：仅保留 `packages/{app,protocol,server,pi-worker}` 与 Tauri Android 构建链路，已移除桌面打包（NSIS/DMG/DEB）、便携包（bun `--compile`）、内嵌本地服务进程、单实例、窗口装饰条、iOS 与 Docker 相关内容。
>
> **APK 内不包含 agent runtime**：手机端必须连一个远端 PiUI server（局域网或反向代理）。本地开发时才需要自己起 server。

## 要求

- Node.js `>= 22.19.0`
- npm
- 默认使用 PiUI 固定的 Pi SDK `1.0.3`；外部 SDK 需单独通过兼容性验证
- 对话需要配置 Pi 的 provider 凭据；测试和类型检查默认不会调用真实 LLM
- 构建 APK 另需：JDK 17+、Android SDK（含 NDK `29.0.14206865`）、Rust 稳定版并带 `aarch64-linux-android` / `armv7-linux-androideabi` target

## 快速开始

```bash
npm install
npm run dev
```

`npm run dev` 会同时启动：

- PiUI server：`http://127.0.0.1:8787`
- Vite app：通常是 `http://127.0.0.1:5173`

如果 `5173` 已被占用，Vite 会自动使用下一个端口。开发时应该打开终端中 Vite 打印的地址，这样才能使用 HMR；`8787` 是后端服务和静态 fallback 地址。

只启动后端或前端：

```bash
npm run dev:server:pi
npm run dev:app
```

## 纯终端运行

只启动 PiUI server，不启动浏览器前端：

```bash
npm run dev:server:pi
```

开发 server 使用 `tsx --watch`，适合修改 server/worker 代码时使用。生产构建：

```bash
npm run build
npm start -w @piui/server
```

也可以直接使用 server CLI：

```bash
npm run pi-worker -- web --host 127.0.0.1 --port 8787
npm run pi-worker -- web --host 127.0.0.1 --port 8787 --api-only
```

`--api-only` 不托管前端静态文件，只提供 API 和 WebSocket 服务。

查看 CLI 参数：

```bash
npm run pi-worker -- web --help
```

## 监听地址和远程访问

默认只监听本机：

```text
PIUI_HOST=127.0.0.1
PIUI_PORT=8787
```

局域网访问可以绑定所有 IPv4 网卡：

```bash
PIUI_HOST=0.0.0.0 PIUI_PORT=8787 npm run pi-worker -- web
```

PowerShell：

```powershell
$env:PIUI_HOST = "0.0.0.0"
$env:PIUI_PORT = "8787"
npm run pi-worker -- web
```

启动后 server 会打印局域网访问地址。Android 客户端不管理远端服务的监听配置；请在服务所在机器修改环境变量并重启服务。

监听地址选项：

- `127.0.0.1`：仅本机，默认且最安全
- `0.0.0.0`：所有 IPv4 网卡，适合局域网访问
- `::`：IPv6 所有接口，具体双栈行为取决于操作系统

绑定到 `0.0.0.0` 或 `::` 不等于自动拥有公网访问能力。公网访问还需要路由器端口转发、防火墙规则和公网地址。不要把 PiUI 直接裸露到公网，建议使用 VPN、SSH 隧道或带 TLS 和访问控制的反向代理。

PiUI API 使用本地 auth token。token 默认位于：

```text
~/.piui/auth-token
```

远程访问时必须保护这个 token，并确认访问者可信。拿到 token 的客户端可以调用 API、创建终端和操作 agent。

## 常用环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PIUI_HOST` | `127.0.0.1` | server 监听地址 |
| `PIUI_PORT` | `8787` | server 监听端口 |
| `PIUI_AUTH_TOKEN` | 自动生成 | 显式指定 API token |
| `PIUI_DATA_DIR` | `~/.piui` | PiUI 数据目录 |
| `PIUI_WEB_ROOT` | 自动查找 | 指定前端静态文件目录 |
| `PIUI_DRIVER` | `pi` | 使用 `mock` 可运行无 LLM 的测试 server |
| `PIUI_SDK_PATH` | 空 | 指定 Pi SDK 路径 |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | Pi agent 配置目录 |
| `PI_CODING_AGENT_SESSION_DIR` | 自动 | Pi session 文件目录 |

设置示例：

```bash
PIUI_HOST=0.0.0.0 \
PIUI_PORT=9000 \
PIUI_DATA_DIR=/var/lib/piui \
npm run pi-worker -- web --api-only
```

## 多服务器使用

1. 在“设置 → 服务器”添加远端 PiUI 地址及 token。也可通过连接链接导入；不要公开分享含 token 的链接。
2. 启用多服务器模式，订阅需要同时查看的服务器。侧栏按服务器、工作区、会话分组；搜索支持服务器名、工作区路径及会话内容。
3. 打开不同服务器的会话或分屏。每个会话绑定自己的服务器，切换焦点不会断开其他服务器的会话流。
4. “设为默认服务器”只改变下次启动的默认选择，不立即切换当前会话。关闭多服务器模式后恢复单服务器侧栏。

会话、事件游标、命令、模型偏好、置顶、目录及终端快照按服务器隔离；文件、Git、provider 管理面板跟随当前焦点。Android 不启动或管理本地 agent runtime。

本轮 OCUI 移植范围、验证方式和保留限制见 [同步记录](docs/OCUI_ANDROID_SYNC.md)。

## 插件宿主适配（P0 + P1）

已加入会话级主题、可见的 RPC 降级、组件回调错误隔离与 custom UI 取消处理。扩展诊断通过原有状态/通知通道显示，未将协议版本提升为 2；终端主题不会改变 Android 全局主题。

- 这些修复主要在 server/worker；只安装新 APK 不会更新远端宿主。
- 个人插件清单仅做版本/哈希快照和隔离验证，**没有自动启用整套个人配置**。
- `PI_CODING_AGENT_DIR` 默认仍是 `~/.pi/agent`，为保持兼容没有修改。试用新宿主时应显式指定一个独立目录，再逐个配置插件；不要直接复制凭据、旧会话或自动补丁。
- 初始化成功不代表插件功能全部适配。原生问答、任务卡片、远程评审和上下文视图属于后续阶段。

完整实现、逐插件测试边界、可复现命令及签名 APK 记录见 [P0/P1 交付记录](docs/PLUGIN_HOST_P1.md)。

## Android 构建

```bash
# 一次性：生成 Android 图标资源占位（不放桌面 runtime 进 APK）
npm run prepare:tauri-mobile-resources

# 开发（连接本机 8787 的 server；需先另开 npm run dev:server:pi）
npm run tauri:android:dev

# 打包 APK（arm64）
npm run tauri:android:build -- --apk --target aarch64
```

- `gen/android` 已提交进仓库（含自定义 `MainActivity.kt` 与沉浸式主题），**不要重新 `tauri android init`**，否则会覆盖自定义文件。
- 构建产物在 `packages/app/src-tauri/gen/android/app/build/outputs/apk/`。
- 发布签名走 CI（`.github/workflows/android-release.yml`），需配置 `ANDROID_KEYSTORE_BASE64` / `ANDROID_KEYSTORE_PASSWORD` / `ANDROID_KEY_ALIAS` 三个 secret。
- 本机需安装 Android SDK（`ANDROID_HOME` 指向 SDK 根目录，NDK 装在 `$ANDROID_HOME/ndk/` 下即可被 tauri CLI 找到，CI 固定用 `29.0.14206865`，本机 r28 亦验证可构建）。

## 架构概览

PiUI 将 session 浏览和 agent 执行分开：

```text
session.preview
  -> Pi SDK SessionManager.open()
  -> 读取 session header/branch/entries
  -> 不创建 Agent runtime

发送消息或执行命令
  -> sessionId
  -> server ensureAttached(sessionId)
  -> AgentSessionRuntime
  -> Pi SDK prompt/steer/followUp
```

因此切换历史 session 不需要启动新的 Pi runtime。只有真正执行消息、工具或扩展命令时，server 才会为对应 session 准备 runtime。

## 开发和验证

```bash
npm run typecheck
npm test
npm run build
```

真实双后端 + Chromium 移动视口冒烟（使用 mock worker，不调用 LLM，也不读取个人 Pi 配置）：

```bash
npm run build
node --import tsx scripts/smoke-android-ui.mjs
```

需要本机 Chromium；可通过 `CHROMIUM_BIN` 指定路径。测试结束会关闭其启动的服务、worker 和浏览器，截图路径打印在输出中。

只运行 app 测试（低内存环境可附加 `-- --maxWorkers=1`）：

```bash
npm run test:run -w @piui/app
```

只运行 server 测试：

```bash
npm test -w @piui/server
```

安装测试扩展：

```bash
npm run install:test-extension
```

## 相关目录

- `packages/app`：React 客户端（Tauri Android 壳 + Web）
- `packages/server`：HTTP、WebSocket、session host、PTY 和静态托管
- `packages/pi-worker`：Pi SDK worker 和 runtime adapter
- `packages/protocol`：前后端协议与命令定义
- `scripts`：开发、构建和测试辅助脚本
- `docs`：设计和开发文档

## 应用图标

应用图标全部由 `packages/app/assets/app-icons/` 下的 SVG 源驱动（`app-icon.svg` 为桌面/通用主图，`app-icon-android-foreground.svg` / `app-icon-android-background.svg` 为 Android 自适应图标专用）。

设计比例：桌面图标背景铺满画布（圆角 22%），中心标志约占画布 56%；Android 自适应前景单独缩小到约 37% 画布居中，系统遮罩裁剪（可见 66/108）后与桌面观感一致。

修改 SVG 后重新生成图标：

```bash
# 1. 重新生成通用图标全套（写 src-tauri/icons，同时是下一步的输入源）
npm run icons:tauri -w @piui/app

# 2. 重新生成 Android mipmap 全套（tauri 的 Android 输出比例不可控，必须用脚本覆盖）
powershell -File scripts/make-android-icons.ps1
```

`scripts/make-android-icons.ps1` 从 `src-tauri/icons/icon.png` 派生 Android 全套：`ic_launcher.png`（桌面图标原样缩放）、`ic_launcher_round.png`（圆形遮罩）、`ic_launcher_foreground.png`（标志单独 36.7% 画布居中），同时写入构建源 `gen/android/.../res` 和备份目录 `src-tauri/icons/android`。

## 发版流程

本项目采用线性历史：日常开发在 `dev` 分支，稳定/发布在 `main` 分支，`main` 只用于发版。

### 正常发版

```bash
# 1. 确保 dev 已包含要发布的改动
#    需要时先把 dev rebase 到最新的 origin/main
git switch dev
git fetch origin
git rebase origin/main

# 2. 用 fast-forward 把 dev 推进到 main
git switch main
git pull --ff-only origin main
git merge --ff-only dev

# 3. 在 main 上准备发版：升版本号、生成 CHANGELOG
#    默认会跑 npm run validate；--skip-validate 可跳过完整验证
node packages/app/scripts/prepare-release.mjs 0.x.x [--skip-validate]

# 4. 提交、打 tag、推送
git add -A
git commit -m "chore: release 0.x.x"
git tag v0.x.x
git push origin main
git push origin v0.x.x

# 5. GitHub Actions 自动构建并发布 Android APK

# 6. 把 main 同步回 dev
git switch dev
git merge --ff-only main
git push origin dev
```

发版脚本要求：

- 工作区必须是干净的。
- 目标版本 tag（如 `v0.6.6`）不能已存在于本地或远程。
- 普通开发不要制造 `Merge branch 'dev' into main` 这类噪音提交；只有在确实需要保留上游 PR 拓扑时才使用真正的 merge commit。

### 升级 Pi SDK

当前发布基线固定为 `1.0.3`。升级前先用 `scripts/probe-pi-sdk.mjs` 对指定候选安装运行隔离契约测试，不直接追随全局 Pi 或 npm latest。

同步脚本会更新依赖声明、`PI_PARITY_SDK_VERSION`、`BUNDLED_PI_SDK_VERSION`、测试断言和文档草稿；修改完成不等于验证通过。请显式指定候选版本，检查整个 SDK 家族均为精确版本，并审阅文档中的能力声明：

```bash
node scripts/update-pi-sdk.mjs <candidate-version>

# 不重新 npm install（依赖已正确安装时使用）
node scripts/update-pi-sdk.mjs <candidate-version> --no-install
```

然后运行 SDK 一致性校验：

```bash
npm run conformance:sdk          # 全量验证
npm run conformance:sdk:check    # 只检查版本一致性
```

## 许可证

UI 基线为 GPL-3.0。协议、server 和其他包的许可证以对应目录声明为准。
