# WorkLite Desktop Client

The desktop client is a thin [Tauri v2](https://v2.tauri.app/) shell around the existing WorkLite web application. It bundles no local services and stores no local data: the window loads the same React SPA, which keeps talking to the managed deployment API the same way a browser does.

## Requirements

- Node.js >= 22 and pnpm 10 (already required by the monorepo).
- A Rust toolchain (`rustup`, stable channel).
- macOS: Xcode Command Line Tools (`xcode-select --install`).

## Development

1. Start the web dev server first (it is not started automatically):

   ```sh
   pnpm dev
   ```

2. In a second terminal, launch the desktop window:

   ```sh
   pnpm tauri:dev
   ```

   The window loads `build.devUrl` from `src-tauri/tauri.conf.json`, currently `http://localhost:3390` — the Web-only development profile, which proxies `/api` to the managed deployment API on port `23391`.

## Production build

```sh
pnpm tauri:build
```

The compiled app and installers are written under `src-tauri/target/release/bundle/` (`.app` and `.dmg` on macOS). The first build compiles all Rust dependencies and takes several minutes; later builds are incremental.

### Configuring the production URL

A release build loads the URL in `build.frontendDist` of `src-tauri/tauri.conf.json`. WorkLite currently has no fixed public deployment address, so this is a placeholder:

```json
"frontendDist": "https://worklite.example.com"
```

Replace `https://worklite.example.com` with the real deployment URL before producing a release. Keep the same origin in `remote.urls` of `src-tauri/capabilities/default.json`, otherwise plugin APIs (notifications) stay blocked for that origin in release builds. To point a build at the local deployment profile instead, use `http://localhost:23390`.

## Layout

```text
src-tauri/
|-- tauri.conf.json          # Window, dev/prod URLs, bundle and icon settings
|-- Cargo.toml               # Rust crate (tauri + notification plugin)
|-- build.rs                 # Tauri build script
|-- src/main.rs              # App entry point
|-- capabilities/default.json# Permissions granted to the loaded web origin
`-- icons/                   # Placeholder icon set (replace with the real brand icon)
```

## Replacing the placeholder icon

Put a 1024x1024 PNG of the real icon anywhere and regenerate every variant:

```sh
pnpm tauri icon path/to/icon.png -o src-tauri/icons
```

## Cross-platform notes

The configuration is platform-neutral: the same `tauri:build` produces Windows (`.msi`/`.exe`) and Linux (`.deb`/`.AppImage`) bundles when run on those platforms, and the icon set already includes their formats. Only macOS has been verified so far.
