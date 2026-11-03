# Claude Agent SDK 执行器实施文档

## 目标

将 WorkLite 中 Claude 项目执行器改为使用官方 TypeScript Agent SDK。SDK 负责启动和驱动 Claude Code Agent、处理协议与工具循环；WorkLite 负责创建任务、准备任务资源、处理用户提问、记录任务状态和向用户报告结果。

这次迁移以 SDK 的公开 API 为边界设计，不以复刻当前 CLI 参数、控制协议或命令执行记录为目标。Claude Agent SDK 仍会运行其提供的 Claude Code binary；目标是移除 WorkLite 对该进程协议的自行实现。

适用范围是通过 Claude 执行的 Chat 项目任务和 Coder 角色任务。Codex 执行器继续使用自己的执行方式。产品界面只展示用户明确要求的信息，本方案不增加任务卡片或执行记录的展示字段。

## 现状与需要改变的边界

当前 `ClaudeCodeService` 拼接 CLI 参数，通过 `CommandsService.openStdioProcess` 启动进程，自行处理 JSON 行、初始化、权限控制、流式消息和提问。它将命令执行 ID 作为执行活动的一部分，并通过临时配置文件注入系统提示、Gateway 和 MCP。Claude 可执行命令还作为插件配置保存和检测。

新设计直接使用 `@anthropic-ai/claude-agent-sdk` 的 `query()`、SDK 消息流和 `canUseTool`。不实现 SDK 的自定义进程启动适配器；进程启动、退出和协议由 SDK 管理。平台保留任务级活动和错误信息，Claude 任务不再依赖 `CommandExecution`、进程 ID 或原始 stdout/stderr 作为业务身份。

## 目标架构

```text
Chat 项目任务 / Coder 任务
        ↓
ProjectExecutorService：准备工作目录和任务资源
        ↓
Claude Agent SDK 执行器：query、消息映射、提问与取消
        ↓
Agent SDK 管理 Claude Code 运行时
        ↓
WorkLite Gateway / MCP servers / 项目文件
```

### SDK 配置

1. 在 API 包中固定 Agent SDK 版本，并在 lockfile 中固定依赖。使用 SDK 附带的 Claude Code binary；移除 Claude 插件的命令路径、固定参数和 `--version` 探测。SDK 与其 binary 随应用依赖一起升级。
2. 每次执行使用项目工作目录、任务选定模型和 WorkLite 提示词。显式使用 `claude_code` 系统提示预设并追加 WorkLite 指令，以保留 Claude Code Agent 的基础工作方式。SDK 默认系统提示较精简，不能依赖默认值。
3. 使用流式输入和 `includePartialMessages` 消费 SDK 消息。将文本增量、完整回复、工具调用和结果转换为平台已有的任务活动；内部只消费业务需要的消息。保留事件顺序，等待事件持久化后再完成任务。
4. 使用 `mcpServers` 配置选定的 HTTP MCP 服务，继续执行服务发现和工具限制。仅将已发现且选定的服务交给 SDK；发现失败时记录可诊断错误，并延续当前资源可用性语义。凭据不进入任务活动或应用日志。
5. 使用 SDK 的本地 `plugins` 配置加载任务选定的 Skill 包。项目和用户的 Claude 配置来源应显式指定为 `user`、`project`、`local`，使运行环境可预测；项目指令、用户配置与任务资源的合并顺序在实施时固定并验证。
6. Gateway 模型通过 SDK 的 `settings` 设置 `ANTHROPIC_BASE_URL` 和认证值，通过 `env` 注入请求归属头。传入 `env` 时保留所需的继承环境。继续校验所选 Gateway 模型支持 `anthropic/messages`。
7. 显式设置 `permissionMode: 'bypassPermissions'` 和 `allowDangerouslySkipPermissions: true`，与当前直接执行授权一致；`canUseTool` 专门处理到达应用的提问或权限请求。明确的拒绝规则和选定 MCP 工具限制仍须生效。
8. 设置 `persistSession: false`。一次任务执行对应一个 SDK session；WorkLite 数据库存储任务状态和必要活动，不依赖 Claude 本地会话文件恢复任务。

## 生命周期与用户提问

任务启动后创建 SDK 流式 session。收到 `AskUserQuestion` 时，`canUseTool` 将问题交给现有任务状态机，任务进入 `waiting_for_input`，SDK session 保持存活。用户在 Chat 中回答后，回调将答案按 SDK 的 `AskUserQuestion` 输入格式返回，任务恢复运行。回调需响应取消信号，防止取消后继续等待。

