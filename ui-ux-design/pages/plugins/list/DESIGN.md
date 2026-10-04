# Plugin List

## Route

`/plugins`

## Design Source

- `docs/ui-design-system/README.md`
- Applicable shared specifications in `ui-ux-design/shared/`

## Implementation

- `apps/web/src/routes/plugins/index.tsx`

## Purpose

Communication channels are reached through Chat; Feishu is excluded from this collection.

See which trusted workspace plugins are available and open one to configure its command.

## Primary Task

Open the plugin being looked for. Action budget: one — activate the row, which is a single link to its configuration.

## Layout

Fluid collection width up to `1440px`. Plugins is a first-level workspace destination: the page shows no Agent resource tab strip and no other local navigation row. A page heading sits above a toolbar carrying only the filter; there is no creation action, because plugins are product-owned rather than user-created. Columns are Plugin, Command, Availability, and Updated.

Each row shows the plugin name with its description beneath, the configured executable command in the monospace stack, the availability state, and update time. The list is read-only; configuration opens from the row.

Do not add plugin installation, marketplace, upload, or arbitrary runtime registration controls.

The built-in `codex-cli-chat` plugin always appears when its workspace configuration exists.

## Interaction Contract

Activating a row navigates to `/plugins/:pluginId`. It is a plain link with no intermediate step, and it is the only navigation on this surface.

Typing in the filter narrows the list on each keystroke against name, description, and command. The no-results state offers `Clear filters`.

A failed load offers `Try again`, which refetches in place.

Availability is a stale value this surface does not heal. It reflects the last server-side test of the persisted command rather than live availability, and this collection carries no poll. A row therefore reports what was last observed; the configuration surface owns re-testing. Because the list neither polls nor exposes a refresh control, it must not present availability as live.

There is no deletion, no mutation, and no confirmation on this surface.

## States

| State | Behavior |
| --- | --- |
| Loading | `CollectionLoading` with the table's four columns, inside a `role="status"` live region naming the load. |
| Empty | No plugin is available to configure. This is a product-state explanation, not a first-use prompt, because the user cannot add one. |
| No results | Names the active filter and offers `Clear filters`. |
| Error | `ErrorState` with `Try again`, preserving the toolbar so the filter is not lost. |
| Busy | Refetch reports on the `Try again` control. No other action exists. |
| Offline | Inherits `shared-states.md`. |
| Long content | Long commands and descriptions truncate in their cells; the exact value stays reachable. |

Availability is a server-reported state and carries a text or icon cue in addition to color. The page never exposes environment variables, credentials, or process output.

## Copy Inventory

| Key | Category |
| --- | --- |
| `plugins:title` | State |
| `plugins:search` | Action |
| `plugins:loading` | State |
| `plugins:loadFailed` | Recovery |
| `plugins:empty.title` | State |
| `plugins:empty.description` | State |
| `plugins:noMatches.title` | State |
| `plugins:noMatches.description` | State |
| `plugins:columns.plugin` | State |
| `plugins:columns.command` | State |
| `plugins:columns.availability` | State |
| `plugins:columns.updated` | State |
| `common:status.available` | State |
| `common:status.missing` | State |
| `common:status.error` | State |
| `common:actions.clearFilters` | Action |

`plugins:description` is removed. "Configure trusted workspace plugins and their execution commands." restates the page title and the Command column; the execution-boundary constraint belongs on the configuration surface where the command is actually edited.

`plugins:empty.description` is classified State rather than Recovery: no plugin being available is a fact about the product with no next step the user can take here.

## Accessibility

The filter input takes its accessible name from its placeholder contract. `Tab` reaches the filter, then each row link. The row link must present a visible focus indicator that follows the row shape.

Availability uses the shared status badge, which pairs an icon and a text label with its color, so status never depends on color alone. The plugin icon is decorative and stays `aria-hidden`. The command renders in a `code` element so its boundaries are unambiguous.

## Responsive Behavior

At mobile widths, replace the table with object rows that keep the plugin name, availability, and command visible. Keep Plugins reachable through the shared navigation drawer and keep the row keyboard accessible.

## Coverage Status

Verified 2026-09-19. Differences found against `apps/web/src/routes/plugins/index.tsx`:

- The row link wraps `CollectionRow` in an anchor with `className="block"`. Unlike the other collections this does generate a box, but no focus indicator is applied to it, so keyboard users get no visible row focus.
- Truncated commands and descriptions have no tooltip or other disclosure, so a truncated value is unrecoverable.
- The filter is component state only and is not persisted in URL state, contrary to `shared/page-patterns.md`.
- `plugins:description` needs removal under `shared/copy-standards.md`.

The mobile object-row requirement is met: this is the one collection whose rows collapse to `grid-cols-1` below `768px` with no minimum width, so it does not scroll horizontally.

## Changelog

### 2026-09-19 - Copy cleanup

- Removed `plugins:description` from both locales: it defined the object instead of telling the reader anything they act on from the list.

### 2026-09-19

- Rewrote this specification against `TEMPLATE.md`, adding the action budget, the per-state table, the copy inventory, and verified coverage findings.
- Recorded that availability on this surface is a last-observed value with no poll and no refresh control, so it must not be presented as live.
- Required a visible row focus indicator and recoverable disclosure for truncated commands, and classified the empty state as a product fact rather than a first-use prompt.
- Removed the page description under the new copy standards.

### 2026-08-30

- Promoted Plugins from the capability resource tabs to first-level workspace navigation.

### 2026-08-29

- Established the Plugin List specification for workspace-owned plugin configuration resources.
