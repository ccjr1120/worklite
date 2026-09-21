# Model Providers

## Route

`/model-providers`

## Design Source

- `docs/ui-design-system/README.md`
- Applicable shared specifications in `ui-ux-design/shared/`

## Implementation

- `apps/web/src/routes/model-providers.tsx`

## Purpose

Configure the upstream model providers the local Portkey Gateway dispatches to and manage the Codex account pool.

Gateway request metrics and captured request details are read at [Logs](../logs/DESIGN.md), not here. This page owns what the Gateway dispatches to; that one owns what it did.

## Primary Task

Confirm that a configured provider actually answers. Action budget: two — open `Test`, then explicitly activate `Run test`.

Opening the test dialog never sends a request. The dialog shows the Provider name, a model list, and an explicit `Run test` action. A remembered model or the first configured model may be selected by default, but the request starts only after the user activates the test action.

Creating or editing a provider costs two actions — fill the form, then save — because the configuration is a set of values the product cannot resolve and a save writes credentials.

## Layout

Fluid collection width up to `1440px`. Providers is a top-level workspace destination: it is not part of the Agent resource tabs and does not use the Settings local navigation.

Two page-level tabs use the `tab` URL Search parameter with `providers` and `codex` values. A missing or invalid value resolves to `providers`, and changing tabs updates the URL so refreshes and direct links restore the selected view.

The `providers` view is one continuous surface: the full-width Portkey Gateway summary first, then Gateway-managed provider administration. The `codex` view holds the account pool as one neutral card per account, two per row at `xl`.

## Interaction Contract

### Provider administration

Show provider configuration status, protocol, endpoint metadata, masked credentials, configured model IDs, and header names. Support creating a provider, editing its complete non-secret configuration, replacing its write-only secrets, and deleting it after explicit confirmation.

The create and edit dialog presents fields in this order: Provider name, Base URL, Protocol, API key, Models, Headers. Base URL and Protocol establish the upstream contract before credentials and model discovery. Protocol is a namespaced selection of `openai/chat`, `openai/responses`, `anthropic/messages`, or `codex/responses`. There is no separate Provider type field. New provider forms require an explicit protocol selection and do not prefill one.

New provider forms do not offer `codex/responses`; an existing legacy Codex record may retain that protocol while being edited. For `codex/responses` the API key is not required, the Base URL is descriptive Provider metadata, and the Gateway uses its Codex authentication manager and private upstream configuration.

Secrets stay write-only. During editing, an empty API key preserves the stored key and a non-empty key replaces it. A supplied Headers JSON replaces the stored headers and `{}` clears them. Headers are entered as a JSON object in a multiline field; stored values are never loaded back into the browser. The list exposes only header names and count, never values, and omits header copy when none are configured. Invalid JSON, non-object JSON, or non-string header values prevent saving and produce an inline validation message.

Model IDs use an ordered draggable list rather than a free-form input. Each row exposes a drag handle, the model identifier, and an accessible remove action. Dragging changes the draft order; fetching models appends newly discovered IDs with stable de-duplication; saving remains the only persistence action and preserves the displayed order.

Provider deletion uses the shared named confirmation pattern: close before success feedback and refresh, retain visible errors on failure.

Provider CRUD, proxy, connection-test, and draft model-discovery requests use the `/api/portkey-gateway` prefix so every browser-facing request reaching the Gateway has one explicit route owner. Provider secrets are persisted by the Gateway and are never stored in WorkLite resource state. The protected WorkLite `gateway-provider` binding is internal and never appears on this page.

When at least one Codex account is enabled and usable, the Gateway automatically supplies a `codex` Provider and its discovered model catalog. That Provider is not created by the form and exposes no edit or delete actions. When Codex is unconfigured, the automatic Provider is omitted from this page and from model selectors.

### Provider test

Activating `Test` resolves the model and runs. Resolution order: the model remembered for that provider in browser storage if it is still configured, otherwise the single configured model, otherwise no resolution. Remembered input is applied silently and is never presented as a step to confirm.

