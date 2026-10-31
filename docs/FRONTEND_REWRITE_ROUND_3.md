# 前端重写：第三轮

## 状态

- 用户授权：开始第三轮。起点 `13fa2c74`，工作区干净；大小检查通过（666 文件、13 个既有登记）。
- 本轮是阶段 3 首包，不等于全部剩余界面或真机验收完成。
- 上轮完整 validate、1371 测试通过 / 2 跳过及浏览器证据见 `docs/FRONTEND_REWRITE_ROUND_2.md`；不得冒充本轮结果。
- 保持静态风格、文案、设置路径、快捷键、Pi 协议与原生行为。没有依赖变更、APK 安装或用户数据操作。

## 工作包与单写者

四个独立 worktree，最多四个代理并行；主代理负责公共记录、行数登记、集成与最终验证。

| 角色     | 白名单与目标                                                                                                                                                               |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A 弹层   | Dialog、ModalShell、useModalAnimation 及必要的独立可见性 helper / 本包测试；补中断、卸载、reduced-motion，去除 Dialog transition-all。只 A 可按需扩展 animation.ts         |
| F 设置   | SettingsUI、SettingsDialog、本包 settings helper / 测试；统一既有状态反馈，为指针触发的 tab 内容切换增加轻量反馈，键盘与搜索跳转即时，保留惰性挂载 / 已展开保活 / 搜索定位 |
| G 工作区 | DiffViewer、DiffViewer.test、新 diff 模型及测试；先提取纯计算，再让 split/unified 复用一次 diffLines，resize 不重复做行级 diff；不改虚拟化或折叠状态语义                   |
| H 验证   | 新独立兼容测试 / 旧版 diff 参考及 QA 记录；验证 settings/弹层操作契约，独立核对计算输出和调用数量，不同时编辑实现代理测试                                                  |

这些界面在 OCUI 上游有等价实现。代理须核对相应文件，按判据 1 保留已同步的结构与 Pi 数据出口；不借本轮同步新版上游外观，不搬回 OpenCode 功能。内部辅助模块仍随其所属界面记录判据。

## 动效与性能边界

- Dialog 保留现有 200ms 级时序与静止样式；只列 opacity / transform 等必要属性。减少动态效果时去掉自动位移 / 缩放与无意义等待。
- 设置 tab 仅指针点击改变内容时允许 160ms opacity 反馈；不延迟 setTab、滚动、focus 或回调。不动画键盘切换、搜索跳转、打开初始化、同 tab 点击；快速切换可取消。
- SettingsDisclosure 保留首次展开前不挂载、展开后折叠仍保活。箭头和真实布局展开同步，减少动态效果即时；不新增 collapse 时卸载、隐藏字段数据清理或 API 请求。
- 保留 Dialog 触摸背景默认不关闭、仅拖拽条起手、纵向 >10px 才识别、>100px 才关闭；不加速度阈值，不改返回栈、焦点恢复、问答数据或 safe-area。
- 不动画 blur，不加常驻 will-change，不动移动 pager、聊天虚拟列表、SmoothHeight、useCompositorExpand 或输入法处理。
- Diff 仅组件本地 useMemo 复用，不新增全局代码缓存或 Worker 协议；原有折叠分块、行号、空行、CRLF、单边 diff、word diff 与 resize 行为需等价。
- 不把拆文件、减少一次函数调用或 jsdom 动画替身当作真实设备帧率、绘制耗时或观感证明。

## 验证与验收

1. 各代理维护本模块单测，覆盖快速反转、运行中 reduced-motion、卸载、焦点 / 键盘与真实状态更新；不靠删断言换绿。
2. H 使用冻结旧逻辑 / 固定语料独立验证 Diff，明确动画替身与真实浏览器的证据边界。
3. 主代理审查后集成，DiffViewer 行数登记只能下调；新增文件不超过 1000 行。
4. 完整 validate、原始 timeline/android-ui smoke；补设置 / 弹层 / Diff 浏览器状态与稳定帧检查，必要时记录动态中间帧。
5. 真机 IME、返回、安全区、完整主题 / glass 矩阵、启动与长时内存仍单列。无真机证据不关闭相关待办。

## 执行证据

待实现及集成后填写，不预写通过。

本轮证据分三层，边界各自单列：本地静态检查、远端完整 validate/tauri、以及尚未完成的真机与浏览器观感。

### 1. 本地集成与静态检查

- 集成 11 个提交（G 4 个、A 1 个、F 2 个、H 3 个，H 的 diff 依赖复用 G 的同名提交），另加行数登记同步 1 个。
- `npm run check:size` 677 文件通过，登记 13 个待拆文件；`DiffViewer.tsx` 1997→1655。`check:docs` OK（SDK 1.4.0、app 0.6.21 五处清单一致）。全仓 `prettier . --check` 通过。
- TypeScript LSP 对 8 个生产改动文件 0 诊断；对 `DiffViewer.compat.test.tsx` 只剩既有的“可转默认导入”提示，不是错误。
- 组装顺序按 H 声明的依赖：先 G 的模型抽取与复用，再 H 的兼容测试；A、F 与它们无文件交集。

### 2. 远端完整验证（fork CI，可复现）

