# 第二轮重写 · H 独立验证记录

基线 `940844c5`（`docs: close rewrite gates and start second batch`），验证 worktree 分支 `rewrite/round2-qa`。
本文只记录 H 侧独立验证：不改生产代码，只新增测试与冻结参考实现，并对 C / D 交付做只读复核。
C / D / E 的实现结论与最终 speedup 由主代理终稿记录，本文不替代。

## 1. 结论摘要

| 项                     | 结论                                                                                                                                                  | 证据层级                           |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| C：时间线聚合重构      | 与 `940844c5` 旧实现行为等价（16 条手写语料 + 200 条定种随机 + 60 条复用随机，全等价）                                                                | 模型（纯函数输入/输出）            |
| 时间线测试自身         | 变异验证有牙齿：4 类语义改错各被 1–3 例捕获；1 类属语义等价变异，已排除                                                                               | 模型                               |
| 命令面板抽取           | 22 条命令顺序 / 条件项 / when / 一次性 thunk 求值 / focused pane 取最新 controller 均保持                                                             | DOM（jsdom + spy，无真实服务）     |
| D：一次性高亮 key 释放 | 工作树版本恢复「消费时点判 latest」语义；提交 `6032321d` 确实存在该时序差（已实证复现）。调用方影响：仅静态审查，未找到可见回归路径，**不是排除证明** | mockWorker（假 Worker + Map 探针） |
| D：CodeBlock 窄订阅    | 只订阅 `codeWordWrap`；无关主题字段变化不再重渲染；换行与语法主题仍生效                                                                               | DOM（jsdom + 真实 hook）           |
| E                      | 未审查（工作树 `/home/zhangtung/.cache/piui-round2-1eUv5J/round2-composer`，尚未交付；不审活动中的工作树，等主代理通知续派）                          | —                                  |

**未测**（本文不主张）：浏览器稳定帧、真机 / WebView 掉帧、帧率、主线程交互 P95、堆内存实测，
以及 D 时序窗口的浏览器侧复现（5.2 仅为读代码 + 任务顺序推理）。
D 的 key 释放只证明「客户端 Map 里不再留 key」，不等于堆大小下降；C 的访问次数下降不等于端到端帧率提升。

## 2. 证据分层说明

- **模型层**：`buildProcessTimeline` / `reuseProcessTimelineItems` 是纯函数，输入 `PiTimelineItem[]` + 选项，输出行数组。差分比较的是「同一输入下旧实现与新实现的返回值」以及输出对输入对象的引用关系。
- **mockWorker 层**：D 的 17 例客户端测试用假 `Worker`（记录 postMessage、可手动投递响应），被测的 `latestRequestByKey` / `pendingRequests` 是真实 Map。用 `Map.prototype.set` 探针统计残留 key。
- **DOM 层**：命令面板与 CodeBlock 测试跑在 jsdom 里，用 React Testing Library 渲染真实组件、真实 store 通知，只把外部边界（worker 客户端、i18n、`useInputCapabilities`）替换成替身。没有启动真实 Shiki worker，没有连 Pi 服务。
- **浏览器 / 真机**：本轮 H 全部未做。稳定帧与 smoke 由主代理持有。

## 3. 任务一：冻结旧时间线行为

### 3.1 冻结参考

`packages/app/src/test/processTimelineReference.ts`（288 行）是 `940844c5a2d50fc516f218b1bf43ac92259c84bf` 上
`packages/app/src/features/chat/processTimeline.ts` 的逐字拷贝，只把导出名加 `reference` 前缀，并保留三个必要私有
helper（`itemRenderKey` / `assistantHasLiveWork` / `resolveTurnDurationMs`）。文件头写明来源 hash 与「不 import 生产模块、
生产实现变化后不要同步本文件」——它是差分基准，不是第二份实现。

参考自身有两条手算自检（不依赖任何生产代码）：纯 final 回合输出 `['user-1', 'process-shell:user-1']`；过程 + final 回合
输出壳属性 `{userMessageId:'user-1', isActive:false, durationMs:500, children:[assistant-1 inline, assistant-2 process], finalEntryId:'assistant-2'}`。

### 3.2 语料与断言

`packages/app/src/features/chat/processTimeline.compat.test.ts`（729 行，24 例）：