When the model resolves, the dialog opens in its waiting state and the request is already in flight. When it does not, the dialog opens with a model selection and one explicit run action; selecting a model persists it as the remembered value for that provider.

The test is read-only. It sends the fixed user message `你好` and contains no prompt input or composer. Starting the test locks model selection. The waiting label shows elapsed whole seconds from submission, updating once per second with tabular numerals and without resizing the layout. Success shows the provider name, selected model, and complete reply. Failure replaces the waiting state with a credential-safe error, keeps the dialog dismissible, and offers `View request log` when the server returns the correlated request-log identifier, which opens the Logs `requests` tab filtered to that Provider. Success, failure, and timeout all retain the final elapsed duration and allow another test.

### Portkey Gateway summary

The full-width Gateway section shows the configured loopback listener, using development port `3392` by default, with current process status and credential-safe startup failure details. Gateway startup, shutdown, and unexpected-exit recovery are automatic; the section has no lifecycle mutation controls.

Integration details stay collapsed by default and include the `/v1` Base URL, no-key guidance, namespaced models, and a connection example. Model chips and the connection example use the actual `<providerName>/<modelId>` request value; internal Provider ids are never exposed as model prefixes. Copying the Base URL or the example reports `Copied` on the control that was activated.

### Codex account pool

The pool shows one neutral card per account with email or name, masked ChatGPT account id, plan, enabled or disabled state, concurrency, priority, latest fetch time, expiry, and provider-reported primary and secondary remaining quota with reset times. Each quota row shows remaining percentage, used percentage, a progress bar, and the localized reset time; window names are never inferred from plan type. Progress stays neutral and uses text in addition to width in both themes. Tokens are never rendered.

`Add account` starts OAuth login: it opens the server-reported authorization URL and polls status without receiving tokens. Remote operators must use a secure tunnel for the registered localhost callback. `Import JSON` imports an account-export document. Each account has an accessible enable or disable switch and a removal action.

Quota and token freshness are self-healing and expose no manual refresh control. `useCodexAccountUsagesQuery` refetches every 60 seconds while the `codex` view is active, and the Gateway independently refreshes the OAuth token of every enabled account on its own 60-second timer. The pool instead shows a quiet last-updated time derived from the usage snapshot's `fetchedAt`.

Disabled accounts show persisted metadata without an upstream quota request. An individual usage error is shown on that account and never hides other accounts.

## States

| State | Behavior |
| --- | --- |
| Loading | Providers: `CollectionLoading` with four rows and the table's five columns. Codex pool: a polite status line while accounts are present; card geometry is preserved. |
| Empty | Providers: explain the object and offer `Create provider`. Codex pool: explain that an account can be added or imported. |
| No results | Providers: names the active search and offers `Clear filters`. The Codex pool has no search. |
| Error | Providers: `ErrorState` with a retry action. Gateway and Codex errors render as inline `role="alert"` text scoped to the affected section or account without hiding sibling content. |
| Busy | Every mutation reports on the control that was activated. The test dialog owns its own waiting state; the row's `Test` control shows its pending label only for the provider being tested. |
| Offline | Inherits `shared-states.md`. |
| Long content | Provider table cells stay on one line with horizontal overflow on narrow layouts. Model tokens truncate individually. |

Define unconfigured, testing, connected, invalid credentials, unavailable provider, rate-limited, permission, and replacement-confirmation states. Changing configuration explains affected Agents or future Runs when known.

## Copy Inventory

