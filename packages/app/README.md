# @piui/app

PiUI 客户端：React 19 + Vite 前端，通过 Tauri 打包成 Android APK（同一份代码也可在浏览器里跑，用于开发和冒烟测试）。

完整的产品说明、服务端部署和发版流程见仓库根 [`README.md`](../../README.md)；本文件只覆盖这个包自身的开发边界。

## 职责

- 渲染 Pi 原生数据：session 列表、native entries/branch/tree、原始 Pi 事件、扩展 UI 对话框
- 维护前端状态：`src/pi/`（event stream、transport、store、selectors）与 `src/store/`（布局、主题、服务器、快捷键等本地 UI 状态）
- **不包含 agent runtime**：不发消息给模型、不读写 Pi session 文件。所有执行都发生在远端 `@piui/server` + `@piui/pi-worker`

## 与协议的关系

命令和事件的形状来自 `@piui/protocol`，不在本包内重新定义类型。新增能力时先改 `packages/protocol`，再在本包消费。

## 命令

```bash
npm run dev           # vite dev server（需要另开 npm run dev:server:pi）
npm run typecheck     # tsc -b（tsconfig.app.json + tsconfig.node.json，extends 根 tsconfig.base.json）
npm run lint          # eslint
npm run format        # prettier --write
NODE_ENV=test npm run test:run   # vitest run（jsdom）；npm test（仓库根）会自动设好 NODE_ENV
npm run test:pi       # 只跑 src/pi
npm run build         # tsc -b && vite build
npm run validate      # typecheck + lint + test:run + build
```

Android：

```bash
npm run tauri:android:dev     # 连本机 8787 的 server
npm run tauri:android:build -- --apk --target aarch64
```

`src-tauri/gen/android` 已提交进仓库（含自定义 `MainActivity.kt` 与沉浸式主题），**不要重新 `tauri android init`**。

## 目录

| 路径                                   | 内容                                                               |
| -------------------------------------- | ------------------------------------------------------------------ |
| `src/pi/`                              | Pi 事件流、HTTP/WS transport、跨服务器 scoped 状态、领域 selectors |
| `src/store/`                           | 本地 UI 状态（布局、主题、服务器列表、快捷键、通知、置顶）         |
| `src/features/pi-chat/`                | Pi 原生会话主界面（`PiChatPane`）                                  |
| `src/features/chat/`                   | 上游 OpenCodeUI 的聊天外壳（侧栏、分屏、输入框等），见下方说明     |
| `src/components/`                      | 通用组件（Markdown、Diff、终端、文件树等）                         |
| `src/hooks/`、`src/utils/`、`src/lib/` | 复用逻辑                                                           |
| `src-tauri/`                           | Tauri 壳（Rust）、图标、Android 工程                               |

### 关于 `src/features/chat`（遗留外壳）

它是 fork OpenCodeUI 时保留的视觉壳，与 `src/features/pi-chat` 在 `src/App.tsx` 中同时挂载：外壳负责布局/侧栏/输入框，`PiChatPane` 负责 Pi 会话内容。两者边界尚未成文，改动前请先确认代码路径属于哪一侧，避免在错误的一侧修 bug。

## 冻结的上游文件

以下两个文件保留 fork 时的上游内容，不再维护，仅作历史参考：

- `README.opencodeui.md`（上游 OpenCodeUI 说明，其中的 OpenCode 后端与桌面/容器部署在 PiUI 里不存在）
- `CHANGELOG.opencodeui.md`（上游版本历史，编号体系与 PiUI 无关；PiUI 发版只写根 `CHANGELOG.md`）

## 许可证

UI 基线来自 GPL-3.0-only 的 OpenCodeUI，见 `LICENSE`。
