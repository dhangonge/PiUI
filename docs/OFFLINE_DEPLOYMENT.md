# Linux ARM64 / Termux ARM64 离线部署记录

## 范围

本轮仅解决把 Pi 本身、PiUI server/worker/Web 和运行时部署到其他设备，便于多服务器测试。未修改 Todo 卡片、过程折叠闪烁、通知开关或问答全屏界面。没有复制个人 Pi 配置、凭据、会话、插件或开发签名密钥。

安装包使用独立数据目录；目标机首次部署不需要 npm/pkg install。它不是操作系统镜像：需要相应 Linux 基础系统或已安装可用的 Termux。模型服务、额外插件和系统工具 Git 不在离线承诺内。

使用说明位于 `scripts/offline/README.md`，随每份包交付。

## 组成与版本

| 项目         | Linux ARM64                                         | Android Termux ARM64                      |
| ------------ | --------------------------------------------------- | ----------------------------------------- |
| Pi SDK / CLI | 1.3.0                                               | 1.3.0                                     |
| Node         | 官方 24.21.0                                        | Termux nodejs-lts 24.18.0-1               |
| npm          | 官方 Node 包自带 11.19.0                            | 相同 npm JS，使用 Android Node            |
| rg / fd      | Debian 12 的 ripgrep 13.0.0 / fd 8.6.0              | Termux ripgrep 15.2.0 / fd 10.5.0         |
| PTY          | @lydell/node-pty-linux-arm64 1.2.0-beta.14          | node-pty 1.1.0 源码，NDK 交叉编译 N-API 8 |
| C 运行库     | 系统 glibc >= 2.36；面向 Debian 12+ / Ubuntu 24.04+ | Android bionic；不能使用 Linux glibc 包   |

Android PTY 构建使用 NDK 28.0.13004108、API 24、node-addon-api 8.5.0 头文件，静态链接 C++ 运行库；产物只依赖 Android libc/libm/libdl。其上游源码声明 node-addon-api ^7.1.0 是构建依赖，当前固定头文件组合已经实测加载和 PTY 操作。

Linux 包按二进制设置 `$ORIGIN/../lib` RUNPATH，携带 libstdc++/libgcc/pcre2，不向用户 shell 全局导出 Linux LD_LIBRARY_PATH。ELF 修改采用 64 KiB 页对齐，兼容更小页大小。Android 包仅在自身启动环境设置运行库路径，保留 Termux 提供的库及必要符号链接。

## 构建

构建机：Linux x86_64，已安装项目 npm 依赖、Node >=22.19、curl、tar、ar、patchelf；Termux 包额外需要 Android NDK。不是在目标手机上编译。

```sh
npm run build
node scripts/build-offline.mjs linux-arm64 /new/path/piui-linux-arm64
NDK_HOME=/path/to/android-ndk node scripts/build-offline.mjs termux-arm64 /new/path/piui-termux-arm64
```

输出目录必须不存在，避免覆盖旧部署和数据。缓存默认 `~/.cache/piui-offline`，可用 `PIUI_OFFLINE_CACHE` 改到磁盘目录。失败产物不自动覆盖/删除，修复后选择新的输出目录。

- 外部包固定在 `scripts/offline/lock.json`；每次使用缓存和下载都验证 SHA-256。
- Node 初始 SHA 来自官方 SHASUMS256；npm tar 包与 registry 的 SHA-512 核对；Termux、Debian deb 与官方 Packages 元数据核对，再固定为构建锁。
- 打包当前安装的生产依赖闭包，检查 package-lock 中的版本；不拷贝整个开发 node_modules，也不带 Bun backend 或构建机 x64 PTY。当前闭包 129 个包，目标 PTY 单独注入。
- `manifest.json` 记录代码提交、工作区是否有修改、package-lock SHA-256、运行时包清单。正式交付须从干净提交生成。
- `piui-source.tar.gz` 包含对应已跟踪源码；运行时包内保留许可证和 Debian版权说明。外部运行时锁随包提供。
- Pi CLI 直接使用 SDK 的 CLI 入口，保留调用者工作目录；服务端直接调用 startPiUiServer，避免旧 bundle-entry 根据当前目录误选全局 SDK/native modules。

## 验证结果与边界

已验证：

1. 四包 TypeScript 检查通过；server 126 项通过、2 项既有 skip；独立 launcher 集成测试通过。
2. launcher 集成测试：两份 PIUI_HOME、两个监听端口；独立 token；无 token/外来 token 返回 401；健康接口与 Web 首页可用；重复启动不重复创建进程；停止 A 不影响 B；拒绝停止无关 PID；日志不输出 token。
3. Android ARM64 实机，仅在用户同意的新建 `/data/local/tmp/piui-offline-test-*` 目录测试：Node、npm、Pi CLI 版本，rg/fd 文件搜索，PTY 创建/读输出/调尺寸/退出，真实 Pi SDK 会话及扩展初始化全部通过。没有模型请求、安装 App、访问现有 Termux 数据或开放端口。
4. Linux ARM64 在本机 QEMU 用户态验证：Node、Pi CLI、rg/fd、匹配架构的 PTY 和真实 SDK 初始化通过。没有安装全局 binfmt；测试专用 preload 将 rg/fd 子进程显式交给 QEMU，该 preload 不进入交付包。
5. server 启动日志现在只显示 Web URL 和 token 文件位置，不自动拼接带 token 的 URL；已增加不泄漏 token 的回归断言。

尚未验证：Linux ARM64 真机完整服务流程；Termux App 用户环境中的完整 server/worker、真实 provider 和 Android 后台长期存活。Android shell 临时目录测试不能冒充 Termux App 内验收；QEMU 测试也不能冒充 Linux 真机测试。

本轮 vtsls 对 start.ts 返回 diagnostics timeout；使用通过的 tsc 和实际 server 测试作为代码验证，不把超时说成零诊断。

## 目标设备首次验收

- 解压新目录，运行 `sh deploy.sh`，确认 doctor 全部通过、服务健康。
- 在可信网络下显式加 `--listen 0.0.0.0`；在 APK 中添加 URL 和本实例 token。
- 两设备均出现会话列表，分别创建会话、发送一条测试消息、打开终端执行 `pwd`。
- 多服务器模式切换焦点，确认消息/目录/终端不串服务器；停止 A 后 B 仍可操作。
- Termux 额外检查退后台、锁屏和恢复；操作系统可能限制后台进程，需要用户自行决定电池策略。

不默认添加系统服务、修改防火墙、提升权限或开放公网。启停只管理自己的实例，不强制 kill。升级先停止、备份数据、解压到新目录；回退保留旧包及升级前的数据，不能假设旧 SDK 能读取新版写入格式。
