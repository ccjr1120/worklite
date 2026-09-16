# Model Providers

Providers is a top-level workspace destination. It is not part of the Agent resource tabs and does not use the Settings local navigation. The page is one continuous surface: Portkey Gateway information appears first, followed by Gateway-managed Model Provider administration. The protected WorkLite `gateway-provider` binding is internal and never appears in this page.

The page-level tabs use the `tab` URL Search parameter with `providers`, `codex`, and `statistics` values. The missing or invalid value resolves to `providers`; changing tabs updates the URL so refreshes and direct links restore the selected view.

## Scope

Show provider configuration status, protocol, endpoint metadata, masked credentials, configured model IDs, and header names. Support creating a provider, editing its complete non-secret configuration, replacing its write-only secrets, and deleting it after explicit confirmation. The form uses a user-supplied Base URL and a namespaced protocol selection (`openai/chat`, `openai/responses`, `codex/responses`, or `deepseek/chat`), followed by an API key for ordinary upstreams, model IDs, and optional Headers JSON. For `codex/responses`, the API key is not required; the Base URL is descriptive Provider metadata and the Gateway uses its Codex authentication manager and private upstream configuration. When at least one Codex account is enabled and usable, the Gateway automatically supplies a `codex` Provider and its discovered model catalog; this Provider is not manually created by the form and has no edit or delete actions. When Codex is unconfigured, the automatic Provider is omitted from this page and from model selectors. The page also shows the Gateway Codex account pool. It provides `Add account` through OAuth, an account-export JSON import action, and a credential-safe account list with email, plan, enabled state, configured concurrency, priority, and expiry. Each account has an accessible enable or disable switch; tokens are never rendered. Account-local refresh and removal actions operate on the selected account. Login opens the server-reported authorization URL and polls status without receiving tokens; remote operators must use a secure tunnel for the registered localhost callback. There is no separate Provider type field. Headers are entered as a JSON object in a multiline field; stored values are never loaded back into the browser, and an explicit empty object clears them.

The create/edit dialog presents fields in this order: Provider name, Base URL, Protocol, API key, Models, and Headers. Base URL and Protocol establish the upstream contract before credentials and model discovery. New Provider forms do not offer `codex/responses`; Codex is supplied by the automatic Provider, while an existing legacy Codex record may retain its protocol during editing. Models remain an Enter-committed token input with a Fetch models action; Headers is the final advanced configuration field.

The create/edit dialog keeps secrets write-only. During editing, an empty API key preserves the stored key; a non-empty key replaces it. A supplied Headers JSON replaces the stored headers, and `{}` clears them. The list exposes only header names/count, never header values, and omits header copy when none are configured. Invalid JSON, non-object JSON, or non-string header values prevent saving and receive an inline validation message.

Provider CRUD, proxy, connection-test, and draft model-discovery requests use the `/api/portkey-gateway` API prefix so every browser-facing request that reaches the Portkey Gateway has one explicit route owner. Provider secrets are persisted by Gateway and are never stored in WorkLite resource state.

Model IDs use one token input rather than a comma-separated field or a multi-row editor. Typing a model ID and pressing `Enter` commits one token inside the same bordered control and keeps focus in the input; leaving the field also commits the current non-empty draft so Save and Fetch models cannot discard text that was just entered. Left and right arrow keys move through committed tokens and the text caret; `Backspace` or `Delete` removes the active or adjacent token at the corresponding boundary. Each token has an accessible remove button. Fetching models merges newly discovered IDs into the draft token set with stable de-duplication; saving remains the only persistence action.

Testing opens a read-only conversation dialog without sending a request. The dialog requires selecting one configured model and provides an explicit `Run test` action. The browser remembers the last selected model separately for each Provider; if that model is no longer configured, the first current model becomes the selection. Starting the test locks model selection and shows the fixed user message `你好`, followed by a non-blocking waiting state until the server returns the selected model's reply. The waiting label shows elapsed whole seconds from submission and updates once per second using tabular numerals without resizing the layout. Success, failure, and timeout states retain the final elapsed duration and allow another test after completion. The dialog contains no prompt input or composer. Success shows the provider name, selected model, and complete reply; failure replaces the waiting state with a credential-safe error and keeps the dialog dismissible.

Define unconfigured, testing, connected, invalid credentials, unavailable provider, rate-limited, permission and replacement-confirmation states. Changing configuration must explain affected Agents or future Runs when known.

## Portkey Gateway

The full-width Portkey Gateway section shows the configured loopback listener, using development port `3392` by default, together with current process status and credential-safe startup failure details. Gateway startup, shutdown, and unexpected-exit recovery are automatic; the section has no lifecycle mutation controls. Integration details are collapsed by default to keep the page compact and include the `/v1` Base URL, no-key guidance, namespaced models, and a connection example. Model chips and the connection example use the actual `<providerName>/<modelId>` request value; internal Provider ids are not exposed as model prefixes. The section preserves stable loading, starting, running, unavailable, and port-conflict states in both themes.

The dedicated Codex Account Pool view shows per-account primary and secondary remaining quota returned by the Codex account usage endpoint. Each quota row shows remaining percentage, used percentage, progress bar, and localized reset time; window names are not inferred from plan type. Loading preserves the card geometry, an unavailable account snapshot shows a restrained inline error on that account, and the pool-level Refresh all quotas action refreshes the independent snapshots. Progress remains neutral and uses text in addition to width in both themes.

