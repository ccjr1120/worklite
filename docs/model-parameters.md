# 模型使用处参数

参数在使用模型的位置设置，不写入 Provider 配置，也不修改本机 Codex／Claude 配置。

- Chat：设置 → 模型配置，在模型下选择推理强度、服务档位及请求参数 JSON。后续回合和 `/summarize` 使用该配置；已开始的回合保留自己的快照。
- Agent／子 Agent：配置页的每个模型下分别设置参数。候选模型各自保存参数，自动切换时使用对应模型的参数。
- Codex／Claude 运行时：选择推理强度和服务档位；模型留空时也可覆盖本机运行时的参数。参数随新任务捕获，已有引擎会话的续跑保留原快照。
- Provider 测试：在测试弹窗中为本次请求选择参数，关闭后不成为 Provider 默认值。
- 节点重跑：在模型下设置本次重跑的参数，不修改原节点定义。
- TypeSafe 能力：在能力的 `config.modelParameters.requestBody` 中填写协议参数；System One Map 的每项调用都携带该配置。

未指定参数时不发送覆盖值，由上游模型或运行时决定。`default` 是显式标准服务档位，`fast` 是显式快速模式；参数是否可用取决于具体模型和账号，快速模式可能增加费用。

AGENT.md 示例：

```yaml
modelParameters:
  reasoningEffort: high
  serviceTier: fast
```

原生 Agent 的候选模型可分别配置，键与 `publicModels` 中的完整名称一致：

```yaml
collaboration:
  publicModels:
    - openai/gpt-model
    - anthropic/claude-model
  modelParameters:
    openai/gpt-model:
      reasoningEffort: high
      serviceTier: fast
    anthropic/claude-model:
      reasoningEffort: medium
      requestBody:
        thinking:
          type: adaptive
```

`requestBody` 使用所选协议的字段，如 `temperature`、`max_output_tokens`、`thinking`。不得覆盖模型、消息、工具、流式控制及平台归因字段。Codex／Claude 引擎只提供其 SDK 支持的推理强度和速度设置；额外请求 JSON 用于原生 Agent 和协议请求。

协议映射：OpenAI Responses 使用 `reasoning.effort`，Chat Completions 使用 `reasoning_effort`，两者使用 `service_tier`；Anthropic Messages 使用 `output_config.effort` 和 `speed`。Codex App Server 使用 `turn/start.effort` 和 `serviceTier`，并将当前进程的配置覆盖为同一选择。

参数依据：[OpenAI App Server](https://learn.chatgpt.com/docs/app-server)、[OpenAI Fast mode](https://developers.openai.com/api/docs/guides/fast-mode)、[Anthropic effort](https://platform.claude.com/docs/en/build-with-claude/effort)。
