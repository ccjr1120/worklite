# Internationalization

## Status and Purpose

This document is the source of truth for internationalization in WorkLite. Internationalization is a normal part of product development, not a separate delivery phase or workflow. Every change that adds or modifies user-facing content must follow this document as part of its ordinary implementation.

The initial supported locales are:

- `en`: English and the fallback locale.
- `zh-CN`: Simplified Chinese.

Source code, identifiers, comments, documentation, translation keys, and default source copy remain in English. Non-English text is permitted only in locale resources or minimal fixtures that explicitly verify localized behavior.

## Product Decisions

### Locale Resolution

Resolve the active locale in this order:

1. An explicit user preference.
2. A locally persisted preference for the current browser.
3. The browser language when it matches a supported locale.
4. `en` as the final fallback.

Normalize compatible regional variants to a supported locale. For example, `zh`, `zh-CN`, and compatible Simplified Chinese browser preferences resolve to `zh-CN`. Unsupported locales must resolve to `en` without producing a broken or partially empty interface.

The initial implementation may persist the preference in `localStorage`. When personal preferences are persisted by the API, locale remains a user preference across devices. A local value provides immediate pre-hydration behavior.

### Routing

Application routes do not include a locale segment. WorkLite is a local personal workspace rather than a locale-indexed public content site, so routes remain stable when the user changes language.

If WorkLite later introduces public, search-indexed content with localized canonical URLs, that surface requires a separate routing decision. It must not change workspace routes implicitly.

### Scope of Translation

Translate product-owned interface content, including:

- Navigation, headings, labels, actions, help text, placeholders, tooltips, and dialogs.
- Loading, empty, error, permission, offline, and success feedback.
- Form validation messages and accessible names.
- Status labels and product-owned descriptions of domain values.
- Product-generated emails and notifications when those capabilities are introduced.

Do not automatically translate user-authored or externally supplied content, including:

- Workspace, agent, workflow, skill, MCP server, artifact, and file names.
- Prompts, workflow input, model output, logs, and artifact contents.
- Third-party provider, model, MCP tool, or skill content.
- Technical identifiers, code, configuration keys, and protocol values.

Product labels surrounding this content remain localized. Untrusted external content must continue to follow the existing rendering and security rules.

## Web Application Standard

Use `i18next` with `react-i18next` for React integration. Configure one application-level provider and keep locale resolution, persistence, fallback behavior, and resource loading behind a small application-owned module.

Locale resources belong under:

```text
apps/web/src/i18n/
|-- config.ts
|-- locale.ts
`-- locales/
    |-- en/
    `-- zh-CN/
```

Split resources by stable product domain rather than by individual component. Expected namespaces include `common`, `workspace`, `onboarding`, `agents`, `workflows`, `runs`, `skills`, `mcpServers`, `artifacts`, and `settings`. Add a namespace only when it represents a durable ownership boundary.

English and Simplified Chinese resources must have matching key structures. English is the runtime fallback, but missing translations in a supported locale are defects and must be visible during development.

### Translation Keys

Use semantic, stable keys:

```text
common.actions.cancel
onboarding.provider.title
runs.empty.description
workflows.publish.confirmation.title
```

Do not use English sentences as keys. Do not encode layout, component filenames, punctuation, or a temporary visual position into a key. Reuse a key only when the meaning is genuinely identical; identical English wording in different contexts does not necessarily have identical meaning in another language.

Keep interpolation values separate from translated grammar:

```text
t('home.greeting', { name })
t('runs.results', { count })
```

Use the library's pluralization and selection features. Do not build sentences by concatenating translated fragments, and do not place JSX inside a sentence when a complete translatable message or structured rich-text translation can express it.

### Formatting

Format dates, times, relative times, numbers, percentages, and list conjunctions with locale-aware `Intl` APIs or shared wrappers around them. Do not hard-code display formats or assemble formatted values manually.

Persist and transmit machine-readable values independently of locale:

- Use ISO timestamps and explicit time-zone semantics for time data.
- Use numeric values rather than localized numeric strings in API contracts.
- Keep enum and status values stable and language-neutral.
- Localize values only at the presentation boundary.

The active locale changes language and formatting conventions. Time zone is a separate preference and must not be inferred from locale.

### Layout and Accessibility

