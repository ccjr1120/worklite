# Model Providers

Model Providers is a team-scoped resource view in the Agents surface. It follows Agents, Skills, and MCP Servers in the shared page-level navigation, and is always the final view in that navigation. It does not use the Settings local navigation.

## Scope

Show provider configuration status, masked credentials, connection testing, available models and configuration impact. Secrets are write-only and never appear in ordinary logs or errors.

Define unconfigured, testing, connected, invalid credentials, unavailable provider, rate-limited, permission and replacement-confirmation states. Changing configuration must explain affected Agents or future Runs when known.

## Changelog

### 2026-08-24

- Placed Model Providers after MCP Servers in the Agents resource surface.
- Defined the route as `/:teamSlug/model-providers` without a compatibility alias for the previous settings path.

### 2026-08-13

- Established Model Provider Settings.
