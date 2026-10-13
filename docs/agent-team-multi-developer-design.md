# Agent Team 多 Developer 并行开发设计

- 日期：2026-10-10
- 状态：调研与设计稿；未实施
- 范围：内置 Team `agent_team_bmad_tea` 的 Developer 实例配置、Run 内并行编排、任务进度可观察性
- 兼容目标：现有六元素 `roles` API、单 Developer 配置和既有 API 消费者不回归；六个角色条目仍各恰好一次（其中非 Developer 角色实际为五个）

## 1. 结论

当前实现是“一条 Run、一个 LangGraph thread、一个 `development` taskKey、一个 Developer TaskAttempt、一个 captured `developerExecution`”。LangGraph 图用固定边强制 Planner → Test Designer → Developer → Test Author → Test Runner → Reviewer 串行执行；数据表的 `runId + taskKey + attemptIndex` 唯一键本身不阻止不同 taskKey 并行，但配置、版本快照、图结构和前端都假设单 Developer。

建议不引入第二个调度器，也不改变“一条 Run 只有一个 active Run、一个 LangGraph thread”的边界：

1. `roles` 仍必须是六个角色条目且每个角色条目恰好一次；仅在 `developer` 条目上新增可选 `developerInstances`，表示除既有主 Developer 之外的额外实例。
2. TeamVersion 为每个逻辑 Developer 捕获独立 executor launch 与完整配置；旧字段 `developerExecution` 继续表示主 Developer。
3. 将 development 阶段改成 LangGraph 原生 fan-out / fan-in： Planner 产出安全的工作分配，Developer dispatcher 按 TeamVersion 捕获的并发上限派发，全部 Developer 完成后进入唯一的 Test Author、Test Runner 和 Reviewer。
4. taskKey 按 Developer 归属稳定展开：主 Developer 保持 `development` 与 `repair_<round>`，额外实例使用 `development_<developerId>` 与 `repair_<round>_<developerId>`。
5. 事件仍使用 Run 级单调 sequence 与 `Last-Event-ID` replay；`task.*` payload 增加 `developerId`，Run view 增加阶段、下一步与 Developer lane 汇总。
6. `progressText` 不新增长期字段，从该 TaskAttempt 最新带 `text` 的 `task.activity` 反向派生，语义对齐 Chat project task 的现有实现。

## 2. 现状分析

### 2.1 Run 引擎与编排

| 主题 | 代码位置 | 现状结论 |
| --- | --- | --- |
| 内存执行边界 | `apps/api/src/modules/agent-teams/agent-team-runtime.service.ts:117-137` | 每 Run 一个 execution promise、一个 AbortController、一组进程内事件 listener。 |
| Run 创建 | 同文件 `151-247` | 读取项目指令、创建 immutable TeamVersion 与 Run；同 Team 只允许一个 active Run（`185-193`）；LangGraph thread 固定为 `atthread_<runId>`（`220`）；创建后调度 initial graph input（`244-246`）。 |
| 图状态 | `packages/team-runtime/src/graph.ts:19-86` | `pendingInput` 与 `activeTaskKey` 是单值；task result、answer 虽是 map，但一次只服务一个 active task。 |
| 依赖与节点 | 同文件 `141-159`、`230-258` | Developer 依赖 `test_design`；Test Author 依赖 `test_design` 与 `development`；只有一个 `developer` 节点。 |
| 串行边 | 同文件 `260-280` | 固定链路 Planner → Test Designer → Developer → Test Author → Test Runner → Reviewer；Reviewer repair 只回到唯一 Developer。 |
| 输入中断 | 同文件 `217-228`、`285-287` | `interrupt()` 暂停当前唯一 active task；恢复值是 `{ answer, authorizedCommands }`。 |
| 图执行 | `agent-team-runtime.service.ts:863-931` | 一个 Run 同时只有一个 execution promise；顺序消费 `graph.stream`，interrupt 后 Run 进入 `waiting_for_input`，完成后聚合最终 outcome。 |
| TaskAttempt | `packages/db/src/schema/index.ts:649-668` | `taskKey`、`attemptIndex`、role/status/result/active；唯一键允许不同 taskKey 并行。`agent-team-runtime.service.ts:1077-1140` 按 taskKey 幂等复用 completed/waiting attempt，禁止同 taskKey running 重入。 |
| 结果提交 | `agent-team-runtime.service.ts:1051-1260` | executor 输出解析后，waiting attempt 持久化 pending input；completed attempt 持久化 result、documents、command ids，并发布 task 事件。 |
| Run 事件 | `packages/db/src/schema/index.ts:688-694`；`agent-team-runtime.service.ts:1556-1606` | `(runId, sequence)` 主键；事务内分配连续 sequence，事务提交后发布，避免事件先于状态可见。 |
| SSE | `apps/api/src/modules/agent-teams/agent-teams.controller.ts:110-156` | Run SSE 先注册 live buffer，再按 `Last-Event-ID` replay 持久事件，最后 flush buffer；terminal 状态关闭连接。Conversation SSE 在 `37-78` 使用同样模式。 |
| 暂停/恢复 | `agent-team-runtime.service.ts:552-575` | `pause` 写 desired control 并在图边界生效；`resume` 只允许 paused Run，基于 checkpoint 恢复。 |
| 取消 | 同文件 `578-609` | 写 `cancel_requested`，通过 Run 级 AbortController 中断执行；没有 execution 时直接关闭 active attempts。 |
| 失败重试 | 同文件 `612-645` | 只允许 failed active attempt；旧 attempt 置 inactive，Run 回 running，并从同一 LangGraph checkpoint 恢复。 |
| API 重启恢复 | 同文件 `702-723`、`766-820` | queued/running Run 逐个 reconcile；interrupted operation 优先暴露恢复；answered pending input 可恢复；checkpoint 缺失则失败，checkpoint 有 next 时关闭 stale running attempts 再调度。 |
| uncertain operation | `agent-team-operation-journal.service.ts:56-165`；`agent-team-runtime.service.ts:397-548` | journal 按 workspace/run/taskAttempt 限定；支持 adopt、mark failed、显式 replay；原 attempt 关闭并由新 attempt 承接。 |

