# 第三轮重写 · H 独立验证记录

基线 `d13bc984`（第三轮起点），验证 worktree 分支 `rewrite/round3-qa`。
本文只记录 H 侧独立验证：不改生产代码，只新增冻结参考、兼容/合同测试与本文档。
A / F / G 的实现结论由主代理集成后记录，本文不替代。

## 1. 结论摘要

| 项                         | 结论                                                                                                                                                      | 证据层级                |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| Diff 冻结参考              | `src/test/diffModelReference.ts` 与 `d13bc984` 的 6 个纯计算函数 AST 指纹 6/6 相等；冻结时捕获并修回 1 处阈值走样（见 3.1）                               | 模型（AST + 纯函数）    |
| Diff 生产差分              | G 的 `diffModel`（`21b00e6f` + `daa73be8` + 类型修订 `99b1a9cb`）在 9 条主语料 + 5 条边界输入上与冻结参考逐字段相等；paired / unified / resize / 折叠一致 | 模型（纯函数输入/输出） |
| Diff 调用次数              | `computeLineDiff` 1 次 `diffLines`；split + unified + resize 复用同一模型，不重跑行级 diff，resize 的 `wordDiff:false` 不再做词级                         | 模型（diff 包装器计数） |
| Diff 测试牙齿              | 7 个变异全部被 1–15 条用例捕获，且每次都断言变异确实落地（见 3.4）                                                                                        | 模型                    |
| 设置 tab / 搜索 / 键盘合同 | 5 条合同：general 别名、capability 隐藏 tab（导航/初始/搜索三处）、键盘环绕 + roving tabIndex、Enter 选中、Escape 清除。不重复既有 6 个搜索场景           | DOM（jsdom + 替身）     |
| 设置合同牙齿               | 7 个变异全部被 1–2 条用例捕获（见 4.2）                                                                                                                   | DOM                     |
| A 弹层                     | 已交付 `aa52790a`，H 本轮不审查（只完成既有 H 包，不扩张到 A）                                                                                            | —                       |
| F 设置动效                 | 已交付 `6397a4e`，H 本轮不审查；本文件只钉不随动效变化的外部合同，不声称动效/帧率                                                                         | —                       |

**未测**（本文不主张）：浏览器稳定帧、动态中间帧、绘制耗时、真机 / WebView 掉帧、主线程交互 P95、堆内存。
Diff 的等价性只覆盖纯计算与调用次数，不等于端到端渲染性能；设置合同只覆盖交互语义，不覆盖 160ms opacity 反馈的观感。

## 2. 证据分层说明

- **模型层**：Diff 的冻结参考与生产 `diffModel` 都是纯函数：输入 `before/after` 字符串（+ 折叠描述符），输出行数组 / 折叠数组。差分比较同一输入下两边的返回值，期望全部来自冻结参考；生产实现只作为被比较的一侧。
- **调用次数层**：通过 `vi.mock('diff')` 包装真实的 `diffLines` / `diffWordsWithSpace`，计数由包装器记录，jsdiff 仍真实执行。H 只断言模型层计数，hook 层（`useDiffViewerData`）计数由 G 的 `DiffViewer.diffCalls.test.tsx`（7 例）持有，不重复。
- **DOM 层**：设置合同跑在 jsdom，用 React Testing Library 渲染真实 `SettingsDialog` / `SettingsSearch`，只替换外部边界：`Dialog`、`useIsMobile`、`isTauriMobile`、`usePiCapabilities`、各 tab 内容组件、i18n。
- **浏览器 / 真机**：本轮 H 全部未做，由主代理持有。

## 3. 任务一：冻结旧 Diff 行为并对生产模型做差分

### 3.1 冻结参考与 AST 指纹

`packages/app/src/test/diffModelReference.ts`（360 行）把 `d13bc984`
`packages/app/src/components/DiffViewer.tsx`（1997 行）Diff Computation 段落的 6 个函数冻结为
`reference*` 同名实现，并冻结常量 `REFERENCE_CONTEXT_LINES = 3`、`REFERENCE_EXPANSION_LINE_COUNT = 100`。

`DiffViewer.compat.test.tsx` 用 TypeScript 编译器 API 解析 `?raw` 引入的参考源码，对每个函数 `printNode`
（`removeComments: true`）后做归一：去 `export`、`ReferenceX` → `X`、`referenceX` → lowerCamel、压缩空白，
再取 sha256。H 另用 worktree 外的一次性脚本从 `git show d13bc984:...` 独立重算并与参考侧比对（6/6 相等）：

