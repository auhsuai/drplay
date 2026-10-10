# VIDEO LIBMPV MIGRATION — EXECUTION PLAN (Phase 10)

Repo: E:\drplay | Date: 2026-10-08 | Source of truth: user spec (62 sections) + this plan.

## Task classification

FEATURE / ARCHITECTURE MIGRATION (new renderer architecture replacing `mpv.exe --wid` HWND embedding).
Orchestrator+subagent model per AGENTS.md. Main Agent = plan/dispatch/review/verify only.

## Verified facts (reconnaissance 2026-10-08, evidence-based)

| # | Fact | Evidence |
|---|------|----------|
| F1 | Bundled player = mpv v0.41.0-1042-g7e4cb538a (built 2026-09-10, shinchiro-style msvc build), libplacebo v7.371.0, FFmpeg N-126492 | `mpv.exe --version` |
| F2 | Exact revision render.h exposes ONLY `MPV_RENDER_API_TYPE_OPENGL` + `_SW` (no D3D11 API) | raw.githubusercontent.com/mpv-player/mpv/7e4cb538a/include/mpv/render.h |
| F3 | Stack: Tauri 2.11.3, wry 0.55.1, tao 0.35.3, webview2-com 0.38.2, windows 0.61 | Cargo.lock |
| F4 | wry 0.55.1 = windowed WebView2 only (no CompositionController). Child HWND class WRY_WEBVIEW. wry `with_transparent` → `ICoreWebView2Controller2::put_DefaultBackgroundColor(0,0,0,0)` | wry source (registry) |
| F5 | WebView2 windowed transparency IS supported (since 1.0.774.44): "In the case of a transparent DefaultBackgroundColor WebView will render hosting app content as the background" — supported on all platforms except Win7 | MS Learn ICoreWebView2Controller2 |
| F6 | webview2-com-sys 0.38.2 HAS full CompositionController API (CreateCoreWebView2CompositionController, RootVisualTarget, SendMouseInput/SendPointerInput, Cursor) — no SendKeyInput anywhere | bindings.rs grep |
| F7 | Tauri `transparent:true` (window+webview) → tao: DwmEnableBlurBehindWindow(empty region) on top-level + wry webview transparent. `WebviewBuilder::transparent` can also be set webview-only (tauri src/webview/mod.rs:1022) | tao/tauri source |
| F8 | Project already accesses WebView2 COM directly via webview2-com (MemoryUsageTargetLevel) — precedent for runtime controller calls | src-tauri/Cargo.toml comment |
| F9 | Current app: mpv.exe sidecar + named-pipe IPC + Job Object + `--wid` child HWND (video_host.rs 54.8KB, mpv/{handle,ipc,job,process,video_lifecycle}.rs, context_menu.rs) | repo tree |

## THE decisive architectural fork — SPIKE-1 (before any production code)

Path A (lazy, preferred): keep wry windowed WebView2; make ONLY the webview transparent
(runtime `SetDefaultBackgroundColor(0,0,0,0)` or Tauri `transparent` config); put the video
as a **DirectComposition GPU visual on the main window, BELOW the WebView2 child HWND**;
libmpv renders via OpenGL render API into GL FBO → WGL_NV_DX_interop2 → D3D11 texture →
IDCompositionSurface → visual. DWM composites: [window bg] < [video visual] < [webview (transparent page)].
React elements paint over video because they are HTML in the top layer.
NO wry fork, NO composition controller, NO input forwarding, NO native video HWND.

Path B (fallback): if SPIKE-1 shows DComp visual does NOT show through the transparent webview child:
fork/vendor wry → CompositionController visual hosting (video visual + webview visual in one DComp tree),
input forwarding (SendMouseInput/PointerInput; keyboard per MS: WebView2 gets keyboard directly), etc.
Substantially larger; only if Path A fails.

SPIKE-1 = standalone temp-dir Rust app: opaque window + DComp red/green visual + WebView2 child
(transparent bg, page transparent) + desktop-screenshot pixel evidence + resize test.
Variant A1: opaque top-level. Variant A2: tao-style DwmEnableBlurBehindWindow. PASS/FAIL per variant.

