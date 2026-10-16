# PiUI app 分层与边界

`packages/app` 的代码按「谁懂 Pi 语义」「谁被谁复用」分层。这份文档说明每层放什么、
新代码该进哪一层、哪些依赖方向被门禁挡住，以及当前的已知缺口。

## 分层

```text
App.tsx                     挂载与布局：pane 树、路由、跨 pane 协调、设置/侧栏开关
  │  props（唯一挂载点）
  ▼
features/pi-chat            容器层：把 pane/session 绑到 Pi runtime
  │  props + src/pi 的 store/hook
  ▼
features/chat               渲染层：聊天面（消息流、输入框、侧栏、头部、视口机制）
features/message            消息与工具卡渲染（被 features/chat 与 components 共同复用）
components/*                跨面通用组件（面板、弹窗、Diff、Markdown、文件树…）
  │  读状态 / 发命令
  ▼
src/pi/**                   Pi 状态层：eventStream、selectors、store、hooks、transport、domain
```

依赖方向单向向下；`src/pi/**` 是状态与命令的唯一出口，UI 层不直接 speak 协议。

## 两层分别是什么

|          | `features/pi-chat`                                                                                                       | `features/chat`                                                                                                                                                     |
| -------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 规模     | 3 文件 / 1906 行（`PiChatPane.tsx` 1800）                                                                                | 43 文件 / 14.4k 行                                                                                                                                                  |
| 角色     | 容器：一个 pane 的完整生命周期                                                                                           | 渲染层：聊天面的可复用组件                                                                                                                                          |
| 挂载点   | 仅 `src/App.tsx:512`（`renderPaneLeaf`）                                                                                 | 被 `pi-chat` 与 App 复用                                                                                                                                            |
| 典型内容 | 打开/关闭 runtime、订阅事件流、`prompt`/`steer`/`followUp`/`fork`/redo、拖拽落点、草稿、大纲、扩展 UI 应答、项目信任提示 | `ChatArea`、`InputBox`、`Sidebar`、`Header`、`PaneHeader`、`PaneDropOverlay`、`chatViewport`、`SplitContainer`、`chatPageModel`、`EmptyState`、`ExtensionUiDialog*` |
| 公开面   | `PiChatPane`、`ProjectTrustPrompt`、`attachmentToImage`                                                                  | `features/chat/index.ts` 的五个导出 + 若干深路径（`PaneHeader.js`、`chatViewport.js`…）                                                                             |

`features/pi-chat/PiChatPane.tsx:5-13` 从这里引入视图件：

```ts
import { ChatArea, Header, InputBox, type ChatAreaHandle, type InputBoxHandle } from '../chat/index.js'
import { PaneHeader } from '../chat/PaneHeader.js'
import { PaneDropOverlay, resolveDropZone, type DropZone, type PaneDropOverlayHandle } from '../chat/PaneDropOverlay.js'
import { ChatViewportProvider, useChatViewportMaybe, type ChatViewportValue } from '../chat/chatViewport.js'
import { ExtensionUiDialogHost } from '../chat/ExtensionUiDialogHost.js'
```

需要注意的是：`features/chat` **不是纯展示组件库**。它有 17 个文件直接读 `src/pi/**`
（`Header.tsx`/`PaneHeader.tsx` 调 `renamePiSession`、`loadPiSessions`、`usePiCapabilities`；
`ExtensionUiDialogCard.tsx` 调 `respondPiExtensionUi`；`input/InputFooter.tsx` 用 `usePiSessionTodos`；
`sidebar/*` 用 `usePiBranchData`、`useFocusedSessionId`），另有 `ChatArea.tsx:27-28`、
`RetryStatusInline.tsx:5` 复用 `features/message` 的消息与工具卡渲染。它渲染 `PiTimelineItem`
这类 Pi domain 类型（`chatPageModel.ts:2`、`chatAreaVisibility.ts:1`）。所以准确的定位是
**UI 层**：可以读 Pi 状态、渲染 Pi 类型，但不负责会话生命周期与命令编排。

## 依赖方向（有门禁）

`packages/app/eslint.config.js` 用 `no-restricted-imports` 固定两条：

1. `src/features/chat/**` 不得 import `features/pi-chat/**` —— 渲染层不能反向依赖容器层，否则两层绕成环。
2. `src/**`（`App.tsx` 与 `features/pi-chat/**` 自己除外）不得 import `features/pi-chat/**` ——
   `PiChatPane` 只能由 `App.tsx` 挂载。

允许的方向：

| 从                 | 到                                                                       | 状态                                     |
| ------------------ | ------------------------------------------------------------------------ | ---------------------------------------- |
| `features/pi-chat` | `features/chat`、`features/message`、`components`、`src/pi`、`src/store` | 允许（当前 `PiChatPane.tsx` 正是这么用） |
| `features/chat`    | `src/pi/**`、`src/store/**`、`src/components`、`features/message`        | 允许（当前分别有 17 处 / 12 处）         |
| `features/chat`    | `features/pi-chat`                                                       | **禁止**（ESLint 报错）                  |
| 任意其他位置       | `features/pi-chat`                                                       | **禁止**，仅 `App.tsx`                   |

