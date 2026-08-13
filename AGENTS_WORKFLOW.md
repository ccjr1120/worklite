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