## Render bridge (identical in both paths)

libmpv OpenGL render API (F2) on a render thread:
- own WGL context (hidden anchor window) + GL FBO/RGBA texture
- `mpv_render_context_create(OPENGL)` + update callback → condvar (no rendering in callback)
- render: `mpv_render_context_update()` → `render(OPENGL_FBO)` → `report_swap()`
- GL texture ⇄ D3D11 texture via `WGL_NV_DX_interop2` (NVIDIA GTX1050 = target; non-NVIDIA → software-render fallback path, documented)
- D3D11 `CopyResource` into `IDCompositionSurface` (BeginDraw/EndDraw) → visual on main HWND → `Commit`
- hwdec: verify what `hwdec=auto-safe` selects under GL render API (nvdec/cuda GL interop expected on GTX1050); MUST verify H264/HEVC8/HEVC-Main10 hardware decode empirically (spec §20)

## Execution order (spec §51)

0. [NOW] Audits A1/A2/A3 + SPIKE-1 (parallel) → Main Agent cross-verify → ADR (VIDEO-RENDER-ARCHITECTURE-ADR.md)
1. Engine slice: libmpv FFI + lifecycle + event thread + property mapping (ENGINE-001..007, 021..024 headless)
2. Render slice: render thread + GL + interop + DComp surface; real frame on screen (1080p → 4K → HEVC → Main10, hwdec evidence)
3. Composition slice: webview transparency wiring + React player area transparent + PlayerBar/menu-over-video proof (playwright + screenshots)
4. Command/event/state migration (existing facade contract preserved), Drive streaming through libmpv, fullscreen/resize/DPI
5. Old path removal: video_host.rs, --wid, IPC, Job Object, context_menu native, probes; regression suite; reports

## Guardrails

- No production code by Main Agent; every slice = 1 subagent dispatch with TDD + RED→GREEN evidence + MCP research rules.
- No change to stream proxy / auth / Drive byte flow (spec §4, §19).
- ONE final renderer; old path removal only after new path proven (spec §54).
- Licensing: shinchiro libmpv = GPL build → linking libmpv = combined work (≠ current aggregation of mpv.exe).
  MUST be documented in ADR; LGPL path (`-Dgpl=false` build) documented as alternative if proprietary distribution required.
- Diagnostics/probes must not survive into production (spec §40-41).

## UPDATE 2026-10-08 — SPIKE RESULTS CONFIRMED (architecture frozen)

- Path A CONFIRMED with `CreateTargetForHwnd(hwnd, topmost=FALSE)`: DComp video visual sits
  between window layer and WebView2 child HWND; transparent page pixels composite pixel-exact
  over it; LIVE at 30fps (13 color transitions at 500ms cadence + moving bar through
  transparent pixels); resize-safe; **55 runs / 3552 valid samples / ZERO true transparency
  failures** after fixing a measurement artifact (occluding windows were sampled; ownership-
  gated sampling is now the rule). topmost=TRUE hides the webview (rejected). Blur-behind not
  needed. Webview transparency wiring = pre-creation `ICoreWebView2ControllerOptions3`
  background {0,0,0,0} = Tauri config `backgroundColor: [0,0,0,0]` (window stays opaque).
- hwdec CONFIRMED: under `--gpu-api=opengl`, `hwdec=auto-safe` → **nvdec (CUDA-GL interop)**
  for H264/HEVC8/Main10 on the GTX 1050 (real media). d3d11va unavailable under OpenGL.
- libmpv adopted: `mpv-dev-x86_64-20260920-git-e76a35ec95.7z` (v0.41.0-1050-ge76a35ec9;
  closest to bundled 1042; API 2.5 identical), libmpv-2.dll SHA256
  `63E1FBB4EE890D153A9F5086410157174EE18582846BF35F6CC4E5D08D4BB662`, loads, exports render API.
