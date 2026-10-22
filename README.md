# Code Remote

在手机浏览器和 Android APP 中远程查看并继续本机 Codex 与 Claude Code 对话。网页提供对话记录侧栏、聊天页面、实时消息、模型选择和图片输入；代码助手运行在开发电脑上。

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

需要后台常驻时，可安装仓库中的 systemd unit：

```bash
sudo install -m 0644 /code/code-remote/deploy/codex-remote.service /etc/systemd/system/codex-remote.service
sudo install -m 0644 /code/code-remote/deploy/codex-remote-tmux.service /etc/systemd/system/codex-remote-tmux.service
sudo systemctl daemon-reload
sudo systemctl enable --now codex-remote-tmux.service codex-remote.service
```

此 unit 在启动时构建网页并使用构建资源。更新已安装的 unit 后需要执行 `systemctl daemon-reload`；已有服务需要在聊天任务结束后重启才能加载新版后端。该服务同时管理 Codex 子进程，重启会中断它仍在执行的任务。

常驻服务的配对码和运行日志通过下面的命令查看：

```bash
journalctl -u codex-remote.service -f
```

网页服务把 API 和 WebSocket 请求转发给电脑上的 `127.0.0.1:18766`。Codex App Server 只通过本机 stdio 连接，不开放网络端口。手机与电脑之间的网页连接使用局域网 HTTP；只在可信网络中使用，并允许电脑防火墙接收 4173 端口的连接。

## 跨设备 Codex 群聊

Linux 和 Windows 各自启动 Code Remote，并分别在自己的浏览器中完成网页登录配对。选择一台设备作为房间设备，在左侧栏切换到“设备群聊”模式并创建房间；侧栏顶部的“连接另一台设备”会显示一次性设备加入码和可编辑的房间地址。在另一台电脑自己的 Code Remote 网页打开“设备群聊 → 加入房间”，填写房间设备的内网穿透域名或其他可达 HTTP/HTTPS 地址，以及设备加入码。设备加入码与网页登录配对码不同。如果房间网页当前通过穿透域名打开，该地址会自动填入；若通过 `localhost` 打开，则需手动填写穿透地址。穿透服务需允许 WebSocket 连接。左侧栏可在普通聊天列表与群聊内容间切换，右侧共用聊天区和输入框。房间设备的 Code Remote 服务需要保持运行。

群聊侧栏顶部始终提供“创建房间”和“加入房间”。如果两台设备都创建了房间，选择其中一台保留房间；另一台点击“加入房间”，按提示先解散自己的房间，再填写保留房间的设备地址和加入码。单台设备当前一次只参与一个房间。

加入后，在“发送给”中选择 `@设备名`，消息会交给那台设备上的本机 Codex，回复和其他群聊消息会同步到两边。每台设备默认会为房间创建专用 Codex 对话，也可以在群聊侧栏选择本机已有的 Codex 聊天以沿用其上下文。若 Codex 请求操作批准，请在目标设备自己的 Code Remote 聊天列表中打开对应的 Codex 对话进行处理。

Windows 和 Linux 都支持。Windows 原生环境请在项目目录的 PowerShell 中创建 `.venv`，然后运行 `pnpm --filter code-remote start`，也可双击 `启动 Code Remote.bat`；启动器会自动使用 `.venv\Scripts\python.exe`，并兼容 `codex.cmd`/`codex.exe`。如果 Codex 不在 PATH 中，可显式设置：

```powershell
$env:CODEX_REMOTE_COMMAND = "C:\Users\你的用户名\AppData\Roaming\npm\codex.cmd"
$env:CODEX_REMOTE_WORKSPACE = "C:\path\to\your\project"
pnpm --filter code-remote start
```

Linux/macOS 的聊天终端使用 tmux 保留会话；Linux 可运行 `sudo apt-get install tmux`，macOS 可运行 `brew install tmux`。使用 systemd 时还需安装上面的 `codex-remote-tmux.service`，这样 Python 服务重启后 tmux shell 仍可重新连接。电脑重启、主动停止 tmux service、输入 `exit`、会话空闲 30 分钟或未连接会话超过 10 个时会清理会话。Windows 原生终端保持临时 shell 行为。

