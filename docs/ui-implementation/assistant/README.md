# Workspace Agent Chat

## Purpose

Agent Chat helps a team configure a model provider and create Skills, connect MCP servers, and create Agents through a guided conversation. It is a task-oriented assistant owned by the workspace shell, presented as the same full-width expandable panel on Home and other team pages. It is not the default representation of the rest of the product.

The canonical route is `/:teamSlug/home`. The legacy `/:teamSlug/assistant` route redirects to Home with Agent Chat expanded. Agent Chat appears in command search but not as a separate primary navigation destination.

## Layout

Keep the workspace shell stable. Every team page shows a single-line composer by default. Composer focus opens a full-width conversation panel above the current page, using the same expanded dimensions and animation on Home and other team pages. Navigating always closes the visible panel while preserving the current team's session.

The expanded conversation header identifies Agent Chat and the current local prototype state and provides an icon-only minimize control. Before the first message, the Dashboard or current page remains primary; compact task starters may appear after composer focus opens an empty conversation. The starters are `Configure provider`, `Create skill`, `Connect MCP server`, and `Create agent`. They populate a user request and produce a representative structured proposal without hiding the normal resource editors.

The composer remains visible in both expanded and minimized states. It uses a visible compact label, a single-line input, one primary send action, and concise supporting status. Focus opens the applicable conversation presentation and `Enter` sends. Sending is disabled for empty input and while a response is being prepared.

On a sufficiently wide Home panel, the inspector is `360px` to `400px` wide beside the conversation. Other pages and narrower Home panels use internal `Chat` and `Proposed changes` views rather than a separate full-screen sheet. The inspector shows proposal scope, resource operations, dependency order, missing secure inputs, validation state, and one primary confirmation action. It must not use card nesting; operations are separated list rows within one surface.

## Session Ownership

The workspace shell stores independent local-prototype sessions keyed by `teamSlug`. Messages, draft input, proposals, and execution states survive page and team navigation for the current browser lifetime. Switching pages or teams closes the visible conversation. Returning to a team restores its minimized session without opening it automatically. Background local execution updates only its owning team session. Browser reload clears all sessions.

## Minimized Status

After the first request, show one compact status row above the composer while the conversation is minimized. Summarize the most important current state: preparing, number of tool calls running, ready for review, secure input required, completed, partially failed, failed, or offline. Use an icon and text, not color alone. The row is keyboard accessible, reopens the conversation, and must not imply that minimizing cancels execution. Long operation names remain in the expanded view.

## Proposal And Execution

Assistant output is represented as resource-specific structured operations, not free-form claims of completed work. Each operation shows its resource type, action, meaningful configuration summary, and one of `Draft`, `Needs input`, `Ready`, `Running`, `Completed`, or `Failed` with a non-color cue.

The user must explicitly confirm a ready proposal before execution. Provider credentials and other secrets are never requested in the message composer. A proposal that requires a secret links to or opens the dedicated secure resource form and cannot be confirmed until that requirement is satisfied.

Execution preserves operation order when dependencies exist. Progress remains visible per operation. Partial failure keeps completed results, explains the failed step, and offers retry or manual editing. Completed operations link to their resulting resource pages.

The initial implementation is a local interaction prototype. It may simulate proposal generation and execution, but must label the session as local and avoid implying persistence after reload.

## States

Define empty, composing, preparing proposal, ready for review, needs secure input, applying, partially failed, completed, permission, offline, and long-content states. Conversation content preserves scroll position while the user is reading and follows the end only when already at the end.

Untrusted user and third-party content renders as plain text without inline execution. Long proposal values wrap safely and technical identifiers use monospace styling where useful.

## Responsive Behavior

At `1280px` and above, Home and other team pages use the same large constrained panel dimensions; only Home supports optional side-by-side proposal inspection. From `768px` to `1279px`, keep the panel within stable outer space and use internal Chat and Proposed changes views when required. Below `768px`, use the available width minus `12px` outer margins and at most about `70vh`; never make the conversation full-screen.

The task starters become a single-column list when needed. The composer and review controls must remain reachable above mobile browser controls and support touch targets of at least `40px` where space permits.

## Accessibility And Themes

Use semantic surface, border, text, brand, and status tokens in both light and dark modes. Persimmon indicates the primary action, current selection, or active execution only. Messages use neutral surface contrast and speaker labels rather than color alone.

All icon-only controls require accessible names and tooltips. Conversation updates and operation status changes use restrained live-region announcements. Keyboard focus moves to the new proposal summary after generation and returns predictably when a mobile inspector closes. Reduced-motion mode retains static progress cues.

## Changelog

### 2026-08-24

- Unified Agent Chat expansion dimensions across Home and other team pages while keeping proposal inspection Home-specific on wide screens.

### 2026-08-20

- Moved session ownership to the workspace shell, keyed sessions by team, and required route changes to close without clearing state.
- Added the focus-opened single-line composer, constrained Home panel, and lower-right cross-page popover.
- Moved Agent Chat into Home with a persistent composer, upward-expanding conversation layer, and compact minimized execution status.
- Converted the assistant route to a compatibility redirect and removed the separate primary navigation destination.
- Established the Agent Chat route, guided task starters, structured proposal review, explicit confirmation, secure-input boundary, responsive behavior, and local-prototype state.
