# 前端重写：门禁清理与第二轮

## 状态与约束

- 用户已授权：处理第一轮阻塞，然后开始第二轮。
- 起点：`655eaa6c`，工作区干净；第一轮证据见 `docs/FRONTEND_REWRITE_ROUND_1.md`。
- 前置门禁已通过；第二轮 C / D / E / H 开始实施，后文性能目标不代表已经达标。
- 不提高行数基线、不降低测试阈值、不改变静态风格、操作逻辑、持久化键、原生接口或 Pi 协议。
- worker 仅为修复既有门禁而做兼容提取，不扩展后端功能。真机安装与操作不自动进行。

## 1. 前置门禁清理

复核结果：15 项行数 / 登记问题、3 个格式问题，与第一轮一致。

| 责任         | 范围                                                                                                 | 要求                                                             |
| ------------ | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 主代理       | AGENTS、UI_SYNC_POLICY、sessionChildrenExpansionStore.test 的格式；FolderRecentList 的登记；最终基线 | 政策内容不变，只同步真实下降值；审查集成                         |
| Gate Chat    | InputBox、ChatArea、ChatArea.test、chatPageModel                                                     | 按职责抽取，保留 effect 顺序、滚动和输入语义；不在此阶段优化算法 |
| Gate Shell   | FileExplorer、SidePanel、SessionList、App                                                            | 提取纯逻辑 / 内聚子组件，保留导航、布局、焦点与权限边界          |
| Gate Render  | MarkdownRenderer、其测试、themeStore                                                                 | 保留增量 DOM、安全清理、主题持久化与原生系统栏时序               |
| Gate Runtime | real-session、其集成测试、mock-session                                                               | 保留 SDK / 事件时序、取消、错误和 mock 行为；测试迁移不减断言    |

4 个独立 worktree，单文件单写者。现有登记文件必须缩小到登记值以下；SessionList 未登记，必须降至 1000 行以内；新增文件不超过 1000 行。禁止靠挤空行、删除注释或用例来凑数。

已完成：

- `d3451351` 修复 3 个格式文件，复核无政策语义变化；FolderRecentList 登记从 1300 下调为实际 1273。
- `format:check` 通过；sessionChildrenExpansionStore 的 3 条测试通过。
- Gate Chat 已集成：InputBox 1957→1778、ChatArea 1342→1210、ChatArea.test 1278→786、chatPageModel 1039→736；保留 re-export 和 effect 位置。主代理比较了 61 个字面量测试回调，未删除或改写。
- Gate Runtime 已集成：real-session 1510→1171、mock-session 1093→881、原集成测试 1707→650；24 条集成用例迁移后的回调 AST 一致，worker 仍为 107 条通过。
- Gate Render 已集成：MarkdownRenderer 1664→233，拆为内联 / 表格 / Mermaid / HTML artifact / DOM block 五个模块；原测试 1571→1426、themeStore 1177→1003。101 个字面量测试回调 AST 一致，动态生成的用例另由运行验证。
- 三路集成后完整 typecheck 通过；LSP 检查 14 个关键文件无错误，有 1 条既有 FormEvent 废弃提示。check:docs / conformance:sdk:check 通过。
- Gate Shell 已集成：FileExplorer 2159→1925、SidePanel 1392→1352、App 1114→928、SessionList 1068→977。命令表在仅将 sessionArchive 参数化后 AST 一致，6 个迁移的叶子 / 纯函数体一致；App 的 12 项 useMemo 依赖未改。

**前置门禁通过（`694ce780`）**：`npm run validate` 退出 0；文件大小检查覆盖 657 个文件，保留 13 个只许缩小的既有登记；格式全通过。app 164 文件 / 1015 测试通过，protocol / worker / server 无失败，lint 为 0 errors / 30 warnings。两项原始浏览器 smoke 均通过，参数与第一轮相同。日志：`gate-validate.log`、`gate-smoke-timeline.log`、`gate-smoke-android-ui.log`。

前置拆分没有删除用例，也没有将所有旧文件压到 1000 行以内；解决的是现行门禁违规，剩余 13 个登记文件仍需后续按职责收敛。真机与完整主题矩阵不在这次本地通过声明中。

### 审查中撤回的扩张

