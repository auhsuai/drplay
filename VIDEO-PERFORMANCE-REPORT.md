# VIDEO-PERFORMANCE-REPORT.md

Phase: hardware-decode / performance. Date: 2026-10-07.
Machine under test: **Intel Core i5-3570 (4C/4T @ 3.40 GHz)**, **Intel HD Graphics
(Ivy Bridge GT1, DeviceID 8086:0152)**, driver **10.18.10.4252 (2015)**, Windows 10 Pro
19045, single monitor. mpv **v0.41.0-1042-g7e4cb538a** (libplacebo 7.371, FFmpeg
N-126492), `--vo=gpu-next,gpu` (d3d11 context, FL 11_0) — the shipped sidecar and the
shipped flag set.

**CPU figures are % of ONE core** (taskmgr shows ~1/4 of these on this 4-core machine).

The two questions this phase had to answer:

> **"Video đang lag vì nguyên nhân gì?"**
> ▶ **Decoder bottleneck.** The lagging file is 4K **HEVC**, and this GPU has **no HEVC
> decoder at all** (exact driver failure below). Software HEVC decode saturates ~1 full
> core and presents only **~18.8 of 25 fps** — the picture chops while audio (the master
> clock) stays smooth. The UI/IPC/network legs are measurably idle.

> **"Configuration nào cho trải nghiệm tốt nhất trên máy hiện tại mà vẫn fallback an toàn?"**
> ▶ **`--hwdec=auto-safe`** (shipped in this phase). H.264 → d3d11va engages, CPU drops
> 5–19×; every unsupported codec/GPU falls back to software automatically, verified on
> the real Drive file. 4K HEVC on this machine stays software — a hardware limitation,
> not a configuration one (no transcode/resize applied, per policy).

---

# 1. Bottleneck Diagnosis

Layers ruled out with evidence, not assumption:

| candidate | evidence | verdict |
|---|---|---|
| **A. decoder** | 4K HEVC (Drive, real): mpv = **89–106 % of one core**, presented fps **18.4–18.8 / 25**; the same binary presents 4K H.264 at **full fps with 4 % CPU** when d3d11va engages | **← THE bottleneck** |
| B. renderer | 4K H.264 **hardware** path: 3840×2160 → window at **4.0–4.9 % CPU, full fps, 0 drops** → the iGPU scales/composites 4K cheaply | ruled out |
| C. WebView/UI/debug/CDP | drplay.exe measured **2.6 % of one core** with video playing (prior phase) and **0 %** with audio playing (this phase, CDP + debug build + Vite all active); WorkingSet 40 MB | ruled out |
| D. IPC | property polling + seek over the existing pipe: seek→900 s acknowledged and completed in **116 ms**; no timeouts; no respawn | ruled out |
| E. network/transport | Drive stream via local proxy: cache-speed **0.3–6.1 MB/s** vs ~1 MB/s bitrate, no underrun stalls, seek re-fetch fine | ruled out |

Decoder sub-bottleneck, isolated further: the HEVC **software decoder** itself is the
cost. Proof: identical file, identical VO, only the decode path changes —
H.264 4K software 76–86 % CPU vs H.264 4K d3d11va 4–11 %; and this GPU's driver
refuses HEVC hardware init (see §3), so HEVC has no cheaper path on this machine.

# 2. Baseline (software decode, hwdec=no)

Local fixture bench — same mpv binary, same VO, same flag set as the app; 8–20 s
steady-state samples, `--vo=gpu-next`, serial runs:

| # | fixture (local) | codec | pix_fmt | res | fps | CPU %/core | WS MB |
|---|---|---|---|---|---|---|---|
| A | Mushoku B-Global 2160p (1.7 GB) | H.264 | yuv420p (8-bit) | 3840×2160 | 23.976 | **76.4** (20 s) – **86.1** (8 s) | 561–586 |
| A2 | Mushoku ToonsHub 2160p x264 | H.264 | yuv420p (8-bit) | 3840×2160 | 23.976 | **78.1** | 544 |
| B | [ASW] Mushoku S3-05 1080p HEVC | HEVC Main10 | yuv420p10 (10-bit) | 1920×1080 | 23.976 | **41.6** | 347 |
| C | Chainsmoker.Cat 1080p NF | H.264 | yuv420p (8-bit) | 1920×1080 | 23.976 | **28.4–35.0** | 196–205 |

In-app, real Drive, baseline hwdec=no: **106.4 % / 526 MB** (4K HEVC, §7).

All baseline arms: `decdrop=0`, presented fps = container fps, playback advanced
1.000× real-time. Software decode of **H.264 4K** and **HEVC 1080p** is heavy but
sustains full rate; **HEVC 4K in-app did not fully sustain** (§6).

# 3. Hardware Decode Results

`hwdec=auto-safe` was tried first, then checked for **actual engagement** (never just
"mpv started"):

**H.264 (8-bit) — ENGAGED, working.**
- `hwdec-current = d3d11va`
- log: `[vd] Using hardware decoding (d3d11va).`
- output: `VO: [gpu-next] 3840x2160 d3d11[nv12]` (NV12 = hw frames path)
- gpu-next + d3d11va compatible; the `gpu` fallback in the VO list was never needed.

