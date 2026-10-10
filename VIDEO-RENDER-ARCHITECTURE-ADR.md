# VIDEO RENDER ARCHITECTURE — ADR

Repo: E:\drplay | Date: 2026-10-08 | Status: ACCEPTED (pending user ack of §Licensing)
Supersedes: VIDEO-EMBEDDING-ARCHITECTURE.md (Option B+, 2026-10-07 — rejected here).

## Problem

React controls (PlayerBar, More menu, right-click menu, fullscreen UI) must be able to
render visually ABOVE the video, in ONE compositing system, without native overlay
windows, without a native video window, and without z-order hacks. The current
architecture (mpv.exe sidecar painting into a native child HWND via `--wid`) makes that
impossible by construction: a native child HWND always paints above the WebView2 surface.

## Current Architecture (audited 2026-10-08, file:line evidence in migration plan)

- Rust creates `DrPlayVideoHost` child HWND (`video_host.rs:47,484-520`), frontend syncs a
  physical-pixel rect (`lib/videoHost.ts`), mpv.exe spawned with `--wid={hwnd}`
  (`mpv/process.rs:185-187`), controlled via named-pipe JSON IPC (`mpv/ipc.rs`) and
  pinned with a Job Object (`mpv/job.rs`).
- Native child paints above WebView2 ⇒ the app had to guarantee no React element ever
  overlaps the video rect (`videoHost.ts:157-174`), intercept right-click via a wndproc
  subclass (`video_host.rs:585-624`), re-raise z-order on every move (`:628-632`), and
  force keyboard focus back to the WebView2 (`:382-415`).
- The video input overlay experiments were already deleted (commit deeee90); the
  remaining architecture is still HWND-embedding.

## Why HWND Embedding Is Rejected

1. React can never overlay the video (hard product requirement, spec §5/§38/§62).
2. Every workaround tried or proposed (native overlay HWND, transparent controls HWND,
   popup, z-order pushes, mouse proxies) is explicitly rejected by the phase spec
   (§2/§53) and each one is one more native window in the way of input/composition.
3. Input, focus, and context-menu handling all become hacks around the extra HWND
   (§24-25) instead of normal WebView ownership.

## Candidate Architectures

### A. Windowed WebView2 (transparent page) + DirectComposition video visual below — SELECTED

- Keep wry 0.55.1's normal windowed WebView2 child HWND. Make ONLY the webview background
  transparent (page pixels alpha=0 show what is behind). Keep the top-level window opaque.
- Render libmpv video into a DirectComposition surface on the SAME top-level window with
  `IDCompositionTarget` created via `CreateTargetForHwnd(hwnd, topmost=FALSE)` — the
  non-topmost visual tree renders between the window's own layer (bottom) and child
  windows (WebView2) per Microsoft's documented 4-layer window model.
- DWM composites live, per frame: [window paint] < [video DComp visual] < [WebView2 child
  HWND (page, alpha-aware)] — so React elements paint over video naturally, and video
  updates at full frame rate (verified, see Evidence).
- Input: the WebView2 child still receives ALL mouse/keyboard because it is a normal
  child window covering the client area. React stays the input owner. Zero forwarding
  code. No wry fork, no Tauri fork, no CompositionController.
- Cost: custom render thread (libmpv OpenGL render API → D3D11 → DComp) — required by
  EVERY candidate anyway (the GPU bridge is architecture-independent).

### B. WebView2 CompositionController visual hosting (video visual + webview visual in one DComp tree)

- The "textbook" structure of spec §10. Requires REPLACING wry's webview creation on
  Windows (upstream wry 0.55.1 has no composition mode; verified in source) and
  re-implementing manual input forwarding (SendMouseInput/SendPointerInput, cursor
  events, focus, drag/drop), or vendoring/patching wry + tauri-runtime-wry.
