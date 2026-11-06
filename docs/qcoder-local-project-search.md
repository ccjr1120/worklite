# qcoder 本地项目检索

本能力由 qcoder 自己的 `tools/search-local-projects.yaml` 和 `tools/search-local-projects.mjs` 实现，不需要新增平台注册能力或修改 `collaboration.capabilities`。

将同目录两个工具文件放入目标 Agent 的 `tools/`，把 YAML 的 `handler.workingDirectory` 改为该 `tools/` 的实际绝对路径。脚本读取 `WORKLITE_TOOL_INPUT_BASE64` 中的 `{input:{query,limit?,refresh?}}` 参数，调用已有只读 `/api/local-projects/search` 索引接口，并自行检查目录状态。默认服务地址为 `http://127.0.0.1:23391`，可用 `WORKLITE_API_URL` 覆盖。工具实现和参数转换归 Agent 私有文件所有，平台无需注册新的能力类型。

只使用 `directoryStatus=exists` 的候选；多候选有歧义时请用户选择。未命中时以 `refresh:true` 重试一次；仍未命中报告“未索引”，不能声称“不存在”。`approximate` 只是建议；保留并报告 partial/stale/timedOut/truncated/aliasFileError 局限。输出截断时使用 `read_result` 读取完整结果。

后续调用自动加载文件，不需要重启 API 或部署。已有运行任务保留其配置快照。同目录 AGENT.md 仅供配置对照，不要覆盖其他环境的模型和子 Agent 配置。