**HEVC — hardware init FAILS (exact reason), clean software fallback.**
- `[e][ffmpeg] AVHWFramesContext: Could not create the texture (80070057)`
- `[e][vd] Failed to allocate hw frames.`
- `0x80070057` = `E_INVALIDARG`: the driver refuses to create the HEVC decode profile
  texture. This is a **capability** answer, not a bug: Ivy Bridge (2012) silicon has no
  HEVC decode engine — no driver update can add one.
- mpv then proceeds with `[vd] Using software decoding.` — playback continues; in-app
  the whole probe cost ~100 ms with no visible effect, no respawn, no crash.

`auto` (the less-safe list) was not needed: `auto-safe` already selected d3d11va where
the hardware exists, and the HEVC failure is at the D3D11 texture/profile level, which
no hwdec API can bypass on this GPU.

# 4. Codec Matrix

| codec | hw decode on THIS GPU | evidence | software fallback | CPU software → hardware |
|---|---|---|---|---|
| **H.264 8-bit** | **YES** (d3d11va) | `Using hardware decoding (d3d11va)`; `d3d11[nv12]`; 0 drops | n/a | 1080p: 35.0 → **6.8**; 4K: 76–86 → **4.0–4.9** |
| H.264 10-bit (Hi10P) | **NOT TESTED** — no fixture exists on this machine or in the Drive library; Ivy Bridge is expected to lack the High-10 profile (would fall back software) | — | expected | — |
| **HEVC 8-bit** | NO | in-app Drive 4K: driver `80070057` → software | YES, clean | 4K in-app: 89–106 % (software) |
| **HEVC 10-bit** | NO | local `Ma10p` 1080p: same `80070057` → software | YES, clean | 1080p: **41.6** full-rate software |
| AV1 | NO (Ivy Bridge predates AV1; not exercised in-app) | — | expected (mpv software, as before) | — |
| VP9 | NO | — | — | — |

Unsupported codecs falling back to software is **expected behaviour**, not an app bug.
Nothing in the app special-cases codecs — mpv's own per-codec probe decides.

# 5. CPU / RAM A–B

Same file, same segment, one variable (hwdec), serial runs:

| fixture | hwdec | CPU %/core | Δ | WS MB | presented fps | decdrop |
|---|---|---|---|---|---|---|
| 1080p H.264 | no | 35.0 | — | 205 | 23.976 | 0 |
| 1080p H.264 | auto-safe | **6.8** | **−80 %** | 257 | 23.976 | 0 |
| 4K H.264 | no | 76.4–86.1 | — | 561–586 | 23.976 | 0 |
| 4K H.264 | auto-safe | **4.0–4.9** | **−94 %** | 680–725 | 23.976 | 0 |
| 1080p HEVC10 | no | 41.6 | — | 347 | 23.976 | 0 |
| 1080p HEVC10 | auto-safe | 39.8 (fallback) | ≈0 | 330 | 23.976 | 0 |
| Drive 4K HEVC | no | 106.4 | — | 526 | 25 | 0 |
| Drive 4K HEVC | auto-safe | 89.1 (fallback) | ≈0 | 537 | 25 | 0 |

RAM: hardware decode adds ~80–160 MB at 4K (NV12 frame pool) but **does not track file
size** (the 17 MB probe file and the 1.7 GB file behave the same); peak observed
722–733 MB at 4K. No abnormal growth over 20 s samples.

# 6. Frame Stability

- **Hardware arms (H.264, 1080p + 4K)**: `estimated-vf-fps` = container fps
  (23.976), `decoder-frame-drop-count = 0`, time-pos advance = wall clock (1.000×)
  over 20 s windows → smooth.
- **1080p HEVC 10-bit software**: full rate (23.976), 0 decoder drops.
- **4K HEVC in-app (software)** — the lag, quantified: `estimated-vf-fps` settled at
  **18.38 → 18.75** against a **25 fps** container (`Video --vid=1 (hevc [Main]
  3840x1632 25 fps)`), stable over repeated samples, while time-pos advanced exactly
  real-time (audio-driven clock). ⇒ **~25 % of video frames are not presented**:
  choppy picture, smooth audio. `decoder-frame-drop-count` stays 0 because the drop
  happens at the VO/video-sync level (gpu-next does not expose `drop-frame-count`).
- **After seek** (900 s, in-app): `decdrop=0`; a few `Invalid video timestamp` /
  `Non monotonically increasing PTS` warnings appear briefly post-seek — pre-existing
  gpu-next/demuxer behaviour on this file, in the **HEVC software** path, unrelated to
  hardware decode (the flag was in fallback at that moment). No corruption, no stall.

# 7. Real Drive Results

Real account, real Google Drive stream through the unchanged local proxy:

