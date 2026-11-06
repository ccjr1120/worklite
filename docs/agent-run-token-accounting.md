# Agent 运行 token 归因与本次历史查询

## 实现与口径

- `inspect_agent_run(runId)` 只需运行 ID 即可读取运行树及 token 用量；`runId` 支持 `air_...` 或拥有该运行的 `aex_...`。入口为 `GET /agents/run-usage/:runId`；详情仍可用 `GET /agents/:agentId/history/:runId`，UI 为 Agents → 运行记录 → Token 消耗。
- Agent 模型、能力调用及执行器通过 `x-worklite-agent-run-id`、`x-worklite-agent-execution-id` 传递归因；执行器额外传递 `x-worklite-executor`。不复用 Chat 的 `conversationId`。
- Gateway 永久统计和短期请求详情均保存两个字段，查询支持 `agentRunId`、`agentExecutionId`，`groupBy=agent_run` 按运行及执行器分层。精确 runId 过滤不隐式包含子调用；运行详情根据已保存的调用树选取后代，排除兄弟调用。
- Claude 的请求头覆盖本机默认模型及显式 Gateway 模型；Codex 显式 Gateway 模型使用每次启动的 Provider 请求头。原生 Codex 另读取已配置目录（或 CODEX_HOME / ~/.codex）的 config.toml，为其中指向本机 WorkLite Gateway 的 Provider 添加每进程请求头，不改配置文件或复制凭据；该原生 Provider id 须仅含字母、数字、下划线或连字符，否则明确拒绝启动以免静默漏记。任意自定义 shell、工具子进程、动态项目配置层和外部直连不保证经过该边界，不能声称所有网络流量都被 Gateway 捕获。
- Codex/Claude 上报的缓存读取、缓存写入字段随运行 usage 保存；未知值保留为未知。运行上报的 input 包含缓存；Gateway 的 promptTokens 是非缓存输入。Gateway 和运行上报是重叠口径，不能相加。
- Gateway 不可用时保留运行详情与已保存的 usage；无归因请求不显示成零 token。旧行的两个新字段维持 NULL，不按时间回填。

本次没有启动服务、运行测试、lint、typecheck 或迁移，没有数据库写入、commit、push、deploy。按规则允许执行的 Gateway build 成功（Rollup 仅报告循环依赖警告）；API/Web 未进行运行时验证。新增回归用例覆盖归因写入与过滤、缓存口径、executionId 别名、子树隔离及 Gateway 故障降级，但未运行。新能力需代码被加载后才生效；本次未在运行中的实例执行新工具。

## 历史运行结果

查询日期：2026-11-05。数据来源均为对 `.data/deployment/worklite.db` 和 `worklite-gateway.db` 的 `sqlite3 -readonly` 查询。

- 主运行：`air_05168b19-62ab-4b93-ae2e-471a7d16089e`
- 拥有实例：`aex_fe2f5902-a481-433b-8eb3-da9991dbc56e`
- Agent：qcoder（`agt_7ff316582b1478f03879ed8c83d06e50`）
- 时间：2026-11-05 10:39:45.572–11:24:42.910（Asia/Shanghai），状态 completed。

| 层级 | 输入（含缓存） | 输出 | 合计 | cache read | cache creation/write |
| --- | ---: | ---: | ---: | ---: | ---: |
| qcoder 自身模型循环 | 357,218 | 15,779 | 372,997 | 304,896 | 0 |
| im-codex 第一次 | 530,070 | 7,460 | 537,530 | 465,536 | 0 |
| im-codex 第二次 | 3,141,534 | 24,623 | 3,166,157 | 3,048,704 | 0 |
| im-codex 第三次 | 804,882 | 10,193 | 815,075 | 699,136 | 0 |
| 执行器小计 | 4,476,486 | 42,276 | 4,518,762 | 4,213,376 | 0 |
| 已保存运行口径合计 | 4,833,704 | 58,055 | **4,891,759** | **4,518,272** | **0** |

cache 是输入的组成部分，不能再次加到合计。非缓存输入合计为 315,432。以上是可核对的运行时/请求上报 token，不代表供应商账单或未上报的内部重试开销。

主循环总量来自 `audit_logs(action=agent.invocation)` 的 usage。窗口内 15 条 `surface=agent`、`model=kimi-k3.1-pro` 请求详情全部含本次原始任务文本；统计为 fresh input 52,322、cache read 304,896、cache creation 0、output 15,779、total 372,997，与该运行审计吻合。不能只凭窗口和模型作此关联。

三个子运行及命令证据：