### 2.2 角色配置与 API

- 固定六个角色定义在 `apps/api/src/modules/agent-teams/agent-team-configuration.ts:8-15`：planner、test_designer、developer、test_author、test_runner、reviewer。
- “六个角色各恰好一次”的核心校验在 `apps/api/src/modules/agent-teams/agent-teams.service.ts:182-203`：
  - `182-184` 要求数组长度等于 `AGENT_TEAM_ROLES.length`；
  - `193-197` 拒绝非法或重复角色；
  - `201-203` 按固定顺序要求每个角色存在。
- `208-215` 只允许 Developer 配置 executor，且 executor 只能是 `claude` / `codex`；模型协议必须匹配。`211` 显示缺省 executor 为 `claude`。
- `PATCH /agent-teams/:teamId` 路由在 `agent-teams.controller.ts:32-35`；service 在 `agent-teams.service.ts:68-87` 只接受 `roles` 并整体替换。
- Team view 在 `287-306` 输出六个 role；仅 Developer 额外输出 executor。
- 内置 Team 初始化在 `agent-team-runtime.service.ts:647-671`，每角色一条、模型为空；TeamVersion 创建在 `674-699`，`686` 用第一个 Developer 捕获唯一 `developerExecution`，`698` 固定 `maxRepairRounds = 2`。
- 存储结构：`packages/db/src/schema/index.ts:527-550` 中 role 配置的 `executor` 是单值，version snapshot 的 `developerExecution` 是单值；`agent_teams.roles` 是 JSON（`552-562`）。
- 公开契约：`packages/contracts/src/index.ts:1194-1221` 中 role 仍是单 Developer 配置，TeamVersion metadata 仍是单个 `developerExecution`；`1611-1613` PATCH 请求仍为 `roles`。
- Team 默认值：初始化时六个 `publicModelId` 均为空（`agent-team-runtime.service.ts:653-662`）；版本捕获时非 Developer 空模型回落到 `AGENT_TEAM_DEFAULT_PUBLIC_MODEL_ID`，Developer 空模型刻意保持为空并由 executor 自身默认值解析（`692-693`）；Developer 缺省 executor 为 `claude`（`agent-teams.service.ts:211`、`302`）；默认修复轮数为 2（`agent-team-runtime.service.ts:698`）。

### 2.3 Developer 执行器集成

