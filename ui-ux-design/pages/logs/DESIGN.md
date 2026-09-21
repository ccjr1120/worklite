# Logs

## Route

`/logs`

## Design Source

- `docs/ui-design-system/README.md`
- Applicable shared specifications in `ui-ux-design/shared/`

## Implementation

- `apps/web/src/routes/logs.tsx`
- `apps/web/src/features/logs/time-range.tsx`
- `apps/web/src/features/logs/gateway-statistics.tsx`
- `apps/web/src/features/logs/request-logs.tsx`

## Purpose

Read what the local Portkey Gateway did over a chosen period: how requests performed in aggregate, and what one individual request sent and received.

## Primary Task

Narrow to a period and read what happened in it. Action budget: one for a preset — activating a preset applies it and both views reload.

A custom range costs three: the start instant, the end instant, and `Apply`. The two instants are one interval, so applying each field on its own would query a half-specified range and, while the reader is still typing the end, run a query over an interval they never asked for. `Apply` is the commit for one value expressed in two fields, not a preparation step paired with a commit. It stays disabled until both fields hold a valid ordered pair, so the control reports whether the range can be applied at all.

## Layout

Fluid collection width up to `1440px`.

Two page-level tabs use the `tab` URL Search parameter with `statistics` and `requests` values. A missing or invalid value resolves to `statistics`.

The time range sits above the tabs, not inside either one, because it applies to both and its position has to show that it survives a tab change. It is one row: the four presets as a segmented group, then the custom start and end fields with `Apply`. Below `768px` the presets and the fields stack in one column.

The `statistics` view holds four summary metrics above an expandable provider and model breakdown. The `requests` view holds its own filter row above a compact request list whose rows expand in place to reveal the captured request and response.

## Interaction Contract

### Time range

The range is the page's shared state and lives in route Search parameters, so a refresh or a shared link restores the same period on the same tab.

A preset persists as its name in `range`, one of `1h`, `24h`, `7d`, or `30d`. A custom range persists as absolute ISO-8601 instants in `from` and `to` with `range` absent. Storing a preset by name is what keeps the link meaningful: a shared "last 24 hours" link must mean the last 24 hours when it is opened, not the interval that was current when it was copied. A shared custom range is the opposite case and must not move, so it persists as the instants themselves.

The client resolves the active range to absolute instants on every query. A preset resolves against the current instant, so a preset view advances as the 30-second refetch runs. `to` never exceeds the current instant.

Activating a preset applies it immediately, clears `from` and `to`, and reports on the activated preset through its selected state. Editing either custom field is local draft state and queries nothing; `Apply` commits both, writes them to Search state, and clears `range`. An end earlier than the start keeps `Apply` disabled and names the problem beside the fields; no request is sent and the previous range stays applied.

The custom fields use minute precision. Setting start and end on the same date expresses hours within that day; setting different dates expresses a multi-day period. The fields carry the applied range's values when a preset is active, so switching to a custom range starts from what is on screen rather than from an empty pair.

### Gateway statistics

Statistics show request count, success rate, average latency, and known token totals for the applied range, followed by provider and model breakdown rows. Rows expand in place to reveal endpoint, status, and token availability. Expansion is local and resets when the range changes, because a row key from one period does not identify a row in another. Token values missing from upstream responses are labeled unavailable rather than zero. The view is read-only and never exposes prompts, responses, credentials, or header values.

`useGatewayStatsQuery` refetches every 30 seconds, so the view has no refresh control.

### Gateway request logs

Statistics answer how the Gateway performed; request logs answer what one request actually sent and received. Each row carries its time, Provider, model, endpoint, status, and duration, with a non-color status cue and tabular numerals. A row expands in place to reveal the transformed upstream request body and the captured response. A streaming response is presented as its ordered captured events rather than as one opaque blob, and a response that could not be captured states that rather than rendering an empty body.

Captured bodies are untrusted recorded content. They render as plain preformatted text inside a height-bounded scroll container, never as markup and never as an executed or fetched resource. Each body offers `Copy`, which reports on the control that was activated. Long bodies stay bounded by that container rather than extending the page.

Filters cover Provider, model, status class, and correlated Workflow Run, and persist in the same Search parameters as the range, so one link restores the whole investigation. A Run-scoped link from a Workflow Run node log opens this tab filtered to that Run. A failed provider test's `View request log` opens it filtered to that Provider. Paging is an explicit `Load more` action appending the next page; it is not infinite scroll, because the list is an investigation surface rather than a feed. Changing the range or any filter discards accumulated pages, since they describe the previous query.

Retention is a constraint the reader cannot infer: captured requests are kept for three days while statistics are kept indefinitely. The view states the three-day window, and when the applied range starts earlier than that window it states that the earlier part of the range has already expired. Without that text an expired period is indistinguishable from a period with no traffic. The view exposes no delete, export, or retention-configuration control, because expiry is automatic and the window is fixed. It is read-only and never exposes credentials or custom header values, which are excluded at capture time rather than filtered here.

## States

