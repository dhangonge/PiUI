# 前端重写：第一轮执行记录

## 1. 范围与状态

- 计划：`docs/FRONTEND_REWRITE_PLAN.md`；旧版测试详情：`docs/FRONTEND_REWRITE_BASELINE.md`。
- 源码基线：`03af7883`；计划提交：`48344fd3`，两者业务源码相同。
- 第一批 A / B / H 已集成，主代理修订已提交。**本批代码与测试完成，不等于全面重写或全仓验收完成。**
- `npm test`、类型检查、lint、构建及两项浏览器冒烟通过；`validate` 仍受 15 项既有行数问题和 3 个既有格式问题阻塞。
- 未安装、启动或操作已连接手机上的应用。真机触屏、IME、安全区、系统返回与性能未验证。
- 每个代理使用独立 worktree 与文件白名单；没有改依赖、协议、store 公共接口、原生桥或用户数据，没有清理其他人的临时文件。

## 2. 本批交付

### A：动效基础

- `hooks/usePresence.ts`：关闭中重开从当前动画状态衔接；取消旧动画；卸载停止；减少动态效果时直接完成状态变化，不空等普通退场时长。
- `hooks/useReducedMotion.ts`：通过 `useSyncExternalStore` 跟踪 `prefers-reduced-motion`，响应运行中切换；SSR / 无 matchMedia 时回退 false。
- `constants/animation.ts`：按压 140ms，曲线 `cubic-bezier(0.23, 1, 0.32, 1)`，保留既有主题切换常量。
- `Button` / `IconButton` / `MenuItem`：显式过渡 background-color、color、opacity、scale，替代 transition-all；减少动态效果时禁用按压缩放。
- 没有改静态颜色、字号、尺寸、间距或按压幅度，没有动 `useCompositorExpand`、`SmoothHeight`、entry-grow、毛玻璃降级与手势阈值。
- CSS 使用静态 Tailwind 类以保证扫描产出，单测校验它们与 JS 时长 / 曲线 token 一致；Tailwind 4 的缩放使用独立 `scale` 属性，不是 `transform`。

### B：控制逻辑抽取

- 新增 `features/pi-chat/hooks/usePiQueueControl.ts` 和 `usePiExtensionEditorBridge.ts`。
- `PiChatPane.tsx` 从 1866 行降至 1752 行（减少 114 行），只下调对应行数登记。拆文件本身不计作性能提升。
- 保留队列 clear-then-replay 顺序、500ms 编辑器镜像防抖、本地输入防旧镜像覆盖、extension 来源旁路、发送前清镜像、切换 / 卸载取消。
- 保留 fork seed 先于镜像回填的 effect 注册顺序，父层共享 ref 不移动。

### H：旧行为契约

- 新增 10 条返回栈测试：压栈、嵌套关闭、程序关闭、卸载、快速开关、最新回调与遗留 ignore 标志。
- 新增 5 条 Tauri 视口测试，原 2 条浏览器测试保留：原生底部 padding 不与 Web 键盘 inset 重复叠加，Web 只更新 app-height，保留原生注入的顶部 inset。
- H 的 jsdom 测试不是 Android 硬件验收；旧行为记录也不是要求后续永远保留缺陷。

## 3. 主代理审查与修订

1. **effect 顺序回归**：初版抽取把镜像 effect 注册到 fork seed 之前。已恢复调用位置及父层 ref，增加真实 extension store + seed 的顺序用例；故意错误顺序能够复现覆盖问题。
2. **服务器标识碰撞**：分隔符拼接会合并不同字段组合，也会混淆缺失与空字符串，导致待发送镜像未取消。改成 `JSON.stringify([id, token, url])`，不记录值。新增 token-only、URL-only、分隔符与空值边界测试；修复前 2 失败 / 6 通过，修复后 8 条通过。
3. **回调测试失真**：H 初版用“再挂一个顶层 hook”代替了“同一 hook 更换回调”。改成真正 rerender 原实例，验证最新回调。
4. **原生 inset 说明**：顶部是原生真实值，只有底部 / 左右由 Web 接收 0。修正注释，增加原生顶部 24px 不被覆盖的断言。
5. **动效 token 漂移**：将硬编码测试期望改为引用 JS token，保证静态 CSS 字面量与语义参数一致。

覆盖边界：B 的调用点 harness 复刻父层接线，但不渲染整棵真实 PiChatPane；实际接线经 diff 审查与浏览器集成验证。presence 测试使用真实 motion/mini 和最小 WAAPI 替身，不能代替设备动画轨迹或所有任意 ref 替换场景的验证。

## 4. 合并后验证

环境：Node `v26.12.1`、npm `12.2.1`、Chromium `156.0.8078.79`；临时 mock 服务与浏览器数据，不使用生产会话。

