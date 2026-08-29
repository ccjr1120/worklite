# Plugin Configuration

## Layout

The plugin editor uses the standard focused editor column with a breadcrumb back to Plugins, a save indicator, and one `Save` action in the context bar. The page identifies the plugin, describes its execution boundary, and exposes the persisted executable command field. The command field accepts the executable name or path used by the plugin and defaults to `codex`; it does not read or display environment-variable overrides.

For `codex-cli-chat`, the same page includes a WeChat ClawBot connection section. It shows the server-reported connection state, a QR image or QR URL while login is pending, the bot identifier after login, and explicit `Start login`, `Refresh QR`, and `Disconnect` actions. The browser never receives or edits the bot token. A connected state also shows the number of mapped WeChat conversations and the last connection error when present.

The editor provides a server-side `Test command` action. Testing runs the saved plugin command with its fixed plugin arguments and reports available, missing, or failed states without exposing raw process output or environment values. Saving persists the draft and preserves the last server-reported availability state until the next test.

## States and Safety

Show `Saving`, `Saved`, and `Unsaved changes`. Keep validation and server errors next to the field, preserve the command on failure, and disable duplicate saves or tests while pending. The page does not expose arbitrary arguments, environment variables, credentials, shell output, marketplace actions, delete controls, or plugin code editing. QR login errors remain next to the connection controls and include a recovery action. Connection status uses text and icon cues in addition to color.

## Themes, Accessibility, and Responsive Behavior

Use semantic surface, border, text, brand, and status tokens in both themes. Associate the visible label and validation message with the command input. The test result uses a label and icon or shape in addition to color. At mobile widths, keep the form within the focused column and retain the save and test controls without horizontal overflow.

## Changelog

### 2026-08-29

- Established the Plugin Configuration specification for persisted Codex CLI command editing and server-side testing.

### 2026-08-30

- Added the WeChat ClawBot QR login and connection-state section to the built-in Codex plugin configuration page.