- LICENSING: shinchiro libmpv = GPLv2+ ⇒ in-process link = combined work (posture change vs
  current sidecar aggregation). Migration proceeds with GPL libmpv; **LGPL self-build
  (-Dgpl=false; hwdec unaffected, verified) required before any proprietary distribution**.
  Flagged to user 2026-10-08.
- dll placement: `src-tauri/bin/libmpv-2.dll` (committed; resolved like resolve_mpv_exe).

## FROZEN INTERFACE CONTRACT (migration must not break the frontend)

Wire names stay identical (frontend `src/lib/mpvProtocol.ts` TAURI_COMMANDS):
- Commands: `mpv_spawn` → `{conn}`; `mpv_command(cmd: Vec<String>)` → `{data, load_epoch}`;
  `mpv_get_property(prop)` → value; `mpv_shutdown` → `()`. `video_host_acquire/set_rect/
  set_visible` stay registered (in libmpv mode: no-op — acquire returns 0 — until S3 rewires
  them to the DComp surface rect; must never create/show any HWND).
- Events: `mpv-property {name,data,epoch,conn}`; `mpv-event {event,reason,error,epoch,conn}`
  (incl. synthetic `ipc-closed` ONLY on un-commanded engine failure/teardown);
  `stream-proxy-error`, `video-context-menu`, `media-control` unchanged.
- Observed properties: `time-pos, duration, pause, paused-for-cache, demuxer-cache-state`.
- `conn` = process-wide monotonic per engine instance; `epoch` bumped exactly once per
  loadfile reply, attached to every emitted event (same race rules as mpv/ipc.rs:144-163).
- Engine selection during migration: env `DRPLAY_PLAYER_ENGINE=libmpv` routes the four
  mpv_* commands to the in-process engine; default = legacy sidecar until cutover.
- `end-file` reason/error mapping must match mpv/ipc/wire.rs:41-47 (file_error preferred).

## SLICE MAP (execution order)

- S1 ENGINE CORE: libmpv FFI + loader + engine lifecycle + event thread + wire mapping +
  dispatcher. NO render context yet (`vo=null` migration-only, NO window ever).
  Tests: ENGINE-001/006/007/015/021/024 + wire unit tests (epoch/conn/end-file) + real
  playback smoke (generated WAV: load/pause/seek/stop).
- S2 RENDER CORE: GL anchor window + WGL + FBO + mpv_render_context + update callback +
  render thread + report_swap (renders into FBO, headless). Verify hwdec inside render ctx.
- S3 COMPOSITION: NV_DX_interop2 + D3D11 + IDCompositionSurface + visual (topmost=FALSE)
  on main HWND + rect/visibility/DPI + resize. First real video visible in-app.
- S4 FRONTEND PLUMBING: webview transparency config + player area CSS transparent +
  PlayerBar-over-video proof (playwright + screenshots). NO visual redesign.
- S5 COMMAND/STATE PARITY: full command set, Drive streaming E2E, error classification,
  recovery semantics (load deadline/restart), hwdec evidence 1080p/4K/HEVC/Main10.
- S6 FULLSCREEN/RESIZE/DPI + React right-click/More menus (delete native menu for video).
- S7 OLD PATH REMOVAL: video_host.rs, mpv/{ipc,job,process,handle,video_lifecycle},
  context_menu.rs (video), sidecar packaging (mpv.exe, externalBin, fetch script), probes,
  dead wiring (streamUrl, loadNonce), port/rewrite HWND-dependent tests, reports, regression.

## TEST/VERIFY NOTES

- Baseline: working tree is intentionally dirty (Phase 8/9 uncommitted state) — do NOT commit,
  do NOT create worktrees; slices run sequentially on this tree (single writer).
- No window may EVER appear during engine tests (user-facing requirement): engine dev mode
  `vo=null`, tests use generated WAV; render/video verification only in S3+ behind explicit
  dev runs coordinated with the user.
- Test-media fixtures: `drplay-bench\fixtures` + real Drive path for S5; generated WAV for S1.