| 函数                   | 归一后函数体 sha256                                              |
| ---------------------- | ---------------------------------------------------------------- |
| computePairedLines     | 27a1470a74a6bfc15d29a87729297d22fbb7cd755a9e31d82c81b0e67251944d |
| computeUnifiedLines    | 7947f3098a90555554e216d9c1df9bb98a8ea48fa2909187f08183554b2868d9 |
| isTooFragmented        | ffdecd71b877feaddcb200434040d866376bdb43e9ac9b3c16018ae86b290402 |
| computeWordDiff        | bb07625cde61c345968ff573aa0466bdd24711a946e125a99b2fc1b962a595cd |
| collapseContextPaired  | f881fe2d5c362b5b94d19e99c591260088fbe03d1f9994b48af51da2f79ce336 |
| collapseContextUnified | c27c6fe2a3d093a7bf1a4d006b55acca3054e885453dc1c7d1604faeb1c358d6 |

冻结过程实际捕获了一处走样：旧产物把 `isTooFragmented` 写成 `totalLength >= 10`，基线是
`totalLength > 10`（`d13bc984` DiffViewer.tsx:1956）。修回后 6/6 相等，且修正前正是 2 条用例红
（AST 断言 + 「恰好 10 个字符不算碎片」）；这不是模拟失败，是真实漂移被测试挡下。

### 3.2 语料与差分断言

主语料 9 条：crlf、尾换行、双空、只增、只删、替换、不等长替换、中文、碎片化替换。
补充 5 条只做差分、不手写期望的边界：仅空白变化、连续空行、无 `\n` 的 `\r`、400 字符单行、
两侧都无尾换行。

对 14 条输入逐一断言：

1. `computePairedLines(before, after, false/true)` ≡ 参考（含/不含词级）；
2. `computeUnifiedLines(before, after)` ≡ 参考；
3. `computeLineDiff` 模型派生的 `buildPairedLines`（含 `{wordDiff:false}`）与 `buildUnifiedLines` ≡ 参考。

另加：

- 碎片阈值：恰好 10 字符（共同占比 0）必须 `false`，并与参考在 4 组总长/占比组合上逐个相等；
- 词级分段：`a  b` / `node_modules .git .gitignore` / 中文 / 单边增删，与参考逐段相等。

折叠差分直接对同一批手写行跑两份实现，期望来自冻结参考：

- paired：上下文段长度 0 / 8 / 9 / 10 / 106 / 107 / 120，每档再乘 3 种展开描述符（无、单侧 5、双侧 5/5）；
  8→不折叠、9→折叠 3、106→隐藏 100 未 chunked、107→隐藏 101 chunked 均为基线边界；
- unified：长度 8 / 9 / 106，每档乘 2 种描述符，并带一条删除边界行验证行号不被折叠打乱。

### 3.3 调用次数

`diff` 包装器计数下：

| 操作                                                                        | diffLines | diffWordsWithSpace |
| --------------------------------------------------------------------------- | --------- | ------------------ |
| `computeLineDiff(before, after)`（一次替换）                                | 1         | 0                  |
| 再 `buildPairedLines(model)`                                                | 1（不变） | 1                  |
| 再 `buildUnifiedLines(model)` + `buildPairedLines(model, {wordDiff:false})` | 1（不变） | 1（不变）          |
| 旧签名 `computePairedLines(..., true)` + `computeUnifiedLines(...)`         | 2         | 0                  |
| 对上述结果再做 paired / unified 折叠                                        | 2（不变） | 0（不变）          |

即：两视图共享一次行级 diff；resize 只决定是否重算词级；折叠不碰 diff。

### 3.4 变异验证（证明测试有牙齿）

每个变异都先断言「精确替换命中 1 次（折叠实现成对出现的模式命中 2 次）」，打印 `git diff --unified=0`
的落地行，再跑测试，最后 `git checkout --` 还原；测试全部通过后才记录。

| 变异                                                      | 落地行（节选）                                          | 失败用例数 | 首条失败                   |
| --------------------------------------------------------- | ------------------------------------------------------- | ---------- | -------------------------- |
| M1 `isTooFragmented` `> 10` → `>= 10`                     | `return totalLength >= 10 && …`                         | 1          | exactly 10 characters      |
| M2 配对 `Math.max` → `Math.min`                           | `const maxCount = Math.min(count, addCount)`            | 1          | uneven replacement         |
| M3 unified 删除行号 `+1` → `+2`                           | `oldLineNo: oldIdx + j + 2`                             | 12         | crlf                       |
| M4 `computeLineDiff` 调两次 `diffLines`                   | `changes: [...diffLines(...), ...diffLines(...)]`       | 15         | crlf                       |
| M5 `chunked: count > EXPANSION_LINE_COUNT` → `>=`（成对） | `chunked: count >= EXPANSION_LINE_COUNT,`               | 2          | 106-row paired context run |
| M6 `minToCollapse = CONTEXT_LINES*2+2` → `+3`（成对）     | `const minToCollapse = CONTEXT_LINES * 2 + 3`           | 2          | 9-row paired context run   |
| M7 `buildPairedLines` 丢掉 `!skipWordDiff`                | `if (oldLine !== undefined && newLine !== undefined) {` | 10         | crlf                       |

