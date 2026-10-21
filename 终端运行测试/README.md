# 终端运行测试文件

在 Code Remote 右侧文件树打开此目录，右键点击任意 `sample script.*` 文件，选择“终端运行”。

每个脚本只打印脚本类型、文件路径、终端工作目录和 `status=ok`。工作目录应是本文件夹。文件名含空格、目录名含中文，可顺带检查路径引用。

- `.py` 需要 Python 3。
- `.js`、`.mjs`、`.cjs` 需要 Node.js。
- `.sh` 需要 Bash。
- `.ps1` 需要 PowerShell；Linux 终端需安装 `pwsh`。
- `.bat`、`.cmd` 只能在 Windows 的 CMD 或 PowerShell 终端运行；Linux 不能直接执行这两种批处理文件。
