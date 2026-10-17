# UI 同步规则（OCUI ↔ PiUI）

适用范围：`packages/app` 下所有面向用户的界面（面板、卡片、对话框、设置页、侧栏）。本规则用于回答一个具体问题：**这个 UI 该照 OpenCodeUI 抄，还是自己写？**

## 规则

> **OCUI 有的就同步；OCUI 没有的，按 PiUI 原风格写。**

「有」指 OCUI 存在**等价界面**，而不是存在同名文件。

## 判定流程

按顺序判，命中即停：

1. OCUI 有等价 UI **且** Pi 侧有对应数据来源
   → **同步 OCUI 设计**：布局、交互结构、展开/折叠语义、视觉层次按 OCUI 来；数据接入换成 Pi 的原生通道。
   → 不是把 OpenCode 的模块搬回来。同 `docs/OCUI_ANDROID_SYNC.md` 的立场：*Changes are adapted by behavior, not copied over the Pi-native implementation.*

2. OCUI 有 UI 但 Pi 侧无对应概念（OpenCode 独有）
   → **不移植**。按 `PiUI-OCUI-0.7-port-plan.md` 的 D 档排除，不在 PiUI 里造一个没有数据源的壳。

3. OCUI 没有对应 UI
   → **PiUI 原风格自研**，遵守下面的「原风格契约」。

判不准时按 3 处理，并在提交信息里写明「OCUI 无对应界面」。

## 参考源

| 用途 | 位置 |
|---|---|
| OCUI 上游源码 | `/home/zhangtung/项目/opencodeui-upstream/`（对应版本见 `PiUI-OCUI-0.7-port-plan.md` 头部） |
| 三方差异判定 | `/home/zhangtung/项目/ocui-3way.sh`、`ocui-scan.sh` |
| 移植计划与分档 | `/home/zhangtung/项目/PiUI-OCUI-0.7-port-plan.md`（A/B/C/D 档 + 9 个批次） |
| 上一次同步的决策记录 | `docs/OCUI_ANDROID_SYNC.md`（含 Coverage decisions 表） |

移植计划里的分类标签含义：`PURE-UI` = 纯界面可直接同步；`DEP-API` = 依赖后端接口，需先落 API；`TRANSPORT` = 传输层，只取不碰；A 档干净直接取、B 档低接线、C 档中接线、D 档明确不取。

## 明确排除（判据 2 的既有实例）

来自 `docs/OCUI_ANDROID_SYNC.md` 的 Coverage decisions，已判定不移植，不要因为「OCUI 有」就复活：

- OpenCode 的 config editor（`configEditor*.tsx` 一整套）—— Pi 没有 OpenCode 的 config 文件；PiUI 用 `PiManagementSettings` / `PiResourceManagement` / `PiProviderManagement` 等自有页面替代。
- `PermissionDialog` / `usePermissionHandler` —— Pi 走 extension UI + keyed pending actions。
- WSL 管理（`wslStore.ts`、`features/wsl/`）。
- Docker / 桌面运行时 / OpenCode SDK transport。
- OpenCode 更新通道（`updateStore` 的 OpenCode 语义）—— PiUI 保留自己的更新行为。
- OpenCode 的 message-part 模型、`messageStore` / `todoStore` / `childSessionStore` / `autoApproveStore` / `followupQueueStore` —— 已被 Pi 原生 store 取代。

## 原风格契约（判据 3）

判据 3 场合，遵守下列既有约定，不要引入新的视觉语言：

- **颜色 / 圆角 / 字号**：只用 `packages/app/src/index.css` 的 token。颜色 `--color-bg-*` / `--color-text-*` / `--color-accent-*`；圆角 `--radius-xs..2xl`；字号 `text-[length:var(--fs-xxs|xs|sm|md|base|lg|code)]`。禁止硬编码 hex 和 px 字号。
- **结构原语**：`components/ContentBlock.tsx`（可折叠内容块）、`components/ui/` 下的通用件、`features/settings/components/SettingsSection` / `SettingsDisclosure`（设置页）。优先复用 `MessageExpandPanel` / `useMessageExpandRender` / `useUiDisclosureState` 这一套展开语义。
- **工具卡片**：新增工具渲染器必须走 `packages/app/src/features/message/tools/registry.tsx` 注册（`match` + `icon` + 可选 `extractData` / `renderer`），实现 `ToolRendererProps`；不要绕开 registry 在 `ToolPartView` 里加特例分支。
- **文案**：一律走 i18n，命名空间为 `locales/{en,zh-CN}/{chat,commands,common,components,message,settings}.json`。不写硬编码中文/英文。
- **动画**：克制，只用于状态变化（展开、加载、完成）。不加装饰性动效。
- **无障碍/触屏**：按触屏设计，可点区域足够大；折叠态要能承载关键状态。

## 测试要求

同步或自研的界面，都要有对应断言。反面教材：`packages/app/src/features/message/tools/renderers/TaskRenderer.test.tsx` 现有 5 条断言全是「跳转按钮 / agent 徽章 / 无子会话时隐藏按钮」，**没有一条覆盖子会话内容渲染**——所以 `SubSessionView` 长期是占位符也没被发现。

## 记录要求

改动提交信息里写清走了哪条判据：

```
feat(app): port OCUI task card child-session stream   [判据1: OCUI 有等价 UI, 数据源换 Pi child session]
feat(app): extension widget mirror panel              [判据3: OCUI 无对应界面, 原风格自研]
```

## 已判定的条目

| 界面 | 判据 | 结论 |
|---|---|---|
| subagent（`Agent` / `StopAgent` / `MessageAgent` / `AgentStatus` 卡片） | 1 | 同步 OCUI `TaskRenderer` 的子会话流 + 停止；数据源换成 Pi `subagents:child:*` 事件 + 子会话消息 RPC |
| `rpiv-todo` 任务卡片 | 1 | 已同步（`TodoRenderer.tsx`），缺原生交互 |
| `rpiv-ask-user-question` | 1 | 已同步（`QuestionRenderer.tsx`），缺原生复选框/多题回顾 |
| extension widget 镜像 | 3 | 原风格（`41e2d011` 的快照镜像路径） |
| Pi packages / trust / provider / resources 管理页 | 3 | 原风格自研 |
| OpenCode config editor / WSL / PermissionDialog | 2 | 不移植 |
