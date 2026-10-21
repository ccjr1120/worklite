# AI Workflows

## Project Architecture Change Workflow

Use this workflow for changes to system architecture, technology choices, service or domain boundaries, persistence, runtime behavior, security boundaries, repository structure, or deployment topology.

1. Explain the motivation, alternatives, tradeoffs, migration impact, and implementation boundaries to the user.
2. Wait for the user's explicit confirmation before changing architecture or implementing the proposed architecture.
3. Implement only the confirmed approach and approved scope.
4. If implementation requires a new architectural decision or a material deviation, pause and return to the user for direction.
5. Keep code, configuration, tests, and operational instructions consistent.
6. Report the architecture and implementation changes when handing the task back.

## UI Change Workflow

Use this workflow for user-interface changes, including pages, components, layouts, visual styling, design tokens, colors, typography, icons, motion, responsive behavior, themes, user-facing copy, interaction feedback, and workflow-editor presentation.

1. Explain the proposed result, affected surfaces, and relevant tradeoffs to the user.
2. Wait for the user's explicit confirmation before changing the interface.
3. Implement only the confirmed approach. Prefer semantic design tokens and reusable components over duplicated page-level styles.
4. Design and implement light and dark modes together.
5. Preserve accessibility, including sufficient contrast, visible keyboard focus, non-color status cues, reduced-motion support, and accessible names for icon-only controls.
6. If implementation requires a new design decision, pause and return to the user for direction.
7. Report affected surfaces, theme behavior, and type-check result when handing the task back.

## General Fallback Workflow

Use this workflow only when no more specific workflow applies.

1. Explain the proposed development approach, intended changes, and relevant implementation considerations to the user.
2. Wait for the user's explicit confirmation before modifying files or performing any implementation action.
3. Do not create or modify test cases for the implementation.
4. After implementation, only a simple type check is permitted.
5. Do not package or build the project.
6. Do not run test cases or attempt other validation commands beyond the permitted simple type check.
7. Report the implemented changes and the result of the type check, if one was available and performed.
