import AppKit
import UserNotifications

// A stable app identity is required; osascript's exit code cannot confirm a banner.
final class NotificationApp: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    let center = UNUserNotificationCenter.current()
    var payload: [String: String] = [:]

    func finish(_ result: [String: Any], code: Int32 = 0) {
        if let data = try? JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]) {
            FileHandle.standardOutput.write(data)
            FileHandle.standardOutput.write(Data("\n".utf8))
        }
        exit(code)
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        center.delegate = self
        if CommandLine.arguments.contains("--guide") {
            let focus = CommandLine.arguments.last == "focus"
            let alert = NSAlert()
            alert.messageText = focus ? "专注模式静音了 WorkLite 通知" : "允许 WorkLite 发送通知"
            alert.informativeText = focus
                ? "在系统设置→专注模式→当前模式中允许“WorkLite 通知”。macOS 不允许后台应用自动修改这项选择。"
                : "在系统设置→通知→WorkLite 通知中打开“允许通知”，并选择横幅或提醒。此授权只需设置一次。"
            alert.addButton(withTitle: "打开设置")
            alert.addButton(withTitle: "稍后")
            NSApp.activate(ignoringOtherApps: true)
            if alert.runModal() == .alertFirstButtonReturn {
                let pane = focus ? "com.apple.Focus-Settings.extension" : "com.apple.Notifications-Settings.extension?id=com.worklite.notifications"
                if let url = URL(string: "x-apple.systempreferences:\(pane)") { NSWorkspace.shared.open(url) }
            }
            finish(["status": "guided"])
        }
        if !CommandLine.arguments.contains("--status") {
            do {
                let data = FileHandle.standardInput.readDataToEndOfFile()
                payload = try JSONSerialization.jsonObject(with: data) as? [String: String] ?? [:]
                if payload["body"] == nil { throw NSError(domain: "WorkLite", code: 1, userInfo: [NSLocalizedDescriptionKey: "Missing notification body"]) }
            } catch { finish(["status": "failed", "error": error.localizedDescription], code: 1) }
        }
        center.getNotificationSettings { settings in
            if CommandLine.arguments.contains("--status") { self.finish(self.settingsResult(settings)) }
            if settings.authorizationStatus == .notDetermined {
                // macOS can leave its permission banner awaiting an answer indefinitely.
                // Hand back a blocked result so the host can show its durable setup guide.
                DispatchQueue.main.asyncAfter(deadline: .now() + 20) {
                    self.center.getNotificationSettings { current in
                        if current.authorizationStatus != .authorized {
                            var result = self.settingsResult(current)
                            result["status"] = "blocked"
                            result["reason"] = "authorization"
                            self.finish(result)
                        }
                    }
                }
                self.center.requestAuthorization(options: [.alert, .sound]) { _, error in
                    if let error = error { self.finish(["status": "failed", "error": error.localizedDescription], code: 1) }
                    self.center.getNotificationSettings { self.send($0) }
                }
            } else { self.send(settings) }
        }
    }

    func settingsResult(_ settings: UNNotificationSettings) -> [String: Any] {
        return ["status": "settings", "authorization": settings.authorizationStatus.rawValue,
                "alerts": settings.alertSetting == .enabled, "alertStyle": settings.alertStyle.rawValue,
                "sound": settings.soundSetting == .enabled, "timeSensitive": settings.timeSensitiveSetting == .enabled,
                "bundleId": Bundle.main.bundleIdentifier ?? "unknown"]
    }

    func send(_ settings: UNNotificationSettings) {
        var result = settingsResult(settings)
        guard settings.authorizationStatus == .authorized, settings.alertSetting == .enabled,
              settings.alertStyle != .none else {
            result["status"] = "blocked"
            result["reason"] = "authorization"
            finish(result)
            return
        }
        let content = UNMutableNotificationContent()
        content.title = payload["title"] ?? "WorkLite"
        content.subtitle = payload["subtitle"] ?? ""
        content.body = payload["body"] ?? ""
        if let sound = payload["sound"], !sound.isEmpty {
            content.sound = UNNotificationSound(named: UNNotificationSoundName(rawValue: sound + ".aiff"))
        }
        // The system still honors the user's per-app and Focus choices.
        content.interruptionLevel = settings.timeSensitiveSetting == .enabled ? .timeSensitive : .active
        let id = UUID().uuidString
        let request = UNNotificationRequest(identifier: id, content: content, trigger: nil)
        center.add(request) { error in
            if let error = error { self.finish(["status": "failed", "error": error.localizedDescription], code: 1) }
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                self.center.getDeliveredNotifications { notifications in
                    var submitted = result
                    submitted["status"] = "submitted"
                    submitted["id"] = id
                    // History membership alone does not prove a banner was visible.
                    submitted["inNotificationCenter"] = notifications.contains { $0.request.identifier == id }
                    self.finish(submitted)
                }
            }
        }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .sound])
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = NotificationApp()
app.delegate = delegate
app.run()