这种设计让同一次 Agent session 接收答案，不再通过拒绝工具调用、结束进程和拼接新一轮提示来模拟问答。现有 Chat 和 Coder 的任务控制接口应统一接入这个生命周期；用户看到的提问入口和展示内容遵循现有产品要求。

SDK session 是进程内状态，API 重启后不能继续等待原回调。启动恢复时，将受影响的运行或等待任务标记为中断，保留已有任务活动和问题；用户可按现有任务控制流程重新发起执行，并明确获得中断结果。不得把新 session 标记成已恢复的原 session，也不得自动重放可能已产生副作用的工作。

取消时先通过 SDK 的中断能力停止当前流式执行，再关闭 session；设置有界等待时间，超时后通过 SDK 的关闭/取消机制结束。确保用户提问回调、消息消费和任务状态收敛为同一个取消结果。SDK 异常、错误 result、空结果和进程异常退出应转成可读的任务失败原因；不要依赖 CLI 错误字符串或退出码判断业务结果。

## 数据与配置调整

- 为 Claude 执行活动提供任务级标识；调整 `ProjectExecutorActivity` 中对 `commandExecutionId` 的必填假设。Codex 仍可使用其原有命令执行记录。
- Claude 启动快照记录执行器、选定模型和任务资源配置；不再捕获 CLI 命令数组。运行时固定使用应用安装的 SDK 版本。
- 删除 Claude CLI 插件的命令配置、命令测试和相关文案，避免保留一个不再生效的设置。同步调整 API contract、数据库初始化数据、插件列表及调用方。
- 历史任务及其已有命令记录作为历史数据保留并可读取；新执行使用新的快照结构。旧运行中的任务在服务切换时按中断处理，不建立旧协议和新 SDK 的双运行模式。
- 保留任务结果、提问、活动及 Gateway 请求归属所需的数据；不额外持久化完整 SDK 原始消息或工具输入输出。检查现有执行记录依赖，防止删除命令 ID 后出现断链。

## 实施步骤

1. 增加并固定 SDK 依赖；确认本地开发、生产安装及 Alpine 镜像均包含匹配架构和 libc 的 SDK binary。
2. 实现 SDK 执行器及清晰的 session 生命周期：创建、消息消费、等待提问、回答、取消、关闭和失败。使用 SDK 类型处理消息与权限回调。
3. 将 Gateway、归属头、MCP、Skill、工作目录、系统提示和图片/参考资料接入 SDK。按任务捕获资源配置，避免运行期间配置变化影响已启动任务。
4. 调整 Chat 项目任务和 Coder 任务的提问、答案、取消和服务重启处理，使它们使用存活 session；移除仅为旧 CLI 提问恢复设计的重跑分支。
5. 将任务活动与执行记录从 Claude 的命令执行 ID 解耦，保留用户已有历史记录的读取能力。
6. 移除手写 stream-json 控制协议、临时 CLI 参数文件、Claude 可执行命令插件配置及无效契约；同步更新内置说明和部署文档。
7. 完成下述验证后再切换运行。更新部署时应停止或标记受影响的活跃任务，避免重复执行。

## 验收与验证

自动化验证应覆盖有意义的行为边界，包括：SDK 消息到任务活动的顺序映射；提问后等待、回答继续、等待时取消；SDK 失败和异常退出；Gateway 配置及归属头；MCP 工具限制和发现失败；Skill 加载；服务重启后的中断处理；历史任务读取；Codex 执行器不受 Claude 迁移影响。

在真实 SDK 和测试 Gateway 环境中完成端到端验证：普通任务、工具调用、流式输出、提问后继续、运行中取消、Gateway 模型、选定 MCP 与 Skill，以及 API 重启。验证过程中确认没有自动重放，任务记录和实际执行结果一致。部署构建还需验证目标系统的 SDK binary 可被解析和启动。

完成标准：Claude 任务完全通过 Agent SDK 公开接口执行；任务问答、取消、结果和历史记录正常；Claude 不再要求用户配置或安装独立的 `claude` 命令；平台不再自行实现 Claude 的 stdio 控制协议。

## 参考

- [Agent SDK 概览](https://code.claude.com/docs/en/agent-sdk/overview)
- [TypeScript SDK 参考](https://code.claude.com/docs/en/agent-sdk/typescript)
- [流式输入](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)
- [处理审批和用户输入](https://code.claude.com/docs/en/agent-sdk/user-input)
- [SDK 安装与 binary](https://code.claude.com/docs/en/agent-sdk/quickstart)