- 共享边界：`apps/api/src/modules/agents/project-executor.service.ts:12-13` 明确 Chat project task 与 Team Developer 共用 ProjectExecutorService；`23-45` 捕获 launch 并按 executor 分发。
- 协议约束：`project-executor.types.ts:60-64` 要求 Codex 使用 `openai/responses` 或 `codex/responses`，Claude 使用 `anthropic/messages`。
- Team 派发：`agent-team-runtime.service.ts:941-986` 按 role 找第一条版本配置；Developer 要求唯一 captured execution/model（`957-960`），并把 correlation 绑定到 team run 与 task attempt（`979`）。`onEvent` 写 `task.activity`，`onTextDelta` 写 `task.delta`（`980-985`）。
- Codex App Server：`codex-app-server.service.ts:56-128` 每个任务启动一个 stdio process，执行 initialize、thread/start、turn/start，结束后关闭；`196-208` 产出带 process execution、thread/turn/item 标识的 activity，只有 completed `agentMessage` 附完整 `text`；`229-243` delta、item 与最终 agent message 分别回调。
- Claude Code：`claude-code.service.ts:16-94` 每任务一个 headless `claude -p` stream-json/control process；`214-249` 记录 session、assistant 完整文本与 tool started/completed；`252-275` 区分 result 与 `AskUserQuestion`，后者转为 Team pending input。
- Team 目前没有 progressText。Chat 的对照实现在 `chat-project-tasks.service.ts:97-129`：`120` 反向找最新 `text` activity，`126` 输出 `progressText`。Team 只把 activity/delta 持久化为 Run event。
- Developer 原生效果没有 Team operation journal；非 Developer isolated invocation 才走 `agent-team-runtime.service.ts:988-1046` 的 operation journal。

### 2.4 前端

- Team 页路由：`apps/web/src/routes/agent-teams/$teamId.tsx:14-25`，组件 `apps/web/src/features/agent-teams/team-detail.tsx`。
- 配置 tab 固定六个 draft：`team-detail.tsx:30-39`；`40-54` 从服务端 role 生成固定六个 draft，但未复制 executor；`56-69` 保存时也不保留 executor。因此当前 UI 即使后端支持 executor，也会在保存时丢失该配置。
- Run 页路由：`apps/web/src/routes/agent-team-runs/$runId.tsx:4-11`，组件 `team-run-detail.tsx`。
- Run SSE：`team-run-detail.tsx:517-558` 使用 `EventSource(api.agentTeamRunEventsUrl(runId))`，按 sequence 去重；非 `task.delta` 事件才刷新 Run query。
- Run 展示：`315-399` TaskPanel 仅显示 taskKey、role、attempt、错误、changed files 与 JSON result；`709-762` 是基础元数据；`775-781` 平铺 tasks；`785-805` 将所有 `task.delta` 按全局 sequence 混排，仅标 taskKey/role，没有 Developer lane、phase 或 next step。
- Conversation：`team-conversation.tsx:309-334` 订阅 conversation SSE；`345-348` 只读取一个 pendingInput；`385-395` 控制一个 activeRun；`623-673` active Run 卡片只显示基础状态、项目与 mode。公开契约 `packages/contracts/src/index.ts:1562-1568` 也只有一个 `retryableTaskKey`。

### 2.5 测试现状

主仓库当前没有 Agent Team 专属 `*.test.ts` / `*.test.tsx`。现有相关工作区测试只有：

- `apps/api/src/modules/agents/agent-execution-failure.test.ts`（当前为未跟踪文件）
- `apps/web/src/api/client.test.ts`
- `apps/web/src/components/ai-elements/prompt-input.test.tsx`
- `packages/db/src/agent-model-messages.test.ts`（当前为未跟踪文件）
- `packages/db/src/client.test.ts`（当前为未跟踪文件）

测试命令由根目录 `package.json` 提供：`pnpm test`，实际 Vitest 配置为 `vitest.config.ts`，包含 `apps/**/*.test.{ts,tsx}` 与 `packages/**/*.test.{ts,tsx}`。类型检查命令为根目录 `pnpm typecheck`，也可用 `pnpm --filter @worklite/api typecheck`、`@worklite/web`、`@worklite/team-runtime`、`@worklite/db`、`@worklite/contracts`。本阶段仅记录命令，不执行。

