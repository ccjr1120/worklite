# Artifact Run Card Presentation

## Structure

There is no standalone Artifact collection route or execution tab. Artifacts are presented in the expanded card of the Run that produced them and in direct Artifact details. A Run-card artifact row emphasizes name, type, useful size metadata, creation time, and provenance context; its name links to `/artifacts/:artifactId`.

The expanded Run card defines loading, empty, failure, and long-collection states. Artifact deletion remains available from Artifact details.

## Changelog

### 2026-09-14

- Removed the standalone Artifact list route and moved Artifact collection presentation into expandable Run cards.

### 2026-09-10

- Standardized resource deletion actions, named confirmation, success feedback, dependency errors, and navigation.

### 2026-08-13

- Established the Artifact List specification.