| State | Behavior |
| --- | --- |
| Loading | Statistics: four metric skeletons above a table-shaped skeleton in a `role="status"` live region. Requests: row-shaped skeletons matching the list columns; an expanding row shows a bounded body-shaped skeleton while its detail loads. |
| Empty | Statistics: explain that Gateway requests in this range appear once they occur. Requests: explain that captured requests appear once a Provider request occurs and that they are kept for three days. |
| No results | Requests: names the active filters and offers `Clear filters`, branching on whether the unfiltered range is empty so an expired or quiet period is never reported as a filter mismatch. Statistics has no filters, so it has no no-results state; an empty range is the Empty state. |
| Error | `ErrorState` with a retry action, scoped to the affected view. A failed row detail keeps its row expanded and explains itself inside that row rather than collapsing it. An invalid custom range is not an error state: it is reported beside the fields with `Apply` disabled and the previous range still applied. |
| Busy | `Apply` and `Load more` report progress on themselves and keep existing content visible. |
| Offline | Inherits `shared-states.md`. |
| Long content | Breakdown model identifiers wrap by character rather than widening the row. Captured request and response bodies stay inside a height-bounded scroll container with `Copy`, so a large body never extends the page. |

## Copy Inventory

| Key | Category |
| --- | --- |
| `logs:title` | State |
| `logs:views.statistics` / `requests` | Action |
| `logs:range.label` | Action |
| `logs:range.last1h` / `last24h` / `last7d` / `last30d` | Action |
| `logs:range.custom` | Action |
| `logs:range.start` / `end` | Action |
| `logs:range.apply` | Action |
| `logs:range.invalid` | Recovery |
| `logs:range.applied` | State |
| `logs:statistics.loading` | State |
| `logs:statistics.error` | Recovery |
| `logs:statistics.emptyTitle` | State |
| `logs:statistics.emptyDescription` | Recovery |
| `logs:statistics.requests` / `successRate` / `averageLatency` / `totalTokens` / `provider` / `model` / `endpoints` / `statuses` / `tokens` / `input` / `output` / `total` / `unavailable` | State |
| `logs:requests.title` | State |
| `logs:requests.retention` | Constraint |
| `logs:requests.retentionTruncated` | Constraint |
| `logs:requests.rowLabel` | State |
| `logs:requests.filters.provider` / `model` / `statusClass` / `workflowRun` | Action |
| `logs:requests.statusClass.all` / `success` / `clientError` / `serverError` | Action |
| `logs:requests.loadMore` | Action |
| `logs:requests.copyRequest` / `copyResponse` / `copied` | Action |
| `logs:requests.request` / `response` / `streaming` / `streamEvents` | State |
| `logs:requests.columns.*` | State |
| `logs:requests.emptyTitle` | State |
| `logs:requests.emptyDescription` | Recovery |
| `logs:requests.noMatches.*` | State |
| `logs:requests.error` / `detailError` | Recovery |
| `logs:requests.responseUnavailable` | State |
| `logs:requests.correlatedRun` | State |
| `workspace:nav.logs` | Action |

Moved keys: the `settings:providers.statistics.*` and `settings:providers.requestLogs.*` trees move to this surface's `logs` namespace with their views. `settings:providers.views.statistics` and `settings:providers.views.requestLogs` are removed with the tabs they labelled.

Removed keys:

- `settings:providers.statistics.description` ("Credential-safe request metrics recorded by the local Portkey Gateway."): it restates the heading and then describes internal recording mechanics the reader cannot act on.
- `settings:providers.statistics.window`, `last24h`, `last7d`, `last30d`: replaced by the shared `logs:range.*` control, which owns the window for both views.
- `settings:providers.statistics.windowRange`: the applied range is already stated by the range control above both tabs, so repeating it under the table duplicates a visible value.

## Accessibility

Tabs are a labelled `TabsList` with the selected tab reflected in the URL. Each view's sections are labelled by their headings.

The range presets are a labelled radio group, so arrow keys move between them and the selected preset is exposed as checked rather than by styling alone. Each custom field has a visible label, and the invalid-range message is associated with both fields so a screen reader reaching either one hears why `Apply` is unavailable. `Apply` keeps an accessible name while disabled.

A request-log row is an expand control with an accessible name naming its Provider, model, and time, and its expanded state is exposed to assistive technology. Captured bodies sit in labelled, keyboard-scrollable regions, and each `Copy` control names the body it copies. Request status uses the shared status badge with a non-color cue, and a streaming capture is labelled as streaming in text rather than by styling alone. Breakdown rows use the same expand-control pattern and non-color status cues.

## Coverage Status

`Pending verification`. The route, its shared range, and both views are specified and implemented in the same change.

## Changelog

### 2026-09-21 - Logs destination

- Added `/logs` with Statistics and Requests tabs, moved off the Providers destination so Providers configures upstream dispatch while Logs reads it.
- Added the shared time range: four presets plus a minute-precision custom start and end covering a specific date or a span of hours within one day. A preset persists by name so a shared link stays relative; a custom range persists as absolute instants so a shared link stays fixed.
- Declared the three-action budget for a custom range, with the reason that two fields express one interval and `Apply` is its single commit.
- Recorded the retention asymmetry as a Constraint and required an explicit statement when the applied range reaches past the three-day request-log window.
- Removed the statistics description, the three window labels, and the duplicated window-range line as copy the shared control or the heading already covers.
