# Token 用量查询接入 Codex Proxy

## 目标与分类

新增功能（MINOR），目标版本 `0.106.0-dev.1`。Token 用量查询增加 Codex Proxy 数据源，可在设置页保存其服务地址和主 Proxy API Key，并在统计页切换查看。已有 CPA-Manager-Plus 配置继续保留。

## 已确认的接口约束

Codex Proxy `20a5053` 提供 `GET /admin/usage-stats/summary` 的累计值及 `GET /admin/usage-stats/history?granularity=hourly&hours=N` 的时间序列。管理接口通过主 Proxy API Key 的 Bearer 认证，且 `/admin/*` 不开放跨域；因此由 Code Remote 已认证后端转发固定路径。历史数据按快照差值计算，不能保证补齐统计启用前或快照之间的用量。接口没有当前时间段的模型、账号明细及推理 Token。

## 实施步骤

1. 扩展设置为两个独立数据源配置，旧存储数据迁移到 CPA 选项；设置页可切换、测试并保存 Codex Proxy 地址及主 API Key。
2. 后端增加仅转发两个固定统计路径的已认证接口，限制地址、超时、响应大小及重定向，不把密钥写入 URL 或日志。
3. 前端按选中的数据源取数。Codex Proxy 使用小时级历史点计算今天、昨天、近 7 天、近 30 天的卡片与趋势；累计接口仅用于连通性及补充账号总数。未提供的数据项不伪造。
4. 对数据转换和请求边界进行验证，完成网页构建并本地提交。用户另行要求时再推送。

## 验收与限制

- CPA 配置不丢失，切回后仍使用旧接口与筛选。
- Codex Proxy 连通性测试能区分鉴权、路径及连接错误，统计页显示实际历史范围内的 Token、请求、估算金额与趋势。
- 因上游历史按整点聚合，跨小时的边界只能按小时近似；按模型、账号和推理 Token 在此数据源下不显示。
