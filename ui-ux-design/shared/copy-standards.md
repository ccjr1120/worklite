# Copy Standards

This document is the source of truth for which user-facing text WorkLite is allowed to show. `docs/ui-design-system/README.md` governs typography and tone; `docs/internationalization/README.md` governs translation ownership. This document governs whether a string may exist at all.

## Admitted Categories

Product-owned text belongs to exactly one of four categories. Text that fits none of them is removed.

- **Action.** Names what activating a control does: `Publish`, `Retry node`, `Clear filters`.
- **State.** Reports what is happening or what is true right now: `Running`, `Unsaved changes`, `Waiting for QR scan`.
- **Constraint.** Tells the user something they must know to act correctly and cannot infer from the interface: `Credentials are write-only and never shown in logs`, `This permanently deletes the Workflow, its draft, published versions, schedule, and run history.`
- **Recovery.** Names the next step after a failure or an empty result: `Add a provider to make models available to agents.`

## Excluded Text

Remove text that restates its own heading. A page titled Artifacts does not need to be described as outputs produced by workflow runs.

Remove text that describes what a visible component already communicates. A save indicator makes `Changes are saved automatically.` redundant.

Remove text that explains internal mechanics the user cannot act on, including poll intervals, refresh cadence, and expiry timestamps for values the product replaces on its own.

Remove product definitions that do not change what the user does on the surface. Explaining what a workflow is does not help someone who is looking at their workflow list.

Remove promotional and reassuring phrasing. State the fact instead.

## Automation Debt

When an interaction becomes automatic, the text that existed to support the manual path is removed in the same change. An automatically replaced authentication code shows neither its expiry time nor an instruction to replace it: both describe work the user no longer does.

Automation that removes a control removes its label, its help text, and its locale keys together, in every supported locale.

## Optional Descriptions

A page or section description is optional. Write one only to state a constraint or to bound a scope that is not evident from the content. When no such text is needed, the heading stands alone.

## Inventory

Every `DESIGN.md` lists its surface's locale keys under Copy Inventory with the category each key belongs to. A key that cannot be assigned a category is removed rather than reclassified. Removing a key removes its Copy Inventory row in the same change.

## Changelog

### 2026-09-19

- Established copy standards: four admitted categories, explicit exclusions for restated headings and component-duplicating text, same-change removal of text made obsolete by automation, optional descriptions, and per-surface copy inventories.
