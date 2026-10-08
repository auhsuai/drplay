# VIDEO-PLAYER-UX-CONTEXT-MENU-REPORT.md

Phase: full video player UX. Machine: Intel i5-3570 / Intel HD Graphics (Ivy
Bridge) / driver 2015 / Windows 10 Pro 19045, mpv 0.41.0-1042-g7e4cb538a,
`--vo=gpu-next,gpu`, `--hwdec=auto-safe`. Real media: Google Drive.

## 1. What Changed

| area | change | files |
|---|---|---|
| native context menu | Win32 popup menu rendered by the Rust side; the frontend only sends the tree and receives the chosen id | `src-tauri/src/context_menu.rs` (new, 498 lines) |
| mouse input over video | an invisible, no-activate layered overlay window sized to the video rect, so a right-click on the video reaches the app at all | `src-tauri/src/video_host.rs` |
| runtime requirement | the app manifest now declares `supportedOS` Windows 8+; without it Windows refuses `WS_EX_LAYERED` on a child window and the overlay cannot exist (proved experimentally) | `src-tauri/windows-app-manifest.xml` (new), `build.rs` |
| shortcut system | ONE command registry (`PLAYER_*` ids). The keyboard, the context menu and the player bar all call the same id. Five previously independent keydown listeners were removed | `src/player/commands.ts`, `usePlayerCommands.ts`, `playerUiBus.ts` (new) |
| mpv surface for the UI | one facade for tracks, chapters, devices, crop/zoom/aspect, delays, A-B loop, screenshot, media info | `src/lib/mpvControl.ts` (new, 592 lines) |
| menu content | the menu is rebuilt from live player state on every open (labels, checked, enabled, shortcuts) | `src/player/menuModel.ts` (new, 1163 lines) |
| right-click wiring | overlay event → snapshot → native menu → run the chosen command | `src/player/useVideoContextMenu.ts`, `src/lib/nativeMenu.ts` (new) |
| media information | dialog fed by mpv properties; the video host hides while it is open so the dialog is never hidden behind the native window | `src/ui/NowPlaying/components/MediaInfoDialog.tsx` (new) |
| video player bar | video mode is now one horizontal row of controls under the video; the vertical stack (title block, controls, seek bar, volume) is gone | `src/ui/NowPlaying/components/VideoPlayerBar.tsx` (new), `NowPlayingView.tsx`, `VideoSurface.tsx` (`fill`) |
| docs | shortcut reference generated from the registry | `docs/player-shortcuts.md` (new) |

Not touched: `stream_proxy`, auth, Drive transport, mpv spawn flags, the video
host architecture, `mpvAudio`'s engine logic, the audio player layout.

## 2. Context Menu Architecture

A DOM menu cannot work here: the video is a native child HWND, so anything React
paints in that rectangle is painted over. The menu is therefore a real Win32
popup owned by the app window.

```
right-click on video
  → DrPlayVideoInputOverlay (invisible, layered alpha 0, WS_EX_NOACTIVATE)
      WM_RBUTTONUP → emit "video-context-menu" {x, y}   [screen pixels]
  → useVideoContextMenu: takeVideoMenuSnapshot()        [one IPC batch]
  → buildContextMenuModel('full', snapshot)            [labels/checks/enabled]
  → invoke show_context_menu                           [main thread, modal]
  → RunOnMainThread → TrackPopupMenu(TPM_RETURNCMD)     [native menu appears]
  → selected id (or null) → runMenuEntry(id)           [same registry as keys]
```

The overlay exists because mpv creates its own child window inside the host and
would otherwise swallow every mouse message. It is layered (alpha 0) so it never
covers a pixel, `WS_EX_NOACTIVATE` so a click never steals focus from the WebView
(the keyboard shortcuts keep working), and it is positioned with the host rect and
toggled with the host visibility, so it can never drift.

The menu content is data, not code paths: the frontend describes items and the
Rust side only renders them. That is what keeps the menu, the keyboard and the
player bar consistent — they all resolve to the same `PLAYER_*` ids.

Verified live (evidence in §11): the menu opens at the cursor in normal mode and
in fullscreen, keyboard navigation opens submenus, the selected id comes back and
runs the action, `Escape` and an outside click both dismiss, and no menu window
survives the dismissal (top-level window count returns to its baseline of 6).

## 3. Shortcut Registry

`src/player/commands.ts` holds every action as one entry:

```ts
{ id, labelKey, shortcut, match(event), run(ctx), preventDefault }
```

`findCommandForEvent` is the only key dispatcher; `shortcutFor(id)` is the only
source of the text shown in the menu. Full table in `docs/player-shortcuts.md`.
Highlights: `V` cycles the subtitle track and `Shift+V` toggles visibility,
`F` toggles fullscreen, `F8` opens the queue, `Ctrl+Shift+S` toggles shuffle,
`Ctrl+Q` is kept as an alias of the queue command because it was already a user
key. `Escape` is deliberately not a command: it is the layer closer (dialog →
fullscreen → player).