- Keyboard caveat: WebView2 gets keyboard directly from Windows even in visual hosting
  (Microsoft answer on WebView2Feedback#1054), but mouse/pointer/cursor forwarding,
  hit-testing and IME become host responsibilities.
- Rejected for now: far larger risk surface for zero user-visible gain over candidate A;
  kept as the documented fallback if candidate A regresses.

### C. Native HWND video below opaque WebView2 (status quo B+)
Rejected: the root limitation this phase exists to remove.

### D. z-order / overlay / popup / CPU-frame streaming variants
Rejected: explicitly listed as non-solutions (spec §53). No CPU per-frame paths.

## Selected Architecture

Candidate A, with the libmpv bridge:

```
libmpv core (in-process)                    [engine thread: mpv_wait_event → app events]
   │ mpv_render_context (OpenGL render API) [render thread owns GL/D3D11/DComp]
   ▼
GL FBO texture (RGBA/BGRA)
   │ WGL_NV_DX_interop2 (wglDXRegisterObjectNV/LockObjectsNV)
   ▼
D3D11 texture (shared, GPU-only)
   │ ID3D11DeviceContext::CopyResource
   ▼
IDCompositionSurface (BeginDraw/EndDraw, B8G8R8A8)
   │ SetContent on IDCompositionVisual
   ▼
DirectComposition target (CreateTargetForHwnd(hwnd, topmost=FALSE))
   ▼
DWM composites: window layer < VIDEO VISUAL < WebView2 child (transparent page)
   ▼
React UI paints over video (HTML, same window, normal webview input)
```

## Graphics Backend

- libmpv build `v0.41.0-1042-g7e4cb538a` (bundled exe) and the adopted dev package
  `mpv-dev-x86_64-20260920-git-e76a35ec95` (v0.41.0-1050-ge76a35ec9) expose ONLY
  `MPV_RENDER_API_TYPE_OPENGL` and `MPV_RENDER_API_TYPE_SW` in render.h (no D3D backend).
- DECISION: OpenGL render API + WGL context on a dedicated render thread (hidden anchor
  window). Software render API is NOT acceptable for production 4K (per-frame CPU) and
  is only a documented degraded fallback for non-NVIDIA GPUs (see Compatibility Risks).
- hwdec: empirically verified on this machine (GTX 1050, real media) that with
  `--gpu-api=opengl`, `hwdec=auto-safe` selects **nvdec (CUDA-GL interop)** for H264,
  HEVC 8-bit and HEVC Main10 (`cuda[nv12]` / `cuda[p010]` in logs); d3d11va cannot load
  under OpenGL (needs d3d11/ANGLE context). Hardware decode stays NVDEC — no regression
  from today's `--hwdec=auto-safe` (which resolves to d3d11va under d3d11 vo).
  Re-verify inside libmpv render context during Slice S2.

## WebView2 Composition Strategy

- Webview-layer-only transparency via pre-creation `ICoreWebView2ControllerOptions3.
  SetDefaultBackgroundColor({A:0,R:0,G:0,B:0})` — this is exactly what wry does when
  webview `transparent=true`, and reachable from Tauri config `app.windows[0].
  "backgroundColor": [0,0,0,0]` (webview layer only; window stays opaque; tao blur-behind
  originally NOT used). CURRENTLY REVERTED (2026-10-10) together with the libmpv-mode
  experiment below — re-add these config lines when the libmpv mode is picked up again.
- 2026-10-10 UPDATE (restored-window video black — experiment REVERTED, issue parked):
  the "window stays opaque" half of the bullet above stopped being sufficient on
  Evergreen WebView2 runtime 155.0.4283.45 — in restored windows the transparent webview
  hole no longer composes down to the non-topmost DComp video visual
  (maximized/fullscreen kept working; the spike-verified configuration was runtime
  154.0.4258.62). The follow-up `"transparent": true` experiment (tao
  `DwmEnableBlurBehindWindow` empty-region path, guarded by the Rust test
  `the_main_window_keeps_the_dwm_transparent_flag`) was TRIED and did NOT fix the
  windowed-black: the user verified the restored window stayed black. DECISION (user,
  2026-10-10): revert `transparent: true` + `backgroundColor: [0,0,0,0]` back to the
  legacy-known-good window config (guard test deleted), and switch the DEFAULT engine
  back to the legacy mpv.exe sidecar temporarily (`player/mod.rs` `is_libmpv_mode`:
  absent env ⇒ legacy). The in-process libmpv path is kept and selectable with
  `DRPLAY_PLAYER_ENGINE=libmpv` for future work; the windowed-black root cause was never
  found — re-open this section when libmpv mode is revisited (re-verify whenever the
  runtime auto-updates).
- The top-level window keeps its normal opaque painting.
- DComp target: exactly ONE non-topmost target for the main HWND (Microsoft allows at
  most one topmost + one non-topmost per window). Reserve the non-topmost slot.

## libmpv Render API Strategy

- `mpv_render_context_create` with `MPV_RENDER_API_TYPE_OPENGL`,
  `MPV_RENDER_PARAM_OPENGL_INIT_PARAMS{get_proc_address=wglGetProcAddress}`,
  `MPV_RENDER_PARAM_ADVANCED_CONTROL=1` (enables direct rendering; strict threading
  rules honored — see Threading Model).
- `mpv_render_context_set_update_callback` only signals a condvar (never renders, never
  blocks, never calls other libmpv APIs).
- Render thread loop: wait signal → `mpv_render_context_update()` →
  `mpv_render_context_render(MPV_RENDER_PARAM_OPENGL_FBO)` → present (interop copy +
  DComp commit) → `mpv_render_context_report_swap()`. Event-driven; no busy loop.
- NOTE the task spec's claim "no D3D11 backend" is CONFIRMED for this exact revision;
  do not invent constants.

## Threading Model (hard rules)

- ENGINE / EVENT THREAD: owns `mpv_wait_event` loop; converts events to wire events
  (`mpv-property`, `mpv-event` with `epoch`/`conn`), emits to frontend. Runs tests-free.
- RENDER THREAD: owns GL context + FBO/texture + interop + D3D11 + DComp + render
  context. Calls ONLY `mpv_render_*` on its own context (allowed) — never other libmpv
  APIs while rendering.
- UI / TAURI THREAD: Tauri commands; calls normal libmpv API (thread-safe) except during
  render-context teardown (state lock + ownership protocol).
- Destroy order (spec §18/§45): stop playback → signal render thread stop → join render
  thread → `mpv_render_context_free` (on render thread, GL current) → release GL/D3D/DComp
  → `mpv_destroy` → join event thread → drop statics. No render ctx may outlive mpv; no
  mpv destroy while render ctx exists.

## Input Model

- React/WebView2 owns ALL input (mouse, keyboard, wheel, context menu) because the
  webview child window is the top-most input surface in the client area (DComp visuals
  are not windows; they never receive input).
- The old `video_host.rs` wndproc subclass (right-click interception, focus forcing,
  z-order) is deleted with the old path.
- Right-click and the More/Audio/Subtitle menus become React-rendered HTML over the
  video, reusing the existing menu model (`src/player/menuModel.ts`, already
  React-side + test-covered); the native `TrackPopupMenu` path (`context_menu.rs`) is
  removed from the video UI per spec §39/§49.

## Resize / DPI Model

- Video visual rect comes from the existing React rect pipeline (physical px,
  `VideoSurface.tsx` → same rAF/ResizeObserver/DPR machinery).
- DComp visual offsets/scales use DIPs; convert physical→DIP using the window's DPI
  (`GetDpiForWindow/96`). Spike machine is 100% DPI — conversion formula verified during
  S3 on a scaled monitor or with a forced-DPI test.
- Resize never recreates the engine: surface texture + FBO resize on the render thread;
  the WebView2 resizes via wry's existing WM_SIZE subclass. DComp surface must be resized
  with the window (spike evidence: fixed-size surface anchored at client 0,0 stays put —
  real integration resizes it).

## Fullscreen Model

- Fullscreen stays a VIEW state (current React overlay fullscreen, `App.tsx:183-188`) or
  optionally later a real window fullscreen (`tao` window state) — either way it is the
  same DComp surface + same webview; never a native video window. React can show any
  overlay over the video in both modes.

## Cleanup / Lifetime Model

- Engine = in-process singleton (Tauri state), teardown via `mpv_shutdown` command or
  app exit (`ExitRequested`); no process, no Job Object for video, no orphan possible.
- Recovery: no more "process died" events. Engine failures surface as wire events
  (`end-file` with reason/error from real mpv errors; synthetic `ipc-closed` only on
  un-commanded engine failure) — preserves frontend error semantics
  (`network_interrupted` vs `engine_closed`) without fake process-death coverage
  (spec §30-31).

## Performance Risks

- Per-frame GPU cost: mpv GL render + 1× GPU CopyResource (4K ≈ 33 MB/frame ≈ 2 GB/s at
  60 fps — trivial vs GTX 1050 bandwidth) + DComp commit. No CPU readback, no RGBA CPU
  conversion, no per-frame CPU memcpy. Event-driven rendering only.
- WebView2 transparency adds a DWM alpha composite of the webview layer (GPU) — measured
  acceptable in spike (no CPU spikes observed; formal perf comparison in S2/S6, spec §55).
- Cold-start: first WebView2 frame may show a brief warmup artifact (observed once in
  spike); mitigated by pre-creation background color; verify in-app.

## Compatibility Risks

- `WGL_NV_DX_interop2` is NVIDIA-only ⇒ the zero-copy GL→D3D path is NVIDIA-only. Target
  hardware (GTX 1050) is covered; non-NVIDIA machines fall back to the software render
  API (documented, degraded, not production). ANGLE-based d3d11 path possible later if
  ever needed (requires shipping libEGL/libGLESv2).
- Bundled libmpv revision differs from mpv.exe by 8 commits (1042→1050): API version
  identical (2.5); both verified. mpv.exe is removed from the app at the end of the
  migration, so the revision delta is transient.
- WebView2 runtime floor ≥ 1.0.774.44 for alpha background (machine has 154.0.4258.62).
- WebView2 windowed transparency stability: 55 runs / 3552 ownership-gated pixel samples
  showed ZERO true transparency failures (earlier "whiteouts" were a measurement artifact
  — other windows occluding the sampled pixels). The transparency risk is cleared for
  this environment; keep ownership-aware sampling in future harnesses.

## Licensing / Redistribution Considerations

- Current posture: mpv.exe shipped as a separate process (externalBin) = mere aggregation.
- The adopted shinchiro libmpv build is GPLv2+ (`gpl` feature baked into the DLL; FFmpeg
  built --enable-gpl --enable-version3). Linking it in-process = combined work ⇒ the
  distributed app would be covered by GPL. This is a REAL posture change and must not be
  silently adopted (spec §13).
- Verified facts: `-Dgpl=false` (LGPLv2.1+ build mode) disables only cdda/dvbin/dvda/
  dvdnav/jack/oss/caca/direct3d(d3d9)/x11 — **hardware decode, demuxing, HEVC/Main10 are
  NOT affected**. An LGPL libmpv DLL is the escape hatch if DrPlay must stay proprietary.
- DECISION (pending user acknowledgment): use the prebuilt shinchiro GPL libmpv for this
  migration (no public distribution change implied today); MUST self-build
  `-Dgpl=false` (mpv-winbuild-cmake) before any proprietary distribution. Documented in
  the migration report.
- The GPL libmpv DLL is committed next to the (still present) mpv.exe during migration;
  mpv.exe is removed at the end.

## Rejected Alternatives

- wry fork + CompositionController (Candidate B): rejected for now — largest risk/effort,
  no user-visible gain over A; fallback only.
- Native HWND behind opaque webview (status quo): root limitation.
- Transparent native overlay / controls HWND / topmost z-order pushes / popup window:
  forbidden by spec §2/§53 and all fail input ownership.
- CPU frame streaming to `<img>`/canvas, WebCodecs, HTML `<video>`: rejected by spec §53
  and by media pipeline (MKV/HEVC/Drive Range proxy).
- ANGLE/EGL as the render-context provider: libmpv's Windows render path is WGL-based;
  ANGLE is only relevant for hwdec under d3d11 (not our path).

## Evidence Index

- Spike `a3`/`b1` (temp `spike-dcomp-webview`): DComp visual below transparent WebView2 —
  PASS, pixel-exact before/after resize, live 30fps animation through transparent pixels
  (13 color transitions at 500ms cadence + moving bar), zero whiteouts over 55 runs with
  ownership-gated sampling. `CreateTargetForHwnd(topmost=FALSE)` is load-bearing.
- hwdec logs (temp `libmpv-audit`): nvdec under `--gpu-api=opengl` for H264/HEVC8/Main10.
- libmpv dev package: SHA256 `63E1FBB4EE890D153A9F5086410157174EE18582846BF35F6CC4E5D08D4BB662`
  (libmpv-2.dll, v0.41.0-1050-ge76a35ec9), LoadLibrary + render API exports verified.
- wry 0.55.1 source: windowed-only (no CompositionController), webview transparency
  wiring, WM_SIZE subclass.
- Repo audit: current HWND path, wire contract (commands/events/epoch/conn), test
  inventory — see VIDEO-LIBMPV-MIGRATION-PLAN.md.
