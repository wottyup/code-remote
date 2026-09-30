# Codex Remote

在手机浏览器里远程查看和继续本机 Codex 对话。网页提供对话记录侧栏、聊天页面和实时消息；Codex CLI 与 App Server 都运行在开发电脑上。

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

在电脑上打开两个终端。

终端一启动本机服务。后端默认仅监听 `127.0.0.1:18766`，并在终端打印一次性配对码：

```bash
cd /code
source /code/codex-remote/.venv/bin/activate
pnpm --filter codex-remote engine:dev
```

终端二启动可从局域网访问的网页：

```bash
cd /code
pnpm --filter codex-remote dev:lan
```

在手机浏览器打开 `http://电脑的局域网 IP:4173`，输入终端一显示的配对码。电脑端本机也可以访问 `http://127.0.0.1:4173`。

网页开发服务器把 API 和 WebSocket 请求转发给电脑上的 `127.0.0.1:18766`。Codex App Server 只通过本机 stdio 连接，不开放网络端口。手机与电脑之间的网页连接使用局域网 HTTP；只在可信网络中使用，并允许电脑防火墙接收 4173 端口的连接。

## 工作目录和历史会话

新建对话默认使用 `/code/codex-remote` 作为工作目录。可以通过环境变量或启动参数更改：

```bash
CODEX_REMOTE_WORKSPACE=/path/to/your/project pnpm --filter codex-remote engine:dev
```

历史列表读取本机 Codex 最近 100 条未归档会话，包含其他工作目录创建的会话；打开会话后，标题下方会显示该会话的工作目录。后端监听 Codex 会话文件变化，并通过 WebSocket 通知侧栏更新，无需刷新网页。

## 构建

```bash
cd /code
pnpm --filter codex-remote build
```

构建产物位于 `codex-remote/dist`。本项目当前通过 Vite 开发/预览服务器提供网页，Python 服务仍需单独启动。