本地不做编译。验证方式：把集成分支推到我账号下 `dhangonge/PiUI` 的同名副本，用仓库自带 `.github/workflows/ci.yml` 的 `validate ubuntu` / `validate windows` / `tauri check` 三个 job 跑。分支 `rewrite/round3-integration`，草稿 PR 仅用于触发 `pull_request`；没有触碰上游主干，也没有触发 release 工作流（它只在 tag `v*` 或手动 dispatch 时运行）。

结果（首轮红、修正后全绿）：

| job                                          | 结果 | 关键输出                                                                                                                                                                                               |
| -------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| validate ubuntu（含 app 覆盖率与两个 smoke） | 通过 | `doc consistency OK`、`file size OK: 677 files`、coverage `17/17`、`27/27`、`28/28` 文件被度量、app `178 files / 1264 tests passed`、`PASS timeline order/expansion smoke`、9 条 `PASS:` 安卓 UI smoke |
| validate windows                             | 通过 | 同一套 `npm run validate` 全绿                                                                                                                                                                         |
| tauri check                                  | 通过 | `cargo clippy --all-targets -- -D warnings` + `cargo test --lib`                                                                                                                                       |

同一 CI 通道暴露并修掉的三处问题，都不是第三轮界面代码引入的：

1. **类型错误（本轮引入，真缺陷）**：`DiffViewer.compat.test.tsx` 手写 `ChangeObject` 时只填了 `value`/单个标记，而该版本 `diff` 的 `ChangeObject` 要求 `added`、`removed`、`count` 必填。已改为三字段齐全，断言不变。
2. **覆盖率门禁在 CI 假失败（既有缺陷）**：`scripts/node-coverage.mjs` 只认 spec 报告器的 `ℹ ` 行前缀，而 Node 22 在非 TTY（CI）下默认用 tap（`# ` 前缀），于是判成“所有文件没被测试加载”。本机 Node 26 默认 spec，所以本地一直看不出来。已显式传 `--test-reporter=spec`，输出版本无关。
3. **Windows 格式门禁必失败（既有缺陷）**：仓库没有 `.gitattributes`，Windows runner 的 `core.autocrlf=true` 把检出写成 CRLF，`prettier . --check`（`endOfLine` 默认 lf）报 778 个文件。已加 `* text=auto eol=lf`，只影响检出与后续提交的换行归一。

这三处属于 CI 基础设施与测试夹具修正，没有改变产品行为；第 2、3 条在第三轮起点之前就已存在。

### 3. 真实浏览器动效采样（fork CI，可复现）

jsdom 只能证明属性、时长和取消语义，插值是否真的发生必须回到浏览器。为此在 fork 分支 `ci/round3-browser` 上挂了一次性工作流 `.github/workflows/round3-browser.yml`：远端 `npm run build`，再用 Chromium 加载真实构建产物 + 临时 mock 服务，走 CDP 真指针点击（`clickCount: 1`，`event.detail > 0`）与真键盘事件，采样本轮的切换反馈和 Dialog 属性。工作流只存在于 fork 的诊断分支，不进产品代码。

结果（`desktop 1100x800` 与 `mobile 412x915` 两档，均通过）：

| 断言                                  | 实测                                                                                            |
| ------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 指针切 tab 产生且只产生一次反馈动画   | 1 次，目标是当前挂载的 panel（`isLivePanel: true`），没有重复 panel                             |
| 反馈参数                              | `duration: 160`，`easing: cubic-bezier(0.23,1,0.32,1)`，帧 `[0.55, 1]`                          |
| 静置后不残留半透明                    | `getComputedStyle(panel).opacity === '1'`                                                       |
| 键盘切换（方向键）不加动效            | 0 次动画                                                                                        |
| CI 的 `prefers-reduced-motion` 被识别 | `reduce` 命中，切换 0 次动画                                                                    |
| 减少动态效果下的 Dialog               | `transition-property: opacity`、`0.12s`、`transform: none`                                      |
| 常规 Dialog                           | `transition-property: opacity, transform`，`0.2s, 0.2s`，无 `all`                               |
| 中断续接（不回跌倒 0.55）             | 把在跑动画暂停在 80/160ms → 可见透明度 `0.984692`；第二次动画起点 `0.984692`，第一条被 `cancel` |

最后一行是这轮唯一有说服力的“手感”证据：它直接否掉了原来的实现（重播必然从 0.55 起），也证明 F 那版的修正真的在浏览器里生效，而不只是在 jsdom 的替身里成立。截图（`desktop/mobile-appearance[-reduced].png`）确认布局没有被动效改动。

这次采样仍不做帧率/长任务判断：它证明插值发生、目标正确、可中断、可降级，不证明在低端 Android WebView 上仍是 60fps。

### 4. 尚未验证（不预写通过）

- 没有真机证据：IME、系统返回、安全区、玻璃效果降级、完整主题矩阵都未验。
- Diff 只证明了调用次数（一次行级 diff、resize 不重跑行级 diff）与 936 组输入的输出等价，没有帧耗时或真机滚动证据。
- 覆盖率数字是 CI 上的实测，不等于渲染性能；`1264` 是测试条数，不是速度。
