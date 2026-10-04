# Plugin Configuration

## Route

Feishu configuration has moved to the Chat Channels view; `/plugins/feishu-bot` no longer renders this page. The Feishu setup rules below apply to the reused channel configuration surface.

`/plugins/:pluginId`

## Design Source

- `docs/ui-design-system/README.md`
- Applicable shared specifications in `ui-ux-design/shared/`

## Implementation

- `apps/web/src/routes/plugins/$pluginId.tsx`

- `apps/web/src/features/plugins/plugin-configuration.tsx`

## Purpose

Configure the Codex executable, connect Feishu for master-Agent dialogue, or connect the WeChat Official Account used by Workflow publication.

## Primary Task

Each plugin exposes its own goal with one activation point.

Persist the executable command. Action budget: one — `Save`.

Create and connect a Feishu application. Action budget: one — `Scan to create application`; platform confirmation is outside the WorkLite action budget. Credentials and a returned user id are persisted automatically, with no follow-up save. Configuring an existing application is an alternative goal with one `Save` activation after field entry. Binding a missing user id is a separate required goal with one `Save`.

Connect the WeChat Official Account. Action budget: one — `Start login`, followed by scanning the QR with a phone. Scanning is not a product action and is not counted. Completion arrives through the existing plugin query; the user never confirms that they scanned.

## Layout

Focused editor column at `840px`. For `codex-cli-chat`, the context bar holds the breadcrumb, save indicator and `Save`. Feishu uses the shared configuration content inside Chat Channels with its own local save indicator and action. The Official Account has no save control. The page heading identifies the plugin; the focused content below shows only that plugin's configuration or connection.

The command field accepts an executable name or path followed by optional fixed leading arguments and defaults to `codex`. The server parses quoted arguments without enabling shell operators, expansion, or environment-variable overrides.

For `feishu-bot`, place the QR registration action and status first. After activation, show the locally rendered PNG QR and the same platform confirmation URL as a keyboard-accessible link. Creating another application replaces the current configuration only after platform confirmation; show that constraint before activation. Manual App ID, write-only App Secret and allowed open-id fields remain below, with `Save` shown when manual edits need committing or a newly created application needs a user id. Disable manual fields during registration so the chosen path owns its result. The user can cancel pending registration without disconnecting the current application. Show credential registration and socket connection as separate states. Link to the current application's platform console and state the message-permission, event/callback long-connection and publication requirements. Read responses report only whether a secret is configured. Disconnect is available for a configured connection. The Codex plugin retains only executable-command configuration.

The built-in `wechat-official-account` Plugin uses the same focused surface for one official-account connection. It shows the credential-safe account label, connection health, and last verification time. Login runs in a server-owned Playwright browser context and the page renders only the returned QR image. Cookies, browser storage, platform tokens, and private responses never reach Web.

## Interaction Contract

`Scan to create application` owns request progress and prevents duplicate begin requests. Platform completion updates the plugin query and clears any transient Secret input. The server persists registration and polling state, so a page reload or API restart can resume a pending attempt. The page replaces an observed expired QR automatically while the flow is visible; no refresh button or expiry timestamp is shown. Denial and failure offer the same registration action as recovery. Cancel removes the pending confirmation link while preserving existing credentials. A completed credential flow does not claim the robot is usable: connected state comes only from the socket. A missing open id asks only for that field and preserves the acquired Secret.

`Save` reports progress on itself, persists the command, and settles the save indicator at `Saved`. Failure preserves the command, returns the indicator to `Unsaved changes`, and states the reason next to the field. Editing the command marks the draft unsaved and clears the last availability result, because that result described a command that is no longer current.

`Save` persists the command and then runs the saved executable with its parsed leading arguments and the fixed test argument, reporting available, missing, or failed without exposing raw process output or environment values. Verification is part of saving rather than a separate control: a command is worth storing only if it runs, and the previous implementation already saved before probing. Persistence and availability are reported separately, so a stored command whose executable is missing says exactly that. Availability persists as the last server-reported state until the next save.

`Start login` reports progress on itself and requests a QR from the server. While the connection status is `qr_pending`, the QR refreshes automatically through the plugin query that already polls this route; an expired code is replaced without being asked for. The replacement is shown as state on the QR itself — the image dims while its successor loads — and never as an instruction to the user. There is no manual refresh control for the Official Account connection, and no expiry timestamp is displayed: both describe work the product now does on its own, per `shared/copy-standards.md`.

`Start login` keeps its connect semantics throughout. It is disabled while a connection is established and while a login request is in flight; it does not relabel itself into a refresh action.

`Disconnect` is available whenever the connection is not already disconnected. It reports on its own control and is a neutral execution control rather than a destructive one, because reconnecting uses another save for Feishu or login for the Official Account.

Login and disconnect failures remain next to the connection controls with a recovery action. Completion of a scan arrives through the same plugin query and replaces the QR with the connected state automatically.

## States

