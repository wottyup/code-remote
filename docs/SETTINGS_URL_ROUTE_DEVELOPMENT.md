# 设置页 URL 路由

## 目标与分类

为网页设置页和 Token 用量页增加可直接识别、可分享、刷新后可恢复的路径路由。设置页使用 `/settings`，Token 用量页使用 `/usage-stats`；聊天主界面使用根路径。现有覆盖层交互、浏览器前进后退和旧版 History state 继续兼容。

本次属于新增可见导航能力（MINOR）的路由形式修订，目标版本为 `0.100.0-dev.2`，Android `versionCode` 递增到 `406`。

## 实施步骤

1. 增加路径路由与现有 `history.state` 的双向解析，支持从直接链接初始化面板。
2. 打开、切换、关闭设置和 Token 用量面板时同步 URL；保留浏览器前进后退行为，并兼容旧版没有 URL 参数的历史记录。
3. 更新 Web 与 Android 版本号、CHANGELOG，并保留现有未跟踪构建产物不进入提交。
4. 执行网页生产构建和 `git diff --check`，完成本地 Git 提交，不推送远程。

## 验收要点

- 点击设置后地址栏显示 `/settings`，刷新或复制链接重新打开仍进入设置。
- 点击 Token 用量后地址栏显示 `/usage-stats`。
- 关闭面板回到根路径；浏览器前进后退能在聊天、设置和 Token 用量之间切换。
- 不引入额外路由依赖，Vite 开发和预览服务为路径回退到 `index.html`。

## 实施结果

- 已完成设置页和 Token 用量页的路径路由、直接链接初始化、刷新恢复以及前进后退同步。
- 已保留旧版 `history.state`，访问旧历史记录时会自动补齐路径。
- `pnpm --filter code-remote build` 和 `git diff --check` 已通过；未生成 Android 安装包，未运行自动化测试，未推送远程。
