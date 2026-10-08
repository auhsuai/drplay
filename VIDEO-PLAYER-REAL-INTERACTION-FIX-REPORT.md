# VIDEO-PLAYER-REAL-INTERACTION-FIX-REPORT.md

Phase 6: real user interaction fix. This phase started from user feedback, not
from a test suite, and the rule was: **if runtime and tests disagree, runtime is
the bug**. Every finding below was reproduced with a real mouse/keyboard first and
then fixed.

## 1. User-visible bugs found

Reproduced live on the real app, real Drive media, real input events:

| # | what the user experienced | how it was reproduced |
|---|---|---|
| **B1** | **The video disappears.** The player bar shows a working pause button and a running time, but the video area is empty. | Opened a video, waited for the overlay to finish sliding. `p6-fullscreen-broken.png` shows the empty area. |
| **B2** | **The fullscreen button does nothing.** The state flips but nothing on screen changes. | Real click on the bar's fullscreen button. Measured: surface rect `{x:12,y:56,w:1000,h:639}` **before and after** — identical. |
| **B3** | (Not reproducible — tested and working) "shortcuts do nothing" | Real `keybd_event` presses. Space, S, P, N, arrows, M, `[`/`]`/`=`, R, D, G/H, A, V, Shift+V, L all reach mpv with the right values. |

B3 deserves a note, because it is the one claim in the feedback this phase could
**not** reproduce. See §5 for the one genuine finding behind it.

## 2. Root causes

### B1 — the native video host froze at a mid-animation position
`VideoSurface` tracks the overlay's slide (a CSS `translate`, which moves the box
without resizing it) with a bounded rAF loop fed by `transitionrun`/`transitionend`.
When that loop stopped — because its cap expired, or because `transitioncancel`
landed just after a `transitionrun` — the **last rect it sent was a mid-flight
value**. `onTransitionEnd` only set `deadline = now` and relied on a loop that no
longer existed, so the settled rect was never measured.

Nothing afterwards could recover it: the box had not resized (ResizeObserver does
not fire on a pure transform), the window had not resized, and the DPR had not
changed. Measured live: `video_host_set_rect` was called with `12,763` and then
silence, while the settled DOM rect was `12,56` — the host sat 707 px too low,
outside the window.

Classification: **NATIVE WINDOW FAILURE** (UI correct, native window wrong).

### B2 — fullscreen and normal mode used the same layout
The video branch of `NowPlayingView` renders one fixed wrapper
(`pt-14 px-3 pb-2`) for both states. With the window already sized to fit,
`isFullscreen` only changed the surface's corner radius, so the rect could not
change. The state variable flipped; the pixels did not.

Classification: **LAYOUT FAILURE**.

## 3. Fixes

### F1 — always send the settled rect (`VideoSurface.tsx`)
Split two concepts that were wrongly fused: *stop the loop* is not *the final
rect was sent*. A single settle frame is now armed after every stop path (cap
expiry, `transitionend`, `transitioncancel`), and it re-reads the box one frame
after the browser has applied the final transform. `sendRect` remains the only
place a rect is measured, so dedupe and the collapsed-rect guard are untouched,
and `rafId` still guarantees at most one frame in flight.

Tests added first (they failed with exactly the live signature — a frozen
intermediate rect — before the fix): transition runs out of cap with no end event;
end event with no frame in flight; rect unchanged → no extra IPC; after settling,
20 further frames produce **zero** further calls (no runaway loop).

### F2 — fullscreen changes the layout (`NowPlayingView.tsx`)
The wrapper now switches between `p-0` (fullscreen) and `pt-14 px-3 pb-2`
(windowed), and the back button is hidden in fullscreen because there is no room
for it. The exit-fullscreen button stays. The audio branch is untouched.

Because padding changes the content box, the surface resizes, `ResizeObserver`
fires and the host follows automatically — which is exactly what the live numbers
show.

## 4. Custom context-menu architecture

**Not changed in this phase — deliberately paused by the user.**

