# 前端重写：门禁清理与第二轮

## 状态与约束

- 用户授权：处理第一轮阻塞，然后开始第二轮。
- 起点：`655eaa6c`，工作区干净；第一轮证据见 `docs/FRONTEND_REWRITE_ROUND_1.md`。
- 结果：15 项行数 / 登记问题和 3 项格式问题已清理；第二轮 C / D / E / H 首包已完成本地验收。被测集成提交为 `03532d33`。
- 没有提高行数基线、降低测试阈值，未改变静态风格、操作逻辑、持久化键、原生接口或 Pi 协议；未新增依赖。
- worker 仅为修复既有门禁而兼容提取，不扩展后端功能。没有安装、操作手机应用，真机与完整视觉矩阵仍未验收。
- 本包主要减少渲染工作，不新增逐 token 动画、历史消息重入动画或手势；不能称为全面重写或全部动效覆盖完成。

## 1. 前置门禁清理

四个独立 worktree，单文件单写者；主代理独占基线、公共记录与集成。新增文件不超过 1000 行，已有登记只下调或删除，没有使用 `check:size --update`、挤空行或删除用例规避门禁。

| 责任         | 结果                                                                                                                                                                          |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 主代理       | `d3451351` 修复 AGENTS、UI_SYNC_POLICY、sessionChildrenExpansionStore.test 的格式，政策语义不变；FolderRecentList 登记 1300→实际 1273，相关 3 条测试通过                      |
| Gate Chat    | InputBox 1957→1778、ChatArea 1342→1210、ChatArea.test 1278→786、chatPageModel 1039→736；保留 re-export、effect 位置和滚动契约；61 个字面量测试回调 AST 一致                   |
| Gate Shell   | FileExplorer 2159→1925、SidePanel 1392→1352、App 1114→928、SessionList 1068→977；命令表仅参数化 sessionArchive 后 AST 一致，6 个迁移函数体一致，App 的 12 项 useMemo 依赖未改 |
| Gate Render  | MarkdownRenderer 1664→233，拆为内联 / 表格 / Mermaid / HTML artifact / DOM block；原测试 1571→1426、themeStore 1177→1003；101 个字面量测试回调 AST 一致，动态用例另经运行验证 |
| Gate Runtime | real-session 1510→1171、mock-session 1093→881、原集成测试 1707→650；24 条迁移集成用例的回调 AST 一致，worker 107 条测试保留                                                   |

**前置门禁通过（`694ce780`）**：完整 `validate` 退出 0，大小检查覆盖 657 文件、保留 13 个只许缩小的登记；app 164 文件 / 1015 测试通过，protocol / worker / server 无失败，lint 0 errors / 30 warnings；两项原始 smoke 通过。日志为 `gate-validate.log`、`gate-smoke-timeline.log`、`gate-smoke-android-ui.log`。

这不是把所有旧文件压到 1000 行以内；剩余 13 个登记文件仍需后续按职责收敛。主代理此前对 14 个关键文件运行 LSP：无错误、1 条既有 FormEvent 废弃提示。

### 撤回的扩张

Runtime 初版 live-message 提取把 `getEntries()` 提前到原本会早退的路径，shadow 辅助函数又增加了求时间操作。主审要求撤回，仅保留纯辅助模块迁移；最终 RealPiSession 类体 AST 与 `655eaa6c` 一致。测试工装移出生产编译范围，撤去为编译工装增加的双断言，没有修改 tsconfig。

Render 的两个 href 解码函数经逐体比较后合并；HTML sandbox、控件状态、主题注入及原生系统栏调用时序保留。拆分不是性能收益证据。

## 2. 第二轮 C / D / E / H

共同起点 `940844c5`，最多四个子代理并行、各自维护测试。主代理审查后逐项集成，不直接接受代理的通过声明。

### C：时间线

- `fd8185f9` 用回合 / 后缀预计算替代反复后扫，计算复杂度 O(回合数 + 助手数)，额外空间 O(回合数)。
- 未改虚拟化配置、稳定 key、历史引用复用、滚动锚点、入场完成缓存及 Working / Worked 语义。
- 100 / 1000 / 5000 个已结束回合，`isStreaming` 读取次数分别为 5250→200、502500→2000、12512500→10000；尾部 live 为 5050→199、500500→1999、12502500→9999；空队列均为 0。
- 九个计数场景的新旧输出摘要一致。四条规模测试不使用墙钟阈值；冻结旧实现与独立语料由 H 覆盖。