| State | Behavior |
| --- | --- |
| Loading | Content-shaped skeletons for the command field and the connection section, inside a `role="status"` live region. A plain centered text line is not sufficient, because it discards the page shell. |
| Empty | Not applicable; a plugin route always resolves to one configured plugin or to the error state. |
| No results | Not applicable. |
| Error | A failed plugin load keeps the page shell and offers a retry alongside the return link. Save, test, login, and disconnect failures stay next to the control that failed, with `role="alert"`. |
| Busy | Each of `Save`, `Start login`, and `Disconnect` reports on itself and prevents its own duplicate submission. `Save` shows a spinner while persisting and a `config.verifying` cue while probing. A pending connection request must not disable the command field or the save action. |
| Registration | Waiting shows QR, confirmation link, cancellation and text status. Completion removes the QR and reports saved credentials; missing user information enables the binding field. Denied and error states preserve any existing app. |
| Offline | Inherits `shared-states.md`. The Feishu status poll and Official Account QR poll resume without duplicating a connection request. |
| Long content | Long commands and error messages wrap within the focused column without horizontal overflow. |

Show `Saving`, `Saved`, and `Unsaved changes`. App Secret is accepted in a password field and cleared after saving; read responses report only whether it exists. The page does not expose stored secrets, environment values, raw shell output, marketplace actions, delete controls or plugin code editing. Connection status uses text and icon cues in addition to color.

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
| `plugins:config.saved` | State |
| `plugins:config.saveFailed` | Recovery |
| `plugins:feishu.title` | State |
| `plugins:feishu.openPlatform` | Action |
| `plugins:feishu.appId` / `appSecret` / `allowedUserId` | Constraint |
| `plugins:feishu.secretConfigured` | State |
| `plugins:feishu.status.*` | State |
| `plugins:feishu.disconnect` | Action |
| `plugins:feishu.disconnectFailed` | Recovery |
| `plugins:feishu.registration.create` / `replace` / `cancel` / `open` | Action |
| `plugins:feishu.registration.constraint` / `replaceConstraint` / `platformRequirements` | Constraint |
| `plugins:feishu.registration.qrAlt` / `manual` / `starting` / `status.*` | State |
| `plugins:feishu.registration.requestFailed` / `qrFailed` / `cancelFailed` / `status.needs_user_id` | Recovery |
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

The former ClawBot copy is removed with its transport. `plugins:officialAccount.scan` remains a Recovery: it identifies the administrator account that must scan. Automatic QR replacement keeps manual refresh copy absent.

`plugins:config.commandHint` is retained as a Constraint: shell syntax and environment overrides being unavailable cannot be inferred from the field.

## Accessibility

Registration renders status in a polite live region, names the PNG QR, and always offers a normal link to the same confirmation URL. Buttons reuse shared focus and disabled states in both themes. The PNG's own white background remains scannable in dark mode, with a semantic border around it. Registration request errors sit beside its action. Manual field labels and keyboard focus remain stable during polling.

`Tab` reaches context-bar actions and then the current plugin's fields or connection controls. Feishu fields have explicit labels and the App Secret input is a password field. The command field's visible label and its validation message are both associated with the input. Each connection section is a `section` with `aria-labelledby` pointing at its heading. The QR image carries an accessible name naming the account type it belongs to. Connection and availability status use the shared status badge with a text label, never color alone. The automatic QR replacement is announced politely once rather than on every poll, and reduced-motion mode replaces the dimming transition with a static state cue. Login, disconnect, save, and test failures use `role="alert"` next to their control.

## Coverage Status

Source comparison: 2026-10-04. The shared `PluginConfiguration` now supplies Feishu configuration inside Chat Channels; `/plugins/feishu-bot` is removed. Initial loading uses a content-shaped skeleton, failed reads offer local retry, and background errors retain saved content. Feishu registration now renders a local PNG and the exact same confirmation link, owns request/cancel progress and errors, and replaces an expired attempt once per observed registration id while the page is visible. Server completion updates persisted plugin fields without a second Save. Missing Open ID retains credentials and requires only binding before connection. The manual form reuses Field, Input, Button and SaveIndicator in both themes, disables while registration owns the result, and shows Save for edits or missing binding. Ordinary status polls do not replace unsaved contents; acquired configuration does. Credential and socket states are separate. The ClawBot section, strings and obsolete manual-creation setupHint are removed. Runtime, type, browser and accessibility checks were not run.

Differences retained from the earlier source audit:

- `error` remains one page-level string for save and connection failures; request errors render above configuration content instead of beside the failed control. Server-reported Feishu connection errors do render beside its state.
- Official Account login and disconnect share `connectionPending`; starting one changes both controls' busy state.
- The Official Account QR renders directly from `officialAccount.qrCode`. Its source must be a renderable image; the former ClawBot URL conversion has been removed with that transport.

Resolved or superseded findings: automatic Official Account QR expiry replacement remains implemented. ClawBot's unobservable expiry and its shared connection controls no longer apply because that transport is removed.

## Changelog

### 2026-10-04

- Moved Feishu configuration to Chat Channels through the shared unframed configuration component; added local load recovery.

- Approved QR application registration with automatic credential persistence, separate socket status, cancellation, expired-code replacement and missing-user recovery; retained manual application configuration.
- Replaced the Codex ClawBot section with an independent Feishu configuration form and observable connection state; recorded source coverage and retained unrelated existing differences.

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
