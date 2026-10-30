# 前端重写第一轮 H：旧版行为基线与契约测试

- 分支：`rewrite/round1-contracts`，基线提交 `48344fd3`（`docs: record frontend compatibility rewrite plan`）。
- 工作区：`/tmp/piui-round1-contracts`（隔离 worktree，`node_modules` 为指向主仓的 symlink，未改依赖）。
- 本文件只记录**实际运行过**的命令与结果。未运行或未通过的项目列在「未验证」里，不写成通过。

## 1. 写入范围

| 文件                                                | 类型                                                               |
| --------------------------------------------------- | ------------------------------------------------------------------ |
| `packages/app/src/hooks/useBackClose.test.tsx`      | 新增（10 条契约测试）                                              |
| `packages/app/src/hooks/useViewportHeight.test.tsx` | 既有文件，新增 5 条 Tauri 分支测试（原 2 条 browser 测试保留未改） |

没有改动生产代码、其他测试、`src/test/setup.ts`、vitest/eslint/ts 配置、行数基线或依赖。

## 2. 属于 `48344fd3` 基线的结果

### 2.1 app 单测（全量，`--maxWorkers=1`）

命令（在 `packages/app` 下）：

```sh
NODE_ENV=test npx vitest run --maxWorkers=1
```

结果：**152 个测试文件、930 条测试全部通过**。

推导方式（两条独立运行互相印证，避免把新增测试算进基线）：

```sh
# 含本轮新增测试：153 files / 945 tests passed
NODE_ENV=test npx vitest run --maxWorkers=1

# 排除本轮两个文件：151 files / 928 tests passed
NODE_ENV=test npx vitest run --maxWorkers=1 \
  --exclude '**/node_modules/**' \
  --exclude src/hooks/useBackClose.test.tsx \
  --exclude src/hooks/useViewportHeight.test.tsx
```

`151 + 1（useViewportHeight.test.tsx，被整文件排除）= 152`；`928 + 2（该文件原有 2 条）= 930`。
两次运行均 0 failed、0 skipped。

日志：

- 含新增测试：`/home/zhangtung/.cache/piui-round1-h/baseline-app-full.log`（Duration 382.42s）
- 排除新增测试：`/home/zhangtung/.cache/piui-round1-h/baseline-app-preexisting.log`

环境备注：日志必须写 home 缓存目录并设 `TMPDIR=/home/zhangtung/.cache/piui-round1-h` —— `/tmp` 是 3.9G tmpfs，本轮期间已用 80%，写入测试产物会触发配额错误（主代理侧同样遇到 errno -122）。首次尝试把日志写 `/tmp` 时进程被杀、只剩文件头，故重跑；上表数字来自重跑。

### 2.2 其余三包（主代理提供，未重复运行）

`NODE_ENV=test PIUI_DRIVER=mock npm run test -w @piui/protocol -w @piui/pi-worker -w @piui/server`：
protocol 15/15、pi-worker 107/107、server 143 passed + 2 skipped（共 145）、0 failed。
日志 `/home/zhangtung/.cache/piui-round1-baseline-6XnUQh/node-tests.log`。

### 2.3 工程门禁（主代理提供，`npm run validate`，日志 `/tmp/piui-round1-baseline-validate.log`）

| 项目                                  | 结果                                                                                                                         |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `check:docs`                          | 通过（SDK baseline 1.4.0、app 0.6.21 覆盖 5 个 manifest + CHANGELOG）                                                        |
| `conformance:sdk:check`               | 通过（1.4.0 对齐）                                                                                                           |
| `check:size`                          | **失败，15 项**（见下）                                                                                                      |
| `format:check`                        | **失败 3 个既有文件**：`AGENTS.md`、`docs/UI_SYNC_POLICY.md`、`packages/app/src/store/sessionChildrenExpansionStore.test.ts` |
| `typecheck`                           | 通过（`tsc -b`，四包）                                                                                                       |
| `lint`                                | 退出 0，**31 warnings / 0 errors**（`/tmp/piui-round1-baseline-lint.log`，31 problems 行）                                   |
| `build`                               | 通过，7.96s（有 chunk > 500k 警告）                                                                                          |
| `smoke:timeline` / `smoke:android-ui` | 默认环境下失败（`Runtime.evaluate timeout` / `Page.navigate timeout`）；按环境参数重跑后**两条均通过**，见 §2.4              |

