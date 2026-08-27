# `@worklite/model-gateway`

Provider-neutral model access for WorkLite.

The package keeps WorkLite-owned request, message, result, usage, and provider configuration types separate from the underlying model SDK. `AiSdkModelGateway` is the initial implementation and supports DeepSeek, OpenAI, and OpenAI-compatible providers through AI SDK. Provider initialization accepts the SDK-supported API key, base URL, OpenAI organization/project, and custom headers. Header values remain caller-owned secrets and are copied into the SDK request without being logged or returned by the gateway.

Provider credentials are supplied by the caller for one operation. This package does not persist secrets, enforce team authorization, publish model catalogs, retry jobs, or execute tools. Those responsibilities belong to the API, worker, domain services, and agent runtime.

The public contract supports text streaming and one-step Agent generation with normalized Skill-script tool calls. The gateway describes tools and normalizes model messages, while WorkLite domain services retain assignment validation, immediate execution, persistence, and audit ownership. Structured output, multimodal content, model discovery, and provider-specific options will be added only after their WorkLite-neutral contracts are defined.