M1 与冻结时捕获的真实漂移是同一个阈值，说明该边界不是装饰性断言。M4 的落地是「多调一次」，
计数断言直接变红，证明调用次数不是只在注释里。

## 4. 任务二：设置合同

### 4.1 用例清单与选择理由

`packages/app/src/features/settings/SettingsDialog.contracts.test.tsx`（184 行，5 例）：

| 合同                                                                                                               | 为什么另立                                                          |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| `general` 是 `servers` 别名；首帧即选中 Servers（不等 rAF 回落），且不存在字面 General tab                         | 既有 7 例全在搜索/分组/移动端 service；别名是另一条归一分支         |
| `capabilities.config=false` 时 Management 不进导航、不可作初始 tab（回落 Servers）、不进搜索索引；置真后出现       | 既有用例只覆盖移动端 service 隐藏；capability 过滤是另一条 AND 条件 |
| 键盘导航按可见列表环绕（首项向上→末项、末项向下→首项、Notifications 下一项→Shortcuts），活动 tab 唯一 `tabIndex=0` | 既有用例没有键盘 tablist 导航                                       |
| 搜索 Enter 选中：切 tab、清空输入、失焦、关闭 listbox                                                              | 既有用例只走鼠标点击；Enter 是另一条选择路径                        |
| 搜索中 Escape 只清输入，对话框不关闭                                                                               | 既有用例没有 Escape                                                 |

刻意不写的：搜索结果定位/高亮/重复标签回退/关闭取消高亮（既有 `SettingsDialog.test.tsx` 已覆盖）、
动效时序与可取消性（属 F 的实现测试；H 不用 jsdom 替身冒充观感证据）、完整 tab 内容渲染。

### 4.2 变异验证

| 变异                                          | 失败用例数 | 首条失败                      |
| --------------------------------------------- | ---------- | ----------------------------- |
| S1 去掉 `next === 'general'` 别名             | 1          | general alias                 |
| S2a 导航过滤改为 `true                        |            | id !== 'config'`              | 2   | capability-gated tab |
| S2b 搜索索引 `?? visibleTabs[0]` 补齐隐藏 tab | 1          | capability-gated tab          |
| S3 键盘导航去掉环绕（clamp）                  | 1          | wraps tab keyboard navigation |
| S4 `select()` 不再 `setQuery('')`             | 1          | Enter selection               |
| S5 Escape 直接 return                         | 1          | Escape clears search          |
| S6 所有 tab `tabIndex={0}`                    | 1          | roving tabIndex               |

S1 的用例特意在 rAF 之前断言 Servers 选中：若只等 effect 回落，别名缺失也会被可见性兜底掩盖，
测试将失去意义。S4 的变异是整行删除（`git diff` 只有 `-` 行），落地由命中次数与首条失败共同证明。

## 5. 依赖与集成说明

H 分支上的测试依赖 G 的纯模型。为了让被测依赖在本 worktree 可运行，已 cherry-pick：

| QA 提交    | 来源       | 内容                                                                                  |
| ---------- | ---------- | ------------------------------------------------------------------------------------- |
| `21b00e6f` | `18e21562` | 新增 `components/diffModel.ts` 388 行、`diffModel.test.ts`，DiffViewer 1997 → 1648 行 |
| `daa73be8` | `22ce3a55` | `diffModel.ts` 扩到 423 行、`DiffViewer.diffCalls.test.tsx`，DiffViewer 1652 行       |
| `99b1a9cb` | `a9a879de` | `diffModel.test.ts` 折叠块取内容改为显式类型谓词（修 `tsc -b` 的 TS2339），断言未改   |

集成顺序：先合入 G 的三笔（`18e21562` → `22ce3a55` → `a9a879de`），再合 H 的测试/文档。
若只 cherry-pick H 提交，`DiffViewer.compat.test.tsx` 的阶段 2 会因 `./diffModel` 不存在而无法解析
——这是显式依赖，不是可回退的可选检查。
H 未修改 G 的 `diffModel.ts` / `DiffViewer.tsx` / `diffModel.test.ts` / `diffCalls.test.tsx`。

