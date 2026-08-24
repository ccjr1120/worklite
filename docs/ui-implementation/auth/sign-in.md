# Sign In

## Purpose and Layout

Use the shared authentication shell: a centered `360px` to `400px` column on the application background, with no decorative side panel. Show `Welcome back`, supporting copy, Email, Password, password visibility, `Forgot password?`, full-width `Sign in`, and the sign-up link. Do not show identity-provider buttons.

## Behavior and States

Autofocus email when appropriate, submit with Enter, show `Signing in...`, prevent duplicates, and restore the intended destination. Put field errors beside fields and account errors above submit. Invalid credentials must not reveal account existence. Define recoverable network failure, disabled, autofill and session-expired behavior.

When a session has expired, show a neutral in-page notice above the fields: `Your session expired. Sign in to continue.` Use border and surface contrast, not an error treatment. Intentional sign-out must not show this notice.

## Acceptance

Verify keyboard order, password-manager behavior, accessible visibility control, Light/Dark autofill styling, mobile keyboard access, and non-color error cues. Confirm the expired-session notice in both themes and that it is absent after a normal sign-out.

## Changelog

### 2026-08-14

- Removed the decorative authentication side panel in favor of a centered column.
- Removed identity-provider buttons from the initial sign-in surface.
- Specified a neutral in-page notice for expired sessions, distinct from errors and from intentional sign-out.

### 2026-08-13

- Established the Sign In specification.