Removed duplicate listeners: `PlayerBar/useKeyboardShortcuts.ts` (deleted),
`useSeekKeyboard.ts` (deleted), the key handler inside `VolumeSlider.tsx`, the
`f` branch in `useNowPlayingShortcuts.ts`, and the old hook call in `PlayerBar`.
Grep now shows exactly one player keydown listener.

## 4. PlayerBar Redesign

Video mode previously stacked everything vertically, which is why the fullscreen
video was a thin band. It is now one row:

```
[mode][prev][play][next]   title(truncate)  1:35 ━━━━━━━━━━ 22:09   [vol][A][V][⛶][⋯]
```

- Left: the existing `TransportControls` (unchanged component).
- Centre: title with `truncate`, then the existing `SeekBar`.
- Right: the existing `VolumeSlider` (default responsive form), Audio track,
  Subtitle track, fullscreen, and More — the last three open the native menu, so
  they work through the same command layer as the right-click menu.
- `flex-nowrap`, one row at every width; below `lg` the A/V buttons are hidden
  and stay reachable through More.
- Audio mode is untouched: cover art, title, controls, seek bar, volume exactly
  as before.

## 5. Fullscreen Redesign

```
main (h-full overflow-hidden flex flex-col)
└─ content (flex flex-col h-full w-full pt-14 px-3 pb-2)
   ├─ video area (flex-1 min-h-0 w-full)  → VideoSurface fill
   └─ VideoPlayerBar (shrink-0)
```

`VideoSurface` gained an additive `fill` prop: `w-full h-full`, no `aspect-video`,
no width ladder. `fill` defaults to false, so the audio path and every existing
test behave exactly as before.

Measured: before the change the video was 577 px tall in a 1057 px window; now it
is **928 px of 1057 px (88 %)**, with a 65 px bar underneath, and the native host
rect matches the DOM rect exactly (12,79 1896×928 vs surface 12,56 1896×928 —
offset equals the client origin). Fullscreen enter/exit keeps its previous
behaviour; only the layout changed.

## 6. MPV Integration

All new mpv access went through `mpvControl` (the same `invoke` +
`mpvProtocol` boundary `mpvAudio` uses). No component sends raw JSON, and
`src/player/` contains no `invoke(` call at all — verified by grep. The four
properties the menu needed first (`width`/`height`, `sub-visibility`,
`secondary-sid`) were briefly read locally in `menuModel` because the facade did
not expose them; that was rejected and moved into `mpvControl` as
`getVideoDimensions` / `getSubtitleVisibility` / `getSecondarySubtitleId`.

Every property used was checked against the shipped binary before it was used:
`video-crop`, `video-zoom`, `video-pan-x/y`, `video-aspect-override`,
`deinterlace`, `sub-scale`, `sub-delay`, `audio-delay`, `ab-loop-a/b`,
`audio-device(-list)`, `chapter-list`, `track-list`, `speed`, and the commands
`sub-add`, `screenshot-to-file`, `playlist-next/prev`, `cycle`, `add`.

## 7. Live Test Matrix

| # | case | result | evidence |
|---|---|---|---|
| L1 | right-click, normal mode | PASS | menu captured, 208×291, correct items |
| L2 | menu structure | PASS | `Pause/Space, Stop/S, Previous/P, Next/N, Fullscreen/F, Audio/Video/Subtitle/Playback/Playlist >, Take screenshot/Ctrl+S, Media info/I` |
| L3 | subtitle submenu | PASS | `Subtitle Track V >`, `✓ Toggle subtitles Shift+V`, `Secondary Subtitle >`, `Add Subtitle File...`, `Subtitle Delay >` |
| L4 | real track list | PASS | `✓ Audio Track 1 (default)`, `Below`, `Above`, `✓ Vietnamese-Bottom — vie (forced) (default)` |
| L5 | Escape dismiss | PASS | menu window count 7 → 6 |
| L6 | outside click dismiss | PASS | menu closed, count back to baseline |
| L7 | no orphan menu window | PASS | after every dismissal the only top-level windows are the app window, tray, Tauri helper windows |
| L8 | right-click in fullscreen | PASS | menu opened and dismissed at fullscreen rect |
| L9 | event coordinates | PASS | client (200,100) → `{x:516,y:287}` = overlay origin + client, exact |
| L10 | media information | PASS | `H.265 / HEVC · 3840×1632 · 25.00 fps · yuv420p`, `aac · 2 ch`, `Hardware decoding: no`, `Video output: gpu-next`, `7.22 Mbps`, tracks with current marked |
| L11 | host hidden while dialog open | PASS | host `Visible=False` during the dialog, visible again after `Escape` |
| L12 | snapshot `Ctrl+S` | PASS | `Pictures/DrPlay-20261008-074531.png`, 20 MB (4K) |
| L13 | fullscreen layout | PASS | 928/1057 px video, bar 65 px, no drift |
| L14 | video↔audio switch | PASS | same mpv pid 7092, host hidden, RAM 538 → 63 MB |
| L15 | audio playback unaffected | PASS | time-pos advanced, no respawn, `video=no` per track as designed |
| L16 | menu with real Drive data | PASS | built from the real `track-list`, `chapter-list`, queue and device list of the playing file |
| L17 | keyboard during menu | PASS | menu has focus; `Down`/`Right` navigate submenus, `Escape` closes |
| L18 | focus not stolen by overlay | PASS | `document.hasFocus() === true` after clicking the video |