### D：代码块与高亮

- 主分支 `15b0e723` + `1001b678`：CodeBlock 只订阅 `codeWordWrap`；语法主题仍由既有 hook 订阅，无关主题设置不再使整个代码块重渲染。
- 一次性 token / HTML 请求结算后按 requestId 释放标记；旧请求不删除新标记。正常流式请求保留到 dispose；Worker error 清客户端状态，postMessage 同步抛错清 pending 与本次标记。
- 首版把 latest 判定提前到 onmessage，主审与 H 用合成时序确认契约差异后退回；修订恢复外层 await 后判定，成功清理置于 finally。未在实际 UI 路径复现用户可见故障，不把静态推理当作排除证明。
- 17 条客户端用例 + 4 条订阅用例；主代理额外用红绿验证隔离数字 Map 探针，避免把测试框架的 Map 算作泄漏。
- 隔离 Node + mock Worker 完成 200 次独立 key 请求：完成后保留的客户端标记 **200→0**，显式 dispose 后均为 0。这不是实际堆字节数或真实 Worker 性能。
- 未改 Markdown 清理、增量 DOM、控件状态、离屏门控、同帧合并、Worker 协议与缓存策略；未扩展初始化失败 / Worker 重建机制。置空客户端引用不等于已 terminate 真实 Worker。

### E：输入绑定

- 主分支 `327af7a7`、`e94749c1`、`d4c24cd6`、`1f18ce5f`：新增 `usePiComposerBindings`，PiChatPane 1752→1746，登记仅下调。
- 稳定 models 浅拷贝、能力对象、Todo 插槽、折叠胶囊和操作回调；不使用宽比较器。真实模型、会话、compaction、redo、问答等变化仍可越过 memo。
- 主审纠正 redo 从 void 变 Promise 的返回差异，并补断言；发送、队列、fork seed→mirror、服务器身份取消边界均未移动。
- onCommand 经稳定回调转发到最新实现；H 探针发现 passive 同步偏晚，最终用 layout effect 同步。四条顺序测试覆盖后续父 layout / 子 passive 阶段，不承诺早于父 layout 的子 layout 阶段，也不声称现有 InputBox 在这些 effect 中派发命令。
- 真实 PiChatPane 的 23 条边界测试：重 UI 和数据出口为替身，部分本地 store 与队列 / 编辑 hook 为真实模块。模拟 streaming=true 下同一助手正文更新三次，ChatArea 确认更新至少三次，InputBox memo spy 仍仅初次渲染；不是实际 SSE、真实 InputBox 内部渲染或真机延迟测量。
- 主代理集成后 pi-chat 八文件 / 78 测试通过，原 51 条保留。

### H：独立验证

- 冻结 `940844c5` 的旧时间线；主代理规范化命名后确认六个函数体 AST 一致，没有用新实现计算期望。
- 16 条手写语料、200 个定种生成场景及 60 个种子中含助手的复用样例；验证深等价、输入不变和输出引用。另补 15 条命令表契约。
- 变异测试曾因替换未落地误判 finalOutside 条件冗余；主审要求确认唯一替换后重跑，五例失败，原结论撤回。其他报告中的绝对可见性、语料数量、命令闭包描述均已收紧。
- 独立审查过程快照见 `docs/FRONTEND_REWRITE_ROUND_2_QA.md`；该文件的 D / E 状态不是最终集成状态，以本文为准。

## 3. 最终本地验收

被测提交 `03532d33`；之后仅更新执行记录。

| 检查               | 实测结果                                                                                                                    |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `npm run validate` | 退出 0；docs / SDK conformance / size / format / typecheck / lint / 全量测试 / build 均通过                                 |
| 文件大小           | 666 文件，13 个既有登记；新增文件均 ≤1000 行，未提高登记值                                                                  |
| 测试               | app 171 文件 / 1106 通过，比本轮起点增加 91；protocol 15、worker 107、server 143 通过 / 2 跳过；合计 **1371 通过 / 2 跳过** |
| lint / LSP         | 全仓 lint 0 errors / 30 既有 warnings；本包 13 个文件的主代理 LSP 0 诊断；早先 C 的超时已复测解决                           |
| 原始浏览器 smoke   | timeline 与 android-ui 均通过；未改脚本或删断言                                                                             |
| 稳定帧             | 同视口等待 700ms 后比较四场景，结果如下；不是完整视觉矩阵                                                                   |