- 16 条手写确定性语料：纯 final 收壳、过程 + final、busy 多头助手、空 user 未就绪 / 已就绪、later-live 双轮、页首 assistant
  - `renderKey`、系统条目（`compaction` / `custom_message` 就地平铺）、工具结果时间晚于消息完成（耗时按工具结果 800ms）、
    `turnDurationMap` 回落（只命中前一条 300ms）、busy 多步 gap、idle 空回合不留壳、连发两轮只挂最早、流式纯 final、
    `turnDurationMap` 非正值被忽略（回落时间戳 200ms）、空回合后面已出现助手时收壳。
- 每条语料三组断言：① 生产输出与冻结参考 `toStrictEqual`；② 与两个实现无关的手写 `expectedKeys` + 壳属性
  （`userMessageId` / `isActive` / `durationMs` / `childScopes` / `finalEntryId`）；③ `structuredClone` 前后输入不变，
  且输出的 `item` / `children[].item` / `finalItem` 必须是输入里的**同一对象**（引用稳定契约）。
- 200 条定种随机语料（`mulberry32`，seed 1–200）：用户 / 助手 / 系统条目混合，`renderKey`、`isStreaming`、
  `turnDurationMap`（50% 概率 50–1050ms）、`isUserEntryReady`（半开集合）随机组合，逐条做同样的三组断言；断言消息里带
  `seed` 与 `kind` 序列，失败可直接复现。
- 60 条定种随机语料（seed 201–260）把末条助手改成流式，比较 `reuseProcessTimelineItems` 的「返回 previous 数组 /
  返回 next 数组 / previous 每行是否被复用」三元签名在两个实现上一致，并比较整份结果深等价。
- 1 例重复调用稳定性：同一输入调用两次输出相同且不污染输入。
- 无任何 wall-clock 依赖（时间戳全部是语料里的常量，`turnDurationMap` 是手填数字）。

### 3.3 变异验证（证明测试有牙齿）

每次都临时改参考实现、跑完立刻用备份还原，`git status` 确认工作树干净：

| 变异                                            | 结果                                                               |
| ----------------------------------------------- | ------------------------------------------------------------------ |
| 去掉 `if (laterHasLive(index)) return true`     | 3 例失败                                                           |
| 去掉「busy 且末回合」不收壳例外                 | 2 例失败                                                           |
| `turnDurationMap` 判定 `mapped > 0` 改成 `>= 0` | 补语料前 0 例 → 补非正值语料后 1 例失败                            |
| `laterHasAssistant` 扫描起点改错                | 补「空回合 + 后续助手」语料前 0 例 → 之后 1 例失败                 |
| 空回合判定去掉 `laterHasAssistant`              | 同上，1 例失败                                                     |
| `finalOutside` 去掉 `!turnIsActive`             | 0 例失败——该分支在 `turnIsActive` 为真时不可达，语义等价，不补断言 |

### 3.4 与 C 改动的独立差分

C 的 `225ad2bc`（主分支记为 `fd8185f9`）只改 `processTimeline.ts` 的后缀判定（一次聚合替代每回合回扫），
并新增 `processTimeline.scaling.test.ts`。本 worktree 在测试提交之后 cherry-pick 为 `7e47d016`（不改 C 文件），
随后 4 个文件 59 例全绿：`processTimeline.test.ts` 16、`processTimeline.compat.test.ts` 24、
`processTimeline.scaling.test.ts` 4、`appCommandItems.test.ts` 15。

H 的独立语料（16 + 200 + 60 条）与 C 自测的 300 组临时差分是两套独立证据：C 的语料按实现思路构造，
H 的参考实现来自旧版本逐字拷贝，且额外校验输入引用不被破坏。

## 4. 任务二：命令面板契约

`packages/app/src/components/appCommandItems.test.ts`（286 行，15 例）。被测表来自 `packages/app/src/components/appCommandItems.ts`
的 `buildAppCommandItems(getDeps)`；主代理已用 AST 对比确认抽取只把 `capabilities.sessionArchive` 参数化，12 项 `useMemo`
依赖保留。H 侧补的契约：

