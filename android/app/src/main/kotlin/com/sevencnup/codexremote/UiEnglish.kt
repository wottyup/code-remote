package com.sevencnup.codexremote

/** UI copy only. Chat messages, file contents, paths and model identifiers stay untouched. */
internal object UiEnglish {
    private val strings = mapOf(
        "设置" to "Settings", "偏好保存在本机" to "Preferences are saved on this device",
        "主题" to "Theme", "选择工作区色彩；自定义主题支持背景图片与颜色。" to "Choose workspace colors. Custom themes support images and colors.",
        "白色" to "Light", "黑色" to "Dark", "暖色" to "Warm", "旧经典" to "Old Classic",
        "像素风" to "Pixel Art", "深蓝像素面板与独立像素图标" to "Deep navy pixel panels and custom pixel icons",
        "自定义主题" to "Custom theme",
        "清爽明亮" to "Bright and clean", "低光阅读" to "Comfortable in low light", "柔和纸感" to "Soft paper tones",
        "颜色、图片与透明度" to "Colors, image and opacity", "背景颜色" to "Background color", "字体颜色" to "Text color",
        "背景图片" to "Background image", "选择图片" to "Choose image", "更换或清除当前图片" to "Replace or remove image",
        "清除背景图片" to "Remove background image", "保留自定义颜色" to "Keep custom colors",
        "背景透明度" to "Background opacity", "数值越高，全局背景图片越透明。" to "Higher values make the global background image more transparent.",
        "显示" to "Display", "字体大小会同时影响聊天、输入框、侧栏、文件区和设置页面。" to "Font size affects chat, composer, sidebars, files and settings.",
        "全局字体" to "Global font", "全局字体大小" to "Global font size", "标准" to "Standard",
        "语言" to "Language", "选择 APP 界面使用的语言；聊天和文件内容保持原文。" to "Choose the app language. Chats and files keep their original text.",
        "简体中文" to "Simplified Chinese", "已选择" to "Selected", "关于与更新" to "About and updates",
        "手动检查项目公开发布的 Android 版本。" to "Check publicly released Android versions manually.",
        "检查更新" to "Check for updates", "正在检查更新…" to "Checking for updates…",
        "尚无公开发布的 Android 版本" to "No public Android release is available yet",
        "当前已是最新发布版本" to "You have the latest published version",
        "发现新版本" to "New version available", "查看发布页" to "View release",
        "检查更新失败，请稍后重试" to "Update check failed. Try again later.",
        "系统通知" to "System notifications", "应用在后台时提醒回复完成；通知不包含聊天正文。" to "Get a completion alert in the background. Notifications omit chat content.",
        "回复完成提醒" to "Reply completion alerts", "发送测试通知" to "Send test notification",
        "检查手机是否允许 APP 显示通知" to "Check whether this phone allows app notifications",
        "已开启" to "On", "已关闭" to "Off", "系统通知已开启" to "System notifications enabled",
        "系统通知已关闭" to "System notifications disabled", "请先开启系统通知" to "Enable system notifications first",
        "手机尚未授予通知权限" to "Notification permission has not been granted",
        "手机系统已关闭此 APP 的通知" to "Notifications are disabled for this app",
        "手机系统已关闭此通知类别" to "This notification category is disabled",
        "未获得通知权限" to "Notification permission denied", "通知通道已就绪。" to "Notification channel is ready.",
        "连接" to "Connections", "保存多台电脑，点击即可切换。" to "Save multiple computers and tap to switch.",
        "电脑服务已连接" to "Computer connected", "电脑服务等待连接" to "Waiting for computer",
        "添加电脑连接" to "Add computer", "输入地址和匹配码" to "Enter address and pairing code",
        "本机配对" to "Device pairing", "管理当前电脑的配对凭据。" to "Manage pairing for the current computer.",
        "解除当前连接配对" to "Unpair current connection", "其它已保存的连接仍可切换" to "Other saved connections remain available",
        "解除配对" to "Unpair", "解除当前电脑的配对？" to "Unpair this computer?", "解除" to "Unpair",
        "对话工作台" to "Chat workspace", "搜索聊天记录" to "Search chats", "搜索" to "Search",
        "清除搜索" to "Clear search", "新建对话" to "New chat", "最近对话" to "Recent chats",
        "刷新对话列表" to "Refresh chats", "当前模式暂无对话" to "No chats in this mode",
        "没有匹配的对话" to "No matching chats", "继续输入名称可搜索其余对话" to "Keep typing to search more chats",
        "切换配置" to "Switch", "重连" to "Reconnect",
        "切换电脑连接" to "Switch computer", "当前连接" to "Current connection",
        "当前" to "Current", "已完成回复" to " has finished",
        "打开对话列表" to "Open chats", "关闭对话列表" to "Close chats",
        "排队消息" to "Queued messages", "展开排队消息" to "Expand queued messages",
        "收起排队消息" to "Collapse queued messages", "修改排队消息" to "Edit queued message",
        "立即发送" to "Send now", "删除排队消息" to "Delete queued message",
        "确认修改排队消息" to "Save queued edit", "取消修改排队消息" to "Cancel queued edit",
        "正在修改排队消息" to "Editing queued message", "编辑排队消息…" to "Edit queued message…",
        "（附件消息）" to "(Attachment message)", "默认模型" to "Default model", "默认" to "Default",
        "模型" to "Model", "思考" to "Reasoning", "思考等级" to "Reasoning level",
        "权限" to "Permission", "权限模式" to "Permission mode", "完全访问" to "Full access",
        "自动模式" to "Auto", "手动确认" to "Ask first", "不询问" to "Never ask",
        "不询问（拒绝需授权操作）" to "Never ask (deny protected actions)",
        "自动编辑" to "Auto edit", "自动接受编辑" to "Auto accept edits",
        "低" to "Low", "中" to "Medium", "高" to "High", "极高" to "Very high",
        "最大" to "Maximum", "最小" to "Minimum", "本机默认" to "Device default",
        "本机默认模型" to "Device default model", "本机默认权限" to "Device default permission",
        "添加图片或文件" to "Add image or file", "发送消息" to "Send message",
        "发送" to "Send", "发送消息…" to "Write a message…",
        "暂停当前回复" to "Pause reply", "继续回复：发送续写请求" to "Continue reply by sending a follow-up",
        "已停止当前回复；点继续会发送续写请求" to "Reply stopped. Continue sends a follow-up request.",
        "继续回复失败" to "Could not continue reply", "暂停失败" to "Could not pause reply",
        "发送失败" to "Send failed", "新建对话失败" to "Could not create chat",
        "正在思考…" to "Thinking…", "正在等待连接…" to "Waiting for connection…",
        "回到底部" to "Scroll to bottom", "最近编辑文件" to "Recently edited files",
        "操作记录" to "Activity log", "展开或收起最近编辑文件" to "Toggle recently edited files",
        "修改文件" to "Changed files", "查看文件" to "View file", "查看图片" to "View image",
        "关闭图片" to "Close image", "关闭文件预览" to "Close file preview",
        "关闭修改预览" to "Close diff preview", "文件" to "File", "文件夹" to "Folder",
        "空文件夹" to "Empty folder", "图片无法加载" to "Could not load image",
        "图片过大，已跳过内嵌预览" to "Image too large for inline preview",
        "这条编辑记录没有保存可审核的差异片段。" to "No reviewable diff was saved for this edit.",
        "工作区" to "Workspace", "本机项目" to "Local project", "刷新文件树" to "Refresh files",
        "关闭文件树" to "Close files", "打开文件树" to "Open files",
        "↑ 上级" to "↑ Parent", "↻ 跟随聊天" to "↻ Follow chat",
        "点按文件夹展开 · 长按查看更多操作" to "Tap folders to expand · long press for more actions",
        "目录内容较多，仅显示前 400 项" to "Large directory: showing the first 400 items",
        "无法读取文件目录" to "Could not read directory", "正在加载文件…" to "Loading files…",
        "文件还在加载" to "File is still loading", "重新加载" to "Reload",
        "新建文件" to "New file", "新建文件夹" to "New folder", "新建文件或文件夹" to "New file or folder",
        "输入服务端目录路径" to "Enter server directory path", "请输入目录路径" to "Enter a directory path",
        "复制" to "Copy", "复制消息" to "Copy message", "复制代码" to "Copy code", "代码" to "Code",
        "剪切" to "Cut", "粘贴" to "Paste", "粘贴到此处" to "Paste here", "聊天消息" to "Chat message",
        "重命名" to "Rename", "删除" to "Delete", "打开" to "Open", "新建" to "New",
        "创建" to "Create", "保存" to "Save", "取消" to "Cancel", "确定" to "OK",
        "关闭" to "Close", "返回聊天" to "Back to chat", "应用" to "Apply",
        "名称" to "Name", "聊天名称" to "Chat name", "删除聊天" to "Delete chat",
        "取消置顶" to "Unpin", "置顶" to "Pin", "已置顶" to "Pinned",
        "加入输入框" to "Add to composer", "已加入输入框" to "Added to composer",
        "该路径已在输入框中" to "This path is already in the composer",
        "剪贴板为空" to "Clipboard is empty", "已复制" to "Copied", "已剪切" to "Cut",
        "已保存" to "Saved", "已展开" to "Expanded", "已收起" to "Collapsed",
        "已绑定当前聊天的工作路径" to "Workspace bound to this chat",
        "绑定当前聊天到此目录" to "Bind this directory to the chat",
        "本机终端" to "Local terminal", "打开终端" to "Open terminal", "关闭终端" to "Close terminal",
        "终端命令" to "Terminal command", "执行命令" to "Run command",
        "复制到输入框" to "Copy to composer", "等待终端输出…" to "Waiting for terminal output…",
        "正在连接终端…" to "Connecting terminal…", "终端会话已结束" to "Terminal session ended",
        "终端还在连接，命令先留在输入框里" to "Terminal is connecting. Command kept in the input field.",
        "请求批准" to "Approval requested", "需要批准" to "Approval required",
        "允许一次" to "Allow once", "批准" to "Approve", "拒绝" to "Deny",
        "帮我批准" to "Approve for me", "授权" to "Authorization",
        "对话操作" to "Chat actions", "回复完成" to "Reply complete",
        "另一模式的对话已完成回复" to "A chat in the other mode has finished",
        "关闭完成提示" to "Dismiss completion notice", "关闭模式提示" to "Dismiss mode notice",
        "新消息将发送到当前模式" to "New messages go to the current mode",
        "与 Codex 完成一个伟大项目" to "Build a great project with Codex",
        "与 Claude Code 完成一个伟大项目" to "Build a great project with Claude Code",
        "正在加载聊天记录…" to "Loading chat history…", "聊天记录暂时没有加载出来" to "Chat history could not be loaded",
        "重试加载" to "Retry", "正在加载更早的对话…" to "Loading older chats…",
        "读取对话列表失败" to "Could not load chats", "读取对话失败" to "Could not load chat",
        "读取排队消息失败" to "Could not load queued messages", "读取附件失败" to "Could not read attachment",
        "队列操作失败" to "Queue action failed", "请求失败" to "Request failed",
        "消息内容和附件不能同时为空" to "Add a message or attachment",
        "请先保存或取消排队消息编辑" to "Save or cancel the queued edit first",
        "请先结束排队消息编辑" to "Finish the queued edit first",
        "无法编辑这条排队消息" to "Could not edit this queued message",
        "修改排队消息失败" to "Could not save queued edit",
        "连接本机 Codex" to "Connect to Codex", "检测并连接" to "Check and connect",
        "电脑 IP 或网页地址" to "Computer IP or web address", "电脑网页地址" to "Computer web address",
        "连接名称" to "Connection name", "连接名称（可选）" to "Connection name (optional)",
        "匹配码" to "Pairing code", "电脑终端显示的匹配码" to "Pairing code shown on the computer",
        "输入电脑终端显示的匹配码" to "Enter the pairing code shown on the computer",
        "电脑网页地址 · 只填 IP 时默认使用 4173 端口" to "Computer web address · IP alone uses port 4173",
        "连接失败，请检查地址和匹配码" to "Connection failed. Check the address and pairing code.",
        "连接失败，请确认电脑服务和匹配码。" to "Connection failed. Check the computer service and pairing code.",
        "电脑地址无效" to "Invalid computer address", "请输入连接名称" to "Enter a connection name",
        "请输入电脑端匹配码" to "Enter the computer pairing code",
        "这个连接需要重新配对。" to "This connection must be paired again.",
        "重新配对" to "Pair again", "重命名连接" to "Rename connection", "删除连接" to "Delete connection",
        "电脑服务暂时无法连接，已保留配对信息，正在重试。" to "Computer unavailable. Pairing is saved; retrying.",
        "正在连接电脑服务并验证配对码…" to "Connecting and verifying pairing code…",
        "手机需要能访问电脑上的 Codex Remote 服务。地址和配对码只用于本机连接。" to "This phone must reach Codex Remote on your computer. The address and code stay on this device.",
        "输入电脑网页地址和终端显示的匹配码。配对信息保存在本机，之后会自动重连。" to "Enter the computer address and pairing code. This device saves pairing for automatic reconnection.",
        "没有可用的图片选择器" to "No image picker available", "没有可用的文件选择器" to "No file picker available",
        "请输入 #RRGGBB 格式的颜色" to "Enter a color in #RRGGBB format",
        "点选色卡，或输入 #RRGGBB。" to "Tap a swatch or enter #RRGGBB.",
        "颜色预览" to "Color preview", "常用色阶" to "Common colors",
        "当前颜色" to "Current color", "读取失败，点此重试" to "Could not load. Tap to retry.",
        "正在连接…" to "Connecting…", "正在读取…" to "Reading…", "加载失败" to "Loading failed",
    )

