# Plugin Configuration

## Route

`/plugins/:pluginId`

## Design Source

- `docs/ui-design-system/README.md`
- Applicable shared specifications in `ui-ux-design/shared/`

## Implementation

- `apps/web/src/routes/plugins/$pluginId.tsx`

## Purpose

Configure a trusted plugin's executable command, and connect the WeChat account it operates through.

## Primary Task

Two goals share this surface, each with its own single activation point.

Persist the executable command. Action budget: one — `Save`.

Connect the WeChat account. Action budget: one — `Start login`, followed by scanning the QR with a phone. Scanning is not a product action and is not counted. Completion arrives through the existing plugin query; the user never confirms that they scanned.

## Layout

Focused editor column at `840px`. For `codex-cli-chat` the context bar holds the breadcrumb, the save indicator, and `Save`; other plugins expose neither, because they have no editable command. The page heading identifies the plugin, then the command field, then the connection section separated by a rule.

The command field accepts an executable name or path followed by optional fixed leading arguments and defaults to `codex`. The server parses quoted arguments without enabling shell operators, expansion, or environment-variable overrides.

For `codex-cli-chat`, a WeChat ClawBot connection section converts the server-reported QR payload URL into a local QR image and keeps the raw URL as an accessible fallback link. It shows the server-reported connection state, the bot identifier after login, the number of mapped conversations when connected, and the last connection error when present. The browser never receives or edits the bot token.

The built-in `wechat-official-account` Plugin uses the same focused surface for one official-account connection. It shows the credential-safe account label, connection health, and last verification time. Login runs in a server-owned Playwright browser context and the page renders only the returned QR image. Cookies, browser storage, platform tokens, and private responses never reach Web.

## Interaction Contract

`Save` reports progress on itself, persists the command, and settles the save indicator at `Saved`. Failure preserves the command, returns the indicator to `Unsaved changes`, and states the reason next to the field. Editing the command marks the draft unsaved and clears the last availability result, because that result described a command that is no longer current.

`Save` persists the command and then runs the saved executable with its parsed leading arguments and the fixed test argument, reporting available, missing, or failed without exposing raw process output or environment values. Verification is part of saving rather than a separate control: a command is worth storing only if it runs, and the previous implementation already saved before probing. Persistence and availability are reported separately, so a stored command whose executable is missing says exactly that. Availability persists as the last server-reported state until the next save.

`Start login` reports progress on itself and requests a QR from the server. While the connection status is `qr_pending`, the QR refreshes automatically through the plugin query that already polls this route; an expired code is replaced without being asked for. The replacement is shown as state on the QR itself — the image dims while its successor loads — and never as an instruction to the user. There is no manual refresh control for either connection section, and no expiry timestamp is displayed: both describe work the product now does on its own, per `shared/copy-standards.md`.

`Start login` keeps its connect semantics throughout. It is disabled while a connection is established and while a login request is in flight; it does not relabel itself into a refresh action.

`Disconnect` is available whenever the connection is not already disconnected. It reports on its own control and is a neutral execution control rather than a destructive one, because reconnecting costs one further login.

Login and disconnect failures remain next to the connection controls with a recovery action. Completion of a scan arrives through the same plugin query and replaces the QR with the connected state automatically.

## States

| State | Behavior |
| --- | --- |
| Loading | Content-shaped skeletons for the command field and the connection section, inside a `role="status"` live region. A plain centered text line is not sufficient, because it discards the page shell. |
| Empty | Not applicable; a plugin route always resolves to one configured plugin or to the error state. |
| No results | Not applicable. |
| Error | A failed plugin load keeps the page shell and offers a retry alongside the return link. Save, test, login, and disconnect failures stay next to the control that failed, with `role="alert"`. |
| Busy | Each of `Save`, `Start login`, and `Disconnect` reports on itself and prevents its own duplicate submission. `Save` shows a spinner while persisting and a `config.verifying` cue while probing. A pending connection request must not disable the command field or the save action. |
| Offline | Inherits `shared-states.md`. The QR poll resumes without duplicating a login request. |
| Long content | Long commands and error messages wrap within the focused column without horizontal overflow. |

Show `Saving`, `Saved`, and `Unsaved changes`. The page does not expose environment variables, credentials, shell output, marketplace actions, delete controls, or plugin code editing. Connection status uses text and icon cues in addition to color.

## Copy Inventory