既有单 Developer 假设主要有：后端用数组长度 6 和重复 role 校验表达单实例；TeamVersion 只捕获一个 launch；图只有一个 Developer 节点且 repair target 只能是 `development`；graph state 的 active/pending input 是单值；前端固定六个 draft 且丢失 executor；Conversation 只暴露一个 pending input 与一个 retryable task。

## 3. 目标行为

1. Team 仍只有一个内置 Team、一个 durable conversation、一条 active Run；并行只发生在 Run 的 development phase 内。
2. 五个非 Developer 角色仍各恰好一次，且 Test Author、Test Runner、Reviewer 在所有 Developer assignment fan-in 后各执行一次。
3. 主 Developer 的现有 taskKey、事件含义、单 Developer API 输出保持不变；额外 Developer 通过显式 `developerId` 与派生 taskKey 区分。
4. 多 Developer 默认共享同一个真实 project checkout。Planner 必须给出不重叠的路径所有权；这不是文件系统沙箱，而是并行分配契约，风险见第 10 节。
5. 并发上限默认为 `min(logicalDeveloperCount, 2)`，可配置为 1 到 4。上限为 4 是本期的产品边界，用于控制本机进程、模型并发与共享 checkout 冲突风险。
6. 每条 assignment 有独立 executor process/session 与 TaskAttempt；成功 attempt 在 sibling 失败或 retry 时不被重跑。
7. Run 详情回答四个问题：当前在做什么、进行到哪一步、哪个 Developer 在做什么、下一步是什么。Conversation 只显示简短全局摘要并链接 Run 详情。

## 4. 配置模型与 API 兼容

### 4.1 Schema

在现有 `AgentTeamRoleConfiguration` 上做增量扩展：

```ts
type AgentTeamDeveloperInstanceConfiguration = {
  developerId: string;           // 稳定、唯一，不可使用保留 id "developer"
  label: string;
  publicModelId: string;         // 空值沿用该实例 executor 默认模型
  instructions: string;
  entryPoints: string[];
  skillIds: string[];
  mcpServerIds: string[];
  toolNames: string[];
  executor?: 'claude' | 'codex'; // 缺省 claude
};

type AgentTeamRoleConfiguration = {
  // 现有六个 role 条目与字段全部保留
  developerInstances?: AgentTeamDeveloperInstanceConfiguration[];
  developerConcurrency?: number; // 仅 developer 条目允许
};
```

语义：

- `roles.length === 6` 与每个 role 条目恰好一次不变；Developer 是“一个 role 条目、一个主实例 + 0..3 个额外实例”。
- 既有 Developer 条目的字段就是主实例，稳定 `developerId` 为保留值 `developer`，不要求旧请求显式传 id。
- `developerInstances` 只允许出现在 `role === 'developer'`；数组内 developerId 唯一。额外实例必须携带完整配置，TeamVersion 不依赖主实例隐式继承，避免版本语义不确定。
- PATCH 中省略 `developerInstances` 表示保留已保存的额外实例，避免旧客户端用六元素请求意外删除新配置；显式 `[]` 才清除全部额外实例。`developerConcurrency` 省略时按默认值重新计算。
- 非 Developer 条目出现任一新字段即拒绝；五个非 Developer 角色仍各恰好一次。
- 校验位置应继续收敛在 `AgentTeamsService.resolveRoles()`，并同步扩展 `ROLE_CONFIGURATION_KEYS` 与公开 contract。

### 4.2 TeamVersion

`StoredAgentTeamVersionSnapshot` 增加：

```ts
developerExecutions: Record<string, StoredProjectExecutorLaunch | { kind: 'codex_app_server' }>;
orchestrationVersion: 2;
```

- key 是稳定 developerId，value 是该实例独立捕获的 launch。
- 现有 `developerExecution` 字段保留，永远等价于 `developerExecutions.developer`，供旧 API 消费者读取。
- 旧 immutable version 不迁移。运行旧 version 时用 `{ developer: snapshot.developerExecution }` 合成 map，并继续走旧单 Developer graph 语义；新 version 才使用 fan-out graph。这样可以避免已存在 checkpoint 的图拓扑被部署后的新代码改变。
- 配置中的每个额外实例独立解析 model 协议、Skills 与 MCP 快照；空模型保持对应 executor 自身默认模型，沿用 `agent-team-runtime.service.ts:692-693` 的 Developer 规则。
- `recipeDefaults` 增加 `maxDeveloperConcurrency`，实际值取配置值与逻辑 Developer 数的较小值。

