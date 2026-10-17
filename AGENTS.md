# PiUI Android — 项目约定

本仓是 PiUI 的**纯安卓二次开发**分支，保留 `packages/{app,protocol,server,pi-worker}`。桌面/Tauri/OpenCode 传输层不在范围内。

## UI 同步规则（强制）

> **OCUI 有的就同步；OCUI 没有的，按 PiUI 原风格写。**

新做或改造任何面向用户的界面之前，先读 [`docs/UI_SYNC_POLICY.md`](docs/UI_SYNC_POLICY.md)，按其中的三步判据走，并在提交信息里注明走了哪条判据。判不准时按「原风格自研」处理。

速记：

1. OCUI 有等价 UI **且** Pi 有数据源 → 同步 OCUI 设计，数据接入换成 Pi 原生通道（不搬回 OpenCode 模块）。
2. OCUI 有 UI 但 Pi 无对应概念 → 不移植（D 档排除）。
3. OCUI 没有 → PiUI 原风格自研，只用 `packages/app/src/index.css` 的 token 与既有结构原语。

参考源：`/home/zhangtung/项目/opencodeui-upstream/`、`/home/zhangtung/项目/PiUI-OCUI-0.7-port-plan.md`。

## 项目文档

| 文档 | 内容 |
|---|---|
| `docs/UI_SYNC_POLICY.md` | UI 同步规则、驳回项、原风格契约、测试要求 |
| `docs/PIUI_MASTER_PLAN.md` | R0–R12 路线（注意：R6/R7/R9 标记滞后于代码） |
| `docs/OCUI_ANDROID_SYNC.md` | v0.6.35→v0.6.47 同步的决策与验收记录 |
| `docs/PLUGIN_HOST_P1.md` | 插件宿主 P1 交付与探针结果 |
| `docs/PI_UI_INTEGRATION.md` | Pi 集成说明（版本号可能滞后） |
| `docs/app-architecture.md` | app 侧架构 |

分析文档在仓库外：`/home/zhangtung/项目/PiUI-个人配置适配阶段分析.md`、`PiUI-架构分析.md`、`PiUI-插件适配审计.md`。

## 验证

```sh
npm run typecheck
npm run lint
npm test
```

单项：`npm run test:run -w @piui/app -- --maxWorkers=1`
