# WorkLite 本地部署

首次部署需要 Node.js 22、pnpm 10 和 `lsof`：

```sh
pnpm deploy:local
```

部署成功后会自动检查并在 `~/.local/bin` 安装指向此项目的 `worklite` 命令。如果该目录不在 PATH 中，将安装脚本提示的 `export` 命令加入 shell 配置并重新加载。项目目录需要保留在原位置。

之后可在任意目录执行：

```sh
worklite start
worklite restart
```

命令启动上次成功部署的版本，默认地址为 http://127.0.0.1:23390/，不会重新构建或修改部署版本。更新项目代码后仍需在项目目录运行 `pnpm deploy:local`；重启电脑后可运行 `worklite start`。数据保存在项目的 `.data/deployment` 中。

## Agent 配置文件

Agent 配置保存在 `~/.worklite/agents/`，可用 `WORKLITE_AGENTS_DIR` 指定其他绝对目录。配置目录独立于部署版本。首次启动会将已有 Agent、子 Agent、已分配的 Skills 和私有 Tools 迁移成文件，保留原 ID、执行记录和引擎会话。

```text
~/.worklite/agents/qcoder/
├── AGENT.md
├── skills/<skill>/SKILL.md
├── tools/<tool>.yaml
└── subagents/
    ├── im-claude/AGENT.md
    └── im-codex/AGENT.md
```

`AGENT.md` 使用 YAML frontmatter 保存配置，正文是提示词，例如：

```markdown
---
id: agt_example
name: example
responsibility: 完成项目任务
runtime:
  kind: native
model: provider/model
collaboration:
  publicModels:
    - provider/model
  capabilities: []
---

这里填写 Agent 的完整提示词。
```

子 Agent 的归属来自 `subagents/` 目录，不在 frontmatter 中填写 `subAgentIds`。私有工具在 `tools/*.yaml` 中声明 `name`、`description`、`inputSchema`、`handler`；Skills 的 `SKILL.md`、脚本和参考文件放在自身的 `skills/` 下。共享 Skill 被选中时会复制到该 Agent，之后独立维护。MCP 配置只保存服务器 ID，凭据仍由平台管理。`tools/` 与 `subagents/` 只属于 native Agent；Codex/Claude 包不生成这些目录。创建或修改会严格校验暂存包和最终目录，最终配置与运行索引都可读取后才提交，失败时恢复文件及索引。

平台列表和 Chat 的 `@` 入口只显示顶层 Agent。通过主 Agent 配置管理子 Agent；子 Agent API 使用 `/api/agents/:parentId/sub-agents/:childId`，不能从全局入口直接运行。配置页面的保存操作也写入这些文件；手工编辑文件在后续读取/调用时生效，正在执行的任务继续使用已捕获的配置。删除配置文件不会从数据库恢复旧定义；删除主 Agent 会一次级联删除其全部后代，不需要先清空子 Agent；删除操作保留历史执行数据并停用被删除 Agent 的定时任务。数据库 Agent 行仅为运行索引，不能再作为配置来源直接编辑。

迁移状态记录在数据库中。移动目录时需要同时调整 `WORKLITE_AGENTS_DIR` 和迁移记录中的根路径；只修改环境变量会拒绝启动，避免误导入另一套配置。

## 运行时与微信配置

Chat 配置可选择原生模型、Codex App Server 或 Claude Agent SDK；运行时选择对新会话生效，已有会话继续使用捕获的运行时。引擎版 Chat 在 `~/.worklite/chat/session-*/` 中工作，禁止指向 `.worklite` 根目录。每轮从 Chat 配置捕获 Skills，重建 `.agents/skills` 和 `.claude/skills`，并从同一份内容生成 `AGENTS.md`、`CLAUDE.md`。平台操作通过只绑定当前轮次的本机 MCP 服务执行；项目事务仍委派给 Agent，任务卡片、提问、计划、流式输出及微信报告沿用现有通道。

Codex App Server 和 Claude Agent SDK 也是内置 Agent 运行时，无需插件配置。Codex 使用主机上可用的 `codex` 命令和 `CODEX_HOME`（默认 `~/.codex`）配置；显式选择 Gateway 模型时注入本次执行的 Responses Provider。旧会话保留已捕获的启动配置。Codex 的 `service_tier = "fast"` 会在本次进程中覆盖为上游接受的 `priority`，不会修改用户的 `config.toml`。Claude 默认配置位于 `~/.worklite/claude`；也可直接选择 `anthropic/messages` 的 Gateway 模型。

`codex/responses` Provider 反代与 Codex App Server / Claude Agent SDK 引擎运行时共存。Provider 页面可创建该协议，也可通过 Codex 账号池登录或导入 OAuth 账号；账号连接后会自动同步默认 `codex` Provider 及模型目录。反代转发 Responses、模型发现和图片生成，在上游边界把 `service_tier: "fast"` 转为 `priority`。已存在及新建的活动 Provider 不会再被启动迁移删除或强制切换运行时；旧退役身份、已完成的迁移标记和已经切换到引擎的配置继续保留。尚未完成的退役身份迁移仍修正 Chat、Agent、版本、执行快照及 Agent 文件配置；保留历史消息、工具证据及引擎支持的推理强度/服务档位；旧 Provider 请求 JSON 参数不适用于引擎，迁移时移除。拥有子 Agent 或能力工具的旧 Agent 通过受限 MCP 保留其委派与工具能力。没有默认项目目录的 Agent 仍须在派发时提供绝对项目目录。

