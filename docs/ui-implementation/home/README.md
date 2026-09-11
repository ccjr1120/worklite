# Home

## Purpose

Home is the personal dashboard library. It organizes dashboards into user-manageable categories and opens a selected dashboard that answers what requires attention, what is running, where work can continue, and what changed. It also provides System Helper Chat without requiring a separate destination.

## Dashboard Library

Show collapsible category sections rather than a flat collection of panels. Provide a default `Workflows` category with `Workflow overview`, `Workflow health`, and `Recent activity` dashboards. Users may add, rename, reorder, and remove categories and may add dashboards from a template or as a blank dashboard. Category and dashboard configuration is local-prototype state until persistence is introduced.

The library shows a category title, dashboard count, category actions, and an `Add dashboard` action. Category headers expand or collapse their dashboard list and expose a non-color open-state cue. Dashboard rows or tiles show their name, short description, meaningful summary metrics from their configured widgets, and a clear open affordance. Category creation sits below the category list rather than in the page header. Home does not duplicate the Workflow creation action; creation remains on the Workflow list and editor. The page keeps the existing workspace shell and does not replace the Workflow list or editor.

Every clickable control uses a pointer cursor and a visible hover state. Category headers use a full-width hover surface, while dashboard cards, empty-category actions, links, and category actions retain distinct hover and keyboard focus feedback. Disabled controls use a not-allowed cursor and do not present an active hover treatment.

Opening a dashboard navigates to its detail view. Dashboard widgets link to the existing resource surfaces: workflow rows open Workflow details, active run rows open Run details, artifact rows open Artifact details, and section actions open the corresponding collection list. These links must remain keyboard accessible and show hover and focus states.

Dashboard detail supports editing the dashboard name, adding supported widgets, reordering widgets, and removing widgets. Supported platform widgets are `Needs attention`, `Active runs`, `Workflow health`, `Recent workflows`, `Recent activity`, and `Recent artifacts`. A workflow-backed dashboard additionally selects one published Workflow, configures its fixed interval, exposes a neutral Run now action, and renders the latest successful `worklite.dashboard` version 1 payload as either a list or a kanban. Kanban columns come from item status values. Source names remain provenance labels rather than product navigation.

## Embedded System Helper Chat

Keep the dashboard library or selected dashboard mounted as the Home content. Place a persistent, labeled, single-line System Helper Chat composer at the bottom center of the Home content region. The dashboard content reserves enough bottom space that the composer does not obscure its final content.

Focusing the composer expands a raised conversation panel above it without waiting for message submission. The panel occupies most, but not all, of the workspace content region, up to `1200px` by approximately `680px` with at least `24px` desktop outer space. Keep the Dashboard mounted beneath the panel and preserve its scroll position. The panel contains the persisted Agent transcript and inline Skill-script approvals defined in `../assistant/README.md`.

Clicking outside, pressing `Escape`, using the icon-only minimize control, or navigating to another page closes the panel without cancelling work or clearing the conversation. The minimized dock retains the composer and, after the first request, a compact status summary such as preparing, tool calls in progress, needs review, completed, or failed. The summary includes a non-color cue and reopens the current conversation. Completion does not automatically minimize the conversation.

Command search may open or focus System Helper Chat through the same Home state, but System Helper Chat is not a separate sidebar item.

## Dashboard Content

Use compact, workflow-oriented widgets rather than decorative totals or generic metric cards. The default Workflow dashboards may contain `Needs attention`, `Active runs`, `Workflow health`, `Recent workflows`, `Recent activity`, and `Recent artifacts`. Section failures remain local to the affected widget.

## First Use

Show a two-step guided sequence: configure at least one Model Provider, then bind a Provider and model to the protected System Helper Chat Agent. The current step owns the primary action; completed steps remain visible but quiet while the sequence is incomplete.

Derive completion from persisted server resources rather than browser preferences. Do not show the guide until both Provider and System Helper Chat queries have resolved successfully. Remove the complete guide as soon as both steps are complete. Creating a custom Agent, creating a Workflow, and running or inspecting a Workflow are not first-use steps.

## Changelog

### 2026-09-10

- Added generic workflow-backed list and kanban dashboards that consume the fixed dashboard payload inside Home.
- Kept schedule and manual execution controls attached to the selected Workflow and removed source-specific navigation.

### 2026-08-27

- Reduced first use to Provider configuration and System Helper Chat Provider-and-model binding, made completion server-derived, and removed the guide after both steps complete.
- Replaced structured proposal review with the persisted System Helper Agent transcript and inline Skill-script approvals.

### 2026-08-25

- Reframed Home as the dashboard library for a single personal workspace.
- Replaced the team setup sequence with an optional provider and first-agent checklist.

### 2026-08-24

- Added explicit pointer-cursor, hover, and disabled-state feedback requirements for Home controls.

### 2026-08-24

- Reframed Home as a categorized dashboard library with user-created categories and dashboards.
- Defined dashboard detail editing, supported widgets, and links to existing Workflow, Run, and Artifact surfaces.
- Added collapsible category sections, board summary metrics, and moved category creation out of the page header.

### 2026-08-20

- Changed Home Agent Chat to a focus-opened, constrained floating panel with a single-line composer.
- Added the persistent Agent Chat composer, upward-expanding conversation surface, minimized execution summary, and legacy-route behavior.

### 2026-08-13

- Established new-team and established-team Home specifications.
