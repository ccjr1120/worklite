# Model Providers

Providers is a top-level workspace destination. It is not part of the Agent resource tabs and does not use the Settings local navigation. The page switches between `Model Providers` and `Portkey Gateway` views in one local navigation surface.

## Scope

Show provider configuration status, protocol, endpoint metadata, masked credentials, configured model IDs, and header names. Support creating a provider, editing its complete non-secret configuration, replacing its write-only secrets, and deleting it after explicit confirmation. The form uses a user-supplied Base URL and a namespaced protocol selection (`openai/chat`, `openai/responses`, or `deepseek/chat`), followed by an API key, model IDs, and optional Headers JSON. There is no separate Provider type field. Headers are entered as a JSON object in a multiline field; stored values are never loaded back into the browser, and an explicit empty object clears them.

The create/edit dialog presents fields in this order: Provider name, Base URL, Protocol, API key, Models, and Headers. Base URL and Protocol establish the upstream contract before credentials and model discovery. Models remain an Enter-committed token input with a Fetch models action; Headers is the final advanced configuration field.

The create/edit dialog keeps secrets write-only. During editing, an empty API key preserves the stored key; a non-empty key replaces it. A supplied Headers JSON replaces the stored headers, and `{}` clears them. The list exposes only header names/count, never header values, and omits header copy when none are configured. Invalid JSON, non-object JSON, or non-string header values prevent saving and receive an inline validation message.

Provider proxy, connection-test, and draft model-discovery requests use the `/api/portkey-gateway` API prefix so every browser-facing request that reaches the Portkey Gateway has one explicit route owner.

Model IDs use one token input rather than a comma-separated field or a multi-row editor. Typing a model ID and pressing `Enter` commits one token inside the same bordered control and keeps focus in the input. Left and right arrow keys move through committed tokens and the text caret; `Backspace` or `Delete` removes the active or adjacent token at the corresponding boundary. Each token has an accessible remove button. Fetching models merges newly discovered IDs into the draft token set with stable de-duplication; saving remains the only persistence action.

Testing opens a read-only conversation dialog immediately. It always shows the fixed user message `你好`, then a non-blocking waiting state until the server returns the first configured model's reply. The waiting label shows elapsed whole seconds from the click and updates once per second using tabular numerals without resizing the layout. Success, failure, and timeout states retain the final elapsed duration. The dialog contains no input, composer, send action, or editable content. Success shows the provider name, selected model, and complete reply; failure replaces the waiting state with a credential-safe error and keeps the dialog dismissible. Closing the dialog does not persist the exchange.

Define unconfigured, testing, connected, invalid credentials, unavailable provider, rate-limited, permission and replacement-confirmation states. Changing configuration must explain affected Agents or future Runs when known.

## Portkey Gateway

The Portkey Gateway view shows the configured loopback port, current process status, listener address, and credential-safe startup failure details. The operator explicitly starts, stops, or restarts the Gateway; changing the port applies on the next start and does not implicitly restart or stop a running process. API startup starts the Gateway, and model discovery ensures it is running before forwarding the request. Ordinary proxy and model-runtime requests remain unavailable while the Gateway is stopped. The view preserves stable loading, saving, starting, stopping, restarting, unavailable, and port-conflict states in both themes and keeps the primary lifecycle action visible at every breakpoint.

## Changelog

### 2026-09-01

- Replaced Provider type selection with a user-supplied Base URL and namespaced protocol selection, and ordered the form as name, Base URL, protocol, API key, models, and Headers.
- Defined model discovery through the same local Portkey Gateway path as all other LLM communication.
- Defined Provider model IDs as an accessible token input with Enter commit, caret navigation, keyboard deletion, explicit remove controls, and draft-only model discovery merging.
- Moved Providers to a top-level destination and grouped Portkey Gateway administration beside Model Providers in the same page context.
- Defined explicit Portkey Gateway port and lifecycle controls with automatic startup from the API bootstrap and model-discovery readiness.
- Replaced key-only Provider replacement with complete Provider editing by id, including model removal and optional key preservation.
- Standardized browser-facing Gateway proxy, connection-test, and model-discovery requests under `/api/portkey-gateway`.

### 2026-08-30

- Moved Model Providers from page-level Agent resource tabs into the unified Agents sidebar subgroup.
- Restored Model Providers as the final page-level Agent resource tab.

### 2026-08-26

- Replaced the simulated success toast with a read-only smoke-test conversation dialog backed by a real model request.
- Fixed the test prompt to `你好` and removed all user input from the test flow.
- Added live elapsed time while waiting and retained final duration for success, failure, and timeout states.

### 2026-08-25

- Aligned the create/replace form with AI SDK provider initialization fields for DeepSeek, OpenAI, and OpenAI-compatible endpoints.
- Added write-only custom-header JSON input and header-name-only list metadata.

### 2026-08-24

- Placed Model Providers after MCP Servers in the Agents resource surface.
- Defined the route as `/model-providers` without a compatibility alias for the previous settings path.

### 2026-08-13

- Established Model Provider Settings.
