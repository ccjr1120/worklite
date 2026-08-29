# Plugin Configuration

## Layout

The plugin editor uses the standard focused editor column with a breadcrumb back to Plugins, a save indicator, and one `Save` action in the context bar. The page identifies the plugin, describes its execution boundary, and exposes the persisted executable command field. The command field accepts the executable name or path used by the plugin and defaults to `codex`; it does not read or display environment-variable overrides.

The editor provides a server-side `Test command` action. Testing runs the saved plugin command with its fixed plugin arguments and reports available, missing, or failed states without exposing raw process output or environment values. Saving persists the draft and preserves the last server-reported availability state until the next test.

## States and Safety

Show `Saving`, `Saved`, and `Unsaved changes`. Keep validation and server errors next to the field, preserve the command on failure, and disable duplicate saves or tests while pending. The page does not expose arbitrary arguments, environment variables, credentials, shell output, marketplace actions, delete controls, or plugin code editing.

## Themes, Accessibility, and Responsive Behavior

Use semantic surface, border, text, brand, and status tokens in both themes. Associate the visible label and validation message with the command input. The test result uses a label and icon or shape in addition to color. At mobile widths, keep the form within the focused column and retain the save and test controls without horizontal overflow.

## Changelog

### 2026-08-29

- Established the Plugin Configuration specification for persisted Codex CLI command editing and server-side testing.