- 22 条命令 id 与顺序；`sessionArchive=false` 时只摘掉 `archiveSession`，其余顺序不变；id 唯一且都有 label / action。
- `getDeps` thunk 每次构建只求值一次（防止把 thunk 当渲染期函数调用）。
- 快捷键全部来自 `keybindingStore.getKey(action)`（抽查设置 / 侧栏 / 取消 / 焦点四个）。
- `when` 条件：`cancelMessage` 随 focused controller 的 `isStreaming`；`closePane` / `togglePaneFullscreen` 随
  `paneLayout.isSplit`；`focusNextPane` / `focusPrevPane` 恒可见（`when` 为 undefined）。
- 原操作接线：通用回调各一次；focused pane 的 8 个 controller 方法各一次；controller 重建后新条目打到新对象、
  旧条目不再打到旧对象（取最新而非闭包里的旧 controller）；`splitPane` 方向参数 `horizontal` / `vertical`、
  未分屏时不关面板 / 不全屏、`splitPaneEnabled=false` 时不分屏；终端命令只动本地 `layoutStore` 与 `piui:new-terminal`
  事件；`focusInput` 聚焦 `[data-input-box] textarea`，无输入框时不抛错。
- 全程只 spy 本地 store 与派发本地事件，不触发服务、网络或设备。

## 5. 任务三：D 交付只读审查

审查对象：`/home/zhangtung/.cache/piui-round2-1eUv5J/round2-highlight` 的
`packages/app/src/lib/shikiWorkerClient.ts`（提交 `6032321d` + 工作树未提交修订 `a6b5e9f5`）、
`packages/app/src/lib/shikiWorkerClient.test.ts`（`c6914c0a`）、
`packages/app/src/components/CodeBlock.tsx` 与 `CodeBlock.subscription.test.tsx`。
H 没有 cherry-pick D，也没有改 D 的任何文件；为跑测试把 D 的两份源码复制到 artifacts 下的临时工程
（`node_modules` 软链 main，vite cacheDir 指到 artifacts），D 的 worktree 自始至终只有 D 自己的两个改动文件。

### 5.1 「settle 时捕获 isLatest」的时序差：确认存在

基线（`940844c5`）在**消费时点**判 latest：`workerHighlight` 只负责 resolve，`highlightTokensInWorker` 在
`await workerHighlight(...)` 之后才比 `result.id !== latestRequestByKey.get(key)`，不等则抛 `superseded`。
`6032321d` 改成在 `pendingRequests.resolve` 里（即 onmessage 投递的那一刻）算出 `isLatest` 并顺带删标记，
消费方只看这个布尔值。于是有两类窗口行为变化：

1. 响应到达 → 同步 `disposeShikiWorkerKey(key)`（删标记）→ 消费：旧版 `map.get` 为 `undefined` → `superseded`；
   新版 `isLatest` 已捕获为 `true` → **成功**。
2. 响应到达 → 消费前启动同 key 新请求 → 旧响应：旧版看到新 id → `superseded`；新版 → **成功**。

实证方式：用同一份 D 的测试文件对三份 `shikiWorkerClient.ts` 分别跑（复制到 artifacts 临时工程，13 例）：

| 被测实现                        | 结果                                                             |
| ------------------------------- | ---------------------------------------------------------------- |
| `940844c5` 基线                 | 9 失败 / 4 通过（失败的都是新契约的「不留 key」断言，符合预期）  |
| `6032321d`（提交版）            | 11 通过 / **2 失败**：正是「消费前 dispose」「消费前新请求」两例 |
| D 工作树 `a6b5e9f5`（当前修订） | **17 全通过**（含上述两例）                                      |

也就是说：差是真实的、可复现的，D 的两条新用例确实钉住了它；工作树把判定挪回消费时点后与基线一致。

### 5.2 该窗口在已审调用方是否可观察

**证据强度限定**：本节只做静态审查（读调用点 + 推理任务顺序），未在浏览器或真机复现。结论是「未找到可见回归路径」，
不是「已排除可见回归」。合成时序已确认 API 判定窗口确实改变（见 5.1）。

逐个调用点核对（`packages/app/src/hooks/useSyntaxHighlight.ts` 与
`packages/app/src/features/settings/components/CodeBlockThemeSettings.tsx`）：

- 流式：`useStreamingSyntaxHighlight` 的 `.then` 有 `if (cancelled) return`，`disposeShikiWorkerKey` 只在该 effect 的
  cleanup（已置 `cancelled = true`）或 `enabled=false` 分支里调用，`.catch` 还会吞掉 `superseded`。即便窗口发生，
  按这条路径也不改输出。