`check:size` 15 项明细（均为 `48344fd3` 已存在，不是本轮引入）：

```
packages/app/src/components/FileExplorer.tsx: 2159 行（基线 2064，超 95）
packages/app/src/features/chat/InputBox.tsx: 1957 行（基线 1939，超 18）
packages/pi-worker/src/runtime/real-session.integration.test.ts: 1707 行（基线 1626，超 81）
packages/app/src/components/MarkdownRenderer.tsx: 1664 行（基线 1621，超 43）
packages/app/src/components/MarkdownRenderer.test.tsx: 1571 行（基线 1522，超 49）
packages/pi-worker/src/runtime/real-session.ts: 1510 行（基线 1379，超 131）
packages/app/src/features/chat/sidebar/SidePanel.tsx: 1392 行（基线 1384，超 8）
packages/app/src/features/chat/ChatArea.tsx: 1342 行（基线 1309，超 33）
packages/app/src/features/chat/ChatArea.test.ts: 1278 行（基线 1214，超 64）
packages/app/src/store/themeStore.ts: 1177 行（基线 1156，超 21）
packages/app/src/App.tsx: 1114 行（基线 1074，超 40）
packages/pi-worker/src/runtime/mock-session.ts: 1093 行（基线 1078，超 15）
packages/app/src/features/sessions/SessionList.tsx: 1068 行（超 1000 上限且未登记）
packages/app/src/features/chat/chatPageModel.ts: 1039 行（基线 1036，超 3）
packages/app/src/features/chat/sidebar/FolderRecentList.tsx: 已降到 1273（基线 1300，需下调登记）
```

本轮新增文件 `useBackClose.test.tsx` 292 行、`useViewportHeight.test.tsx` 200 行，均低于 1000 行上限，未触碰基线文件。

### 2.4 浏览器 / 界面冒烟

默认环境（无额外参数）下两条 smoke 均超时；同一次探测排除了 PiUI 自身：Chromium 156 的 `data:` 导航成功，但最小本地 HTTP 页仍 `Page.navigate` 超时，服务端请求计数为 0，`--no-proxy-server` 重试同样失败。说明是当前 CDP / HTTP 环境阻塞，不据此判 UI 回归失败或通过。

按下列参数重跑后两条 smoke 通过（不改源码）：

```sh
CHROMIUM_EXTRA_ARGS='--password-store=basic --use-mock-keychain --disable-background-networking' \
  node --import tsx scripts/smoke-timeline-order.mjs
# android-ui 另需 TMPDIR 指向 home 缓存目录（/tmp 写入 errno -122）
```

日志：`/tmp/piui-round1-baseline-timeline-keychain.log`、`/home/zhangtung/.cache/piui-round1-baseline-6XnUQh/smoke-android-ui.log`（4 张基线截图在同目录）。

## 3. 本轮新增契约测试的结果（不属于基线）

命令：

```sh
cd packages/app
NODE_ENV=test npx vitest run src/hooks/useBackClose.test.tsx src/hooks/useViewportHeight.test.tsx --maxWorkers=1
```

结果：**2 files / 17 tests passed**，连跑 3 次结果一致（无 flake）。
全量运行中含新增测试为 **153 files / 945 tests passed**（= 基线 930 + 新增 15）。

其它检查：

- `npx eslint src/hooks/useBackClose.test.tsx src/hooks/useViewportHeight.test.tsx` → 退出 0，无输出。
- LSP（typescript，按扩展名自动路由，未指定 server）→ 两文件 0 diagnostics。
- 未在隔离 tree 重跑 `tsc -b`：主仓 typecheck 已覆盖 app，且并发写共享 symlink `node_modules/.tmp` 的 tsbuildinfo 会与主代理运行互相打断。因此 app 级 typecheck 证据归属 `48344fd3` 基线 + 主代理运行，新增文件只有 LSP + eslint + vitest transform 的证据。

## 4. 契约定的是什么