| Key | Category |
| --- | --- |
| `settings:providers.title` | State |
| `settings:providers.description` | Constraint |
| `settings:providers.create` | Action |
| `settings:providers.search` | Action |
| `settings:providers.columns.*` | State |
| `settings:providers.empty.title` | State |
| `settings:providers.empty.description` | Recovery |
| `settings:providers.noMatches.*` | State |
| `settings:providers.createTitle` | Action |
| `settings:providers.createDescription` | Constraint |
| `settings:providers.editTitle` | Action |
| `settings:providers.editDescription` | Constraint |
| `settings:providers.name` / `namePlaceholder` | Action |
| `settings:providers.baseURL` / `baseURLPlaceholder` | Action |
| `settings:providers.baseURLHint` | Constraint |
| `settings:providers.baseURLRequired` | Recovery |
| `settings:providers.protocol` / `protocolPlaceholder` | Action |
| `settings:providers.protocolRequired` | Recovery |
| `settings:providers.apiKey` | Action |
| `settings:providers.secretPlaceholder` | Action |
| `settings:providers.keepSecretPlaceholder` | Constraint |
| `settings:providers.models` / `modelsPlaceholder` / `addModel` / `removeModel` | Action |
| `settings:providers.modelsHint` | Constraint |
| `settings:providers.modelCount` | State |
| `settings:providers.fetchModels` | Action |
| `settings:providers.fetchingModels` | State |
| `settings:providers.modelsApiKeyRequired` | Recovery |
| `settings:providers.modelsFetched` | State |
| `settings:providers.modelsFetchFailed` | Recovery |
| `settings:providers.headers` / `headersPlaceholder` | Action |
| `settings:providers.headersHint` | Constraint |
| `settings:providers.headersError` | Recovery |
| `settings:providers.headerNames` | State |
| `settings:providers.createAction` / `editAction` | Action |
| `settings:providers.created` / `saved` / `deleted` | State |
| `settings:providers.edit` / `delete` / `deleteAction` | Action |
| `settings:providers.deleteTitle` | Action |
| `settings:providers.deleteDescription` | Constraint |
| `settings:providers.deleteFailed` | Recovery |
| `settings:providers.test` | Action |
| `settings:providers.testing` | State |
| `settings:providers.testTitle` | State |
| `settings:providers.testDescriptionWithModel` | State |
| `settings:providers.testModel` / `testModelPlaceholder` / `runTest` | Action |
| `settings:providers.testPromptLabel` / `testReplyLabel` | State |
| `settings:providers.waitingReply` / `waitingReplyAccessible` | State |
| `settings:providers.testDuration` | State |
| `settings:providers.testFailed` | Recovery |
| `settings:providers.traceId` | State |
| `settings:providers.viewLogs` | Action |
| `settings:providers.loading` | State |
| `settings:providers.loadFailed` | Recovery |
| `settings:providers.views.*` | Action |
| `settings:providers.gateway.title` | State |
| `settings:providers.gateway.description` | Constraint |
| `settings:providers.gateway.port` / `status` / `baseURL` / `apiKey` / `models` / `example` | State |
| `settings:providers.gateway.loading` | State |
| `settings:providers.gateway.noApiKey` | Constraint |
| `settings:providers.gateway.noModels` | Recovery |
| `settings:providers.gateway.copyBaseURL` / `copyExample` | Action |
| `settings:providers.gateway.copied` | State |
| `settings:providers.gateway.integrationTitle` | Action |
| `settings:providers.gateway.integrationDescription` | Constraint |
| `settings:providers.gateway.codex.title` | State |
| `settings:providers.gateway.codex.manageInPool` | Recovery |
| `settings:providers.gateway.codex.login` / `addAccount` / `import` / `remove` / `enable` / `disable` | Action |
| `settings:providers.gateway.codex.loginPending` / `enabled` / `disabled` / `concurrency` / `priority` / `unknownPlan` | State |
| `settings:providers.gateway.codex.loginStarted` / `imported` / `removed` | State |
| `settings:providers.gateway.codex.loginFailed` / `importFailed` / `updateFailed` / `removeFailed` | Recovery |
| `settings:providers.gateway.codex.noAccounts` | State |
| `settings:providers.gateway.codex.used` / `resets` / `minutes` / `hours` / `days` | State |
| `settings:providers.codexPool.title` | State |
| `settings:providers.codexPool.primary` / `secondary` / `remaining` / `used` / `resets` / `fetchedAt` / `accountId` / `plan` / `expiresAt` | State |
| `settings:providers.codexPool.quotaUnavailable` | State |
| `settings:providers.codexPool.usageError` | Recovery |
| `settings:providers.codexPool.loading` | State |
| `settings:providers.codexPool.emptyTitle` | State |
| `settings:providers.codexPool.emptyDescription` | Recovery |
| `settings:providers.viewRequestLog` | Action |