验证：`pnpm typecheck`；构建使用 `pnpm --filter @portkey-ai/gateway build`、API 的 `nest build --builder webpack --webpackPath webpack.config.js` 和 Web 的 `vite build`。可选真实引擎冒烟：设置 `WORKLITE_LIVE_CODEX_SMOKE=1` 运行 `chat-runtime-live.smoke.test.ts`；设置 `WORKLITE_LIVE_CLAUDE_MODEL=<Provider名>/<模型>` 运行 `chat-runtime-claude-live.smoke.test.ts`。两者均只调用临时 MCP 工具，不改项目代码。

微信私聊在 Chat 的“渠道”中配置。公众号登录在具备 `wechat-official-account/publish` 能力的 Agent 配置页管理，公众号会话仍由工作区共享。数据库升级会将微信凭据和连接状态从旧插件表迁移到渠道表，保留公众号会话和历史记录；独立 Codex CLI Chat 已移除。

公众号授权等待时，Agent 会返回当前会话的二维码图片附件和可复制的扫码页链接；微信渠道按原生图片发送。扫码页展示同一会话，二维码过期后可在页内刷新，授权完成后返回对话续接原调用。默认入口通过独立的临时端口提供给同一局域网内的手机，只能访问带随机令牌的扫码页，不开放管理 API；没有局域网地址时仅本机可访问。跨网络使用需将 `WORKLITE_PUBLIC_URL` 配为可访问的 WorkLite 根地址，并代理 `/api/agent-actions/scan/`（GET、POST）。入口 15 分钟后失效，需从对话重新获取；API 重启后旧入口失效。旧二维码过期、浏览器关闭或监控失败会释放账号占用。


## 数据保留与空间回收

默认每 15 分钟由独立 worker 清理一次；有积压时每 5 秒继续一批。删除每批最多 500 条，空间回收每次写锁最多移动 16 页，每轮最多 1024 页。清理、存量压缩、增量 vacuum 和 WAL 截断均不在 API / Gateway 主线程执行。

| 记录 | 默认策略 | 配置 |
| --- | --- | --- |
| 命令输出 | 3 天后仅保留 stdout/stderr 合计末尾 16 KiB | `COMMAND_STREAM_RETENTION_DAYS`、`COMMAND_STREAM_TAIL_KILOBYTES` |
| 已结束命令及其事件 | 30 天后删除，工具结果仍保留 | `COMMAND_HISTORY_RETENTION_DAYS` |
| 执行、运行时事件与已结束项目任务活动 | 7 天；保留最新快照、会话重连序号和任务轮次/steer 记录 | `RUN_EVENT_RETENTION_DAYS` |
| 已成功消费的工具包副本 | 所属执行完成后，清除超过 7 天的副本；失败和活跃执行保留以供重试 | `TOOL_PACKAGE_RETENTION_DAYS` |
| API 请求日志 | 1 天 | `API_REQUEST_LOG_RETENTION_DAYS` |
| Gateway 请求和响应正文 | 12 小时 | `GATEWAY_REQUEST_LOG_RETENTION_HOURS` |
| Gateway 请求统计 | 90 天 | `GATEWAY_STATS_RETENTION_DAYS` |

所有保留期设为 `0` 均可关闭对应清理。清除频率由 `SQLITE_MAINTENANCE_INTERVAL_MINUTES` 设置，积压重试间隔由 `SQLITE_MAINTENANCE_CATCH_UP_SECONDS` 设置，批量大小由 `SQLITE_MAINTENANCE_BATCH_ROWS` 设置。完整默认值见 `.env.example`。过期的回放和请求明细不等于没有发生过请求；Agent 历史、保存的对话、结果、产物和运行时用量摘要继续保留。超过 Gateway 统计保留期的用量应以已保存的运行时摘要为准，两者不能相加。

旧数据会在后台分批处理：会话消息和项目活动迁到逐条存储，Skill 包、能力快照、工具输出和大事件正文无损压缩；兼容读取原有 JSON。迁移不会自动重试任务。新安装在建表前启用增量空间回收；历史 `auto_vacuum=NONE` 数据库不会在线执行全库 `VACUUM`，需要安排停机转换；已有 `INCREMENTAL` 数据库会自动归还空闲页。

需要立即处理存量时，可在仓库根目录运行 `node scripts/sqlite-maintenance.cjs .data/deployment/worklite.db --catch-up`，Gateway 使用 `node scripts/sqlite-maintenance.cjs .data/deployment/worklite-gateway.db --gateway --catch-up`。使用新存储格式前应先启动已升级版本以完成迁移；仍在运行旧版本时加 `--legacy-safe`，仅执行旧格式兼容的过期清理和空间回收。命令使用独立连接，遵循相同保留期，不启动或重启服务。不要同时对同一数据库运行多个维护命令。

本地全量回归使用 `pnpm test`，覆盖工作区测试与 Gateway 的 WorkLite/纯工具单元测试。Gateway 也可单独运行 `pnpm --filter @portkey-ai/gateway test:gateway`。第三方上游 Jest 测试保留在 `test:upstream`、`test:plugins` 中，真实服务集成测试需配置各自凭据；不会混入本地 Vitest 回归。真实 Codex/Claude 冒烟仍需显式设置对应环境变量。