Localized interfaces must tolerate text expansion without clipping, overlap, or inaccessible truncation. Avoid fixed widths for text-bearing controls unless the design provides a safe overflow behavior. Verify compact navigation, tables, dialogs, buttons, form messages, and responsive layouts in every supported locale and in both light and dark themes.

Set the document `lang` attribute to the active locale. Localize accessible names, descriptions, validation announcements, screen-reader-only text, and image alternative text when they describe product-owned content. Language switching must be keyboard accessible and must not require a full page reload.

## API and Server-Owned Content

REST APIs return stable machine-readable error codes and structured parameters. They must not require clients to inspect or match an English error message. The web application maps recognized product error codes to localized messages and provides a localized safe fallback for unknown failures.

Developer diagnostics, logs, trace data, and internal exception messages remain in English. Do not localize protocol values, database values, queue payloads, or audit action identifiers.

When the server produces user-visible content outside the web application, such as email, it must choose a locale from the recipient's persisted preference and fall back to `en`. Server-owned templates must follow the same semantic-key, interpolation, pluralization, and fallback principles as the web application.

## Daily Development Requirements

A product change is incomplete if it adds user-facing product copy outside the localization system or updates only one supported locale. As part of normal development:

1. Add or update semantic keys in every supported locale.
2. Keep interpolation variables, plural rules, and markup structurally compatible across locales. A plural-suffixed key belongs only to locales whose CLDR plural rules use that category: `zh-CN` resolves every count to `other`, so it carries `_other` alone, and adding `_one` there creates a string i18next never selects. `apps/web/scripts/check-locale-keys.mjs` enforces this per locale.
3. Use locale-aware formatting for newly displayed dates, times, numbers, percentages, and lists.
4. Localize validation, feedback, tooltips, accessible names, and screen-reader-only content, not only visible body copy.
5. Check the affected UI with long localized content, responsive behavior, keyboard navigation, and both themes.
6. Keep API and persisted domain values language-neutral.
7. Remove obsolete keys when the owning feature is removed, while avoiding unrelated bulk cleanup in feature changes.

Shared components must accept translated content or translate only stable, component-owned product concepts. Feature-specific wording stays in the owning feature namespace. User-authored and third-party content must never be passed through translation lookup as if it were a key.

## Quality Controls

The implementation should provide automated static checks that compare locale key structures and fail on missing or invalid keys. Development mode should report missing translations clearly. Production must fall back safely to English without exposing raw keys to users.

Tests, when introduced under an approved testing workflow, should prioritize locale resolution, fallback behavior, pluralization, formatting, document language, and representative layout-sensitive surfaces. Snapshotting entire translation catalogs is not a substitute for these behavioral checks.

## Adding a Locale

Adding a supported locale is a product decision, not only a translation-file change. Before enabling it:

- Define its canonical locale code and compatible browser-language mappings.
- Complete all required namespace resources.
- Verify pluralization, date, time, number, list, and relative-time behavior.
- Verify fonts, text expansion, responsive layouts, keyboard access, and both themes.
- Define server-template coverage for any product-owned emails or notifications.
- Add the locale to the supported-locale registry only after the experience is complete.

Do not expose partially translated locales in the production language selector.

## Changelog

### 2026-09-19 - Locale-Aware Plural Key Parity

- Scoped plural-suffixed key parity to each locale's CLDR plural categories, so `zh-CN` is no longer required to carry an `_one` form that i18next never selects.
- Removed the unreachable `zh-CN` `_one` entries the previous strict comparison had invited, each of which duplicated its `_other` text verbatim.
- Removed the `onboarding` namespace from both locales together with the route family it served.

### 2026-09-14 - Browser-First Locale Startup

- Clarified startup as explicit browser-local choice, compatible browser language, non-default server preference, then English fallback.
- Required locale and `document.lang` initialization before first paint to avoid an English flash for Chinese browser sessions.
- Kept an explicit local choice as the immediate browser preference while continuing to persist selections through workspace settings.

### 2026-08-14 - Initial Internationalization Standard

- Established internationalization as a daily development requirement rather than a separate workflow.
- Selected English and Simplified Chinese as the initial supported locales, with English as the fallback.
- Defined locale resolution, persistence, routing, resource organization, formatting, API, accessibility, and quality requirements.