### 4.1 `useBackClose`（旧实现先绿的 10 条）

| 契约                                | 断言要点                                                                                                   |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 打开只压入一条 back-close 条目      | `pushState` 恰好 1 次，`history.state.__piuiBackClose === true`；`onClose` 变更导致 effect 重跑后仍为 1 次 |
| 自己的条目被遍历不触发关闭          | 派发 `{__piuiBackClose:true}` 的 popstate，`onClose` 不被调用                                              |
| 用户返回关闭并退回上一状态          | `history.back()` 后 `onClose` 1 次、`history.state === null`                                               |
| 嵌套栈只关顶层并重新挂条目          | 两层时返回只关后压栈的那个；关掉后 `history.state` 重新是 back-close；卸载顶层后第二次返回关底层           |
| programmatic close 不回调 `onClose` | `rerender({open:false})` 后 `onClose` 0 次，且 `history.back()` 1 次（自己回退，不留死条目）               |
| `ignoreNextPopState` 精确吞一次     | 程序化关闭后重开，迟到 popstate 被吞；下一次 popstate 仍能关闭                                             |
| 卸载清理                            | 卸载不调用 `onClose`、`back()` 1 次；卸载后残留 popstate 不回调                                            |
| 快速开关                            | 5 轮 open/close 不额外 `pushState`、不 `back()`、不误关；最终卸载才 `back()` 1 次                          |
| 回调走 ref                          | 替换 `onClose` 后调用新的那个                                                                              |
| 卸载后无 stale 回调                 | 拆卸后两种 popstate 都不回调旧句柄                                                                         |

jsdom 真实性注意（踩坑记录，写测试前必须先验证）：

- `history.back()` 的遍历是异步任务（`SessionHistory.js` 内 `_queueHistoryTraversalTask` → `setTimeout(…, 0)`），popstate 也在 `setTimeout(fireEvents, 0)` 里派发。**不能假设同步**，每次断言前用真实 timer 跑干队列。
- `pushState` 会 `clearHistoryTraversalTasks()`，可取消尚未执行的 `back()` 遍历。
- `history.length` 在同文档遍历时不减少（仍是 2），所以断言用 `history.state` 而不是 `length`。
- 不要用假 timer 直接驱动 `history.back()`：假 timer 会让 traversal 永远不执行。混合场景（清理定时器用假 timer、popstate 手动派发）要分开处理。
- 隔离：hook 状态是模块级单例（`stack`、`historyEntryActive`、`ignoreNextPopState`）。仅 unmount + `replaceState(null)` 不够 —— 一次被 `pushState` 取消的遍历会让 `ignoreNextPopState` 保持 armed，泄漏到下一个测试并吞掉它第一次 popstate。`resetBackCloseState()` 在 `beforeEach`/`afterEach` 各做一次「全部 unmount → 跑干任务 → `replaceState(null)` → 派发一次非 back-close 的 popstate → 再 `replaceState(null)`」（此时栈为空，`closeTopEntry` 是空操作）。

### 4.2 `useViewportHeight` Tauri 分支（新增 5 条）

契约来源：`packages/app/src-tauri/gen/android/app/src/main/java/com/piui/app/MainActivity.kt`

- 原生 `setPadding(systemInsets.left, 0, systemInsets.right, max(imeInsets.bottom, systemInsets.bottom))` —— 底部（含键盘）由原生 padding 处理，WebView 物理 resize。
- 原生注入 `--safe-area-inset-top` 为真实值，`--safe-area-inset-bottom/left/right` 全部注入 `'0px'`。

| 契约                      | 断言                                                                                                                                                 |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 只写 `--app-height`       | `innerHeight` 915px → `--app-height: 915px`；`--keyboard-inset-bottom`、`--safe-area-inset-bottom` 均未被写；不插入浏览器分支的 safe-area probe 元素 |
| 跟 window resize          | 改 `innerHeight` 派发 `resize` → `--app-height: 560px`（因为原生会 resize WebView）                                                                  |
| 不推导键盘 inset          | visualViewport 少 300px（远超 100px 阈值）、派发它的 `resize`/`scroll` + `focusin` + 跑干定时器，`--keyboard-inset-bottom` 仍为空                    |
| 卸载移除 resize 监听      | unmount 后改 `innerHeight` 派发 `resize`，`--app-height` 保持旧值                                                                                    |
| resize 后仍不走浏览器路径 | 同时派发 window `resize` 与 visualViewport `resize`，仍无 `--keyboard-inset-bottom`                                                                  |