    private val extra = mapOf(
        "新对话" to "New chat", "有一条新的回复。打开查看对话。" to "A reply is ready. Open the chat to view it.",
        "Claude Code 不可用" to "Claude Code is unavailable", "Codex 已连接" to "Codex connected",
        "Codex 请求失败" to "Codex request failed", "Codex 连接失败" to "Codex connection failed",
        "Codex 请求执行一项需要批准的操作。" to "Codex requested approval for an action.",
        "正在连接 Codex…" to "Connecting to Codex…", "正在连接电脑终端…" to "Connecting to computer terminal…",
        "图片内容无法解析" to "Could not decode image", "图片过大" to "Image too large",
        "图片过大，无法在 APP 内预览" to "Image too large to preview in the app",
        "设备内存不足，无法预览该图片" to "Not enough memory to preview this image",
        "搜索文件" to "Search files", "搜索资料" to "Search content",
        "删除所选内容" to "Delete selected items", "配置文件" to "Configuration file",
        "图片文件" to "Image file", "压缩文件" to "Archive", "数据库文件" to "Database file",
        "JSON 数据文件" to "JSON file", "Java 文件" to "Java file", "JavaScript 文件" to "JavaScript file",
        "Kotlin 文件" to "Kotlin file", "Markdown 文档" to "Markdown document",
        "Python 文件" to "Python file", "TypeScript 文件" to "TypeScript file", "样式文件" to "Stylesheet",
        "终端脚本" to "Shell script", "终端连接失败" to "Terminal connection failed",
        "终端连接信息发送失败" to "Could not send terminal connection details",
        "连接成功，正在恢复终端会话…" to "Connected. Restoring terminal session…",
        "处理任务" to "Process task", "整理计划" to "Organize plan", "计划" to "Plan",
        "计划模式" to "Plan mode", "生成图片" to "Generate image", "标记文件" to "Mark files",
        "调用工具" to "Call tool", "运行子任务" to "Run subtask", "读取技能" to "Read skill",
        "填写地址和匹配码" to "Enter address and pairing code",
        "请输入电脑终端显示的匹配码。" to "Enter the pairing code shown on the computer.",
        "配对已失效，请重新输入匹配码。" to "Pairing expired. Enter the code again.",
        "服务器返回了不匹配的聊天记录。" to "Server returned a different chat.",
        "关闭应用" to "Close app", "要关闭 Codex Remote 吗？" to "Close Codex Remote?",
        "打开文件" to "Open file", "排队图片" to "Queued image",
    )

