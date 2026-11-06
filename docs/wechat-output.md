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
| 语音、文件、视频 | 上游类型及发送实现存在 | 本地出站仍只支持文本、图片，不声明支持其他媒体发送 |

HTML 尖括号还存在[上游客户端实测报告 #245](https://github.com/Tencent/openclaw-weixin/issues/245)：裸 `<` 可能吞掉行后内容，实体转义可能按字面显示。这是特定客户端版本报告，本任务未自行复现，因此采用保守替换，不视为所有版本规格。

## 本地实现

`apps/api/src/modules/connections/wechat/wechat-reply-format.ts` 在发送前解析完整 Markdown，提取真实图片引用并执行格式转换。分片上限保持原来的 **3500 UTF-8 字节**，这是 WorkLite 自设预算。短 Markdown 块完整保留；过长的正文块降级后按文字边界切分，Unicode 字素尽量保持完整；围栏代码独立闭合。过长且含代码的混合正文/列表块以原文代码块保护，避免去掉行内标记后破坏命令或尖括号。不再截断后文，也不额外插入分片序号或解释。

`wechat.service.ts` 顺序发送所有文字分片与图片，复用每片的稳定 `client_id`、入站 `context_token` 与数据库成功回执。后片失败只重试没有本地成功回执的片段；API 接受后、回执写入前进程中断仍依赖服务端对同一 `client_id` 的处理，不能声称绝对 exactly-once。普通模型增量不发送为独立消息。

图片继续走现有工作区边界、内容读取、字节格式与尺寸验证。PNG/JPEG/GIF/WebP、10 MB、单边 16384 像素和 4000 万像素是 **本地校验范围**，不是已确认的微信服务端格式/尺寸上限。读取、校验或平台拒绝后发送现有可读失败提示，不泄露内部存储地址。

`packages/db/src/client.ts` 的 Chat 提示词及平台 Skill 源同步写入上述规则；模型调用时按会话绑定查询 `web / feishu / wechat`，避免模型猜测渠道。数据库下次初始化同步种子提示词，后续回合捕获新配置；本次没有修改运行中数据库或部署。

## 验证边界

本地测试覆盖实际协议请求体、加密图片上传、格式转换、Unicode 分段、代码围栏、文本图片顺序以及失败续传；测试使用模拟网络与真实内存数据库。没有向真实微信联系人发送探针消息，没有手机端视觉验收。各微信版本的 Markdown 外观、链接点击与预览、GIF 动画、服务端真实长度和频率上限、最终收件状态均未独立确认。接口返回成功仅证明接口接受请求。