Moved keys: the `settings:providers.statistics.*` and `settings:providers.requestLogs.*` trees move to the `logs` namespace with the views they belong to. See [Logs](../logs/DESIGN.md) for their current inventory. `settings:providers.viewRequestLog` stays here because the failed provider test that offers it stays here; it now links to the Logs destination.

Removed keys:

- `settings:providers.views.statistics` and `settings:providers.views.requestLogs`: the tabs they labelled are removed from this page.

- `settings:providers.codexPool.refreshAll` and `settings:providers.gateway.codex.refresh`, `refreshed`, `refreshFailed`, `quotasRefreshed`, `quotasRefreshFailed`: their controls are removed because quota and token staleness are already observable and recovered automatically. Under `shared/copy-standards.md` automation debt, the labels and failure copy go with the controls.
- `settings:providers.codexPool.description`: it restates the pool heading and then documents the one-minute refresh cadence, which is internal mechanics the reader cannot act on.
- `settings:providers.testDescription` ("Select a model, then send the fixed read-only test message."): it describes the removed selection step.
- `settings:providers.viewLogs` and the `traceId` copy beside it: the Diagnostic Logs page they opened is removed, and the correlated Gateway request log replaces the trace identifier.
- `settings:providers.requestLogs.clearFilters`: the shared `common:actions.clearFilters` label is what the control renders.
- `settings:providers.gateway.codex.description`, `rateLimitsLoading`, `rateLimitsUnavailable`, `rateLimitsEmpty`: the summary section delegates account management to the pool tab through `manageInPool`, and the rate-limit strings are unrendered leftovers from the pre-pool presentation.

`settings:providers.description` is retained as a Constraint: write-only credentials and the fact that a change affects future Agent runs but not published Workflow versions are both rules the interface does not otherwise show.

## Accessibility

Tabs are a labelled `TabsList` with the selected tab reflected in the URL. Each view's sections are labelled by their headings.

The model token input keeps focus in its text field after every commit and removal. Each token's remove button carries an accessible name naming that model. Arrow-key traversal moves between tokens and the caret without trapping focus.

Icon-only edit, delete, per-account, and copy controls carry accessible names; per-account names include the account label so they are distinguishable. Enable and disable switches expose the action plus the account label. Quota bars are `progressbar` elements with `aria-valuenow` and a text percentage beside them, so width is never the only encoding. Provider statuses use the shared status badge with a non-color cue. The waiting state exposes a stable accessible string separate from the ticking seconds so assistive technology is not re-announced every second.

## Coverage Status

Verified 2026-09-21 after the observability views moved to [Logs](../logs/DESIGN.md); the remaining entries carry over from the 2026-09-20 verification of the Providers and Codex views. Struck entries were resolved in the 2026-09-19 single-action pass.

- ~~Statistics breakdown rows are keyed by the provider and model joined with a NUL separator, and expansion state is a single string, which is correct but leaves no reset when the window changes.~~ Resolved by relocation: the breakdown moved to Logs, where expansion resets when the range changes.

