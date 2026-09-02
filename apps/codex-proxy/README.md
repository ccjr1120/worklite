# WorkLite Codex Proxy

This package is an optional Node.js sidecar that exposes the direct Codex Responses transport through an OpenAI-compatible local endpoint. WorkLite reaches it through the existing Portkey Provider path; the sidecar does not import NestJS modules or access the WorkLite database.

## Configuration

```text
CODEX_PROXY_HOST=127.0.0.1
CODEX_PROXY_PORT=4548
CODEX_PROXY_API_KEY=choose-a-local-key
CODEX_ACCESS_TOKEN=your-codex-access-token
CODEX_ACCOUNT_ID=optional-chatgpt-account-id
CODEX_UPSTREAM_URL=https://chatgpt.com/backend-api/codex
CODEX_CLIENT_VERSION=26.707.31428
CODEX_USER_AGENT=Codex Desktop/26.707.31428 (win32; x64)
CODEX_ORIGINATOR=codex_cli_rs
CODEX_RESIDENCY=us
```

`CODEX_ACCESS_TOKEN` and `CODEX_PROXY_API_KEY` are required for proxy requests. The sidecar reports `configured: false` from `/health` until both values are present. Credentials are read only by the sidecar process and are never returned by an endpoint.

## Endpoints

```text
GET  /health
GET  /v1/models
POST /v1/responses
POST /v1/responses/compact
```

All routes except `/health` require `Authorization: Bearer <CODEX_PROXY_API_KEY>` or `X-API-Key`. Responses are streamed from the private Codex endpoint. The sidecar currently forwards the Responses body and stream without assembling non-streaming responses.

## Development

```bash
pnpm --filter @worklite/codex-proxy dev
pnpm --filter @worklite/codex-proxy typecheck
```

Keep the service bound to `127.0.0.1` unless an explicit trusted-network deployment boundary is configured. OAuth/device login, refresh-token persistence, multi-account rotation, Chat Completions translation, and WebSocket transport are deferred.