本机 smoke 参数仍为 `--password-store=basic --use-mock-keychain --disable-background-networking`，TMPDIR 使用 home 缓存，不改系统配置。原断言覆盖时间线归属 / 展开、多服务器同 ID 隔离、Todo 停靠与交互、全屏问答 / Escape、分屏首击次序和未捕获异常。

### 稳定帧对比

优化前 `940844c5` 的构建与最终构建，使用同一份仓库外诊断脚本（原 smoke 断言 + 截图前 700ms 等待）：

| 场景                | 尺寸     | 差异                              |
| ------------------- | -------- | --------------------------------- |
| collapsed Todo      | 412×360  | 0 像素                            |
| expanded Todo       | 412×915  | 85 像素，仅运行耗时文字 34ms→29ms |
| fullscreen question | 412×915  | 1 个右侧边缘像素                  |
| split pane          | 1100×800 | 85 像素，仅同一运行耗时文字       |

主代理查看了差异区域截图；不把耗时文字变化当性能测量。前置门禁拆分也与第一轮稳定帧对比过：collapsed / question 为 0，另两场景各 34 像素且仅耗时数字。

### 构建体积

与门禁通过时相比，index JS gzip 159.30→159.71 kB，hooks JS gzip 120.31→120.31 kB，CSS gzip 21.05→21.05 kB。前两块合计约增加 0.41 kB；这不是总首屏 JS，也不是启动时间测量。启动不退化目标尚未取得实测结论，单次 build 耗时不作基准。

## 4. 模型性能证据与限制

旧版 `655eaa6c`，新版 `03532d33`；Linux x64、Intel i5-6200U @ 2.30GHz、Node v26.12.1。实现代理结束且浏览器验收完成后运行：每场景 ABBA 顺序、四个独立进程（旧 / 新各二次）；每进程 10 次预热、31 次采样。计时使用普通属性，计数在另外的进程，断言与序列化在计时外。以下是**两次进程各自分位数的中位数**，单位 ms，不是合并样本分位数或浏览器数据。

| 场景      | 回合数 | 旧 P50→新 P50 | 旧 P95→新 P95  |
| --------- | ------ | ------------- | -------------- |
| 已结束    | 100    | 0.334→0.255   | 0.744→0.835    |
| 已结束    | 1000   | 11.121→0.928  | 25.671→3.052   |
| 已结束    | 5000   | 358.073→8.439 | 692.774→17.001 |
| 尾部 live | 100    | 0.403→0.322   | 1.624→1.201    |
| 尾部 live | 1000   | 23.067→2.830  | 43.370→9.573   |
| 尾部 live | 5000   | 323.298→3.506 | 663.171→8.352  |
| 空队列    | 100    | 0.111→0.126   | 0.220→0.238    |
| 空队列    | 1000   | 0.451→0.333   | 1.519→1.677    |
| 空队列    | 5000   | 2.435→1.754   | 6.543→5.823    |

九个场景四次运行的输出摘要全部一致。不能宣称每个场景都更快：小样例存在上表所示回退；5000 已结束回合的新进程 P50 范围为 5.485–11.393ms，仍有宿主与 GC 波动。主要结论是大规模模型扫描工作下降，不外推整体 App 倍率、主线程 P95、掉帧率或电量。

早期 `timeline-baseline.json` 是并行负载下的探索记录，同进程访问器计数还可能影响后续 JIT，不用于计算最终提升。

## 5. 产物与未关闭项

所有日志、截图和探针根目录：`/home/zhangtung/.cache/piui-round2-1eUv5J/`。

- 门禁：`round2-validate.log`、`round2-smoke-timeline.log`、`round2-smoke-android-ui.log`。
- 定向测试：`cdh-integrated.log`、`e-integrated.log`、`highlight-probe-red.log`。
- 视觉：`settled-before/`、`settled-after/`、`round2-stable-pixels.json`、`round2-duration-crops.png`。
- 模型：`timeline-case-probe.mjs`、`run-timeline-paired.py`、`timeline-counts.json`、`timeline-paired-results.json`。
- 高亮：`highlight-retention-probe.mjs`、`highlight-retention-baseline.json`、`highlight-retention-after.json`。

未关闭：真机 IME / 返回 / 安全区 / 前后台恢复、完整主题 / 字号 / glass 矩阵、实际输入与主线程 P95、掉帧率、真实 Worker / 长时间堆内存、启动时间；F / G 界面重写与剩余动效覆盖尚未进入本包。保留分支和 worktree 供复核，没有批量清理、删除旧实现、安装 APK 或触碰用户数据。
