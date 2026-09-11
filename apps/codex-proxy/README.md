# WorkLite Codex Proxy (Deprecated)

The Codex transport is now built into the Portkey Gateway as the `codex/responses` Provider adapter. This package is retained only as a historical standalone wrapper and is not started by WorkLite deployment scripts or required by the API.

Configure Codex through the Gateway process environment instead:

```text
CODEX_ACCESS_TOKEN=optional-bootstrap-access-token
CODEX_ACCOUNT_ID=optional-chatgpt-account-id
CODEX_UPSTREAM_URL=https://chatgpt.com/backend-api/codex
CODEX_CLIENT_VERSION=26.707.31428
CODEX_USER_AGENT=Codex Desktop/26.707.31428 (win32; x64)
CODEX_ORIGINATOR=codex_cli_rs
CODEX_RESIDENCY=us
```

Create a Gateway Provider with protocol `codex/responses`. Its Base URL is descriptive metadata; private Codex routing and credentials are owned by the Gateway process. The Gateway supports a SQLite-backed Codex account pool, exported JSON account import, priority-aware round-robin selection, per-account concurrency, and explicit account enable or disable controls. Non-streaming assembly, Chat Completions translation, and WebSocket transport remain deferred.

The Gateway provides Codex OAuth PKCE login and local SQLite refresh-token persistence for each account in the pool. Use the Model Providers page to start login; the callback uses `http://localhost:1455/auth/callback`. `CODEX_ACCESS_TOKEN` remains an optional bootstrap fallback. No additional encryption key is required for this local-only installation.

For a remote Gateway, forward the callback port before starting login:

```bash
ssh -N -L 1455:127.0.0.1:1455 user@gateway-host
```
