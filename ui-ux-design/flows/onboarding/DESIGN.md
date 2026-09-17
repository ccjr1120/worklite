# Onboarding

## Route

`/onboarding, /onboarding/provider, /onboarding/first-agent`

## Design Source

- `docs/ui-design-system/README.md`
- Applicable shared specifications in `ui-ux-design/shared/`

## Implementation

- `apps/web/src/routes/onboarding/index.tsx`
- `apps/web/src/routes/onboarding/provider.tsx`
- `apps/web/src/routes/onboarding/first-agent.tsx`

## Coverage Status

Migrated from the former indexed page specification. This change moved and indexed the specification; it did not audit implementation coverage.


## Flow

Use an optional resumable first-use sequence with visible progress and one primary outcome per step:

1. Configure a model provider, test credentials, or defer only when the product remains useful.
2. Create the first agent through concise guidance or a small set of intentional templates.

Explain the agent as instructions, model, skills and tools. Never read back secrets. Returning users resume their incomplete step. Finish at the created agent or Home with a clear next action. There is no account or team setup step.

## Changelog

### 2026-08-25

- Removed team creation, invitations, and account-dependent onboarding.
- Kept provider and first-agent setup as an optional local first-use sequence.

### 2026-08-13

- Established the Onboarding specification.