**G 尚有一行修订待落（已知项，不计入 H 的风险清单）**：`d13bc984` 的 `DiffViewer.tsx` 直接
`export type LineType`；提取后 `LineType` 只在 `diffModel.ts` 导出，`DiffViewer.tsx` 仅 import，
公共再导出丢失。主代理已要求恢复，G 正在做一行修订。H 的测试不依赖该再导出（本包用自有的
`ReferenceLineType`），故不阻塞 H 交付；集成时以该修订落地后的 `DiffViewer` 公共出口为准。

## 6. 未测 / 未审查

- A（Dialog / ModalShell / useModalAnimation，`aa52790a`）与 F（SettingsUI / SettingsDialog 动效，`6397a4e`）已交付，
  H 本轮不审查其实现（只完成既有 H 包，不扩张）。设置合同钉在 `d13bc984` 的 dialog 语义上；
  若 F 改动了这些外部合同，需由主代理确认是「预期变更」而不是回归。
- 浏览器层：稳定帧、动态中间帧、绘制耗时、主线程 P95、真实 reduced-motion 媒体查询——全部未做。
- 真机：Android WebView / Tauri、返回栈、IME、安全区、内存——未做。
- Diff 差分是纯函数层：不覆盖虚拟化、滚动锚定、CodeMirror 挂载；调用次数下降不等于端到端帧率提升。
- 设置合同用假定时器把 rAF 换成 `setTimeout(0)`，只证明顺序与状态，不证明动画曲线或取消后的观感。
- 未跑本地 `tsc` / 构建 / 全量门禁（按本轮约定由主代理远端统一）；`eslint` 对这两个路径返回
  「File ignored because of a matching ignore pattern」，故只有 Prettier 与定向 vitest 的本地证据。

## 7. 复现

```sh
# worktree 根目录
TMPDIR=../qa-artifacts NODE_ENV=test npx vitest run --root packages/app \
  src/components/diffModel.test.ts \
  src/components/DiffViewer.diffCalls.test.tsx \
  src/components/DiffViewer.test.tsx \
  src/components/DiffViewer.compat.test.tsx \
  src/features/settings/SettingsDialog.test.tsx \
  src/features/settings/SettingsDialog.contracts.test.tsx --maxWorkers=1

npx prettier --check \
  packages/app/src/components/DiffViewer.compat.test.tsx \
  packages/app/src/test/diffModelReference.ts \
  packages/app/src/features/settings/SettingsDialog.contracts.test.tsx
```

AST 独立重算（不依赖仓库内测试）：`git show d13bc984:packages/app/src/components/DiffViewer.tsx` 导出后，
用 TypeScript 编译器 API 对 6 个函数 `printNode`，按 3.1 的归一规则取 sha256，与参考源码同法结果比对。
H 使用的一次性脚本放在 worktree 外的 `qa-artifacts/`，未提交。

## 8. 计数与提交

| 提交       | 内容                                                                     |
| ---------- | ------------------------------------------------------------------------ |
| `591ab8fb` | 冻结 `d13bc984` diff 模型（AST 指纹 + 9 语料）+ 生产差分、折叠与调用次数 |
| `fe06f553` | 设置 dialog 合同测试 5 例                                                |
| `99b1a9cb` | cherry-pick G 的 `a9a879de`（`diffModel.test.ts` 类型谓词修订）          |
| 本文档     | `git log -1 -- docs/FRONTEND_REWRITE_ROUND_3_QA.md`                      |

新增/修改文件（均为新文件，未动既有测试与生产代码）：

| 文件                                                                   | 行数       |
| ---------------------------------------------------------------------- | ---------- |
| `packages/app/src/test/diffModelReference.ts`                          | 360        |
| `packages/app/src/components/DiffViewer.compat.test.tsx`               | 897        |
| `packages/app/src/features/settings/SettingsDialog.contracts.test.tsx` | 184        |
| `docs/FRONTEND_REWRITE_ROUND_3_QA.md`                                  | 见 `wc -l` |

定向测试计数（6 文件，全绿）：`DiffViewer.compat.test.tsx` 65、`SettingsDialog.contracts.test.tsx` 5、
G 侧 `diffModel.test.ts` 25 + `DiffViewer.diffCalls.test.tsx` 7 + `DiffViewer.test.tsx` 4、
既有 `SettingsDialog.test.tsx` 7，合计 113。

H 自己的新测试 70 例（65 + 5）；其中 diff 65 = 阶段 1 冻结 37 + 阶段 2 差分/调用次数 28。
变异探针 14 个（Diff 7 + 设置 7），全部被捕获。
