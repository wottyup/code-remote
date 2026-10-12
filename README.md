# Codex Remote

在手机浏览器里远程查看和继续本机 Codex 对话。网页提供对话记录侧栏、聊天页面、实时消息、模型选择和图片输入；Codex CLI 与 App Server 都运行在开发电脑上。

## 需要准备

- 已安装并完成登录的 Codex CLI，命令名为 `codex`
- Node.js 20.19+ 和 pnpm
- Python 3.10+
- 手机和电脑连接同一个可信局域网

## 首次配置

在项目目录创建 Python 虚拟环境并安装服务端依赖：

```bash
cd /code/codex-remote
python3 -m venv .venv
. .venv/bin/activate
pip install -r server/requirements.txt
```

前端依赖由 `/code/pnpm-workspace.yaml` 管理。在 workspace 根目录执行过一次 `pnpm install` 后，使用下面的启动命令即可。

## 启动

在电脑终端运行一次即可同时启动本机 Codex 引擎和局域网页面：

```bash
cd /code
pnpm --filter codex-remote dev
```

启动完成后，终端会显示首次授权新浏览器所需的配对码。手机浏览器打开 `http://电脑的局域网 IP:4173`；当前电脑可使用 `http://192.168.15.22:4173`。配对成功后，该浏览器会被记为受信任设备：即使本机服务重启也不用再次输入；新浏览器、无痕窗口或清除站点数据后才需要重新配对。电脑端本机也可以访问 `http://127.0.0.1:4173`。

需要后台常驻时，可安装仓库中的 systemd unit：

```bash
sudo install -m 0644 /code/codex-remote/deploy/codex-remote.service /etc/systemd/system/codex-remote.service
sudo systemctl daemon-reload
sudo systemctl enable --now codex-remote.service
```

常驻服务的配对码和运行日志通过下面的命令查看：

```bash
journalctl -u codex-remote.service -f
```

网页开发服务器把 API 和 WebSocket 请求转发给电脑上的 `127.0.0.1:18766`。Codex App Server 只通过本机 stdio 连接，不开放网络端口。手机与电脑之间的网页连接使用局域网 HTTP；只在可信网络中使用，并允许电脑防火墙接收 4173 端口的连接。

Windows 和 Linux 都支持。Windows 原生环境请在项目目录的 PowerShell 中创建 `.venv`，然后直接运行同一条 `pnpm --filter codex-remote dev`；启动器会自动使用 `.venv\Scripts\python.exe`，并兼容 `codex.cmd`/`codex.exe`。如果 Codex 不在 PATH 中，可显式设置：

```powershell
$env:CODEX_REMOTE_COMMAND = "C:\Users\你的用户名\AppData\Roaming\npm\codex.cmd"
$env:CODEX_REMOTE_WORKSPACE = "C:\path\to\your\project"
pnpm --filter codex-remote dev
```

后端必须和要使用的 Codex 安装在同一台主机上；Linux 后端不能直接识别另一台 Windows 主机里的 Codex 进程。

受信任设备的令牌摘要保存于 `~/.codex/codex-remote/trusted-devices.json`，原始令牌和配对码不会写入该文件。网页中的“退出”会撤销当前设备；如果设备遗失，可停止服务后删除该文件，再启动服务使所有设备重新配对。可用 `CODEX_REMOTE_AUTH_FILE` 设置该状态文件的位置。

## 工作目录和历史会话

新建对话默认使用应用仓库的上一级目录作为工作目录（例如应用位于 `/code/codex-remote` 时，默认工作目录为 `/code`），因此新拉取的项目会与 `codex-remote` 并列，而不是放进应用仓库内部。可以通过环境变量或启动参数更改：

```bash
CODEX_REMOTE_WORKSPACE=/path/to/your/project pnpm --filter codex-remote engine:dev
```

历史列表读取本机 Codex 最近 100 条未归档会话，包含其他工作目录创建的会话；打开会话后，标题下方会显示该会话的工作目录。后端监听 Codex 会话文件变化，并通过 WebSocket 通知侧栏更新，无需刷新网页。

本地 Codex App Server 默认直接使用用户级 `CODEX_HOME`，因此网页端与桌面 Codex 读取并写入同一套配置、模型和会话历史。Windows 会先通过 Codex 官方共享 daemon 与 stdio proxy 接入主运行时，启动器优先使用官方受控 CLI；如果 Codex 的 Windows 沙箱令牌不能访问桌面实例私有的 daemon socket，服务会自动切换到兼容运行时，不会无限重连。兼容运行时继续读取主 `.codex` 的模型和配置，并在主 `.codex/sessions` 可写时将网页会话同步到本机 Codex 历史。桌面侧栏还依赖主 `state_5.sqlite` 索引；该文件可写时会补登网页会话，无写入权限时则保留网页会话，待以有权限的终端启动后补登。可显式设置 `CODEX_REMOTE_APP_SERVER_HOME` 固定使用独立运行目录。

## 在网页与本机 Codex 间交还会话

网页端发送过消息的会话会由网页专用 App Server 持有写入权；如果要回到本机 Codex 继续该会话，先等网页端回复结束，再点击聊天页右上角的“交还本机”并确认。该操作只关闭网页专用的 Codex 子进程，不会重启开发服务、SSH 会话或浏览器配对；网页也不会自动重新占回会话。

要再次在网页继续时，确认本机 Codex 已结束该会话的任务，再点击右上角“重新接管”。若本机仍持有会话，网页会明确提示该会话正被其他 Codex 实例使用。

## 构建

```bash
cd /code
pnpm --filter codex-remote build
```

构建产物位于 `codex-remote/dist`。本项目通过 Vite 提供网页，并由 `scripts/dev.mjs` 同时启动 Python 引擎；使用 systemd 时由 `codex-remote.service` 在后台持续管理。
