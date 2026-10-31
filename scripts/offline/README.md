# Pi + PiUI ARM64 离线部署

包含：固定 Pi SDK/CLI 1.0.3、PiUI server/worker、Web 前端、Node、npm、rg/fd 和平台终端模块。首次部署不需要 npm install、pkg install 或下载依赖。不包含个人凭据、会话、插件、模型权重或系统工具 Git。

## 选对包

- linux-arm64：64 位 ARM Linux，面向 Debian 12+ / Ubuntu 24.04+（glibc >= 2.36）。不是 Alpine/musl、Windows 或 Android 包。
- termux-arm64：Android ARM64、标准 com.termux 的 Termux。需已安装可用的 Termux（Android 7+）；本包不安装 App，也不替换 Termux 的系统 Node/库。其他 App ID、32 位 Android 不支持。
- Android 必须解压到 Termux 的 `$HOME` 等可执行私有目录，不能在共享 Downloads、/sdcard 或 /storage 下直接启动。
- 离线指安装和本地运行不下载依赖；访问远程模型仍需配置 provider 凭据和网络。安装额外插件也可能需要联网。

## 一键部署

先校验下载包的 SHA-256，再解压到一个新目录。不要解压覆盖旧部署目录。

Linux 示例：

```sh
tar -xzf piui-linux-arm64.tar.gz
cd piui-linux-arm64
sh deploy.sh
```

Termux：先用文件管理器/已有共享存储权限把压缩包放到 Termux 能读取的位置，再解压到 `$HOME`：

```sh
cd "$HOME"
tar -xzf /path/to/piui-termux-arm64.tar.gz
cd piui-termux-arm64
sh deploy.sh
```

`deploy.sh` 先自检 Node、原生终端和 Pi SDK，再后台启动服务。默认只监听 `127.0.0.1:8787`，不会修改防火墙、systemd、开机启动或全局 PATH。重跑不会重复启动同一实例。

### 让其他手机/设备连接

首次启动时显式允许可信局域网访问：

```sh
sh deploy.sh --listen 0.0.0.0 --port 8787
```

若已按默认方式启动，先 `./piui stop`，再执行上面的命令。Android APK 中添加服务器：

- URL：`http://该设备的局域网IP:8787`，不能填写 `0.0.0.0`，也不是手机自己的 localhost。
- Token：读取本实例 `data/server/auth-token` 的内容后填写。命令只显示文件位置，不打印密钥。不要上传 token、截图或带 token 的链接。
- 服务器 A、B 各自部署一份；分别添加两个 URL 和各自的 token，再启用多服务器模式。
- 同一网络的不同设备可以都使用 8787；同一设备多个实例须使用不同数据目录和端口。

开放局域网端口意味着持有 token 的人能操作 agent、文件和终端。仅在可信局域网/VPN 内使用；不要直接公网映射。需要公网访问时另行配置 TLS 和访问控制，本包不会替你改基础设施。

## 管理命令

```sh
./piui status
./piui stop
./piui doctor
./piui paths
./piui run --listen 0.0.0.0 --port 8787  # 前台运行，Ctrl+C 停止
./pi --version
./pi                                 # 原生 Pi 终端 CLI，保留当前工作目录
```

Termux 若直接执行脚本报解释器错误，可使用 `sh ./piui ...` / `sh ./pi ...`。后台进程可能被 Android 电池策略或进程限制终止；前台运行便于诊断。需要时由你手动配置电池白名单/唤醒锁，本包不申请额外权限。

默认数据目录为包内 `data/`，与个人 `~/.pi/agent` 分离：

- `data/agent/`：Pi 设置、provider 凭据、后续显式安装的插件。
- `data/sessions/`：会话。
- `data/server/`：PiUI 数据、自动生成的 token。
- `data/server.json`：默认监听地址和端口。命令行覆盖只作用于本次启动，不自动修改此文件。
- `data/server.log`：后台输出；`data/server.pid.json`：进程归属记录。

使用包内 Pi CLI 配置 provider，或按 Pi 的配置格式编辑上述独立目录。配置完成后重启本实例，使 worker 重新读取配置。不要把整个个人配置/自动补丁直接复制进来。Web UI 可访问，但第一次真实对话前必须配置可用的 provider。

要跨版本保留独立数据目录，所有命令都使用相同的 `PIUI_HOME`：

```sh
PIUI_HOME="$HOME/piui-data-A" ./piui start --listen 0.0.0.0 --port 8787
PIUI_HOME="$HOME/piui-data-A" ./piui status
PIUI_HOME="$HOME/piui-data-A" ./piui stop
```

第二个实例改用 `piui-data-B` 和另一个端口。每份实例独立生成 token，不要复制 A 的 token 给 B。

## 自检与故障

- `doctor` 不请求模型，不启动监听服务。它创建临时空会话测试 SDK，检查 PTY 输出与尺寸变更，结束后清理自己的夹具。
- 端口冲突/启动失败：先看 `status` 和 `data/server.log`，不要连续启动。停止命令核验 PID 及实例标识后才发 SIGTERM，不会根据陈旧 PID 杀死不相关进程，不做强制 kill。
- 只保留 `127.0.0.1` 时，其他设备无法连接，这是默认安全行为。
- Linux 的 X11 剪贴板/桌面功能、Termux 原生剪贴板和后台保活依赖系统环境，不属于服务端离线包承诺。
- Web/PiUI 的任务卡片、原生问答等能力与当前代码基线一致，本包仅解决部署，不包含问题汇总里的四个 UI 修复。

## 升级与回退

停止自己的实例，备份完整数据目录，保留旧包；解压新包到新目录，通过 PIUI_HOME 显式指向备份/迁移后的数据。不要覆盖运行中的目录，也不要让两个 server 同时使用同一数据目录。

Pi SDK 升级后不保证旧 SDK 能无损打开新版写入的会话。回退使用旧包和升级前的数据备份，不能仅替换二进制后继续写同一份数据。

`manifest.json` 记录代码/依赖基线，`runtime-lock.json` 记录外部运行时下载地址和 SHA-256；包内保留许可证和 PiUI 对应源码归档。构建来源是 Node 官方、Termux 官方、Debian 官方和 npm registry，没有携带系统代理设置或个人配置。