Not covered by live tests, and why:

- **A real H.264 file from Drive** — the Drive library currently holds only HEVC
  and AV1 files. Hardware-decoding H.264 was measured directly against the same
  mpv binary and the same flag set in the performance phase, but not through the
  Drive path in this phase.
- **Multiple audio tracks from Drive** — no Drive file has more than one audio
  track, so the multi-track selection UI was exercised with an injected subtitle
  track (real `sub-add`, L4) rather than a second audio track.
- **Chapters from a real Drive file** — the menu's chapter submenu was verified
  as correctly disabled when the list is empty; no Drive fixture carries chapters.
- **`Add Subtitle File...` end-to-end** — the item opens the native picker; the
  underlying `sub-add` path was verified, the OS file dialog itself was not
  automated.

## 8. Audio Regression

| check | result |
|---|---|
| video → audio | same mpv pid (no respawn), host hidden, RAM 538 → 63 MB |
| audio → video | same engine, `video=1` per track, host visible again |
| audio play / pause / seek / volume | PASS (unchanged engine path, same facade) |
| audio layout | untouched by this phase |
| keyboard map for audio | every previously bound key still works through the registry |

No audio behaviour was modified: the only audio-side change is that the volume
key handler moved from `VolumeSlider` into the registry, with the same semantics
(0..1, step 0.1, no implicit unmute).

## 9. Performance

- The player bar subscribes only to what it shows; the seek bar keeps the existing
  throttled `timeupdate` path. No new polling, no 60 fps React loop.
- Opening the menu takes **one** state snapshot (~17 IPC reads) and then no
  further IPC until an item is chosen.
- Measured while a 4K video played: `drplay.exe` ≈ 2.6 % of one core (video) and
  **0 %** (audio, WebView + CDP active), `mpv.exe` ≈ 90 % of one core for the 4K
  HEVC software decode — the same decode cost measured in the performance phase,
  unchanged by this UI work. No CPU regression was introduced by the menu or the
  bar.
- `Ctrl+Alt+Arrow` may be claimed by the Intel graphics driver (screen rotation);
  the menu items still work. Unverified on this driver.

## 10. Known Limitations

- No real H.264 Drive file and no multi-audio-track Drive file: those menu states
  are covered by unit tests and by injected tracks, not by a Drive fixture.
- The native menu uses the Windows theme. It looks native, not like DrPlay's own
  surface; a styled popup was explicitly rejected because it cannot be styled
  without a custom window, which would have to re-implement menu behaviour.
- `Ctrl+Alt+Arrow` can be intercepted by the GPU driver.
- The A/V buttons disappear below `lg`; they remain reachable through More, as
  specified.
- The menu cannot be opened over the video while a native menu is already open
  (the open menu owns the mouse). This is Windows behaviour, not a bug.
- The volume rail is hidden below `xl` in the new bar, as in the existing audio
  bar; keyboard and menu volume control remain available.

## 11. Screenshots / Evidence

| file | what it shows |
|---|---|
| `d3-ctx-live.png` | the context menu over real Drive playback |
| `menu-1.png` | Subtitle submenu with checked state and shortcuts |
| `menu-0.png` | Subtitle track list with real tracks and `(forced)`/`(default)` markers |
| `d3-fullscreen.png` | fullscreen layout: video ≈ 88 % of the height, one horizontal bar |
| `d1-video.png` | video rendering through the invisible overlay (unchanged) |

All artifacts live in `%TEMP%\opencode\`.

## 12. Final Verdict

**READY, with the limitations listed above.**

Every item of the phase definition of done that does not need a Drive fixture is
verified live: right-click opens the menu in normal mode and in fullscreen, the
submenus render live state, shortcuts are displayed from the registry, `V`
cycles subtitles, `A` cycles audio, `F` is fullscreen, `Space`/`S`/`P`/`N` work,
the player bar is one horizontal row, the fullscreen video uses the available
height instead of a band, seek and volume work, audio/video switching works,
there is no duplicated player logic, no top-level mpv popup, no orphan menu
window, and the audio regression is zero. Test suites: vitest **197 files /
2911 tests**, cargo **166 passed / 0 failed / 15 ignored**, `tsc --noEmit` clean,
eslint clean.

Not claimed: real H.264 playback through Drive, multi-audio-track selection and
the OS subtitle file dialog, because no such fixture exists in this account.