| 子运行 | 命令记录 | 线程 |
| --- | --- | --- |
| `air_e87555d2-fc51-4139-a0d9-f67e7961fd67` | `cmd_d5f15bae-34e1-4d20-bfac-afc0caaf2ed3` | `01a1a995-7cc3-7e91-bcc5-83b51522a194` |
| `air_2b5f77d3-f19c-4e05-a5bf-f8511dcc4bf7` | `cmd_6a098c1f-6f18-4f01-94a3-cb74edd66bfe` | `01a1a99f-4a09-7e52-84de-ab4f918149fe` |
| `air_9e806dbf-dd4f-43ff-92e4-9967d231b753` | `cmd_0232c9da-df10-466c-bc20-7e717058fac9` | `01a1a9b2-c54a-7550-b86e-36e2b1b9ade6` |

三个命令的 cwd 为授权项目目录，启动/结束时间与子调用一致。对 `item/started` 中 userMessage 文本做 JSON 解码后，与子运行审计 task 全文逐字比较，各得到唯一匹配（不是只比较时间或任务前缀）；末次 `thread/tokenUsage/updated` 的 input/output/total 与子调用审计也逐项相等。缓存来自该末次事件的 `cachedInputTokens` / `cacheWriteInputTokens`，没有累加各次累计通知。可见的 thread/start 回执模型为 `gpt-6.1-sol`；第二个命令没有同样格式的回执可供该查询确认，未据此猜测其模型。

## 无法精确归属的历史请求

同一主运行时间窗口还存在以下 `surface=unattributed` 记录，均无 executor 或 Agent 运行关联：

| 模型 | 请求数 | fresh input | output | cache read | cache creation | total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| claude-opus-5-5 | 114 | 753 | 200,892 | 12,589,100 | 679,263 | 13,470,008 |
| claude-sonnet-5 | 248 | 29,644 | 30,542 | 1,662,263 | 11,221,672 | 12,944,121 |

合计 26,414,129 是窗口内未归因流量，**不是这条运行的执行器消耗**。其请求体带 Claude session id，但没有证据将这些 session 与上述三个 Codex 线程或主运行关联。不能把它们加入 4,891,759，也不能当成该运行新增消耗的可靠估算。最初“这次执行器流量是 Claude unattributed”的判断未被证据支持。

原始 Gateway 表没有 agent_run_id / agent_execution_id 字段，主循环的 conversation_id 也为空。`agent_runtime_runs` 当时为 0 行，但 `audit_logs` 和 Codex 命令事件已经保存了上述用量。因此“完全无法查询历史用量”不成立；无法恢复的是旧 Gateway 请求的运行维度外键，以及缺少内容/线程证据的流量归属。新字段只覆盖代码加载后的请求；本次未改旧数据。历史缓存明细依赖当前仍保留的请求详情和命令事件，本文件保存了本次查询结果。

## 只读核对语句

工作库：

```sql
SELECT id, json_extract(metadata, '$.parentRunId') AS parent_run,
       json_extract(metadata, '$.usage') AS usage
FROM audit_logs
WHERE action = 'agent.invocation'
  AND resource = 'aex_fe2f5902-a481-433b-8eb3-da9991dbc56e';

WITH updates AS (
  SELECT command_id, data,
         row_number() OVER (PARTITION BY command_id ORDER BY sequence DESC) AS r
  FROM command_execution_events
  WHERE command_id IN ('cmd_d5f15bae-34e1-4d20-bfac-afc0caaf2ed3',
                       'cmd_6a098c1f-6f18-4f01-94a3-cb74edd66bfe',
                       'cmd_0232c9da-df10-466c-bc20-7e717058fac9')
    AND json_valid(data)
    AND json_extract(data, '$.method') = 'thread/tokenUsage/updated'
)
SELECT command_id, json_extract(data, '$.params.threadId') AS thread_id,
       json_extract(data, '$.params.tokenUsage.total') AS usage
FROM updates WHERE r = 1;
```

Gateway 库（请求内容关联已在本次只读查询确认；以下输出只包含计数）：

```sql
SELECT count(*) AS requests,
       sum(instr(request_body, '我准备给这个项目的 chat 设计一套 platform 技能的记忆纠正系统') > 0) AS task_matches,
       sum(prompt_tokens) AS fresh, sum(cache_read_tokens) AS cache_read,
       sum(cache_creation_tokens) AS cache_creation,
       sum(completion_tokens) AS output, sum(total_tokens) AS total
FROM gateway_request_logs
WHERE occurred_at BETWEEN 1793846385572 AND 1793849082910
  AND surface = 'agent';
```