| 检查                         | 合并后结果                                                                                     |
| ---------------------------- | ---------------------------------------------------------------------------------------------- |
| `npm test`                   | 通过；protocol 15、pi-worker 107、server 143 通过 / 2 跳过；app 162 文件 / 1015 测试全部通过   |
| 前端测试增量                 | 旧版 152 文件 / 930 测试 → 162 文件 / 1015 测试，增加 10 文件 / 85 测试；旧版计数方法见 H 报告 |
| `npm run typecheck`          | 四包通过，包括主代理修订后的新测试                                                             |
| `npm run lint`               | 退出 0；0 errors / 31 warnings，与基线相同                                                     |
| LSP                          | 主代理检查 13 个源码 / 测试文件，0 diagnostics；子代理还分别检查了本模块                       |
| `npm run build`              | 通过；仍有既有 > 500 kB chunk 警告                                                             |
| `npm run smoke:timeline`     | 通过：隐藏 hook、用户 / 工具壳顺序、展开 / 折叠、流式收尾                                      |
| `npm run smoke:android-ui`   | 通过：多服务器同 ID 隔离、输入 / Todo 停靠、问答全屏、分屏事件顺序、无未捕获异常               |
| `npm run check:size`         | 失败，仍是基线的 15 项；本轮没有增加失败项                                                     |
| `npm run format:check`       | 仍有基线的 3 个文件；本轮改动单独检查                                                          |
| `npm run validate`           | 未通过；check:docs / SDK 对齐后，在 check:size 停止，不能称全仓通过                            |
| 真机 / 覆盖率 / 完整视觉矩阵 | 未运行，不沿用历史覆盖率或声称性能达标                                                         |

### 浏览器环境与复现

默认环境出现 `DevTools timeout: Runtime.evaluate` / `DevTools timeout: Page.navigate`。独立最小 HTTP 页同样超时，且服务器请求数为 0；data URL 正常，故不能把它归为 PiUI 回归。下列参数仅作用于临时测试进程，不改系统密钥存储或安全配置：

```sh
export TMPDIR="$HOME/.cache/piui-round1-integrated-IssWqM"
export CHROMIUM_EXTRA_ARGS='--password-store=basic --use-mock-keychain --disable-background-networking'
npm test
npm run smoke:timeline
npm run smoke:android-ui
```

本机 `/tmp` 写入遇到 `UNKNOWN: unknown error, write`（errno -122）/ EDQUOT；改为 home 下新建的 TMPDIR。A 隔离树的构建曾因该环境失败，主仓集成构建已经通过，没有靠放宽超时、改断言或删除其他人的文件解决。

### 截图对照

原始冒烟在状态标志变化后立刻截图，会截到动画中途，不能直接当静态基线。主代理额外生成**诊断用副本**：保持原断言不变，仅在截图前等待 700ms；原项目脚本未修改。另建 detached worktree，从 `48344fd3` 重建旧版产物，以相同副本对照。

| 场景              | 尺寸       | 稳定帧像素差异         |
| ----------------- | ---------- | ---------------------- |
| 收起输入区的 Todo | 412 × 360  | 0                      |
| 展开输入区的 Todo | 412 × 915  | 40，仅执行耗时数字区域 |
| 全屏问答          | 412 × 915  | 1，右边缘单像素        |
| 分屏              | 1100 × 800 | 40，仅执行耗时数字区域 |

这 4 个样本未发现布局、间距或静态配色偏移，但不等于所有主题、字号、glass 状态及界面均已完成视觉验收。

### 性能与体积

第一批未取得真机 CPU / 掉帧 / 输入延迟基线，不报告性能提升。主仓入口 gzip 由 158.54 kB 到 158.76 kB，hooks chunk 由 120.03 kB 到 120.31 kB，约增加 0.50 kB；这是两个 chunk 的记录，不是首屏总 JS。保留到后续预算评估，不把“增加动效”包装成体积下降。单次构建耗时不作为运行时性能证据。

## 5. 未关闭项

1. **既有质量门禁**：15 项行数 / 登记失败，完整列表见 H 报告；格式失败仍是 `AGENTS.md`、`docs/UI_SYNC_POLICY.md`、`packages/app/src/store/sessionChildrenExpansionStore.test.ts`。没有提高行数基线、降低阈值或格式化这些无关文件。
2. **旧队列语义**：move-mode 通过文本过滤剩余项，重复的相同文本会被一并移除。本轮保持原样并记录，不混入行为修复。
3. **潜在返回竞态**：jsdom 中取消遍历后 ignore 标志可能保留，真实浏览器 / Android 需要单独复现；不把人工 popstate 等同于硬件返回。
4. **真机与完整视觉验收**：尚未安装或操作 Redmi Note 10 Pro；IME、系统栏 / 键盘、硬件返回、140ms 按压手感、系统 reduced-motion 上报与帧稳定性待验证。
5. **后续重写未开始**：本批只落实 A / B / H 的首个工作包；聊天时间线、富文本、输入区及其余页面仍按计划分阶段推进。

全仓门禁与真机未关闭前，不将本轮标为全面验收完成。旧实现清理、无关文件修复和设备部署应另行确认范围；不执行 reset --hard、force push 或批量删除。

## 6. 提交与产物

主分支提交：

- `48344fd3`：保存计划。
- `73bad1ed`、`cd595103`、`8d9a559b`：B 抽取、顺序修订与测试收敛（来自隔离树三条提交）。
- `502a8aac`：A 动效基础。
- `12e63a72`：编辑器服务器边界修正与行数登记下调。
- `bec8eb3c`：CSS / JS 动效 token 同步断言。
- `baaacb12`：H 契约测试与旧版报告。
- `27a4a75f`：H 回调 / 原生 inset 审查修订与证据限定。

日志与截图保留在本机临时产物目录，不提交二进制：

- 基线门禁：`/tmp/piui-round1-baseline-*.log`。
- 基线完整资料：`/home/zhangtung/.cache/piui-round1-baseline-6XnUQh/`。
- H 旧版 / 新增测试：`/home/zhangtung/.cache/piui-round1-h/`。
- 合并后日志与截图：`/home/zhangtung/.cache/piui-round1-integrated-IssWqM/`。
- 稳定帧对照：上述基线与合并后目录各自的 `settled/`。

worktree 与诊断产物保留，未自动删除。
