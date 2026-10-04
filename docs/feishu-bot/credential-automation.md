# 飞书应用凭证自动化调查

调查日期：2026-10-04。参考官方 `larksuite/cli`，源码版本 [`7beffb0`](https://github.com/larksuite/cli/tree/7beffb086d7fa3c5b843d8affa7c089f49cfc65e)。本次仅查看源码与文档，没有创建应用、获取现有凭证或调用飞书注册接口。

## 可以自动化的部分

官方 [`config init --new`](https://github.com/larksuite/cli/blob/7beffb086d7fa3c5b843d8affa7c089f49cfc65e/cmd/config/init_interactive.go) 使用设备注册流程，输出确认链接和二维码，用户在飞书页面完成确认后，程序轮询取得应用凭证。它不是要求用户先去后台复制 Secret 的流程。

[`app_registration.go`](https://github.com/larksuite/cli/blob/7beffb086d7fa3c5b843d8affa7c089f49cfc65e/internal/auth/app_registration.go) 给出的协议如下：

| 步骤 | 源码中的操作 |
| --- | --- |
| 申请注册 | 向 `https://accounts.feishu.cn/oauth/v1/app/registration` 提交表单，`action=begin`、`archetype=PersonalAgent`、`auth_method=client_secret`、`request_user_info=open_id tenant_brand` |
| 用户确认 | 使用返回的用户代码构造开放平台 `/page/cli` 确认地址，显示二维码与链接 |
| 等待结果 | 同一注册接口，`action=poll`，提交内部保存的 `device_code`；遵守返回的轮询间隔与过期时间 |
| 完成 | 接收 `client_id`、`client_secret`，以及可选的 `user_info.open_id`、`tenant_brand` |
| 拒绝或过期 | 分别处理 `access_denied`、`expired_token`、`invalid_grant`，不继续等待 |

因此，**应用创建、App ID/Secret 获取，以及返回了用户信息时的 Open ID 获取**，都有可参考的官方实现。用户在平台上确认应用和所属企业仍然是流程的一部分。Open ID 为可选返回值，缺失时不能把应用凭证获取成功报告成用户身份绑定完成。

## 不能直接承诺的部分

注册代码指定的是 `PersonalAgent` 类型应用，并未在注册请求中显式设置 WorkLite 所需的四项消息权限、`im.message.receive_v1`、`card.action.trigger`、长连接接收方式或应用发布。源码不足以证明这些步骤在所有企业都自动完成，也不能证明企业审批可以省略。

CLI 取得应用令牌时使用新的统一 OAuth 令牌接口，见 [`tat_fetch.go`](https://github.com/larksuite/cli/blob/7beffb086d7fa3c5b843d8affa7c089f49cfc65e/internal/credential/tat_fetch.go)。WorkLite 当前通过官方 Node SDK 运行机器人。这种扫码创建的应用与当前 SDK 的令牌取得、私聊收发和卡片回调是否完全适配，需要明确授权后的真实联调才能确认；不能用“已取得 Secret”代替“机器人已可用”。

应用机器人身份和个人用户授权分别处理。只为收发机器人消息，不需要顺带申请日历、文档、邮箱等用户权限。后续 Agent 需要操作个人资源时，再单独发起对应的用户 OAuth 授权。

## WorkLite 接入流程

飞书插件配置页提供“扫码创建应用”入口（已有凭证时为“扫码更换应用”）。服务端发起注册，网页用同一确认链接生成 PNG 二维码并提供可点击链接；确认后服务端直接将 Secret 加密保存到当前 WorkLite 数据空间，并在平台返回用户 Open ID 时完成绑定和连接。缺少 Open ID 时保留凭证、禁用连接，补充该应用的 Open ID 后保存即可。自动成功路径无需第二次保存。

保留手动应用配置，服务于已有企业应用、平台注册限制和缺失用户信息的情况。尚未确认自动完成的权限、订阅和发布步骤提供对应应用的后台入口；只有实际连接状态可以说明客户端是否已建立连接。开发和部署分别创建应用，禁止复用同一个 App ID 的两个长连接实例。

WorkLite 根据注册协议实现独立流程，避免调用 `config init` 改动本机已有 CLI 配置：[`init.go`](https://github.com/larksuite/cli/blob/7beffb086d7fa3c5b843d8affa7c089f49cfc65e/cmd/config/init.go) 显示，不使用命名配置时，初始化会替换当前配置，并清理其他应用的本机密钥和用户令牌。CLI 的 stdout 也将 Secret 掩码为 `****`，不能直接据此导入凭证。WorkLite 不需要依赖读取 CLI 的 Keychain 或解析终端交互输出。

该方案于 2026-10-04 获得确认，已先更新架构与插件页面设计，并完成服务端和网页代码。新增迁移 `0023_feishu_registration.sql` 保存加密的 device code、确认链接、过期时间和轮询间隔；终态清除 device code 与链接。API 重启继续尚未过期的等待，网页可见时自动更换过期尝试；拒绝和失败由用户再次发起。取消保留当前应用，手动保存先取消等待，按注册 id 和 pending 状态检查的事务避免迟到结果覆盖配置。升级交接等待注册请求结束，隔离预检不发起或轮询注册。

接口为 `POST /plugins/feishu-bot/feishu/registration` 发起、`DELETE` 同一路径取消；既有插件查询返回公开注册状态，不返回 Secret 或 device code。流程没有调用 CLI，没有读取其 Keychain，也没有加入用户 OAuth。

本次没有运行测试、类型检查、构建、数据库迁移、实际扫码创建应用或 SDK 联调，也没有操作现有服务。代码完成不代表上述 PersonalAgent 与 SDK 的实际适配已经证实。