- 一次性 token：`highlightWithCache` 的 key 带 `highlightRequestId++`，**每个请求唯一**，也没有任何 dispose 路径，
  按静态阅读窗口 1 / 2 都不会被构造出来；`try/catch` 把异常翻译成 `null`。
- 一次性 html：同上；例外是主题预览 `CodeBlockThemeSettings` 用**可复用**的 key `preview-${mode}-${themeId}`，
  结构上可能触发窗口 2，但它有 `cancelled || myKey !== requestKeyRef.current` 守卫。
- 事件循环层面（推理，未实测）：真 Worker 的响应是独立 task，`resolve` 后的续体是 microtask，通常在该 task 结束前
  跑完；dispose 与新请求都来自 React effect（后续 task）。据此，常规任务顺序下只有「同一个同步窗口里先投递响应
  再 dispose / 再发请求」才能命中——这需要浏览器侧实测才能确认没有别的交错（例如 worker 消息与 effect 刷新
  落在同一批次、或长任务导致的合并）。

结论：`6032321d` 的语义变化**在合成时序下确认改变了 API 的判定窗口**；**从已审调用方与常规 Worker 任务顺序未找到
可见回归路径，但未做浏览器复现，因此不构成排除证明**。它确实悄悄改了模块契约，把「谁有权判 latest」
从调用方挪进了传输层；D 工作树的改法（判定回消费时点、成功清理放进 `finally`、失败路径按 requestId 守卫释放）
是正确的，且额外保住了「旧请求完成/失败不得抹掉新请求标记」这一条新契约。

### 5.3 工作树修订的逐条核对

- `finally { if (oneShot) releaseLatestKey(params.key, result.id) }`：`releaseLatestKey` 先比 `map.get(key) === id`
  才删。三种情况都正确——成功时删自己；被新请求抢占时不删（新标记保留）；被 dispose 删过时不删（本就不在了）。
  删除发生在消费判定**之后**，不改变任何 superseded 判定：后续 old 请求看到 `undefined` 与旧版看到新 id 一样都不等。
- 一次性 key 释放不会误伤流式：`oneShot = params.complete === true`（tokens 模式）或 `mode === 'html'`；流式请求
  （`complete` 缺席）的标记仍只在 dispose 时释放，与基线一致。
- `onerror` 批量 reject 会经过 reject 包装器，一次性 key 被释放、流式 key 保留——符合新契约，且旧的
  「reject 时不清理」在 worker 重建后本来也不会造成可见差异。
- worker 侧 `shikiWorker.ts` 对 `complete` / `html` 请求本来就会 `streams.delete(key)`，客户端释放标记不改变 worker 状态；
  `dispose` 消息仍会为排队请求回 `superseded`。
- 维护性提示（非缺陷）：`isOneShot()` 与 `highlightTokensInWorker` 里重算的 `params.complete === true` 是同一判定，
  未来若新增一次性模式要同时改两处。

### 5.4 测试质量与残留缺口

`shikiWorkerClient.test.ts`（17 例）用假 Worker + `Map.prototype.set` 探针统计残留 key，覆盖：一次性 token / html
成功与失败后不留 key、`onerror` 释放一次性 key 而保留流式 key、流式 key 留到 dispose、同 key 并发四种次序
（旧先完成 / 新先完成 / 旧失败 / 流式并发）、dispose 后到达的响应仍 `superseded`、以及 5.1 的两条消费时点用例。
判定全部基于 Promise 结果与 key 残留，不看时间。

可信度边界与建议（不影响 D 现有结论）：

1. 探针只能看见「收到过带前缀 key 的 Map」，无法覆盖从未插入过探针 key 的 Map；`retainedProbeKeys()` 跨 Map 求并集，
   理论上多个 Map 持同一 key 时会互相掩盖。
2. 未覆盖 `init-error` 分支：该分支既不清 `pendingRequests` 也不 reject 在途请求，在途一次性 key 会残留。
   这是基线就有的行为（不是本次引入），但新契约下「失败即释放」在这一支不成立，若将来要闭合，建议补一条用例。
3. 未覆盖 worker 回 `{type:'superseded'}` 消息时一次性 key 的释放路径（现有用例只用了 `{type:'error'}`）。

### 5.5 CodeBlock 窄订阅