### 4.3 公开 API

- `GET /agent-teams/:teamId` 与 `PATCH /agent-teams/:teamId` 路径不变；响应仍是 `roles: AgentTeamRoleConfiguration[]`，只是 Developer 条目多了可选字段。
- `AgentTeamTaskAttemptView` 增加 `developerId: string | null` 与 `progressText: string`。
- `AgentTeamVersionMetadata` 增加 `developerExecutions` map，保留 `developerExecution`。
- `AgentTeamRunView.progress` 增加：

```ts
{
  phase: 'planning' | 'test_design' | 'development' | 'test_authoring'
       | 'test_execution' | 'review' | 'repair' | 'waiting' | 'terminal';
  nextStep: 'dispatch_assignments' | 'await_assignment_completion' | 'answer_question'
         | 'test_authoring' | 'test_execution' | 'review' | 'finish';
  totalAssignments: number;
  completedAssignments: number;
  activeDeveloperIds: string[]; // 按 TeamVersion 配置顺序稳定排序
  waitingReason: 'user_input' | 'pause_boundary' | null;
}
```

- Conversation activeRun 增加 `retryableTaskKeys: string[]` 与 `progress`；保留 `retryableTaskKey`，取第一个可重试 assignment，旧 UI 不回归。
- Conversation `pendingInput` 保留为最早未回答问题；新增 `pendingInputs` 数组供新 UI 逐个回答。Run answer API 的 `{ pendingInputId, scopeRevision, answer, authorizedCommands? }` 形状不变。

## 5. Run 内并行编排

### 5.1 assignment 生成

扩展 Planner completed result：

```ts
developmentAssignments?: Array<{
  developerId: string;
  title: string;
  scopeSummary: string;
  ownedPaths: string[];
}>;
```

- 单 Developer 且请求省略该字段：合成主 Developer 的唯一 assignment，taskKey 仍为 `development`，保持现有行为。
- 逻辑 Developer 数大于 1 时要求至少一个 assignment；assignment 的 developerId 必须来自 TeamVersion，且同一 developerId 只能出现一次。
- `ownedPaths` 规范化后必须非空且互不重叠。发生重叠或未知 developerId 时，Run 失败并给出明确 assignment 校验错误，不静默降级为串行。
- 未获得 assignment 的 Developer lane 显示 `not_required`，不启动进程。
- assignment 与 ownedPaths 写入 TeamVersion graph input 或 Planner result，并进入每个 Developer prompt、Test Designer/Author/Runner/Reviewer 的上下文。

### 5.2 LangGraph fan-out / fan-in

新 version 使用一个编译期按 Developer 列表展开的 graph：

```text
START
  -> planner
  -> test_designer
  -> development_dispatcher
  -> developer:<developerId> ...   # 并行分支，每分支有独立 input node
  -> development_join
  -> test_author
  -> test_runner
  -> reviewer
  -> repair dispatcher 或 END
```

- graph state 将单值 `activeTaskKey` / `pendingInput` 扩展为 assignment 维度 map/set，同时保留 task result map。新字段持久化在 v2 checkpoint。
- dispatcher 只从 pending assignments 中取 `cap - activeCount` 个，按主 Developer、额外实例配置顺序确定性派发；completion 回到 dispatcher，直到 pending 为空再 fan-in。
- LangGraph checkpoint 是唯一调度状态；不在数据库建立第二套待办队列。`task.started` 只在真实 executor attempt 创建时发布。
- 每个分支的 `interrupt()` 使用该 assignment 的 pending input id。v2 的 graph resume 值使用 `Record<pendingInputId, answer>`：被唤醒的 input node 只消费自己的 id，未包含在 map 中的 input node 原样重新 interrupt，避免一个答案被广播到多个 Developer。公开 answer API 仍按 `pendingInputId` 提交并在服务端转换成该 map；如果仍有其他 pending question，Run 保持 `waiting_for_input`，否则回 running。旧 orchestration version 继续使用现有单值 resume 形状。
- Test Author / Runner / Reviewer 依赖 fan-in，不在任一 Developer 完成前启动。
- 一个 Developer 节点失败时，Run 进入 failed 并触发 Run 级取消信号：停止未启动 assignment，中断仍在运行的 sibling executor。已成功提交的 TaskAttempt、documents 与 command evidence 保留。
- Reviewer repair 支持按 assignment 返回 `repairRequests: [{ developerId, instruction }]`。单 Developer 旧字段 `repairRequest` 保留并映射为 `{ developerId: 'developer' }`；多 Developer 时禁止笼统 repair，必须指明受影响 assignment。

