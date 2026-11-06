# Chat platform 失败证据

这条链路不建立纠正经验库，不学习或注入历史错误。失败类型来自代码阶段、JSON Schema、进程结果、HTTP 状态及输出契约。

## 存储和查询

调用仍保存在 `agent_tool_calls`：输入、模型 toolCallId、executionId、技能/脚本、捕获的 packageFiles、Command、退出码和结果。错误的模型结果包含 `platform-failure/v1`，同时在现有 `audit_logs` 写入 `action=platform.tool_failure`，`resource` 为调用 id。确定性的 `failure_<callId>` 和调用状态条件更新防止终止竞态重复记录。不增加表或迁移，不改变现有保留/清理规则。

`GET /audit-logs` 支持 action、resource、executionId、commandExecutionId、contractHash、code、stage、effect、from、to、limit（1–500，筛选时默认 100）和 offset。结果仍为原有数组，按时间及 id 倒序。无 query 时保持原接口行为。Chat 可通过 `query_platform` 的 query 对象传入过滤条件。翻页需显式增加 offset；活动写入期间 offset 分页不是一致性快照。

`contractHash` 是调用捕获的整个技能包 SHA-256，定位当次 tools.json、lib 和脚本版本。API 请求证据按请求顺序记录 method、路径哈希、状态、响应阶段、受限格式的 API 错误码和响应 request id（上游未返回时为空）。不复制参数值、响应正文、凭据或异常堆栈。原有 Command 事件和调用输入仍适用原存储策略，新增诊断记录不会复制这些原文。

## 分类及效果

| 阶段 | 证据和稳定错误码 |
| --- | --- |
| 模型归一化 | INVALID_TOOL_REQUEST、INCOMPLETE_TOOL_REQUEST、TOOL_UNKNOWN；不再丢弃调用或因单个无效调用丢失整个 batch |
| 准入 | TOOL_BUDGET_EXHAUSTED、TOOL_NOT_ADMITTED |
| 输入 | PLATFORM_INPUT_INVALID，字段路径及失败的 Schema keyword；脚本内部前置检查为 PLATFORM_SCRIPT_ERROR |
| 启动 | PLATFORM_START_FAILED；仅明确的前置拒绝可标 not_started，其余保守为 unknown |
| 执行 | PLATFORM_PROCESS_FAILED、PLATFORM_CANCELLED、PLATFORM_EXECUTION_INTERRUPTED |
| API | 401/403/404/409/400及422/429/5xx 分别分类认证、权限、资源不存在、冲突、输入、限流、服务错误；另有传输失败和响应 JSON/模型列表契约错误 |
| 结果 | PLATFORM_RESULT_CONTRACT_INVALID；严格解析已声明的类型，不接受未知类型作为成功 |

`not_started` 表示明确前置失败；`not_applied` 表示只有读取请求；`applied` 表示已发出的写请求全部得到 2xx 确认；存在未确认写入或缺失请求证据时为 `unknown`。HTTP 失败不能证明写入回滚，多个写请求中任何一个未确认也保持 unknown。2xx 只代表 API 确认，不能证明第三方最终一致性结果。

`retry=correct_request` 要求修正请求，`inspect_before_retry` 要求先核查实际效果和 Command，不表示允许自动重放。取消、恢复和执行级异常均保留这一约束；恢复对话不重启原脚本，已完成但尚未追加的工具结果不会被覆盖为“丢弃失败”。

同一条用户消息内，若同脚本、同规范化 JSON 参数的先前调用已失败/取消且效果为 applied 或 unknown，准入直接返回 PLATFORM_REPLAY_BLOCKED，不启动脚本。对象键顺序差异不会绕过这一检查。用户后续发送的新消息可发起新操作；这不是跨请求业务幂等键，也不能识别不同参数表达的同一业务写入。

## 修复的确定性契约

- discover/update provider 脚本的 provider_models 显式校验 providerId 和 models，并映射为 snapshot；不再把合法响应判作失败，也不再将错误的 models 响应静默转为空列表。
- 删除 MCP/Workflow 输出 snapshot，避免构造缺少 route、指向已删除资源的 resource。
- platform 结果只解析 stdout，stderr 告警不再破坏 JSON；完整双流仍保留在 Command 中。
- 输入在执行前按 tools.json 校验，单个 JSON 参数与 typed tool 使用同一份契约。

历史已保存的调用不自动回填、不重放。旧能力快照不被改写，缺少新版 lib 请求证据时效果保守标 unknown。数据库不可用等导致持久化本身失败的场景无法保证证据落库。构建不能代替真实 API/进程故障注入验证。
