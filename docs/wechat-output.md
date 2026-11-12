# 微信渠道输出能力与转换规则

调查日期：2026-11-06。对象是 WorkLite `chat_channels` 的微信私聊适配器，使用腾讯 OpenClaw Weixin / iLink Bot 协议，默认 `ilinkai.weixin.qq.com`；公众号发布与企业微信机器人的能力不适用于这里。

## 证据与可信范围

对照腾讯仓库提交 [`874637a`](https://github.com/Tencent/openclaw-weixin/tree/874637a0dbc24050f72d1385add4fc6170a2d726)：

- [协议说明](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/docs/protocol.md)与[消息类型](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/api/types.ts)：文本走 `text_item.text`，图片走 `image_item` 和加密 CDN 上传；还有语音、文件、视频类型。消息类型中没有普通业务卡片、模板消息或交互按钮。类型存在不代表所有能力均已实现，协议说明也明确不能据客户端类型推导完整服务端契约。
- [Markdown 过滤器](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/messaging/markdown-filter.ts)及其[测试](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/messaging/markdown-filter.test.ts)：确认客户端保留/移除哪些语法；这不是所有微信版本的视觉验收。
- [渠道声明](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/channel.ts)设置 `textChunkLimit: 4000`，没有说明服务端按字符还是字节限制；不能将它宣称为官方硬性上限。

## 格式清单

| 格式 | 确认的接口或上游行为 | WorkLite 输出策略 |
| --- | --- | --- |
| 纯文本、Unicode、换行 | 文本字段原样承载 | 保留正文、换行与段落 |
| H1–H4、粗体、分隔线 | 上游保留标记 | 保留短内容格式 |
| 有序/无序列表、引用 | 上游透传 | 保留列表、序号、任务勾选文字与引用行；不提供可点击控件 |
| 行内代码、围栏代码 | 上游保留 | 代码字面内容不做 Markdown 降级、不识别其中的图片链接；长代码关闭并重开围栏 |
| 非中日韩文字斜体/粗斜体 | 上游保留 | 保留斜体；嵌套粗体可保留 |
| 中文等 CJK 斜体/粗斜体 | 上游去掉标记 | 去掉斜体，保留内容与可用的粗体 |
| H5/H6 | 上游去掉标题标记 | 转为普通标题文字 |
| 删除线 | 上游没有专门转换 | 保守降级为文字，视觉支持未确认 |
| Markdown 表格 | 上游保留语法 | 为手机阅读转为逐行“原表头：原单元格值”，保留行顺序与图片 |
| Markdown 链接、裸 URL | 文本可以承载；点击、预览未获完整规格 | 显示标签与完整目的地址 |
| Markdown 图片 | 上游过滤器直接移除图片语法；原生图片另走媒体接口 | 已注册 Artifact/附件图片使用原生图片消息，按正文顺序穿插；外部图片链接显示标签与 URL，不自动下载 |
| HTML、裸尖括号 | 没有可信的 HTML 渲染契约 | 正文尖括号转全角，代码保持字面值；不发送 HTML 富文本 |
| 卡片、模板、按钮、消息编辑 | 已查协议及本地实现没有可用接口 | 不伪造支持；提问转文字选项，由用户文字回复 |
| 文件 | 上游有明确的上传与 `file_item` 发送实现，见下节 | 本地已实现原生文件发送；使用真实 Artifact/附件下载引用触发 |
| 语音、视频 | 上游有相关类型（类型并不单独证明出站可用）；视频有发送实现 | 本地没有原生语音/视频发送；已有视频文件可作为普通文件附件发送 |

HTML 尖括号还存在[上游客户端实测报告 #245](https://github.com/Tencent/openclaw-weixin/issues/245)：裸 `<` 可能吞掉行后内容，实体转义可能按字面显示。这是特定客户端版本报告，本任务未自行复现，因此采用保守替换，不视为所有版本规格。

## 本地实现

`apps/api/src/modules/connections/wechat/wechat-reply-format.ts` 在发送前解析完整 Markdown，提取真实图片引用并执行格式转换。分片上限保持原来的 **3500 UTF-8 字节**，这是 WorkLite 自设预算。短 Markdown 块完整保留；过长的正文块降级后按文字边界切分，Unicode 字素尽量保持完整；围栏代码独立闭合。过长且含代码的混合正文/列表块以原文代码块保护，避免去掉行内标记后破坏命令或尖括号。不再截断后文，也不额外插入分片序号或解释。

`wechat.service.ts` 顺序发送所有文字分片、图片与文件，复用每片的稳定 `client_id`、入站 `context_token` 与数据库成功回执。后片失败只重试没有本地成功回执的片段；API 接受后、回执写入前进程中断仍依赖服务端对同一 `client_id` 的处理，不能声称绝对 exactly-once。普通模型增量不发送为独立消息。

Chat 的 `run_agent` 成功受理后台新任务或继续执行后，若该对话在同一工作区绑定微信，立即向 `chatSubmissions` 投递队列写入一条简短纯文本通知，例如「已派 @codex：修复微信通知，正在执行」。不等待 Chat 回合结束或约五分钟后的进展提醒。Agent 名称最多 40 个 Unicode 码点，任务概要最多 120 个码点，超长加省略号；压平换行、去掉 Markdown 装饰并处理尖括号。正文仅作为文本发送，不解析附件引用。没有可用名称或概要时静默跳过，不生成坏内容。Web 保持现有任务卡片，不追加助手确认正文；飞书不新增此通知。微信随后继续接收有变化的周期进展、需要回答的问题与最终结果。

派发通知与后台任务受理在同一个数据库事务内提交，启动校验失败或事务回滚不入队。通知复用 `conversation` 投递窗口，以工具调用 ID 生成稳定主键 `dispatch_<callId>`，冲突不重复插入；`dispatchNotice` 固定文本快照与 `completionStatus: completed` 使窗口独立于后续对话正文。已受理调用重试时读取持久派发记录，不再次启动任务或重开通知窗口；同一 Agent 的下一次明确继续执行是新的工具调用，可收到新通知。投递沿用现有 `settled=false` 扫描、内容指纹、逐片成功回执与稳定 `client_id`；网络失败或登录失效保留待投递，恢复后续传，重启后不重发已有本地成功回执的内容。API 已接受但本地回执未保存的极小窗口仍依赖服务端对相同 `client_id` 去重，不能保证绝对 exactly-once。

除 `run_agent`（已有上述更详细的派发通知，不重复发送）外，微信绑定对话的每个已受理原生工具调用（`run_host_command`、`skill_script` 等）在进入执行前都会立即投递一条「正在执行：<工具或脚本名>」纯文本通知；标签优先取 Skill 脚本文件名，否则取内部工具名。调用仍在执行时按固定间隔（`WECHAT_TOOL_PROGRESS_INTERVAL_MS`，默认 20 秒）重复投递「仍在执行：<标签>（已运行 N 秒）」，调用结束（成功、失败或取消）后立即停止，不补发结束通知。这些通知与派发通知复用同一套 `dispatchNotice`/`completionStatus: completed` 窗口机制，稳定主键为 `toolstart_<callId>` 与 `toolprogress_<callId>_<timestamp>`，冲突不重复插入。飞书与 Web 不受影响：Web 仍用任务面板展示工具调用，飞书不新增此通知。

派发通知的本地验证使用内存数据库与模拟 iLink 网络：覆盖微信绑定与工作区隔离、新任务和继续执行、派发失败与事务回滚、已受理调用重试、文本概要长度与格式、运行中的 Chat 即时投递、网络/登录失败续传，以及重建服务后沿用成功回执。相关 205 项测试、全仓类型检查、改动文件 ESLint、Gateway/API/Web 构建通过。未向真实微信联系人发消息，未验证手机端最终收件或展示；本次未部署。

图片继续走现有工作区边界、内容读取、字节格式与尺寸验证。PNG/JPEG/GIF/WebP、10 MB、单边 16384 像素和 4000 万像素是 **本地校验范围**，不是已确认的微信服务端格式/尺寸上限。读取、校验或平台拒绝后发送现有可读失败提示，不泄露内部存储地址。

`packages/db/src/client.ts` 的 Chat 提示词及平台 Skill 源同步写入上述规则；模型调用时按会话绑定查询 `web / feishu / wechat`，避免模型猜测渠道。数据库下次初始化同步种子提示词，后续回合捕获新配置；本次没有修改运行中数据库或部署。

## 验证边界

本地测试覆盖实际协议请求体、加密图片上传、格式转换、Unicode 分段、代码围栏、文本图片顺序以及失败续传；测试使用模拟网络与真实内存数据库。没有向真实微信联系人发送探针消息，没有手机端视觉验收。各微信版本的 Markdown 外观、链接点击与预览、GIF 动画、服务端真实长度和频率上限、最终收件状态均未独立确认。接口返回成功仅证明接口接受请求。


## 文件发送：协议依据与边界

本次补齐依据仍固定在腾讯官方仓库提交 `874637a0dbc24050f72d1385add4fc6170a2d726`，不是公众号或企业微信接口。以下「已确认」指官方公开协议说明与参考客户端的具体代码行为，不等同于完整服务端契约或本机真实收件验收。

| 项目 | 已确认的证据 | 不能据此推导的结论 |
| --- | --- | --- |
| 出站支持 | [send.ts 的 sendFileMessageWeixin](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/messaging/send.ts#L346-L382)实际构造 `type:4`、`file_item`；[send-media.ts](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/messaging/send-media.ts#L55-L70)调用上传与发送，不只是类型声明 | 不代表所有扩展名、大小和客户端版本都保证接收 |
| 获取上传地址 | `POST /ilink/bot/getuploadurl`，`media_type:3`，含 `filekey`、`to_user_id`、明文 `rawsize` / `rawfilemd5`、密文 `filesize`、hex `aeskey`、`no_need_thumb:true`；见[协议](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/docs/protocol.md#getuploadurl)与[upload.ts](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/cdn/upload.ts#L55-L111) | 没有公众号的临时素材 `media_id` 步骤；上传参数与下载参数有效期未确认 |
| CDN 上传 | AES-128-ECB / PKCS#7 加密；向 `upload_full_url`（优先）或 `upload_param` 构造地址 POST 密文；需 HTTP 200 与 `x-encrypted-param`。见[上传实现](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/cdn/upload.ts) | 接口接受上传不代表文件消息已投递 |
| 发消息 | `POST /ilink/bot/sendmessage`，每请求一个 `file_item`：`media.encrypt_query_param` 使用 CDN 返回值，`media.aes_key` 为 hex 文本再 base64，`encrypt_type:1`；`len` 为明文字节数的十进制字符串；带稳定 `client_id`、`message_type:2`、`message_state:2` 与入站 `context_token`。见[发送构造器](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/messaging/send.ts#L346-L382) | API 成功不证明最终收件、下载或展示成功；不保证绝对 exactly-once |
| 凭据 | 复用现有扫码登录的 bot token 和会话上下文，共用 JSON 请求认证与 `base_info` | 无需额外公众号 appId/appSecret；过期登录仍需重新扫码 |
| 文件名 | 上游用本地 `basename` 传入 `file_item.file_name`，不会仅发送随机对象名 | 各微信版本对中文、长名称和特殊字符的最终显示未自行确认 |
| 文件类型 | 上游按 MIME 将非图片、非视频交给文件路径，注释举例 PDF、DOC、ZIP；上传接口没有 MIME 字段。见[send-media.ts](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/messaging/send-media.ts) | 没有获得官方完整扩展名白名单/黑名单，不能宣称任何类型都必然成功 |
| 大小与频率 | 已查协议、上传和发送代码没有声明完整服务端数字上限。上游[引用缓存的 25 MiB](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/docs/quote-cache_zh_CN.md)属于本地缓存策略 | 不能将缓存限制当上传限制，也不能将 WorkLite 的 20 MiB 当微信硬上限；没有确认每秒/每天配额或限流解除时间 |

[上游问题 #153](https://github.com/Tencent/openclaw-weixin/issues/153)报告过较大文件失败，[问题 #270](https://github.com/Tencent/openclaw-weixin/issues/270)报告过 `rate limited`。它们是用户环境的一手报告，不是腾讯承诺的统一大小/频率规格，本次没有将报告阈值作为硬编码协议限制。

## 文件发送：WorkLite 与 Chat 用法

1. **已有本地文件、本地产物**：Chat 调用 protected tool `upload_local_files`，参数例如 `{"files":[{"path":"/absolute/report.pdf"},{"path":"/absolute/data.xlsx"}]}`。它调用 `POST /artifacts/local-files`，在当前工作区登记持久 Artifact，返回标准 protected snapshot 的 `data.files`，含真实名称、`contentUrl` 和 `markdown`。Chat 在最终回复中原样放入每个 `markdown`，适配器按正文顺序发送原生文件。登记成功不等于微信发送成功。
2. **已有 Artifact**：从平台查询取得真实 id，回复 `[报告](/api/artifacts/art_REAL/content?download=true)`。原有内联 text / markdown / json 直接以 UTF-8 原始内容输出 `.txt` / `.md` / `.json`，不要求模型重新生成；已登记二进制文件读取存储原始字节。非图片 Artifact 的普通 content 引用也会按文件处理。
3. **已有附件**：实时有效的 `[文件名](/api/chat/attachments/att_REAL?download=true)` 可按文件发送。当前 Web 附件创建入口仍只接收图片，普通本地文件使用上面的 `upload_local_files`。图片不带 `download=true` 时保留原生图片行为；显式下载引用可把图片作为文件发送。外部 URL 不会自动下载，本地绝对路径不会被正文解析器直接读取；代码块中的示例引用不触发发送。

文件路径必须为 API 宿主机可读的普通文件，拒绝路径穿越、符号链接与读取期间变化（macOS 系统目录别名例外）。完整批次先校验再写入：1–8 个文件，每个最多 **20 MiB（20 × 1024 × 1024 字节，界面提示写作 20 MB）**，合计 **40 MiB**，空文件拒绝。所有扩展名按不透明文件处理，不伪造微信类型白名单；平台拒绝时降级。名称保留原始 basename，清理路径/控制字符并最多保留 200 个 Unicode 码点。二进制 Artifact 沿用现有 `unsupported` 预览格式，实际字节持久保存，Web content 路由强制附件下载，避免把 HTML 等文件以内联页面执行。未新增产品 UI 字段。

微信按当前会话工作区读取 Artifact/有效附件，不从链接远程抓取、不接受正文路径直接外发。发送前再次检查真实文件大小，上传前和读取时均有字节预算。所有文字、图片、文件串行发送；成功回执按提交、内容指纹与片段序号保存，后续重试跳过已确认的片段。

- 文件不存在/附件过期：发送“文件已过期或不存在，请在 WorkLite 查看”。
- 空文件、不可读或无效：发送对应可读提示。
- 超过本地预算：发送“文件超过当前渠道的 20 MB 发送上限，请在 WorkLite 查看”。
- 平台拒绝、CDN/网络失败：发送“文件发送失败，请在 WorkLite 查看或稍后重试”；不发送内部 URL、绝对路径或坏链接。后续文件继续处理。
- bot 登录失效（`-14`）：保留为未完成投递，标记需要重新扫码；不把失败当成功。恢复登录后沿用现有投递重试。
- 降级文字本身发送失败（如同样受限流影响）：保留未确认片段，由现有渠道重试机制续传；不反复发送此前已成功的文件。CDN HTTP 4xx 不重试，网络/5xx/缺少下载参数最多尝试三次；没有擅自假定服务端限流配额。

Chat 的 `CHAT_PROMPT` 和 protected platform Skill 源已同步上述触发、限制、降级和未实现的语音/原生视频边界；数据库初始化与 Skill 协调更新按平台既有流程生效，本次未修改运行中配置或部署。验证结果：160 项相关测试通过，全仓 `pnpm typecheck`、改动文件 ESLint、Gateway Rollup / API Webpack / Web Vite 构建通过。测试使用模拟网络、真实加解密与内存数据库，验证请求字段、文件名、顺序、工作区隔离、磁盘读写/回滚、大小预算、失败提示与续传；本次没有向真实微信联系人发送文件。
