================================================================================
ARCHITECTURE DECISION — embedding mpv video INSIDE the DrPlay window
Date: 2026-10-07  |  Repo: E:\drplay
================================================================================

--------------------------------------------------------------------------------
CHOSEN ARCHITECTURE
--------------------------------------------------------------------------------
Option B+ — "native child HWND video host inside the Tauri main window"

  1. Rust creates ONE native Win32 CHILD window (WS_CHILD) whose parent is the
     Tauri main window HWND. It is created lazily and hidden by default.
  2. mpv is spawned with `--wid=<that child hwnd>`, so mpv decodes and paints
     into that child instead of creating any top-level window. There is still
     exactly ONE mpv.exe and it is still job-pinned exactly as today.
  3. The video host is positioned over the "player area" of the EXISTING
     NowPlayingView (the square that currently holds cover art). Its rect is
     driven from React.
  4. DrPlay's existing controls (NowPlayingControls + SeekBar + title/artist)
     stay in their current position — BELOW the video rect, exactly as they
     already sit below the cover-art square.
  5. mpv's own UI is disabled (no OSC, no pseudo-gui menu, no input cursor).

--------------------------------------------------------------------------------
WHY
--------------------------------------------------------------------------------
1. UX / single window — satisfies the hard requirement. No popup, no second
   window, no taskbar entry. Video appears inside the DrPlay window, in the
   place the app already reserves for the "now playing" artwork, with the same
   gradient backdrop, same rounded corners, same typography.

2. Z-ORDER SOLVED BY CONSTRUCTION, not by a workaround. A native child HWND
   always paints above the WebView2 surface, so React can never draw on top of
   it. The honest fix is therefore to make sure no React control ever overlaps
   the video rect. NowPlayingView already lays out as
        [ player area ]   <- cover art today, video host now
        [ title / artist ]
        [ NowPlayingControls ]
        [ SeekBar ]
   so the controls are structurally OUTSIDE the video rect. Nothing is hidden,
   nothing fades, no "controls disappear while playing" compromise. The app
   never had overlay controls on the artwork, so this matches the app's own
   established design language rather than inventing a new one.

3. Stability — proven, not assumed. The shipped mpv 0.41.0 was run against a
   real native child HWND on this machine:
        Setting option 'wid' = '918992'
        [vd] Opening decoder h264
        VO: [gpu-next] 640x360 yuv420p
        libplacebo shaderc compile status 'success'
        135 distinct colours sampled in the video area (a real frame)
   Embedding works with the shipped binary and needs no new dependency —
   mpv already has `--wid`.

4. Compatibility with the existing mpv integration — high. mpv stays
   out-of-process, keeps its named-pipe IPC, keeps the Job Object, keeps
   `--no-config`/`--load-scripts=no`. Only one spawn flag is added. No change
   to the stream proxy, the Drive URL flow, the auth path, or the token
   handling: video still loads `http://127.0.0.1:{port}/stream/{fileId}`.

5. Complexity — lowest of the options that actually satisfies z-order.
   - Option A (`--wid` = the WebView2/Tauri HWND) is rejected outright: mpv
     would paint over the entire UI.
   - Option C (libmpv render API into the WebView) would require a second mpv
     instance, a wasm/native bridge, per-frame copies into the DOM, and would
     cost CPU on a machine class this app explicitly targets. It buys
     overlay-controls capability that this app's design does not use.

6. Lifecycle — mpv is spawned once, the same as today. Switching
   audio <-> video does not respawn: the `video` property already exists from
   the previous phase, and for video we simply make sure the host window is
   visible before the loadfile. That preserves the existing load-deadline /
   stall-recovery machinery.

7. Performance — no per-frame copy. mpv paints D3D11 straight into the child
   HWND. This is strictly cheaper than blitting frames through the DOM, and it
   removes the separate mpv top-level window's compositor work.

--------------------------------------------------------------------------------
OPTIONS CONSIDERED AND REJECTED
--------------------------------------------------------------------------------
 A. --wid = WebView2 / Tauri main HWND
    REJECTED: mpv would paint over the whole UI; the app becomes unusable.

 B'. Keep mpv's top-level window and just position it over the player area
    REJECTED: the DrPlay window's own client area is opaque (WebView2 fills
    it), so a top-level mpv window can never be seen; putting it behind is
    useless and putting it in front violates the "one window" requirement.
    This is what we have today and it is exactly the problem to remove.

 C. libmpv render API / frame blitting into the DOM
    REJECTED for this phase: a second mpv instance plus per-frame copies, on a
    weak-machine target, to obtain overlay controls the app's current layout
    does not use. Revisit only if hover-overlay controls become a requirement.

 D. HTML <video> pointing at the proxy
    REJECTED: (a) Chromium/WebView2 cannot demux MKV at all, and MKV is a
    first-class requirement here; (b) the production CSP deliberately does not
    allow http://127.0.0.1 in media-src, so it would need a CSP weakening.
    mpv remains the decoder, which is also why MKV/HEVC keep working.

--------------------------------------------------------------------------------
KNOWN CONSEQUENCES ACCEPTED (documented, not hidden)
--------------------------------------------------------------------------------
 * Native child HWND content cannot be blurred or clipped by CSS. The app's
   shell already goes `blur-xl` behind a modal; the host must therefore be
   hidden whenever a full-screen modal covers the shell (login, folder
   selection). Since the video host only exists inside the NowPlaying overlay,
   this is a small, explicit rule.
 * Any React element that WOULD overlap the video rect (a toast, a tooltip,
   a dropdown) will be painted over by the host. The implementation must keep
   those out of the player area, or hide the host while they are open.
   A bottom-anchored toast is safe (it cannot reach the player area).
 * Border-radius cannot be applied to the native host. The host is sized to the
   video rect; the visual rounding comes from the surrounding layout and, if
   needed later, from an mpv-side border option — not from CSS.

--------------------------------------------------------------------------------
SCOPE OF CHANGE
--------------------------------------------------------------------------------
Rust:   a new small module for the child HWND + 3 commands; one added mpv
        spawn flag; suppress mpv's own UI.
React:  a VideoSurface component in the NowPlaying player area; a rect
        synchroniser (ResizeObserver + window resize + DPI change); hide/show
        driven by media kind and overlay state.
Untouched: stream_proxy, auth, token handling, Drive URL flow, PlayerBar,
          SeekBar, NowPlayingControls, Dexie schema, audio pipeline.
================================================================================