## 新代码放哪

| 你要写的东西                                 | 放这里                                                                                         |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 新的消息/工具卡渲染                          | `features/message/**`（`parts/`、`tools/renderers/`）                                          |
| 聊天面新部件（面板、头部、输入框部件、侧栏） | `features/chat/**`；会被别的 pane/页面复用的放 `src/components/**`                             |
| 新的 Pi 会话行为（命令、事件派生、状态机）   | `src/pi/**`：`store/`（状态）、`hooks/`（订阅）、`controllers/`（命令）、`selectors/`（派生）  |
| 只在单个 pane 内成立的编排逻辑               | `features/pi-chat/**`（目前都在 `PiChatPane.tsx`，新逻辑优先抽 hook 而不是继续堆在这个文件里） |
| 需要 pane 布局、路由、跨 pane 协调的逻辑     | `App.tsx`（并且只在这里挂 `PiChatPane`）                                                       |

判据很简单：**这段代码会不会被第二个 pane 复用？会不会发命令或订阅事件？** 会 → 放下面一层；
不会 → 放当前容器。命令与事件永远只经 `src/pi/**`。

## 单文件行数上限

`scripts/check-file-size.mjs`（`npm run check:size`，已进 `validate`）：`packages/*/src`
下的 `.ts/.tsx` 上限 1000 行，超过且不在 `scripts/file-size-baseline.json` 里的直接失败。
基线里的文件「只许变小」，涨一行即失败；拆到 1000 行以下要把基线条目删掉（脚本会提示）。
临时需要放大的用 `npm run check:size -- --update`，数字变化会出现在 diff 里。

当前基线 19 个文件，最大的几个：

```
1943  packages/app/src/components/FileExplorer.tsx
1893  packages/app/src/features/chat/InputBox.tsx
1886  packages/app/src/components/DiffViewer.tsx
1800  packages/app/src/features/pi-chat/PiChatPane.tsx
1557  packages/app/src/components/MarkdownRenderer.tsx
1510  packages/app/src/components/MarkdownRenderer.test.tsx
1452  packages/pi-worker/src/runtime/real-session.integration.test.ts
1379  packages/app/src/components/SessionChangesPanel.tsx
1374  packages/app/src/features/chat/sidebar/SidePanel.tsx
1311  packages/app/src/features/chat/sidebar/FolderRecentList.tsx
1274  packages/app/src/store/layoutStore.ts
1242  packages/app/src/features/chat/ChatArea.tsx
```

拆分优先级（按「测试覆盖够不够兜住」排，不是按行数）：

1. `components/DiffViewer.tsx` —— 前 300 行是纯函数（`collapseContextPaired`、`expandRegion`、
   `estimateWrappedVisualLineCount`），可直接抽成 `diffModel.ts` 并补单测。
2. `components/FileExplorer.tsx` —— 内部已是 `FileExplorer`(145-686) / `TextSearchResults`(698-847) /
   `FileTreeItem`(857-969) / `FilePreview`(990-1434) / `MediaPreview`(1442) / `ImagePreview`(1478)
   的独立组件，按同样边界拆文件即可。
3. `features/pi-chat/PiChatPane.tsx` —— 单组件 208-1800 行，**测试覆盖 0%**。拆之前先补测试，
   否则任何重排都是盲改。
4. `features/chat/InputBox.tsx`、`components/MarkdownRenderer.tsx` —— 后者已有 1510 行测试，
   相对安全；前者 60% 覆盖。

## 已知缺口

- **测试覆盖**（2026-10 实测，app 全局 statements 44.6 / branches 37.3 / functions 41.7 / lines 46.7）：
  `PiChatPane.tsx` 0%、`ChatArea.tsx` 4.3%、`Sidebar.tsx`/`Header.tsx`/`PaneHeader.tsx`/`EmptyState.tsx` 0%、
  `chatViewport.tsx` 24.4%。`features/pi-chat` 目录整体 3.9%，`features/chat` 44.8%，`src/pi` 58.5%。
  门槛只挡倒退（43/35/40/45），不挡「新写的容器逻辑没测试」。
- **没有 error boundary**：删除零引用文件时发现 `components/ErrorBoundary.tsx` 从未被挂载过
  （`main.tsx` 里没有用它），已作为死代码删除。也就是说渲染期异常目前没有任何兜底，
  需要时应该重新实现一个真的挂上去。
- **死代码已清理 5 个文件**（2026-10）：`components/ErrorBoundary.tsx`（66 行）、
  `features/chat/virtual/messageGesture.ts`（34）、`hooks/useCancelHint.ts`（50）、
  `hooks/usePanelResizeStatus.ts`（21）、`utils/localServiceUrl.ts`（8）。判据是全仓零引用。
- **`features/chat` 的公开面不成体系**：`index.ts` 只导出五个组件，而 `pi-chat` 走深路径
  （`../chat/PaneHeader.js`、`../chat/chatViewport.js`）——深路径导入让「渲染层公开面」无法收敛，
  新增导出时优先补进 `index.ts`。

相关文档：`DEVELOPMENT.md`（包职责与门禁）、`docs/PI_SDK_API_MATRIX.md`（协议/SDK 边界）。