The Providers page uses a three-view tab strip: `Providers` is the default Model Provider administration view, `Codex Account Pool` is the dedicated Codex account management view, and `Statistics` is the Gateway request-observability view. The compact Gateway summary remains in the Providers view, while OAuth login, JSON import, account toggles, account actions, and per-account quota data move to the Codex Account Pool view. The account view shows one neutral card per account with email or name, masked ChatGPT account id, plan, enabled or disabled state, concurrency, priority, latest fetch time, and provider-reported primary and secondary remaining quota with reset times. It offers Add account, Import JSON, Refresh all quotas, per-account refresh, enable or disable, and removal actions. Disabled accounts show persisted metadata without an upstream quota request; an individual usage error is shown on that account and does not hide other accounts. Loading, unavailable, partial-usage, empty, and query-error states are explicit.

Statistics offer 24-hour, 7-day, and 30-day windows and show request count, success rate, average latency, and known token totals, followed by Provider/model breakdown rows. Rows may expand to reveal endpoint, status, duration, and token availability without increasing the default page height. The page keeps the Gateway status visible in the Providers view, does not expose the protected `gateway-provider`, and leaves Home unchanged. Token values missing from upstream responses are labeled unavailable rather than zero. The statistics view is read-only and does not expose prompts, responses, credentials, or header values.

Provider deletion uses the shared named confirmation pattern: close before success feedback and refresh, retain visible errors on failure, and keep table cells on one line with horizontal overflow on narrow layouts.

## Changelog

### 2026-09-15

- Updated the displayed Portkey Gateway development default from `4547` to `3392`; the local deployment listener remains `23392`.

### 2026-09-11 - Persistent Tab State

- Persisted the Providers page tab selection in the validated `tab` URL Search parameter, including refresh, direct-link, and invalid-value behavior.

### 2026-09-11 - Dedicated Codex Account Pool View

- Moved Codex account import, OAuth addition, enable or disable controls, refresh, removal, and quota display into a dedicated page-level tab.
- Added per-account quota presentation with independent loading, failure, reset-time, and stale-data states.
- Kept both themes neutral by default and reserved brand emphasis for selected tabs, primary actions, and focus states.

### 2026-09-10 - Codex Account Pool

- Replaced the single Codex subscription credential presentation with a credential-safe account pool.
- Added JSON import, OAuth account addition, and per-account enable or disable controls.
- Kept account controls neutral by default and reserved brand emphasis for the primary import or add action and enabled focus states.

### 2026-09-10

- Standardized resource deletion actions, named confirmation, success feedback, dependency errors, and navigation.


### 2026-09-08

- Added connected Codex rate-limit rows for primary, secondary, and additional provider-reported windows, including used percentage and reset time.
- Kept usage failures independent from authentication status and derived labels from actual window duration rather than subscription plan assumptions.
- Changed Provider testing to require an explicit model selection and Run action, with the last model remembered locally per Provider.

### 2026-09-07

- Documented the Gateway-managed automatic `codex` Provider and its visibility rule based on Codex configuration status.

### 2026-09-04

- Added the Providers-page `Statistics` view for persisted Portkey Gateway request observability, with compact summary metrics, time windows, and expandable Provider/model details.
- Gateway Provider CRUD persists through the Gateway-owned SQLite database; the former JSON registry and legacy API Provider rows are imported once and are not used at runtime.
- Changed Gateway model chips and connection examples to the actual `<providerName>/<modelId>` public request namespace.
- Added the `codex/responses` protocol option for the Gateway-native Codex Provider adapter and documented that its Base URL is metadata while the Gateway owns private Codex transport configuration.
- Added the Gateway Codex subscription credential status and OAuth login controls; tokens remain Gateway-owned and are never returned to the browser.
- Model token input commits a non-empty draft on blur so direct Save and Fetch models actions retain manually entered IDs.

### 2026-09-03

- Made the Gateway summary span the full content width for clearer status and listener presentation.
- Kept Gateway details collapsed by default and displayed provider names in model chips while preserving stable provider-id dispatch values.
- Changed the page structure to show Gateway information above the Model Provider list instead of switching between local views.
- Defined one unified Gateway integration entry point with `<providerId>/<modelId>` model namespaces and explicit no-key guidance.
- Moved Provider administration under the Portkey Gateway ownership boundary and kept the protected WorkLite `gateway-provider` binding out of user-facing configuration.
- Removed Gateway start, stop, and restart controls; the surface now communicates automatic lifecycle and recovery.

### 2026-09-01

- Replaced Provider type selection with a user-supplied Base URL and namespaced protocol selection, and ordered the form as name, Base URL, protocol, API key, models, and Headers.
- Defined model discovery through the same local Portkey Gateway path as all other LLM communication.
- Defined Provider model IDs as an accessible token input with Enter commit, caret navigation, keyboard deletion, explicit remove controls, and draft-only model discovery merging.
- Moved Providers to a top-level destination and grouped Portkey Gateway administration beside Model Providers in the same page context.
- Defined fixed Portkey Gateway port `4547` and lifecycle controls with automatic startup from the API bootstrap and model-discovery readiness.
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
