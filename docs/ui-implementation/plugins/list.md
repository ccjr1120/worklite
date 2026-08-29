# Plugin List

## Structure

Plugins are a resource view inside the Agents surface, alongside Agents, Skills, MCP Servers, and Providers. Use the collection pattern with the plugin name, description, configured executable command, availability state, and update time. The list is read-only; configuration opens from the selected row. Do not add plugin installation, marketplace, upload, or arbitrary runtime registration controls.

The built-in `codex-cli-chat` plugin always appears when its workspace configuration exists. Availability is a server-reported state from testing the persisted command and must include a text or icon cue in addition to color. Loading, empty, partial failure, and long-command states remain visible and recoverable.

## Responsive Behavior

At mobile widths, replace the table with object rows that keep the plugin name, availability, and command visible. Keep the resource navigation reachable through its horizontal scroll pattern and keep the row keyboard accessible.

## Changelog

### 2026-08-29

- Established the Plugin List specification for workspace-owned plugin configuration resources.
