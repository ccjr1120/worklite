# AI Workflows

## Project Architecture Change Workflow

Use this workflow for changes to system architecture, technology choices, service or domain boundaries, persistence, runtime behavior, security boundaries, repository structure, deployment topology, or any decision documented in `docs/project-architecture/README.md`.

`docs/project-architecture/README.md` is the source of truth for project architecture.

1. Read `docs/project-architecture/README.md` in full before proposing or implementing an architecture change.
2. Discuss the motivation, alternatives, tradeoffs, migration impact, and implementation boundaries with the user.
3. Do not modify files or implement the change until the user explicitly confirms the agreed approach.
4. After confirmation, update `docs/project-architecture/README.md` before changing implementation files.
5. Update all affected sections so the document remains internally consistent; do not leave obsolete guidance in place.
6. Add a dated entry to the document's `Changelog` describing the decision and its impact.
7. Implement only the architecture described by the updated document and only within the approved scope.
8. If implementation reveals a required deviation or new architectural choice, stop and return to user discussion and explicit confirmation.
9. Keep code, configuration, tests, and operational documentation consistent with the architecture source of truth.
10. Report both documentation and implementation changes when handing the task back to the user.

If a request contains architecture and ordinary implementation work, this workflow takes precedence for the architecture portion. After the architecture is approved and documented, apply any relevant implementation workflow to the remaining work.

## UI Change Workflow

Use this workflow for any user-interface change, including pages, components, layouts, visual styling, design tokens, colors, typography, icons, motion, responsive behavior, themes, user-facing copy, interaction feedback, and workflow-editor presentation.

`docs/ui-design-system/README.md` is the source of truth for UI design principles and visual language. `ui-ux-design/README.md` is the source of truth for page structure, shared UI architecture, implementation sequencing, and page-level acceptance criteria.

1. Read `docs/ui-design-system/README.md` and `ui-ux-design/README.md` in full before proposing or implementing a UI change. Then follow the design index and read every shared document and applicable `DESIGN.md` for the requested surface.
2. Compare the requested change with the documented principles, tokens, shared patterns, page rules, interaction patterns, and product-specific guidance.
3. Explain the proposed visual result, affected surfaces, relevant tradeoffs, and any required design-system changes to the user.
4. Do not modify UI files or implement the change until the user explicitly confirms the proposed approach.
5. If the proposal introduces or changes a design decision, update the affected `DESIGN.md`, applicable shared specification, and `ui-ux-design/README.md` index before changing implementation files. New pages require a page `DESIGN.md` before implementation.
6. Implement only the confirmed approach. Use shared semantic design tokens and reusable components; do not introduce page-level hard-coded styles that duplicate or bypass the design system.
7. Design and implement light and dark modes together. Neither mode may be treated as a fallback or simple color inversion.
8. Preserve accessibility, including sufficient contrast, visible keyboard focus, non-color status cues, reduced-motion support, and accessible names for icon-only controls.
9. If implementation reveals a conflict with the design system or requires a new design choice, stop and return to user discussion and explicit confirmation.
10. Do not create or modify tests. After implementation, only a simple type check is permitted; do not package, build, or run test suites.
11. Report the design-system basis, shared and page documents read or changed, affected UI surfaces, light and dark mode behavior, and type-check result when handing the task back to the user.

If a request contains both architecture and UI changes, apply the Project Architecture Change Workflow first, then this workflow. This workflow takes precedence over the General Fallback Workflow for UI work.

## General Fallback Workflow

Use this workflow only when no more specific workflow applies to the user's request.

1. Do not execute the request immediately.
2. Explain the proposed development approach, intended changes, and relevant implementation considerations to the user.
3. Wait for the user's explicit confirmation before modifying files or performing any implementation action.
4. After confirmation, implement only the approved approach and scope.
5. Do not create or modify test cases for the implementation.
6. After implementation, only a simple type check is permitted.
7. Do not package or build the project.
8. Do not run test cases or attempt other validation commands beyond the permitted simple type check.
9. Report the implemented changes and the result of the type check, if one was available and performed.