| Key | Category |
| --- | --- |
| `plugins:config.fallback` | State |
| `plugins:config.title` | State |
| `plugins:config.description` | Constraint |
| `plugins:config.command` | State |
| `plugins:config.commandPlaceholder` | State |
| `plugins:config.commandHint` | Constraint |
| `plugins:config.verifying` | State |
| `plugins:config.testFailed` | Recovery |
| `plugins:config.testMissing` | Recovery |
| `plugins:config.testUnavailable` | Recovery |
| `plugins:config.saved` | State |
| `plugins:config.saveFailed` | Recovery |
| `plugins:wechat.title` | State |
| `plugins:wechat.description` | Constraint |
| `plugins:wechat.login` | Action |
| `plugins:wechat.disconnect` | Action |
| `plugins:wechat.loginFailed` | Recovery |
| `plugins:wechat.disconnectFailed` | Recovery |
| `plugins:wechat.qrAlt` | State |
| `plugins:wechat.openQrLink` | Action |
| `plugins:wechat.scan` | Recovery |
| `plugins:wechat.botId` | State |
| `plugins:wechat.conversations` | State |
| `plugins:wechat.notConnected` | State |
| `plugins:officialAccount.title` | State |
| `plugins:officialAccount.description` | Constraint |
| `plugins:officialAccount.login` | Action |
| `plugins:officialAccount.disconnect` | Action |
| `plugins:officialAccount.loginFailed` | Recovery |
| `plugins:officialAccount.disconnectFailed` | Recovery |
| `plugins:officialAccount.qrAlt` | State |
| `plugins:officialAccount.scan` | Recovery |
| `plugins:officialAccount.account` | State |
| `plugins:officialAccount.lastVerified` | State |
| `plugins:officialAccount.never` | State |
| `plugins:loading` | State |
| `plugins:loadFailed` | Recovery |
| `common:actions.save` | Action |
| `common:actions.back` | Action |
| `common:status.qr_pending` | State |

`plugins:wechat.refresh` and `plugins:officialAccount.refresh` are removed with the manual refresh controls they label. Automatic replacement makes both the control and its label describe work the user no longer does.

`plugins:wechat.scan` and `plugins:officialAccount.scan` are retained as Recovery: each names the specific app that must scan, which the QR image alone does not communicate, and `officialAccount.scan` additionally states that the administrator account is required.

`plugins:config.commandHint` is retained as a Constraint: shell syntax and environment overrides being unavailable cannot be inferred from the field.

## Accessibility

`Tab` reaches the command field, then the connection controls, then the context-bar `Save`. The command field's visible label and its validation message are both associated with the input. Each connection section is a `section` with `aria-labelledby` pointing at its heading. The QR image carries an accessible name naming the account type it belongs to. Connection and availability status use the shared status badge with a text label, never color alone. The automatic QR replacement is announced politely once rather than on every poll, and reduced-motion mode replaces the dimming transition with a static state cue. Login, disconnect, save, and test failures use `role="alert"` next to their control.

## Coverage Status

Verified 2026-09-19. Struck entries were resolved in the 2026-09-19 single-action pass; the rest remain open.

- ~~The QR does not refresh automatically. The login button relabels itself to `wechat.refresh` / `officialAccount.refresh` during `qr_pending` and waits for a manual click.~~ Resolved: both refresh labels and keys are gone and the login control keeps its connect semantics, disabled while a code is outstanding. The Official Account carries a server-reported `qrExpiresAt`, so an expired code is replaced automatically from a timer that attempts each expiry marker once.

  The ClawBot connection reports no expiry in `WechatConnectionView`, so its staleness is not observable and it is replaced only by starting login again. This is the documented exception `interaction-contract.md` requires: without an expiry the client cannot distinguish a valid code from a dead one.
- `wechatPending` is one flag shared by all four connection mutations across both sections, so starting an Official Account login also disables the ClawBot controls. Busy state must be per-control.
- `error` is one page-level string shared by save, test, login, and disconnect, so a login failure renders above the command field rather than beside the control that failed.
- No loading skeleton. `pluginQuery.isLoading` renders a bare centered text line that discards the page shell.
- The error branch offers only a `Back` link with no retry, so a transient load failure has no in-page recovery.
- The Official Account QR is rendered directly from `plugin.officialAccount.qrCode` without the `QRCode.toDataURL` conversion or the raw-URL fallback that the ClawBot section has, so a payload URL would render as a broken image.

## Changelog

### 2026-09-19 - Single action

- Folded the command verification into `Save` and removed the standalone `Test command` control with its `config.test` and `config.testing` keys. `test()` already called `save()` internally, so the two controls were two activation points for "store a command that runs"; availability now reports as a status badge with a `config.verifying` cue.
- Removed the `wechat.refresh` and `officialAccount.refresh` controls and keys; the login control keeps its connect semantics and is disabled while a code is outstanding.
- Made the Official Account QR replace itself from its server-reported `qrExpiresAt`, attempting each expiry marker once.
- Recorded the ClawBot connection as a documented exception: `WechatConnectionView` exposes no expiry, so its staleness is not observable.

### 2026-09-19

- Rewrote this specification against `TEMPLATE.md`, adding per-goal action budgets, the per-state table, the copy inventory, and verified coverage findings.
- Required the QR to refresh automatically from the existing plugin poll during `qr_pending`, and removed the manual `Refresh QR` control and its locale keys from both connection sections.
- Kept `Start login` at its connect semantics instead of relabelling it into a refresh action.
- Required per-control busy and failure state so one connection request cannot disable or misreport another.

### 2026-09-16

- Added the WeChat Official Account Playwright connection surface used by resumable Workflow publication nodes.

### 2026-08-29

- Established the Plugin Configuration specification for persisted Codex CLI command editing and server-side testing.

### 2026-08-30

- Added the WeChat ClawBot QR login and connection-state section to the built-in Codex plugin configuration page.
- Allowed optional fixed leading arguments in the persisted executable command while excluding shell syntax and environment-variable overrides.
