# Plugin Configuration

## Layout

The plugin editor uses the standard focused editor column with a breadcrumb back to Plugins, a save indicator, and one `Save` action in the context bar. The page identifies the plugin, describes its execution boundary, and exposes the persisted executable command field. The command field accepts an executable name or path followed by optional fixed leading arguments and defaults to `codex`. The server parses quoted arguments without enabling shell operators, expansion, or environment-variable overrides.

For `codex-cli-chat`, the same page includes a WeChat ClawBot connection section. It converts the server-reported QR payload URL into a local QR image for display and keeps the raw URL as an accessible fallback link. It shows the server-reported connection state, the bot identifier after login, and explicit `Start login`, `Refresh QR`, and `Disconnect` actions. The browser never receives or edits the bot token. A connected state also shows the number of mapped WeChat conversations and the last connection error when present.

The editor provides a server-side `Test command` action. Testing runs the saved executable with its parsed leading arguments and the fixed test argument, then reports available, missing, or failed states without exposing raw process output or environment values. Saving persists the draft and preserves the last server-reported availability state until the next test.

## States and Safety

Show `Saving`, `Saved`, and `Unsaved changes`. Keep validation and server errors next to the field, preserve the command on failure, and disable duplicate saves or tests while pending. The page does not expose environment variables, credentials, shell output, marketplace actions, delete controls, or plugin code editing. QR login errors remain next to the connection controls and include a recovery action. Connection status uses text and icon cues in addition to color.

## Themes, Accessibility, and Responsive Behavior

Use semantic surface, border, text, brand, and status tokens in both themes. Associate the visible label and validation message with the command input. The test result uses a label and icon or shape in addition to color. At mobile widths, keep the form within the focused column and retain the save and test controls without horizontal overflow.

## Changelog

### 2026-08-29

- Established the Plugin Configuration specification for persisted Codex CLI command editing and server-side testing.

### 2026-08-30

- Added the WeChat ClawBot QR login and connection-state section to the built-in Codex plugin configuration page.
- Allowed optional fixed leading arguments in the persisted executable command while excluding shell syntax and environment-variable overrides.
