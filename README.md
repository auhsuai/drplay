# DrPlay

**A desktop music player for your Google Drive — lightweight, private, and entirely under your control.**

DrPlay is a cross-platform desktop app (Windows, macOS, Linux) built to play music directly
from your personal Google Drive folder. Instead of making you download hundreds of gigabytes
before you can listen, DrPlay connects to your Drive, builds your library right inside the app,
and streams your music — yet everything is handled locally, kept safe, and never leaks anywhere.

---

## Why DrPlay is different

Most music players today are either browser-dependent web apps or heavy Electron builds that
phone home with telemetry. DrPlay takes a different path.

### Runs locally — no middleman in the cloud

DrPlay is a pure desktop app built on **Tauri**, a framework that uses **Rust** for its backend
instead of a bundled Chromium browser. The entire UI (React/TypeScript) and playback logic run
on your own machine.

When you hit play, the file is not pushed through a developer's server and bounced back to you.
Instead, the app spins up a **local proxy** (`drplay.localhost`) that acts like a virtual drive —
it pulls data straight from Google Drive and serves it back to the player on your machine
(`src-tauri/src/proxy.rs`, `src-tauri/src/protocol.rs`). The result is the shortest possible
media path: Drive → your machine → your speakers.

Your library, playlists, liked songs, listening history, and metadata cache are all stored in
**IndexedDB (Dexie)** and `localStorage` on the device itself (`src/db/db.ts`,
`src/utils/favorites.ts`, `src/utils/playlists.ts`). Uninstall the app and your local data goes
with you — it was never in anyone else's hands.

### No data collection — a commitment, not a slogan

We scanned the entire codebase and can confirm: **DrPlay ships with zero user-tracking tools** —
no PostHog, no Sentry, no Mixpanel, no Amplitude. Nothing in the code sends your behavior back
to a developer server.

This isn't just a promise; it's enforced at the configuration level. The file
`src-tauri/tauri.conf.json` defines a **Content Security Policy** that only permits connections
to two groups of destinations: Google's APIs (`googleapis.com`, `*.googleusercontent.com`) and
local loopback addresses (`127.0.0.1`, `drplay.localhost`). Any connection outside that list is
blocked by the app's own runtime.

Login tokens are also stored **on your machine** via `localStorage` (`src/utils/apiClient.ts`,
`src/hooks/useAuth.ts`). When you sign out, the token is revoked directly through
`oauth2.googleapis.com/revoke` and wiped from the device — no server-side storage, no backup copy.

Access is scoped to what you allow: DrPlay only works with the **Drive folder you choose**, and
never silently scans your whole account (`src/hooks/useDrive.ts`,
`src/ui/FolderSelection/FolderSelectionScreen.tsx`).

### Light enough that you forget it's running

Compared to Chromium-based desktop apps (Electron), DrPlay — on Tauri + Rust — uses far less
RAM and CPU, launches in a blink, and ships a much smaller binary. The dependency list is kept
lean too: only what's truly needed, like React, Dexie, `music-metadata`, and `i18next`
(`package.json`). No hidden runtimes, no bloated transitive dependencies.

---

## Features

- **Secure Google Drive login** — standard OAuth2, with tokens auto-refreshed and stored locally
  (`src/hooks/useAuth.ts`, `src/utils/apiClient.ts`).
- **Pick your music folder** — point DrPlay at any folder on Drive to use as your library.
- **Smooth playback** — play/pause, seek, volume, and a full-featured PlayerBar (`src/ui/PlayerBar/`).
- **Local streaming with buffer & prefetch** — plays even on shaky connections, by preloading
  visible tracks (`src/utils/streamPrefetcher.ts`, `src/utils/safeAudio.ts`).
- **Crossfade** — transition between tracks smoothly instead of cutting abruptly.
- **Playlists** — create, edit, delete, and manage your playlists (`src/ui/Playlist/PlaylistView.tsx`).
- **Liked songs** — mark and revisit your favorites, stored fully on-device.
- **Cover & metadata** — automatically reads ID3 tags and generates cover thumbnails saved
  locally (`src/utils/metadata.ts`, `src-tauri/src/thumbnail.rs`).
- **Trash** — view, restore, or permanently delete files right from Drive (`src/ui/Settings/TrashScreen.tsx`).
- **Library sync** — a background worker syncs changes with Drive via page tokens
  (`src/workers/proSync.worker.ts`, `src/workers/scanner.worker.ts`).
- **Customization** — light/dark theme, multi-language (i18n), download path, minimize-to-tray
  (`src/ui/Settings/SettingsTab.tsx`, `src/hooks/useTheme.ts`, `src/i18n.ts`).

---

## Architecture

```
┌─────────────────────────────────────────────┐
│  Frontend · React + TypeScript  (src/)       │  UI, hooks, utilities
└───────────────┬─────────────────────────────┘
                │  Tauri IPC / local fetch
┌───────────────▼─────────────────────────────┐
│  Backend  · Rust / Tauri  (src-tauri/)       │  OAuth, proxy stream,
│  lib.rs · proxy.rs · protocol.rs · thumbnail │  thumbnails, crossfade
└───────────────┬─────────────────────────────┘
                │  HTTPS (Google APIs only)
        ┌───────▼────────────────┐
        │   Google Drive (yours)  │  File source & auth
        └─────────────────────────┘

Local storage:  IndexedDB (Dexie) · localStorage
```

The code splits cleanly into two layers: the React frontend (`src/`) and the Rust system layer
(`src-tauri/`). Core logic lives in the `utils` layer, which concentrates most calls from the UI
and hooks — keeping the code maintainable and consistent. The Rust side packages authentication,
streaming, and cover handling into a tightly cohesive module with few external dependencies.

---

## Getting started

```bash
npm install
npm run tauri dev      # run the dev build (requires Rust toolchain)
npm run tauri build    # build a release bundle
npm test               # run unit tests (vitest)
```

**Requirements**: Node.js, a Rust toolchain, and a Google Drive account. The app only operates
on the Drive folder you grant access to — it uploads nothing else.

---

## Transparency

DrPlay is a *client* for your own Google Drive. That means:

- All usage data — library, playlists, tokens — lives on your machine or in your Drive.
- No developer server collects your behavior or telemetry.
- Because the music source is Google Drive, the app needs Drive access and will talk to Google's
  servers when playing or syncing. That's a required connection to your storage provider, not a
  third party.

If you ever find a network connection going to any domain beyond those listed above, that's a
bug — and we want to know about it.