Runtime 初版 live-message 拆分把 `getEntries()` 提前到原本会早退的路径，shadow 辅助函数又增加了求时间操作。主代理要求撤回这两块，仅保留纯辅助模块迁移；最终 RealPiSession 类体 AST 与 `655eaa6c` 一致。测试工装移到原本不参与生产编译的范围，撤去为编译工装而加入的双重类型断言，没有修改 tsconfig。

Render 的 href 解码合并经逐体比较，两个旧函数实现相同；HTML sandbox、控件状态与原生系统栏调用时序没有改动。这里只说明审查结论，不替代最后的浏览器与真机验收。

## 2. 第二轮首个工作包

以门禁通过后的共同基线启动 C / D / E / H，最多 4 个子代理并行；主代理独占基线、公共记录与集成。以下是边界，不是已取得的性能结果。

### C：时间线

- 将 process timeline 中逐轮扫描后缀的工作改为一次预计算，保持所有壳合并、live 状态、用户就绪与顺序语义。
- 保留虚拟列表配置、稳定 key、历史项引用复用、滚动锚点和动画完成缓存。
- 用旧实现差分和固定样例验证等价；报告规模增长下的计算量及重复测量，不能用拆文件代替性能证据。

### D：富文本 / 高亮

- 以代码块订阅和高亮生命周期为首个有边界的优化点：避免无关主题设置使全部代码块重渲染，检查一次性高亮请求的资源释放。
- 保留 Markdown 清理、增量 DOM、控件状态、Shiki Worker、离屏门控和同帧合并；不重新设计解析器或缓存策略。
- 对真实发现建立失败用例后修复；不把静态推测写成已测得的内存或帧率收益。

### E：输入系统

- 稳定 PiChatPane → InputBox 的数据、回调和插槽引用，避免父层无关更新击穿 memo。
- 不移动 fork seed / editor mirror 顺序，不改发送、取消、队列、IME、草稿和模型选择语义。
- 证明无关更新不重渲染，同时真实模型、会话、compaction、Todo、问答等更新仍能到达；禁止用过宽比较器吞掉更新。

### H：独立回归与证据

- 复用现有 Vitest / mock / CDP 工具，不引入新框架。
- 对时间线差分、输入边界、富文本状态保存和性能样例进行独立检验，分清模型测试、DOM 测试与浏览器证据。
- 记录测试数、命令、基线、测量环境和残余盲区；主代理负责完整 validate、两项 smoke 与稳定帧对照。

本工作包优先减少占用主线程的工作，让既有动效在流式输出中有执行空间；不增加每 token 动画、历史消息重入动画或新手势，也不宣称已完成所有动效覆盖。

## 3. 验证与产物

- 根命令：`npm run validate`、`npm run smoke:timeline`、`npm run smoke:android-ui`。
- 本机浏览器复用第一轮隔离参数：`--password-store=basic --use-mock-keychain --disable-background-networking`，不改系统配置。
- 大型临时产物使用 home 下 TMPDIR，避免第一轮 `/tmp` 配额问题。
- 本轮工作树和日志根目录：`/home/zhangtung/.cache/piui-round2-1eUv5J/`。
- 所有通过 / 性能数字以实际执行为准。真机帧率、IME、系统返回和完整主题矩阵仍需单列验收。

### 拆分前模型基线

主代理在 `09769ff8`（聊天模型源码与 `655eaa6c` 相同）运行独立 Node 探针：100 / 1000 / 5000 回合，已结束、尾部 live、空队列三种固定场景；校验输出行数、唯一 active 壳并记录结果摘要。

已结束场景对 `isStreaming` 的访问次数为 5250 / 502500 / 12512500，尾部 live 为 5050 / 500500 / 12502500，验证后缀扫描存在二次增长。探针将计数与计时分开，结果保存在 `timeline-baseline.json`；计时采集时有并行子代理负载，只作为原始记录，不据此声称浏览器或真机性能。优化后需要同环境成对复测。

另一个隔离 Node 进程以 mock Worker 完成 200 个独立 key 的一次性高亮请求：客户端 Map 在完成后仍保留 200 个 key，显式 dispose 后归零。结果见 `highlight-retention-baseline.json`。这验证生命周期清理缺口，不是实际堆字节数或真实 Worker 性能；第二轮 D 必须同时保持并发 latest-only 与失败清理语义。