### 5.3 状态与结果聚合

- taskKey 规则：
  - 主 Developer初始开发：`development`；修复：`repair_<round>`。
  - 额外实例初始开发：`development_<developerId>`；修复：`repair_<round>_<developerId>`。
- `agentTeamTaskAttempts` 不需要新表；可增加非唯一 `developerId` 列，或由 TeamVersion assignment map 在 view 层派生。建议持久化 `developerId`，避免事件和 result 反推身份。
- fan-in 聚合各 assignment 的：
  - documents：保留每条 assignment 的 implementation record，并生成一个聚合 implementation summary 给 Test Author；
  - changedFiles：按 Developer 归属记录，再合并为去重列表；发现同一路径多实例修改时标记冲突并进入失败/repair，不静默覆盖；
  - commandIds、unresolvedIssues、criterionAssessments：保序去重合并；
  - completedAssignedWork：全部必需 assignment 完成才为 true。
- Run outcome 保留现有 `summary / unresolvedIssues / criterionAssessments` 公开形状，可增加 `developmentAssignments` 汇总，但不改变既有字段含义。

## 6. 恢复、暂停、取消与重试

- **Pause**：Run 级 desired control，不再派发新 assignment；已启动 Developer process 不强制取消，等待其当前 node 完成并 checkpoint 后进入 paused。progress 显示“等待 N 个在途 Developer 到达暂停边界”。
- **Resume**：读取同一 LangGraph checkpoint 继续，不改写 TeamVersion，也不重跑已 completed attempt。
- **Cancel**：保持 Run 级 AbortController 语义，立即通知所有 Developer executor process，并把所有 running/waiting/waiting_for_recovery active attempts 置 cancelled。多 Developer 不引入单独取消 API。
- **Retry**：继续使用 `POST /agent-team-runs/:runId/tasks/:taskKey/retry`，taskKey 可指向具体失败 assignment；旧单 Developer 行为不变。并行 development fan-out 采用同一个失败屏障的 retry 语义：成功 sibling/predecessor 不重跑；如果同一 fan-out 中多个 assignment 留下 failed active attempt，恢复 checkpoint 时所有待重试 assignment 都创建新 attempt，未启动 assignment 由 dispatcher 继续派发。该语义避免第一次 retry 把 Run 置回 running 后，其余 failed task 因 API 只允许 failed Run retry 而永远无法重试。Conversation 暴露 `retryableTaskKeys`，旧 `retryableTaskKey` 仍提供第一个确定性可重试 taskKey。
- **API restart**：v2 checkpoint 保存 assignment/dispatch 状态。reconcile 时保留 completed 与 answered waiting attempts，只把无法确认仍在进程内的 running Developer attempt 标记 failed，再从 checkpoint 恢复；不自动重放 Developer 原生效果。
- **Developer 原生效果恢复**：仍无 operation journal。失败或中断 retry 的新 attempt 必须携带 sibling 成功结果、已 changedFiles 与项目实况，由 Developer 自行检查后继续；这保持现有 Developer 原生效果边界。
- **非 Developer uncertain operation**：仍按原 taskAttempt scope 处理；fan-out 不改变 adopt/mark failed/replay 语义。多个 operation 不因并行而合并。

## 7. 可观察性设计

### 7.1 事件模型

保留 `AgentTeamRunEvent.sequence` 与 SSE replay。所有 `task.started`、`task.activity`、`task.delta`、`task.waiting`、`task.completed`、`task.failed` payload 增加：

```ts
{ taskAttemptId, taskKey, role, developerId?, assignmentTitle? }
```

新增低频 `run.progress` 事件，只在 phase、next step、waiting reason 或 active Developer 集合变化时发布：

```ts
{
  phase,
  nextStep,
  totalAssignments,
  completedAssignments,
  activeDeveloperIds,
  waitingReason
}
```