- ~~The test flow costs two actions. `openProviderTest` resolves a remembered or first model and then opens the dialog in `status: 'idle'`, requiring `Run test`.~~ Resolved: a remembered still-configured model, or a provider with exactly one model, starts the test immediately and the dialog opens in its waiting state. The selection step remains only when neither holds, where the model is genuinely unresolvable.
- ~~`Refresh all quotas` exists at pool level and calls `codexUsageQuery.refetch()`, duplicating the 60-second `useCodexAccountUsagesQuery` poll.~~ Resolved: the control and its `codexPool.refreshAll`, `quotasRefreshed`, and `quotasRefreshFailed` keys are removed. The already-rendered `usage.fetchedAt` line is the freshness signal.
- Per-account refresh is retained as a justified exception. It calls `POST /codex/accounts/:id/refresh`, which forces an OAuth token refresh for one account: a different operation from the quota poll, and one whose need the client cannot observe from the usage snapshot. Documented here rather than removed.
- `codexAuthBusy` is one page-level flag shared by login, import, toggle, per-account refresh, and delete, so any single account mutation disables every control in the pool instead of reporting on the activated control.
- Codex mutation failures are reported only through toasts, so a failure disappears rather than remaining on the affected account as `shared-states.md` requires for durable errors.
- `settings:providers.gateway.codex.rateLimitsLoading`, `rateLimitsUnavailable`, and `rateLimitsEmpty` are defined but never rendered.
- The provider row `Test` control is disabled only while that same provider is loading, so a second provider's test can replace the dialog state of one in flight.
- ~~Protocol selection did not match the supported current contracts.~~ Resolved: `anthropic/messages` is available, `deepseek/chat` is removed, and a new provider draft starts without an implicit protocol.

## Changelog

### 2026-09-21 - Observability Moved to Logs

- Removed the `statistics` and `request-logs` tabs and their sections; this page now has two tabs, `providers` and `codex`. Gateway observability is specified at [Logs](../logs/DESIGN.md), which reads what the Gateway did while this page configures what it dispatches to.
- Moved the `settings:providers.statistics.*` and `settings:providers.requestLogs.*` copy to the `logs` namespace and removed the two view labels.
- Kept `View request log` on the failed provider test and repointed it at the Logs `requests` tab filtered to that Provider.

### 2026-09-21 - Gateway Request Logs

- Added the `request-logs` page-level tab as the fourth view, with its filters persisted together in route Search state and an explicit `Load more` instead of infinite scroll.
- Specified in-place row expansion showing the transformed upstream request and the captured response, with streaming responses presented as ordered captured events and an uncaptured response stated rather than shown as empty.
- Required captured bodies to render as plain preformatted text inside height-bounded scroll containers, never as markup, because a recorded body is untrusted content.
- Recorded the fixed three-day retention as a Constraint and confirmed the view exposes no delete, export, or retention-configuration control.
- Replaced the provider test's `View logs` trace-identifier affordance with `View request log`, which opens this view filtered to the correlated captured request, and removed the obsolete keys.

### 2026-09-20 - Explicit Provider Protocol

- Added `anthropic/messages` to the provider protocol selection.
- Removed `deepseek/chat` from the current provider form.
- Removed the implicit protocol value from new provider drafts and added inline recovery copy for a missing selection.

### 2026-09-19 - Single action

- Made `Test` start immediately when the model is resolvable from a remembered choice or a single configured model, keeping the selection step only when it is not.
- Removed `Refresh all quotas` and its three keys; the 60-second usage poll plus the existing last-fetched line carry freshness.
- Retained per-account refresh as a documented exception because it forces an OAuth token refresh rather than re-reading the quota snapshot.

### 2026-09-19

- Rewrote this specification against `TEMPLATE.md`, adding the action budget, the per-state table, the copy inventory, the accessibility section, and verified coverage findings.
- Made the provider test a one-action flow: a remembered still-valid model or a single configured model runs immediately with the dialog opening in its waiting state, and the selection step survives only when no model can be resolved.
- Removed the pool-level and per-account Codex refresh controls as manual recovery for staleness that the 60-second usage poll and the Gateway's own 60-second token refresh already handle, replacing them with a quiet last-updated time.
- Removed the refresh labels, their success and failure copy, the pool description's cadence text, and the test dialog's selection instruction as automation debt.

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

- Placed Model Providers after MCP Servers in the shared resource surface.
- Defined the route as `/model-providers` without a compatibility alias for the previous settings path.

### 2026-08-13

- Established Model Provider Settings.

## Language

The Web interface is Chinese-only. The language setting is not shown, and all page copy uses the fixed Chinese resource set.
