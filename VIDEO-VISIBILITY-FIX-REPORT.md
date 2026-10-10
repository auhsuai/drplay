# VIDEO-VISIBILITY-FIX-REPORT.md

Repo: E:\drplay | Date: 2026-10-09 | Slice: S4d

## Root cause confirmed

The video did **not** fail in the graphics engine. It failed in the frontend
painting order.

Verified working (unchanged by this slice):

| Component | Evidence |
|---|---|
| libmpv 4K decode | `video-params=3840x1600`, BMP frame dump of the real picture |
| DirectComposition present | `presented=2875`, `last_present_error=none`, `can_present=true` |
| WebView2 transparency | `SetDefaultBackgroundColor(A=0)` via `backgroundColor [0,0,0,0]` |
| No `mpv.exe` sidecar | process list contains `drplay` only |

Root cause: the page painted opaque background over the whole video rect. The
`drplay-player-bg` layer (`src/ui/NowPlaying/NowPlayingView.tsx:264-275`) punches
an evenodd hole for the rect, but the app shell below the overlay also painted
into that hole, so the video visual was covered by webview pixels.

The S4b rule in `src/App.css:79-85` already neutralises exactly that shell paint
(`aside`, `#content-area` and their descendants) while the marker class
`drplay-host-visible` is set. That rule is **correct and required** — removing it
reintroduces the original symptom (`#0A0A0A` tab root instead of video).

## CSS declarations and rules changed

No production CSS was changed in this slice. The existing rules already expressed
the correct intent; the failure was a mis-diagnosis of which layer was at fault,
corrected by the magenta diagnostic (below).

The variable hypothesis was **disproved**: `--player-bg-solid` / `--player-bg-fade`
are defined at `src/App.css:30-31` (light) and `:37-38` (dark), inside the `html,
body` rule, so they always resolve. No fallback value was added and no new CSS
variable was introduced.

## Why the previous background was invalid

It was not invalid. The declaration resolved correctly; the background was being
painted in the wrong z-order relative to the DComp visual. The fix is layering,
not colour.

## How the S4/S4b scope was corrected

The scope was verified rather than changed. `shouldShowVideoHost`
(`src/lib/videoHost.ts:175-184`) includes `isOpen`, and `VideoSurface`
(`src/ui/NowPlaying/components/VideoSurface.tsx:154-167`) derives both
`setVideoHostVisible(active)` and the marker class from that single value, so the
page never loses its background while the overlay is closed. Rule `App.css:79-85`
stays as the guard that clears shell paint inside the hole.

## Build and test results

| Check | Result |
|---|---|
| `vitest src/ui/NowPlaying + videoHost + hostTransparency` | 166 → **169 pass**, 0 fail |
| `vitest src/App.test.tsx` | **15 pass** |
| `cargo test -p drplay --lib` | **235 pass**, 0 fail, 15 ignored |
| `npx tsc --noEmit` | clean |
| `eslint` (touched file) | 0 errors |

New tests: three guard tests in
`src/ui/NowPlaying/NowPlayingView.videoSurface.test.tsx` asserting the marker class
follows overlay state (closed ⇒ absent, off→on→off cycle, unmount ⇒ removed).

## Actual runtime verification

Method: `PrintWindow(hwnd, hdc, PW_RENDERFULLCONTENT)` captures the window's own
composited surface, so the result cannot be polluted by other windows.

1. Launched the real dev app with `DRPLAY_PLAYER_ENGINE=libmpv`, no diagnostic env.
2. Played a real Drive video (`Renegade Immortal Movie 2`, `.mkv`, 4K 3840x1600).
3. `PrintWindow` capture shows the decoded movie frame (character face, katana,
   Vietnamese subtitle) composited **behind** the React layer — song cards,
   "Good morning, An", and the PlayerBar all render on top of the picture.
4. Magenta probe: `0/12` sample points magenta, confirming no diagnostic colour
   is present and the visible pixels are real video.

The earlier all-magenta captures were produced with `DRPLAY_DIAG_SOLID=1`, which
paints the entire DComp surface magenta by design; that run showed the rect simply
covers the whole content area in `fill` layout, which is the intended design.

## Screenshot evidence

- `final1.png` — real video frame playing with the React UI composited above it.
- `frame-2.bmp` / `frame-2.png` — engine-side frame dump (the actual decoded 4K
  picture read back from the GL FBO).
- `shot-pw.png` — magenta probe showing the DComp visual is visible through the
  webview.

## Remaining issue that prevented complete verification

Fullscreen / resize / pause-resume visual confirmation was not completed: the
session's `f` keypress toggled the overlay closed instead of capturing the
fullscreen layout, and the app was then stopped to release the machine.

Not verified in this slice: window resize and fullscreen re-layout of the video
rect, and pause/resume visual continuity. The engine counters
(`presented`, `can_present`) continued advancing throughout every run, so no
functional failure was observed, but the visual check itself is outstanding.

**Video visible in the real application: PASS**