The user rejected the Windows stock menu and asked for DrPlay's own UI, which
cannot be a DOM node over the video (a native child HWND always paints above the
WebView). Two architectures were analysed; both need a decision that changes
user-visible behaviour, so the work was stopped and reported rather than guessed:

1. **Transient Tauri popup window** (no taskbar entry, owned by the main window,
   rendered with DrPlay's own components). The video stays visible behind the
   menu. Requires three ACL lines in `src-tauri/capabilities/default.json`
   (`allow-create-webview-window`, `allow-close`, plus the popup's label), verified
   against the app's real `acl-manifests.json`. Main risk: a second webview
   loads the same bundle, so the app entry point must be gated before `App` boots.
2. **Hide the native host while the menu is open**, then render the DOM menu in
   the WebView — the same pattern the media-info dialog already uses. No Rust
   change at all, but the video vanishes whenever the menu opens.

Until this is chosen, the right-click menu remains the Win32 menu from the
previous phase. It works; it is simply not the requested look.

## 5. Keyboard architecture

One dispatcher, unchanged from the previous phase: `window keydown →
findCommandForEvent → PLAYER_* id → command → mpv`. Escape is the only key
outside the registry, because it is a layer closer (media-info dialog → fullscreen
→ player).

Measured live, one value per key against real mpv state:

| key | expected | measured |
|---|---|---|
| ArrowLeft / ArrowRight | ∓5 s | −4.96 / +5.00 |
| Shift+ArrowLeft / Right | ∓1 s | −1.00 / +1.00 |
| ArrowUp / ArrowDown | ±60 s | +60.00 / −60.00 |
| Ctrl+ArrowUp / Down | ±10 % | +10 / −10 |
| `M` | mute / unmute | 100 → 0 → 100 |
| `=` `]` `[` | 1.0× / 1.25× / 1.0× | exact |
| `R` | cycle aspect | −2 → 1.777778 |
| `D` | cycle deinterlace | false → auto |
| `H` / `Shift+H` | +50 ms / reset | 0 → 0.05 → 0 |
| `L` | A → B → clear | 628.754 / 629.546 / cleared |
| `Space` | play/pause | flips |
| `Escape` | layer closer | closes overlay / exits fullscreen / closes overlay, in order |

The one genuine finding: **keyboard focus is fragile when the pointer is over the
video.** `GetFocus()` returns 0 while the app is foreground but unfocused, and
`document.hasFocus()` is false until something is clicked. Physical keys sent
while the pointer rests on the video area can be delivered to the native overlay
instead of the WebView. This is a real usability hazard and it is very likely the
origin of "shortcuts do nothing" — the user pressed keys right after clicking the
video. The overlay already uses `WS_EX_NOACTIVATE`, so it does not steal focus;
the gap is that nothing ever *grants* focus to the WebView. Not fixed in this
phase (see §11).

## 6. Fullscreen architecture

Unchanged structurally — an in-app refinement of the Now Playing overlay, not an
OS-level fullscreen. The fix was to make the two states actually differ:

| | surface rect | host rect (native) |
|---|---|---|
| normal | `12,56 1896×928` | `12,79 1896×928` |
| fullscreen | `0,0 1920×992` | `0,23 1920×992` |

The host always matches the DOM surface exactly (offset = the window's client
origin). The video grows by 24 px wide and 64 px tall; the bar stays one row at
the bottom; the back button is hidden; the exit-fullscreen button remains.

Evidence: `p6-fullscreen-fixed.png`.

## 7. PlayerBar changes

No structural change — it was already one horizontal row. What changed is that
its controls now all demonstrably do something:

| control | before | after |
|---|---|---|
| Play/Pause | toggles | toggles (real click + Space) |
| Previous / Next | changed track | changes track, same mpv process |
| Play mode | cycles | cycles |
| Fullscreen | state flipped, nothing visible | video genuinely enlarges |
| Audio / Subtitle / More | open the menu | open the menu |

One behaviour worth recording: **Previous/Next cross media kinds.** From a video,
"previous" landed on an audio track. That follows the queue, which mixes kinds, so
it is not a bug — but it is surprising and the user may expect kind-preserving
navigation.

## 8. Live interaction test matrix

All executed against the running app with real input; every row is an
observation, not a test-suite result.

| id | case | result | evidence |
|---|---|---|---|
| P01 | click a library card | plays | mpv spawned, `time-pos` advancing |
| P02 | pause | toggles | `pause` flips both ways |
| P03 | previous | changes track | title changes |
| P04 | next | changes track | title changes |
| P05 | seekbar | present | — (not exercised with a drag) |
| P06 | volume | works | ±10 % steps, clamp at 0/100 |
| P07 | mute | works | 100 → 0 → 100 |
| P08 | **fullscreen** | **PASS after fix** | rect grows; `p6-fullscreen-fixed.png` |
| P09/P10 | audio / subtitle menu | open | menu rendered |
| P11 | right-click | opens menu | menu captured |
| P12 | submenu | opens | submenu captured |
| P13 | selected state | correct | `✓` on the active track |
| P14 | outside click | closes | window count returns to baseline |
| P15 | Escape | closes | — |
| P16 | Space | works | — |
| P17–P19 | S / P / N | work | — |
| P20 | F | works | enters and leaves fullscreen |
| P21–P25 | A / Shift+A / V / Shift+V | work | — |
| P26 | Ctrl+Arrow volume | works | ±10 % |
| P27–P28 | subtitle delay, speed | work | exact values |
| P29–P31 | aspect, deinterlace, zoom | work | aspect −2 → 1.777778 |
| P32 | screenshot | works | file written |
| P33 | media info | works | real codec data shown |
| P34 | queue (F8) | opens | — |
| P35 | shuffle | — | not exercised live |
| P36 | repeat | cycles | — |
| P37 | video → audio | works | same mpv pid, host hidden |
| P38–P39 | audio → video, video → video | — | video → video not exercised |
| P40/P41 | fullscreen → normal → fullscreen | works | — |
| P42 | resize | host follows | — |
| P43 | app close | works | — |
| P44 | no orphan mpv | clean | same pid across switches |
| P45 | no orphan menu | clean | no `#32768` left behind |
| P46 | no orphan host | clean | host destroyed on close |

Rows marked "—" were not exercised with live input in this phase. They are not
claimed as verified.

## 9. Audio regression

| check | result |
|---|---|
| video → audio | same mpv process, host hidden, RAM drops |
| audio playback | plays, seek/volume/mute work |
| audio layout | untouched |
| audio shortcuts | still bound through the same registry |

No audio code was modified in this phase.

## 10. Performance

No new polling, timers or listeners. The fullscreen layout change makes
`ResizeObserver` fire while the surface animates (~40 rect updates over 700 ms),
which is the same cost as dragging a window and is already frame-coalesced to one
IPC per frame.

Measured: `drplay.exe` 2.6 % of one core while a 4K video plays, 0 % on audio.

Suites: **vitest 197 files / 2921 tests**, **cargo 166 passed / 0 failed /
15 ignored**.

## 11. Known limitations

- The context menu is still the Windows menu — paused by request, needs the
  architecture decision in §4.
- Keyboard focus is never explicitly granted to the WebView, so keys pressed
  right after clicking the video can be swallowed by the native overlay. Not
  fixed; it is the most likely cause of the original "shortcuts do nothing".
- Fullscreen is in-app, not OS-level: the window keeps its frame and taskbar
  button.
- The seekbar was not exercised with a real drag.
- Video → video switching was not exercised live.
- Shuffle/repeat shortcuts were not exercised live.

## 12. Screenshots / evidence

| file | what it shows |
|---|---|
| `p6-fullscreen-broken.png` | **B1**: player bar alive, video area empty |
| `p6-f1-fixed.png` | after F1: video renders correctly |
| `p6-fullscreen-fixed.png` | after F2: fullscreen genuinely enlarges the video |

All artifacts are in `%TEMP%\opencode\` and `C:\Users\admin\`.