| check | result |
|---|---|
| File identity correction | **"Renegade Immortal 089" is HEVC Main 8-bit, 3840×1632 @ 25 fps, 22:09** — the earlier report's "4K H.264 10-bit" was wrong. Source: app mpv.log `Video --vid=1 (hevc [Main] 3840x1632 25 fps)`. The Drive library contains **no H.264 video at all** (2× HEVC + 1× AV1). |
| Transport with flag | unchanged: cache-speed 0.3–6.1 MB/s vs ~1 MB/s bitrate; no underruns; no respawn |
| hwdec at spawn | spawn log: `25 flags` (was 24) — `--hwdec=auto-safe` live |
| hwdec result on this file | `hwdec-current = no` → clean software fallback (HEVC, as this GPU requires) |
| playback | real-time (915.56 → 921.72 s in 6 s; 0 decoder drops), no crash, no black/green frame |
| seek with flag | seek → 900 s in **116 ms**, time-pos landed exactly 900.0, playback continued |
| runtime switch (`set_property hwdec auto-safe`) | applied without respawn (same mpv pid; log shows a fresh `Using software decoding`), seek 116 ms after |
| Conan movie (HEVC 10-bit 1080p) | verified playing in the previous phase; same codec class as local fixture B (full-rate software) |
| AV1 (Black Clover) | **NOT RUN this phase** — hardware impossible on this GPU; the flag does not alter the software AV1 path |

# 8. Audio Regression

- video → audio switch, in-app: **same mpv pid (9988)** — no respawn; audio
  playing (time-pos 5.24 / 312.5 s, advancing); video properties correctly
  `unavailable` (`video=no` per track, by design).
- audio → video path unchanged in code (`video` property per track, set before
  `loadfile`); hardware decode applies to video only — audio-only sessions never open
  a video decoder, so `hwdec` is inert for them.
- Close mid-session: WM_CLOSE → `drplay=0, mpv=0`, host `destroyed` logged, no orphans.
- Volume/mute/queue untouched (no code changed in those paths this phase).

# 9. Recommended Shipping Configuration

**A — ENABLE HWDEC BY DEFAULT, via `--hwdec=auto-safe`. Implemented and verified.**

- `src-tauri/src/mpv/process.rs`: new `MPV_HWDEC = "auto-safe"` const + one flag
  (`--hwdec=auto-safe`), with the measured rationale documented next to it.
- `src-tauri/src/mpv/process/tests.rs`: existing flag-list assertion extended; new
  test `flags_request_hwdec_auto_safe_as_a_soft_policy` (exactly one `--hwdec`,
  value `auto-safe`, both with and without a video host).
- Evidence: subagent RED→GREEN (`missing flag --hwdec=auto-safe` before, pass after);
  Main-agent sanity `cargo test --lib mpv::process` 9 passed / 0 failed; full
  `cargo test` **159 passed / 0 failed / 15 ignored**; live app: 25 flags at spawn,
  fallback clean on the real Drive file, same-pid audio switch, seek 116 ms.

Why not **B (per-codec allow-list in app code)**: `auto-safe` *is already* per-codec —
mpv probes each codec and each GPU at runtime; a hardcoded app-side list would be
exactly the "special-case vô hạn" the brief forbids, and cannot know the driver.

Why not **C (keep software)**: it would leave 5–19× CPU savings on the table for the
most common codec (H.264), for no safety gain — the fallback path is verified.

Safety contract of the shipped shape: hardware init failure → software fallback
(verified in-app); audio unaffected; no respawn caused by switching kinds; no new
configuration surface; no transcoding, no source modification, no transport change.

# 10. Known Hardware Limitations

- This GPU **cannot** hardware-decode: HEVC (8/10-bit), VP9, AV1, H.264 Hi10P.
  Exact HEVC failure: `AVHWFramesContext: Could not create the texture (80070057)`.
- **4K HEVC on this machine is software-only**: ~89–106 % of one core, ~18.8/25 fps
  presented. This cannot be fixed by configuration; per policy the app does **not**
  transcode, resize, or downgrade the source.
- Practical guidance for THIS machine: 4K H.264 now runs at **4–5 %** of one core
  (d3d11va); 1080p HEVC runs full-rate in software (~42 %); 4K HEVC is the only
  painful class.
- H.264 10-bit was **never verified** (no fixture exists on the machine or in the
  Drive library) — expected software fallback, but that is an expectation, not a
  measurement.
- AV1 in-app not exercised this phase; hardware AV1 is impossible on this GPU.
- Multi-monitor / mixed-DPI still not testable on this hardware (carry-over from the
  previous phase).

# Appendix — method & hygiene

- Bench harness: `%TEMP%\opencode\mbench.ps1` — spawns the shipped mpv with the
  app's VO/flags, controls it over a JSON IPC named pipe, samples
  `time-pos / estimated-vf-fps / drop counters / hwdec-current`, measures process
  CPU (TotalProcessorTime delta / wall) and WorkingSet, then kills the process.
  It replaces `--term-status-msg` (silently absent when stdout is not a TTY).
- Every run bounded; `Get-Process drplay,mpv` verified 0 after each stage; no
  orphan window/host at any point.
- In-app measurements used the app's own IPC (`mpv_get_property` / `mpv_command`)
  through the WebView2 CDP console — the same commands the frontend sends.
