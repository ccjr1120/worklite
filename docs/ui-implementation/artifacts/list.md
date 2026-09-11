# Artifact List

## Structure

Use the collection pattern. Rows emphasize artifact name or identifier, type, producing workflow and run, useful size or availability metadata, and creation time. Support direct navigation to the producing context.

Define empty, filtered, processing, unavailable, expired when applicable, permission and large-collection states.

Artifact rows expose a separate destructive Delete action. The named confirmation explains permanent removal; success closes the dialog, shows a toast, and refreshes the list.

## Changelog

### 2026-09-10

- Standardized resource deletion actions, named confirmation, success feedback, dependency errors, and navigation.


### 2026-08-13

- Established the Artifact List specification.