## 阿里云百炼语音输入（可选）

首次使用时，在网页版左侧“设置”→“阿里云百炼语音”中填写 API Key、Workspace ID 和地域，保存后立即生效，无需重启。API Key 保存在服务端本机的配置文件中，不会返回给浏览器；Linux/macOS 下该文件仅允许服务用户读写。默认实时模型为 `qwen3.8-omni-flash-realtime`，默认转写模型为 `qwen3-asr-flash-realtime`；模型也可以在高级设置中调整。

仍可通过 `DASHSCOPE_API_KEY`、`BAILIAN_WORKSPACE_ID`、`BAILIAN_REGION`、`BAILIAN_REALTIME_MODEL` 和 `BAILIAN_TRANSCRIPTION_MODEL` 环境变量配置。环境变量会作为项目设置的回退值；“恢复服务器环境变量”会清除项目内保存的配置。

语音输入仅转写并插入输入框，不会自动发送。浏览器麦克风要求 HTTPS 安全连接；电脑本机的 `localhost` 可直接使用，但手机通过局域网 IP 访问 HTTP 页面时，浏览器会禁止麦克风，需要通过 HTTPS 访问。

后端必须和要使用的 Codex 安装在同一台主机上；Linux 后端不能直接识别另一台 Windows 主机里的 Codex 进程。

受信任设备的令牌摘要保存在用户数据目录中，原始令牌和配对码不会写入该文件。Windows 默认使用 `%LOCALAPPDATA%\CodexRemote`，避免把应用数据写入项目或受限的 Codex 运行目录；Linux/macOS 默认使用 `~/.codex/codex-remote`。网页中的“退出”会撤销当前设备；如果设备遗失，可停止服务后删除该目录中的授权文件，再启动服务使所有设备重新配对。可用 `CODEX_REMOTE_HOME` 或 `CODEX_REMOTE_AUTH_FILE` 设置位置。

## 工作目录和历史会话

新建对话默认使用应用仓库的上一级目录作为工作目录（例如应用位于 `/code/code-remote` 时，默认工作目录为 `/code`），因此新拉取的项目会与 `code-remote` 并列，而不是放进应用仓库内部。可以通过环境变量或启动参数更改：

```bash
CODEX_REMOTE_WORKSPACE=/path/to/your/project pnpm --filter code-remote engine:dev
```

历史列表读取本机 Codex 最近 100 条未归档会话，包含其他工作目录创建的会话；打开会话后，标题下方会显示该会话的工作目录。后端监听 Codex 会话文件变化，并通过 WebSocket 通知侧栏更新，无需刷新网页。

本地 Codex App Server 默认直接使用用户级 `CODEX_HOME`，因此网页端与桌面 Codex 读取并写入同一套配置、模型和会话历史。Windows 与 Hapi 一样，优先使用 PATH 中实际解析到的 Codex CLI，并直接启动 app-server，通过仅监听 `127.0.0.1` 的随机端口和 capability token 连接；不再依赖需要额外权限的共享 daemon/control socket。npm 安装的 Codex 会从 `.cmd` shim 解析到同一安装下的 `codex.js`，再由 Node 启动。网页新建、恢复的会话由 Codex app-server 写入用户原有历史。可显式设置 `CODEX_REMOTE_APP_SERVER_HOME` 固定使用独立运行目录。

## 在网页与本机 Codex 间交还会话

网页端发送过消息的会话会由网页专用 App Server 持有写入权；如果要回到本机 Codex 继续该会话，先等网页端回复结束，再点击聊天页右上角的“交还本机”并确认。该操作只关闭网页专用的 Codex 子进程，不会重启开发服务、SSH 会话或浏览器配对；网页也不会自动重新占回会话。

要再次在网页继续时，确认本机 Codex 已结束该会话的任务，再点击右上角“重新接管”。若本机仍持有会话，网页会明确提示该会话正被其他 Codex 实例使用。

## 构建

```bash
cd /code
pnpm --filter code-remote build
```

构建产物位于 `code-remote/dist`。`pnpm start` 自动构建并通过 Vite preview 提供网页，由 `scripts/dev.mjs --production` 同时启动 Python 引擎；使用 systemd 时由 `codex-remote.service` 在后台持续管理。
