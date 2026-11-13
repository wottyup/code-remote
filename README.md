# Code Remote（远程开发工作台）

<p align="center">
  <a href="CHANGELOG.md"><img src="https://img.shields.io/badge/web%20version-0.121.0--dev.1-orange?style=flat-square" alt="Web 版本 0.121.0-dev.1"></a>
  <a href="https://github.com/wottyup/code-remote/stargazers"><img src="https://img.shields.io/github/stars/wottyup/code-remote?style=flat-square" alt="GitHub 星标数"></a>
  <a href="https://github.com/wottyup/code-remote/forks"><img src="https://img.shields.io/github/forks/wottyup/code-remote?style=flat-square" alt="GitHub Fork 数"></a>
  <a href="https://github.com/wottyup/code-remote/issues"><img src="https://img.shields.io/github/issues/wottyup/code-remote?style=flat-square" alt="未关闭的问题数"></a>
  <a href="https://github.com/wottyup/code-remote/commits/main"><img src="https://img.shields.io/github/last-commit/wottyup/code-remote?style=flat-square" alt="最近提交"></a>
</p>
<p align="center">
  <a href="android/app/build.gradle"><img src="https://img.shields.io/badge/Android-8.0%2B%20%28API%2026%29-3DDC84?logo=android&amp;logoColor=white&amp;style=flat-square" alt="Android 8.0 及以上"></a>
  <a href="package.json"><img src="https://img.shields.io/badge/React-19-149ECA?logo=react&amp;logoColor=white&amp;style=flat-square" alt="React 19"></a>
  <a href="package.json"><img src="https://img.shields.io/badge/Vite-7-646CFF?logo=vite&amp;logoColor=white&amp;style=flat-square" alt="Vite 7"></a>
  <a href="server/requirements.txt"><img src="https://img.shields.io/badge/FastAPI-Python-009688?logo=fastapi&amp;logoColor=white&amp;style=flat-square" alt="FastAPI Python 后端"></a>
  <a href="android/build.gradle"><img src="https://img.shields.io/badge/Kotlin-2.0.21-7F52FF?logo=kotlin&amp;logoColor=white&amp;style=flat-square" alt="Kotlin 2.0.21"></a>
</p>

在手机浏览器和原生 Android APP 中远程查看并操作开发电脑上的 Codex 与 Claude Code。支持历史会话、实时收发消息、模型选择、附件、工作区文件和终端；代码助手运行在开发电脑上。

## 需要准备

- 已安装并完成登录的 Codex CLI，命令名为 `codex`
- Node.js 20.19+ 和 pnpm
- Python 3.10+
- 手机和电脑连接同一个可信局域网

## 首次配置

在项目目录创建 Python 虚拟环境并安装服务端依赖：

```bash
cd /code/code-remote
python3 -m venv .venv
. .venv/bin/activate
pip install -r server/requirements.txt
```

前端依赖由 `/code/pnpm-workspace.yaml` 管理。在 workspace 根目录执行过一次 `pnpm install` 后，使用下面的启动命令即可。

## 启动

日常远程使用时，在电脑终端运行以下命令，先构建网页，再同时启动本机 Codex 引擎和局域网页面：

```bash
cd /code
pnpm --filter code-remote start
```

构建后的网页资源支持压缩与缓存，适合手机长时间访问。仅在编辑前端、需要热更新时使用 `pnpm --filter code-remote dev`；开发服务器会加载较大的调试资源。

启动完成后，终端会显示首次授权新浏览器所需的配对码。手机浏览器打开 `http://电脑的局域网 IP:4173`。配对成功后，该浏览器会被记为受信任设备：即使本机服务重启也不用再次输入；新浏览器、无痕窗口或清除站点数据后才需要重新配对。电脑端本机也可以访问 `http://127.0.0.1:4173`。

网页版只连接当前打开的网址对应的 Code Remote 服务。访问另一台电脑时，直接打开那台电脑的网页地址并单独配对。

需要后台常驻时，可安装仓库中的 systemd unit：

```bash
sudo install -m 0644 /code/code-remote/deploy/code-remote.service /etc/systemd/system/code-remote.service
sudo install -m 0644 /code/code-remote/deploy/code-remote-tmux.service /etc/systemd/system/code-remote-tmux.service
sudo systemctl daemon-reload
sudo systemctl enable --now code-remote-tmux.service code-remote.service
```

此 unit 在启动时构建网页并使用构建资源。更新已安装的 unit 后需要执行 `systemctl daemon-reload`；已有服务需要在聊天任务结束后重启才能加载新版后端。该服务同时管理 Codex 子进程，重启会中断它仍在执行的任务。

常驻服务的配对码和运行日志通过下面的命令查看：

```bash
journalctl -u code-remote.service -f
```

