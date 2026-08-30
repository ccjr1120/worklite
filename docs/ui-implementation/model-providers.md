# Model Providers

Model Providers is a workspace resource beneath Agents in the unified sidebar. It follows Skills and MCP Servers and is always the final item in that subgroup. It does not use page-level resource tabs or the Settings local navigation. Create and delete controls sit on the right side of the collection toolbar directly above the provider table.

## Scope

Show provider configuration status, provider kind, endpoint metadata, masked credentials, configured model IDs, and custom-header names. Support creating a provider, replacing its write-only secrets/configuration, and deleting it after explicit confirmation. The form follows AI SDK initialization parameters: provider kind (`DeepSeek`, `OpenAI`, or `OpenAI-compatible`), API key, optional base URL, model IDs, and OpenAI organization/project fields when applicable. Custom headers are entered as a JSON object in a multiline field; stored values are never loaded back into the browser, and an explicit empty object clears them.

The create/replace dialog keeps secrets write-only. Replacing a provider requires a fresh API key and may also replace the full custom-header JSON. The list exposes only header names/count, never header values. Invalid JSON, non-object JSON, or non-string header values prevent saving and receive an inline validation message.

Testing opens a read-only conversation dialog immediately. It always shows the fixed user message `你好`, then a non-blocking waiting state until the server returns the first configured model's reply. The waiting label shows elapsed whole seconds from the click and updates once per second using tabular numerals without resizing the layout. Success, failure, and timeout states retain the final elapsed duration. The dialog contains no input, composer, send action, or editable content. Success shows the provider name, selected model, and complete reply; failure replaces the waiting state with a credential-safe error and keeps the dialog dismissible. Closing the dialog does not persist the exchange.

Define unconfigured, testing, connected, invalid credentials, unavailable provider, rate-limited, permission and replacement-confirmation states. Changing configuration must explain affected Agents or future Runs when known.

## Changelog

### 2026-08-30

- Moved Model Providers from page-level Agent resource tabs into the unified Agents sidebar subgroup.

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
