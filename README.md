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

Codex App Server 和 Claude Agent SDK 是内置 Agent 运行时，无需插件配置。Codex 使用主机上可用的 `codex` 命令和 `CODEX_HOME`（默认 `~/.codex`）配置；显式选择 Gateway 模型时注入本次执行的 Responses Provider。旧会话保留已捕获的启动配置。

微信私聊在 Chat 的“渠道”中配置。公众号登录在具备 `wechat-official-account/publish` 能力的 Agent 配置页管理，公众号会话仍由工作区共享。数据库升级会将微信凭据和连接状态从旧插件表迁移到渠道表，保留公众号会话和历史记录；独立 Codex CLI Chat 已移除。