`nextStep` 与 `waitingReason` 是稳定机器值，前端负责映射为中文状态文案；事件不携带 UI 文案。不新增每条 assignment 的第二套调度日志；dispatcher 结果以 TaskAttempt 与 `run.progress` 为准。

### 7.2 progressText 与 activity

- `task.activity` 继续持久化 process/session/thread/turn/item、command execution、tool summary 与完整公开 agent message。
- Team TaskAttemptView 的 `progressText` 由该 attempt 的 `task.activity` 事件按 sequence 反向取第一条含 `text` 的值派生；没有完整公开回复时为空字符串。
- 该定义与 `chat-project-tasks.service.ts:120` 一致，不把 streaming delta 误当完整回复，也不新增长期 progress 字段。
- Run view 可提供每 lane 最近 N 条 activity 摘要，但原始 Run event 仍完整保留，不做静默截断。

### 7.3 前端展示

- Team Configuration：
  - 五个非 Developer 角色保持现有单卡。
  - Developer 显示主实例和额外实例列表，每实例可配置 label、executor、model、instructions、entry points、Skills、MCP 与 tools；支持新增/移除额外实例。
  - 保存时必须保留 executor，修复当前 `team-detail.tsx:40-69` 丢字段问题。
- Run Detail：
  - 顶部显示 phase、next step、assignment 进度、Run 状态与等待原因。
  - Development phase 渲染 Developer lanes：label/developerId、executor/model、assignment title、task status、progressText、最新 activity 摘要、changed files、attempt/retry 操作。
  - 时间线按 Developer 分组或提供 lane 过滤，避免多个 delta 流混杂。
  - Test Author/Runner/Reviewer 仍以单任务显示，清楚标记它们在 fan-in 之后。
- Conversation：
  - active Run 卡显示 phase、completed/total、active Developer 摘要、next step，以及所有 pending question 的数量。
  - 默认展开最早一个问题；其余问题可依次回答，不把原始 executor delta 投影进 Conversation。
  - Retry 若有多个失败 assignment，先列出受影响的 taskKey/Developer；任一选择都触发同一失败屏障恢复，成功 sibling 不重跑。只有一个失败时保持现有一键 retry 行为。
- SSE 消费方式不变：Run 页继续用 `agentTeamRunEventsUrl`，Team 页继续用 `agentTeamConversationEventsUrl`，并保留 `Last-Event-ID` 与 sequence 去重。

## 8. 测试计划

以下为后续实施阶段的计划；本阶段不创建、不修改、不运行测试。

### 8.1 并行图单元测试

建议新增 `packages/team-runtime/src/graph.test.ts`：

1. 单 Developer 省略 assignments 时，taskKey 仍为 `development`，边顺序与现有行为一致。
2. 三个 assignments、cap=2 时，第一批只派发两个；一个完成后派发第三个；全部完成后才进入 Test Author。
3. assignment id 未知、重复、ownedPaths 重叠时明确失败。
4. 多个 input interrupt 可按 pendingInputId 独立恢复；一个答案不会重新唤醒其他等待分支。
5. 一个 Developer 失败时保留成功 sibling result，Run 状态 failed，未启动 assignment 不产生 TaskAttempt；同一失败屏障中的多个 failed assignment 可一起恢复且成功 sibling 不重跑。
6. repair 只派发 reviewer 指定的 Developer，且成功 attempt 不重跑。

### 8.2 API / service 测试

建议新增或补充：

- `apps/api/src/modules/agent-teams/agent-teams.service.test.ts`
  - 旧六元素请求兼容；额外 Developer 校验；五个非 Developer 恰好一次；executor/model 协议；`developerInstances` 省略保留、显式空数组清除。
- `apps/api/src/modules/agent-teams/agent-team-runtime.service.test.ts`
  - TeamVersion 每实例捕获 launch；旧 version 单 Developer 恢复；attempt 并行创建；事件 payload 归属与单调 sequence；Run progress 聚合；多 pending input 定向恢复；同一 fan-out 多失败 assignment 的 restart/retry 语义。
- SSE 测试
  - 多 Developer 交错事件保持单调 sequence，`Last-Event-ID` replay 无丢失、无重复。

### 8.3 前端测试

建议补充 `team-run-detail` 组件测试：

