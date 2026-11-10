# macOS 宿主机通知

Chat 的 `publishSnapshotForExecution` 在完成、失败和等待输入时调用通知服务，读取最新 Chat 配置的开关和声音。取消、重复状态快照及周期性进度提醒保持静默。这与浏览器通知权限无关。

通知通过 `UserNotifications` 原生辅助应用发送，身份为 `com.worklite.notifications`，系统显示名称为“WorkLite 通知”。首次发送会自动编译、签名并注册应用，需要宿主机已安装 Xcode Command Line Tools。应用保存在 `SQLITE_PATH` 所在目录的 `host-notifications` 下，独立于 release；缺失或源码变化时自动重建，源码来自当前 release 的 `scripts/macos-notifications.swift`。

首次通知授权由 macOS 要求用户确认；应用无法替用户批准。权限被拒绝、横幅被关闭或系统日志确认专注模式抑制时，会记录 warning，并针对该原因提供一次原生设置引导。授权和专注模式允许列表由 macOS 管理，不会自动关闭用户的专注模式。普通本地签名不能凭空获得 Apple 限制的 Time Sensitive entitlement；仅在系统报告已经允许时效性通知时使用该等级。

日志区分 `submitted`（已交给系统，未证明横幅可见）、`presented`（NotificationCenter 记录允许横幅展示）、`blocked`（权限或展示策略阻止）、`failed`（编译/启动/原生调用失败）和非 macOS 的 `skipped`。退出码 0 和通知中心历史记录都不再单独视为弹窗成功。若 Unified Log 无法读取，保留 `submitted`，不会伪报展示成功。

本地回归：

```sh
pnpm exec vitest run apps/api/src/modules/notifications
```

真实通知冒烟会请求系统授权并发送一条“WorkLite 通知链路已修复”的测试通知，必须显式开启：

```sh
WORKLITE_LIVE_NOTIFICATION_SMOKE=1 SQLITE_PATH="$PWD/.data/deployment/worklite.db" pnpm exec vitest run apps/api/src/modules/notifications/host-notifications.service.test.ts -t 'sends a real WorkLite notification'
```

辅助应用支持 `--status`（只读权限诊断）。测试会检查系统横幅展示记录；用户是否看见通知仍需用户确认。

修改 API 源码不会影响已经运行的不可变旧 release。只有部署新 release 后，日常 Chat 回合才使用新通知链路；独立冒烟可以在不部署、不重启服务的情况下验证新实现。
