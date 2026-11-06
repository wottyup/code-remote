# 聊天翻译支持 OpenAI Responses API

## 需求与版本

新增功能（MINOR），目标版本 `0.97.0-dev.1`。在聊天翻译引擎中新增“OpenAI Responses API（需开启路由）”，支持配置接口地址、密钥和模型，并沿用现有的多套具名配置、切换及连通性试译。其他翻译引擎与现有配置保持兼容。

## 开发步骤

1. 在服务端和网页的翻译引擎类型中加入独立的 Responses 协议标识。读取旧配置文件时自动补齐该引擎的默认配置，不修改旧引擎的已保存内容或密钥。
2. 使用 Responses API 的 `model`、`instructions` 和 `input` 发起请求。接口地址可填 API 根地址、`/v1` 地址或完整 `/responses` 地址；留空时使用 OpenAI 官方 `/v1/responses`。解析 `output` 中 assistant 消息的 `output_text` 内容，拒绝不完整或无文本的结果，再复用现有 JSON 数组译文校验。
3. 在设置页增加引擎选项和相应的地址、密钥、模型字段，接入现有的配置保存、复制、切换、清除密钥和连通性检查。注明第三方网关需要启用 Responses 路由；测试使用表单草稿且不保存。
4. 更新语义化版本和简短版本历史。完成静态检查与网页构建，仅提交本次文件到本地仓库。按现有空闲重启机制加载后端更新。

## 边界

兼容网关需要提供实际可用的 Responses 路由；仅填写支持 Chat Completions 的地址无法完成试译。配置接口只返回是否已保存密钥，错误提示不包含密钥或上游原始响应。

官方协议参考：<https://developers.openai.com/api/docs/guides/text>、<https://developers.openai.com/api/reference/resources/responses/methods/create>。