1. Developer lanes 根据 `progress` 与 tasks 正确分组。
2. `task.delta` 交错时不串 lane。
3. `progressText` 来自 TaskAttempt view，而不是 delta。
4. 多 pending input 可逐个回答。
5. 多 retryable task 可展示并触发同一失败屏障恢复，旧单 retry 字段仍能渲染。

### 8.4 命令

- 全量测试：`pnpm test`
- 定向 Vitest：`pnpm test -- <file>`（例如 `pnpm test -- packages/team-runtime/src/graph.test.ts`）
- 类型检查：`pnpm typecheck`
- 包级类型检查：`pnpm --filter @worklite/api typecheck`、`pnpm --filter @worklite/web typecheck`、`pnpm --filter @worklite/team-runtime typecheck`

是否执行仍须按当时用户授权和项目验证规则确认。

## 9. 分阶段实施清单

1. **设计确认与架构同步**：确认本设计后，先更新 `docs/project-architecture/README.md` 与 `agent-team-implementation.md`，再进入代码；涉及页面行为时同步 `ui-ux-design/pages/.../DESIGN.md`。
2. **契约与配置**：更新 contracts、Stored schema 类型、角色校验、TeamVersion 捕获与 Team view；先保持执行图不变，验证旧配置/API。
3. **图编排**：实现 assignment、dispatcher、fan-in、并行 taskKey、多 pending input 与 repair targeting；配套 graph 单元测试。
4. **运行时恢复与事件**：实现 attempt 归属、并行失败处理、restart reconcile、retry、progress 派生与事件 payload。
5. **前端与页面规范**：先更新 UI/UX DESIGN，再实现配置实例列表、Run lanes、phase/next step、分组输出与 Conversation 摘要。
6. **平台知识同步**：同一变更内同步内置 Chat prompt、`worklite-platform` Skill、typed contracts、脚本 tool schema、snapshot capability metadata 与 reference protections。
7. **验证**：按授权执行测试与类型检查；如需端到端验收，使用独立 fixture 项目和明确授权的 exact command，不触碰 managed deployment 服务。

## 10. 风险与缓解

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 多个 native executor 共享同一 checkout 仍可能越界写同一路径。 | 冲突、覆盖或难以归因的改动。 | Planner 强制 ownedPaths 互斥；prompt 明确边界；fan-in 检测重叠 changedFiles；Reviewer 独立检查。本期不宣称文件系统沙箱。 |
| LangGraph checkpoint 与图拓扑版本不一致。 | 旧 Run 恢复失败或重复执行。 | TeamVersion 记录 orchestration version；旧 version 走旧图，新 version 才走 v2；不迁移旧 checkpoint。 |
| 并行模型与本地进程资源放大。 | Gateway 与 executor 不稳定。 | 总实例数和并发上限均为 4；progress 暴露 active lane；失败不自动重试。 |
| 事件量随 Developer 数增长。 | SSE 与 Run view 压力增大。 | 保留 run 级单调事件；`run.progress` 仅低频发布；前端 delta 按 lane 分组。 |
| Developer 原生效果无 uncertain operation journal。 | 中断后无法精确回滚或重放。 | 保持显式 retry 与项目实况检查策略；attempt 记录 sibling 成功结果与 changedFiles，不自动重放。 |
| 多 pending input 与旧 Conversation 单问题模型冲突。 | 旧 UI 只能看到一个问题。 | 保留 `pendingInput` 为第一个问题；新数组只给支持多问题的新 UI 使用。 |
| 配置 UI 当前会丢失 executor。 | 保存后行为偏离用户配置。 | 实施配置实例列表时同轮修复字段保留。 |

## 11. 本期不做

- 不创建 Team creation/deletion API，不引入第二个内置 Team。
- 不把 Test Author、Test Runner 或 Reviewer 改为多实例。
- ~~不引入独立工作目录、Git worktree、自动合并或文件系统沙箱。~~ （2026-10-12 起被取代：Developer lane 在 git 仓库下各自运行于独立 worktree，成功后经串行合并队列合并回原分支并移除 worktree，规则与 Chat 项目任务一致，见 `docs/project-architecture/README.md` 同日 Changelog。文件系统沙箱仍不引入。）
- 不把 Developer 原生工具效果纳入 operation journal。
- 不改变一条 Run 一个 active Run、一个 LangGraph thread 的边界。
- 不做数据迁移；旧 immutable TeamVersion 按原文读取并保持旧图语义。