    private val activityLabels = mapOf(
        "正在思考" to "Thinking",
        "正在整理执行计划" to "Preparing an execution plan",
        "正在生成回复" to "Writing a response",
        "正在回复" to "Replying",
        "正在读取" to "Reading",
        "正在运行" to "Running",
        "正在搜索文件" to "Searching files",
        "正在搜索资料" to "Searching content",
        "正在修改文件" to "Editing files",
        "正在查看图片" to "Viewing image",
        "正在生成图片" to "Generating image",
        "正在运行子任务" to "Running subtask",
        "正在协调子任务" to "Coordinating subtask",
        "正在调用 MCP 工具" to "Calling MCP tool",
        "正在调用工具" to "Calling tool",
        "正在处理" to "Working",
    )

    fun translate(value: String): String {
        strings[value]?.let { return it }
        extra[value]?.let { return it }
        activityLabels.entries.firstOrNull { (source, _) -> value == source || value.startsWith("$source ") }?.let { (source, translated) ->
            return translated + value.removePrefix(source)
        }
        return when {
            value.startsWith("排队消息 · ") -> value.replaceFirst("排队消息 · ", "Queued messages · ")
            value.startsWith("最近编辑文件 · ") -> value.replaceFirst("最近编辑文件 · ", "Recently edited files · ")
            value.startsWith("模型：") -> value.replace("模型：", "Model: ").replace("思考：", "Reasoning: ")
            value.startsWith("当前版本 ") -> value.replaceFirst("当前版本 ", "Current version ")
            value.startsWith("发现版本 ") -> value.replaceFirst("发现版本 ", "Version ").replace("。打开发布页面查看安装包？", " is available. Open the release page?")
            value.startsWith("切换到 ") -> value.replaceFirst("切换到 ", "Switch to ")
            value.startsWith("当前连接 ") -> value.replaceFirst("当前连接 ", "Current connection: ")
            value.startsWith("已切换到 ") -> value.replaceFirst("已切换到 ", "Switched to ")
            value.startsWith("查看其余 ") && value.endsWith(" 项") -> value.replaceFirst("查看其余 ", "Show remaining ").replace(" 项", " items")
            value.endsWith(" · 当前") -> value.removeSuffix(" · 当前") + " · Current"
            value.startsWith("删除 ") -> value.replaceFirst("删除 ", "Delete ")
            value.startsWith("重命名 ") -> value.replaceFirst("重命名 ", "Rename ")
            value.startsWith("最近编辑文件") -> value.replaceFirst("最近编辑文件", "Recently edited files")
            value.startsWith("加载更早的 ") -> value.replaceFirst("加载更早的 ", "Load ").replace(" 轮对话", " older turns")
            value.startsWith("显示更早的 ") -> value.replaceFirst("显示更早的 ", "Show ").replace(" 轮对话", " older turns")
            value.startsWith("点按重试 · ") -> value.replaceFirst("点按重试 · ", "Tap to retry · ")
            value.endsWith("\n点此重新加载") -> value.removeSuffix("\n点此重新加载") + "\nTap to reload"
            value.startsWith("打开文件 ") -> value.replaceFirst("打开文件 ", "Open file ")
            value.startsWith("查看图片 ") -> value.replaceFirst("查看图片 ", "View image ")
            value.startsWith("思考开始时间 ") -> value.replaceFirst("思考开始时间 ", "Thinking started at ")
            value.startsWith("移除 ") -> value.replaceFirst("移除 ", "Remove ")
            value.endsWith(" 已完成 · 点击查看") -> value.removeSuffix(" 已完成 · 点击查看") + " finished · tap to view"
            value.startsWith("当前") && value.endsWith("模式") -> value.removePrefix("当前").removeSuffix("模式") + " mode"
            else -> value
        }
    }
}