`CodeBlock.tsx` 把 `useSyncExternalStore(themeStore.subscribe, themeStore.getSnapshot)` 换成模块级常量
`selectCodeWordWrap = () => themeStore.getSnapshot().codeWordWrap`。核对点：

- `themeStore.getSnapshot()` 返回 `this.state`（同一版本内引用稳定），选择器返回布尔值 → 快照稳定，不会触发 React 的
  「getSnapshot 未缓存」告警；选择器是模块级常量，身份稳定，不会每帧重订阅。
- `CodeBlock` 只从 `themeStore` 读 `codeWordWrap`（全文件仅一处），语法主题由 `useSyntaxHighlight` 自己的
  `codeBlockThemeKey()` 派生字符串订阅负责；字号 / 预设 / 自定义 CSS 通过 CSS 变量从祖先生效，不需要组件重渲染。
- 行为等价性有 DOM 证据：把 `CodeBlock.tsx` 换回 `940844c5` 版本后，「无关主题设置变化不重渲染代码块」失败；
  换回 D 版本后 4 例全过（无关字段不重渲染、换行开关立刻生效、显式 `wordwrap` 覆盖、代码块主题变化仍到达 worker）。
  该文件用 `useInputCapabilities` 的调用次数当渲染计数，并用 `listenerCount() > 0` 证明「没重渲染」不是因为通知没发出去。
- 缺口：该测试把 `lib/shikiWorkerClient` 整体替换为立即响应的替身，所以「真实客户端 + 真实 CodeBlock」的组合未被覆盖；
  两个模块各自的契约由两个文件分别覆盖。

## 6. 未测 / 未审查

- E（composer / pi-chat）交付未审查：工作树在 `/home/zhangtung/.cache/piui-round2-1eUv5J/round2-composer`，尚未交付，
  不审活动中的工作树；等主代理通知后继续（届时只读审查 D/E 同类接线与测试）。
- 浏览器层：稳定帧、长列表滚动、流式打字、掉帧、主线程 P95——全部由主代理持有，本文不引用、不推断。
  D 时序窗口的浏览器侧交错（5.2）也未实测。
- 真机：Android WebView / Tauri、设备发热与内存——未做。
- 首次 `timeline-baseline` 计时是在并行忙碌主机上采的，**不能**用来算本轮 speedup；真正成对计时由主代理负责。
- 时间线差分是纯函数层，不涉及 Markdown 渲染、滚动锚定与 `requestAnimationFrame` 合并路径。

## 7. 复现

```sh
# 定向测试（worktree 根目录，packages/app 内）
NODE_ENV=test npm run test:run -w @piui/app -- \
  src/features/chat/processTimeline.test.ts \
  src/features/chat/processTimeline.compat.test.ts \
  src/features/chat/processTimeline.scaling.test.ts \
  src/components/appCommandItems.test.ts --maxWorkers=1

# 静态检查（buildinfo 必须写到 worktree 外）
cd packages/app && NODE_ENV=test npx tsc -p tsconfig.app.json \
  --tsBuildInfoFile "$TMPDIR/tsconfig.app.tsbuildinfo"
npx eslint src/features/chat/processTimeline.compat.test.ts \
  src/components/appCommandItems.test.ts src/test/processTimelineReference.ts
```

## 8. 计数与提交

| 提交       | 内容                                                                  |
| ---------- | --------------------------------------------------------------------- |
| `4ce3b7cb` | 冻结旧时间线行为（参考实现 + 16 条语料）并补命令表契约                |
| `7e47d016` | cherry-pick C 的 `225ad2bc`（仅 `processTimeline.ts` + scaling 测试） |
| `21c5aff4` | 定种随机差分（200 + 60 条）与聚合边界语料                             |

新增文件：`packages/app/src/test/processTimelineReference.ts` 288 行、
`packages/app/src/features/chat/processTimeline.compat.test.ts` 729 行、
`packages/app/src/components/appCommandItems.test.ts` 286 行（均 < 1000）。

测试计数（H 相关）：`processTimeline.test.ts` 16、`processTimeline.compat.test.ts` 24、
`processTimeline.scaling.test.ts` 4、`appCommandItems.test.ts` 15，合计 59，全部通过。
D 侧独立复核（临时工程，不改 D 文件）：`shikiWorkerClient.test.ts` 17、`CodeBlock.subscription.test.tsx` 4，合计 21 通过。