配合 `packages/app/src/index.css`：`#root { height: var(--app-height) }`，`padding-bottom: var(--keyboard-inset-bottom)` 只作用于 `:root:not(.tauri-app)`，`.tauri-app #root { padding: … 0 }`。即 Tauri 下「原生底部 padding + 网页 safe-area 0」不叠加，测试锁定的是这个不变量。

原 2 条 browser 测试（blur 后清 stale inset、焦点在输入框间移动保留 inset）未修改，仍通过。

## 5. 发现的旧实现问题（未修，仅报告）

1. **`ignoreNextPopState` 可能吞掉用户的一次真实返回（需要按两次返回）。**
   机制：`scheduleHistoryEntryCleanup` 在 `setTimeout(…,0)` 里置 `ignoreNextPopState = true` 后调用 `history.back()`。若在这次遍历完成前又有叠加层打开并 `pushState`，jsdom 的 `pushState` 会 `clearHistoryTraversalTasks()` 取消掉遍历（浏览器里同为待处理导航被后续 push 覆盖），于是合成 popstate 永不到达，`ignoreNextPopState` 一直 armed。用户下一次真实返回会被当成「迟到的合成事件」吞掉，必须再按一次才关闭。
   复现：`useBackClose.test.tsx` 的 “swallows exactly one late popstate after a programmatic close” 就是这条路径（测试断言的正是当前行为，即旧契约；换实现时该用例会暴露差异）。
2. 相关但不单独成 bug 的既有语义：`closeTopEntry` 里 `setTimeout(0)` 重新挂条目，与清理定时器同为 0ms 任务，先后顺序依赖任务队列而非显式状态；快速开关时靠 `clearCleanupTimer()` 抵消。

两条都属生产代码，本轮按要求未改动，交由主代理判断是否进第一轮修复清单。

## 6. 未验证 / 不宣称

- **真机性能未测**：没有在 Redmi Note 10 Pro 上安装、启动或操作应用，无 FPS / 掉帧 / 首屏数据。不称「真机通过」。
- **Android IME、软键盘 inset、安全区在真机上的实际表现未验证**：viewport 契约只在 jsdom 中断言了「Web 侧不叠加底部 padding」，原生 `setPadding` 行为由读 `MainActivity.kt` 确认，未经设备运行验证。
- 系统返回键的真实硬件行为未在设备上验证（单测用 `history.back()` / 合成 popstate 模拟）。
- 默认环境（不带 `CHROMIUM_EXTRA_ARGS`）下两条 smoke 仍会超时；通过结果依赖 §2.4 的环境参数。
- 未重测覆盖率，未使用历史覆盖率数字。本轮 vitest 配置里的全局阈值（statements 43 / branches 35 / functions 40 / lines 45）未在本次运行中启用（未加 `--coverage`）。
- 未运行 `npm install`、全仓 `prettier --write`、`check-file-size --update`。
- `check:size` 15 项失败与 `format:check` 3 个既有文件失败在基线上就存在，本轮未修复也未绕过。

## 7. 复现命令汇总

```sh
# 基线段（不含本轮新增文件）
cd packages/app
NODE_ENV=test TMPDIR=/home/zhangtung/.cache/piui-round1-h \
  npx vitest run --maxWorkers=1 \
  --exclude '**/node_modules/**' \
  --exclude src/hooks/useBackClose.test.tsx \
  --exclude src/hooks/useViewportHeight.test.tsx

# 本轮新增契约
cd packages/app
NODE_ENV=test npx vitest run \
  src/hooks/useBackClose.test.tsx src/hooks/useViewportHeight.test.tsx --maxWorkers=1

# 新增文件静态检查
cd packages/app
npx eslint src/hooks/useBackClose.test.tsx src/hooks/useViewportHeight.test.tsx
```