网页服务把 API 和 WebSocket 请求转发给电脑上的 `127.0.0.1:18766`。Codex App Server 只通过本机 stdio 连接，不开放网络端口。手机与电脑之间的网页连接使用局域网 HTTP；只在可信网络中使用，并允许电脑防火墙接收 4173 端口的连接。

Windows 和 Linux 都支持。Windows 原生环境请在项目目录的 PowerShell 中创建 `.venv`，然后运行 `pnpm --filter code-remote start`，也可双击 `启动 Code Remote.bat`；启动器会自动使用 `.venv\Scripts\python.exe`，并兼容 `codex.cmd`/`codex.exe`。如果 Codex 不在 PATH 中，可显式设置：

```powershell
$env:CODE_REMOTE_COMMAND = "C:\Users\你的用户名\AppData\Roaming\npm\codex.cmd"
$env:CODE_REMOTE_WORKSPACE = "C:\path\to\your\project"
pnpm --filter code-remote start
```

Linux/macOS 的聊天终端使用 tmux 保留会话；Linux 可运行 `sudo apt-get install tmux`，macOS 可运行 `brew install tmux`。使用 systemd 时还需安装上面的 `code-remote-tmux.service`，这样 Python 服务重启后 tmux shell 仍可重新连接。电脑重启、主动停止 tmux service、输入 `exit`、会话空闲 30 分钟或未连接会话超过 10 个时会清理会话。Windows 原生终端保持临时 shell 行为。

## SSH MCP 远程服务器

在网页版“设置”→“SSH MCP 服务器”中填写服务器 IP 或主机名、端口、用户名和密码，可以添加多台主机。SSH 密码保存在运行 Code Remote 的电脑上，设置页不会回显已保存的密码。保存后，新建或重新打开的 Codex 对话会使用最新设置，正在运行的对话不受影响。当前 SSH MCP 仅接入 Codex；Claude Code 的命令审批还不能转发到网页。

后端必须和要使用的 Codex 安装在同一台主机上；Linux 后端不能直接识别另一台 Windows 主机里的 Codex 进程。

受信任设备的令牌摘要保存在用户数据目录中，原始令牌和配对码不会写入该文件。Windows 默认使用 `%LOCALAPPDATA%\CodexRemote`，避免把应用数据写入项目或受限的 Codex 运行目录；Linux/macOS 默认使用 `~/.codex/codex-remote`。网页中的“退出”会撤销当前设备；如果设备遗失，可停止服务后删除该目录中的授权文件，再启动服务使所有设备重新配对。可用 `CODE_REMOTE_HOME` 或 `CODE_REMOTE_AUTH_FILE` 设置位置。

## 工作目录和历史会话

新建对话默认使用应用仓库的上一级目录作为工作目录（例如应用位于 `/code/code-remote` 时，默认工作目录为 `/code`），因此新拉取的项目会与 `code-remote` 并列，而不是放进应用仓库内部。可以通过环境变量或启动参数更改：

```bash
CODE_REMOTE_WORKSPACE=/path/to/your/project pnpm --filter code-remote engine:dev
```

历史列表读取本机 Codex 最近 100 条未归档会话，包含其他工作目录创建的会话；打开会话后，标题下方会显示该会话的工作目录。后端监听 Codex 会话文件变化，并通过 WebSocket 通知侧栏更新，无需刷新网页。

本地 Codex App Server 默认直接使用用户级 `CODEX_HOME`，因此网页端与桌面 Codex 读取并写入同一套配置、模型和会话历史。Windows 与 Hapi 一样，优先使用 PATH 中实际解析到的 Codex CLI，并直接启动 app-server，通过仅监听 `127.0.0.1` 的随机端口和 capability token 连接；不再依赖需要额外权限的共享 daemon/control socket。npm 安装的 Codex 会从 `.cmd` shim 解析到同一安装下的 `codex.js`，再由 Node 启动。网页新建、恢复的会话由 Codex app-server 写入用户原有历史。可显式设置 `CODE_REMOTE_APP_SERVER_HOME` 固定使用独立运行目录。

## 在网页与本机 Codex 间交还会话

网页端发送过消息的会话会由网页专用 App Server 持有写入权；如果要回到本机 Codex 继续该会话，先等网页端回复结束，再点击聊天页右上角的“交还本机”并确认。该操作只关闭网页专用的 Codex 子进程，不会重启开发服务、SSH 会话或浏览器配对；网页也不会自动重新占回会话。

要再次在网页继续时，确认本机 Codex 已结束该会话的任务，再点击右上角“重新接管”。若本机仍持有会话，网页会明确提示该会话正被其他 Codex 实例使用。

## 构建

```bash
cd /code
pnpm --filter code-remote build
```

构建产物位于 `code-remote/dist`。`pnpm start` 自动构建并通过 Vite preview 提供网页，由 `scripts/dev.mjs --production` 同时启动 Python 引擎；使用 systemd 时由 `code-remote.service` 在后台持续管理。
