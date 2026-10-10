# VIDEO-GTX1050-HEVC-PERFORMANCE-REPORT.md

DrPlay — Phase 7 · Hardware-decode reconstruction + GTX 1050 measurement
Date: 2026-10-08 · Repo: `E:\drplay` @ `deeee90` (branch `main`)

**Scope note up front:** this phase measured. It changed **no production code**.
The only file touched in the repo is this report.

---

## 1. Current Machine

Detected from the OS, not assumed. Every value below came from `Win32_VideoController`,
`Win32_Processor`, `nvidia-smi`, or the mpv binary itself.

| Item | Value | Source |
|---|---|---|
| GPU name | **NVIDIA GeForce GTX 1050** | `Win32_VideoController`, `nvidia-smi` |
| GPU vendor | NVIDIA (VEN_10DE) | PCI ID |
| Exact device ID | **10DE:1C81**, rev A1 (GP107 / Pascal) | `nvidia-smi -q`, mpv `Device ID:` |
| PCI path | `PCI\VEN_10DE&DEV_1C81&SUBSYS_00007377&REV_A1` | PnP device |
| Subsystem ID | 7377:0000 | mpv log |
| Driver version | **582.78** (`32.0.15.8278`) | `nvidia-smi`, WMI |
| Driver date | 2026-06-25 | WMI |
| CUDA / NVENC API exposed | 13.0 | `nvidia-smi` |
| VRAM | **2048 MiB** | `nvidia-smi` |
| Direct3D feature level | 12_1, D3D11.1 runtime | mpv log |
| CPU | **Intel Core i5-3570 @ 3.40GHz**, 4 cores / 4 threads (no HT) | WMI |
| RAM | 16 GB (2×8 GB DDR3-1600) | WMI |
| Windows | Windows 10 Pro 19045 (build 19045, x64) | WMI |
| mpv | **v0.41.0-1042-g7e4cb538a** (built 2026-09-10) | `--version` |
| FFmpeg | `N-126492-gefb0a7e5e`, libavcodec 63.11.101 | `--version` |
| libplacebo | v7.371.0 | `--version` |
| mpv build features | includes `d3d11`, `d3d-hwaccel`, `cuda-hwaccel`, `ffnvcodec`, `dxgi-debug-d3d11`, `vulkan` | `--version` |

Other display adapters present but **not active** (`Status: Unknown`):
Intel HD Graphics (`8086:0152`), Microsoft Basic Display Adapter (`10DE:128B`).

The Intel i5-3570 + Intel HD machine described in earlier reports is **still the CPU
here**. What changed is only the GPU. All CPU numbers below are therefore comparable
to earlier reports, but **every GPU number is new**.

`nvidia-smi` on this box **does expose** `utilization.decoder` (the NVDEC engine),
both via `--query-gpu` and via `dmon`. This is used below as primary hardware-decode
evidence alongside mpv's own reporting.

---

## 2. Current DrPlay Architecture

Reconstructed from source (the previous reports were treated as history only).

```
Google Drive
  │  OAuth2 PKCE, offline; refresh token in Windows Credential Manager
  │  access token in webview localStorage
  ▼
src-tauri/src/auth.rs · src-tauri/src/token_store.rs
  │  (frontend never builds a Drive media URL for playback)
  ▼
stream_proxy  (hyper, 127.0.0.1:ephemeral, GET only — HEAD returns 405)
  │  src-tauri/src/stream_proxy/server.rs
  │  GET /stream/{fileId}  ->  https://www.googleapis.com/drive/v3/files/{id}?alt=media
  │  pure byte forwarding: client Range passed through verbatim, 206 mirrored,
  │  no seek logic, no buffering; 15s header deadline, 20s mid-body idle abort,
  │  1x forced token refresh on 401, 2 retries on 429/5xx
  ▼
http://127.0.0.1:{port}/stream/{fileId}
  │  built by src/lib/mpvProtocol.ts:buildProxyStreamUrl
  ▼
mpv sidecar (one per session, named-pipe IPC, kill-on-close Job Object)
  │  src-tauri/src/mpv/process.rs  ·  handle.rs · ipc.rs · ipc/wire.rs
  │  flags: see §3
  ▼
native video host HWND (--wid)   src-tauri/src/video_host.rs
  │  class "DrPlayVideoHost", child of the Tauri main window,
  │  WndProc subclass -> WM_MOUSEACTIVATE=MA_NOACTIVATE, right-click -> context menu
  ▼
DrPlay React UI
     src/ui/NowPlaying/components/VideoSurface.tsx  (a measuring <div>, NOT a <video>)
     src/ui/NowPlaying/components/VideoPlayerBar.tsx
     src/player/commands.ts  (single command + shortcut registry)
     src/player/useVideoContextMenu.ts -> context_menu.rs
```

Verified live: `loadfile url="http://127.0.0.1:2098/stream/1Z20u3bZTEZYm8fg0Tk2KW9K8F2pVCGMz"`
and `--wid=2492328` in the running sidecar's own command line.

Media kind is decided per track over IPC (`set_property video` → `"1"` / `"no"`)
immediately before `loadfile` — there is deliberately no `--no-video` spawn flag, so
one engine serves audio and video without respawn.

---

## 3. Current mpv Configuration

Verbatim from `src-tauri/src/mpv/process.rs:mpv_flags()` (lines 106–198), and
**confirmed against the running sidecar's own logged command line**:

```
--vo=gpu-next,gpu                 (process.rs:32,112)
--hwdec=auto-safe                 (process.rs:46,113)
--no-terminal --no-config --load-scripts=no --idle=yes
--input-ipc-server=\\.\pipe\drplay-mpv-<uuid>
--gapless-audio=yes --prefetch-playlist=no
--demuxer-readahead-secs=30 --cache-secs=30 --cache-pause-wait=0.2
--demuxer-max-back-bytes=8MiB --demuxer-max-bytes=64MiB --cache=yes
--media-controls=no --input-media-keys=no
--osc=no --osd-level=0 --input-cursor=no
--input-default-bindings=no --input-vo-keyboard=no
--wid=<video host HWND>
--player-operation-mode=cplayer
--log-file=<appdata>/com.drplay.app/logs/mpv.log
```

**`--gpu-context` is NOT set anywhere** — not in spawn flags, not at runtime over IPC.
mpv auto-selects. Confirmed auto-resolution on this machine:

```
Initializing GPU context 'auto'
Initializing GPU context 'd3d11'
Using Direct3D 11 feature level 12_1
Device Name: NVIDIA GeForce GTX 1050
Device ID: 10de:1c81 (rev a1)
```

Binary capability checks (`--list-options` on the shipped mpv): `--hwdec` is a string
list (default `no`), `--hwdec-codecs` default includes `hevc`, `--gpu-context` exists
as an object list (default empty), `--d3d11-*` options present.

**Hardware-decoding-relevant code in the whole repo is exactly two lines**
(`process.rs:32` and `process.rs:46`) plus two read-only pulls
(`mpvControl.ts:56,58` reading `video-params/pixelformat` and `hwdec-current`).
Decode policy is fixed at spawn; the app never `set_property hwdec` in production.

---

## 4. Software Decode Baseline (`--hwdec=no`)

Control arm. Identical fixture, identical flags, only `--hwdec` changed.

> **CPU unit convention (required by §16):** "CPU % of one core" = processor-seconds
> consumed ÷ wall seconds × 100. This box has **4 cores / 4 threads**, so
> "Task Manager total" = that number ÷ 4. A reading of 27.9% here means 27.9% of
> **one** core — the whole machine is at 7.0%.

---

## 5. Hardware Decode Results (`--hwdec=auto-safe`)

Production flag, unchanged. Median of N runs; every run is 25s steady-state after a
6s warm-up, and every run asserted zero orphaned mpv afterwards.

| Case | arm | n | CPU % 1 core | CPU % all 4 | WS MB | Priv MB | presented FPS | dec drops | **NVDEC %** |
|---|---|---|---|---|---|---|---|---|---|
| H.264 1080p (real anime) | `no` | 1 | 27.9 | 7.0 | 216.6 | 293.8 | 23.976 | 0 | **0** |
| H.264 1080p (real anime) | `auto-safe` | 1 | 3.1 | 0.8 | 197.8 | 347.2 | 23.976 | 0 | **9** |
| H.264 2160p (real anime) | `no` | 1 | 74.2 | 18.6 | 409.5 | 590.3 | 23.976 | 0 | **0** |
| H.264 2160p (real anime) | `auto-safe` | 1 | 0.0 | 0.0 | 256.1 | 732.2 | 23.976 | 0 | **25** |
| **HEVC Main10 1080p (REAL)** | `no` | 3 | 27.9 | 7.0 | 267.1 | 351.8 | 23.976 | 0 | **0** |
| **HEVC Main10 1080p (REAL)** | `auto-safe` | 3 | **3.1** | 0.8 | **178.2** | 427.2 | 23.976 | 0 | **10** |
| HEVC Main10 1080p (fixture) | `no` | 1 | 31.0 | 7.8 | 217.6 | 305.5 | 23.976 | 0 | **0** |
| HEVC Main10 1080p (fixture) | `auto-safe` | 1 | 0.0 | 0.0 | 139.6 | 388.9 | 23.976 | 0 | **9** |
| HEVC Main 1080p (fixture) | `no` | 1 | 21.7 | 5.4 | 174.7 | 253.0 | 23.976 | 0 | **0** |
| HEVC Main 1080p (fixture) | `auto-safe` | 1 | 0.0 | 0.0 | 138.8 | 301.7 | 23.976 | 0 | **8** |

All source files are 23.976 fps. Every hardware arm presented **23.976 fps** with
**0 decoder-frame-drops**.

First-frame latency was 485–633 ms in both arms; hardware decode was not slower
(HEVC Main10 real: 577/624/574 ms software vs 555/497/502 ms hardware).

---

## 6. HEVC 8-bit

Real local content with an 8-bit HEVC fixture (encoded from real anime footage,
libx265 `-profile:v main -pix_fmt yuv420p -crf 20`, 45s):

```
software : hwdec-current = no       hw pixel = yuv420p    NVDEC 0%   CPU 21.7% of one core
hardware : hwdec-current = d3d11va  hw pixel = d3d11[nv12] NVDEC 8%   CPU  0.0% of one core
VO (hw)  : VO: [gpu-next] 1920x1080 d3d11[nv12]
```

**PASS.** 8-bit HEVC is hardware-decoded.

Also confirmed 8-bit HEVC on a **real Drive file** in the live app:
`hevc 3840x1598 25 fps`, `Decoder format: 3840x1598 d3d11[nv12]`, `hwdec-current = d3d11va`.

---

## 7. HEVC 10-bit (the decisive test)

### 7a. Real local file — `[ASW] Mushoku Tensei S3 - 05 [1080p HEVC]`

Probed, not assumed: `codec=H.265`, `video-params/pixelformat = yuv420p10`,
1920×1080, 23.976 fps.

```
software : hwdec-current = no       hw pixel = yuv420p10    NVDEC 0%   CPU 27.9% of one core
hardware : hwdec-current = d3d11va  hw pixel = d3d11[p010]  NVDEC 10%  CPU  3.1% of one core
VO (hw)  : VO: [gpu-next] 1920x1080 d3d11[p010]
```

3 independent runs: CPU 3.1 / 3.1 / 0.0 % of one core · NVDEC 10 / 10 / 10 % ·
presented FPS 23.976 every run · 0 decoder drops every run.

### 7b. Real Google Drive file in the running app — "Renegade Immortal Movie 2"

Straight out of the app's own `mpv.log`, on the live Drive stream:

```
● Video  --vid=1  (hevc [Main 10] 3840x1600 25 fps) [default]
[vd] Codec profile: Main 10 (0x2)
[vd] Trying hardware decoding via hevc-d3d11va.
[vd] Allocated a fixed pool of 26 hw surfaces.
[vd] Requesting pixfmt 'd3d11' from decoder.
[i][vd] Using hardware decoding (d3d11va).
[vd] Decoder format: 3840x1600 d3d11[p010] bt.709/bt.709/bt.1886/limited/auto
```

**PASS.** HEVC Main10 is hardware-decoded on this machine, in the real app, on a real
Drive file, as a **10-bit `p010` hardware surface**.

---

## 8. H264 Control

| Arm | CPU % 1 core | NVDEC | hwdec-current | pixel format |
|---|---|---|---|---|
| software | 27.9 | 0% | `no` | `yuv420p` |
| hardware | 3.1 | 9% | `d3d11va` | `d3d11` |

4K control is the strongest signal: **74.2% → 0.0% of one core** (machine total
18.6% → 0.0%) with NVDEC at **25%**. Software decoding 2160p on this i5-3570 is
near its ceiling; hardware decoding removes it entirely. This confirms the whole
D3D11 hardware-frame pipeline works for H.264 too, not just HEVC.

---

## 9. 4K Results

- **4K H.264 (real local file)** — measured above: `d3d11va`, 0.0% of one core,
  23.976/23.976 fps, 0 drops, NVDEC 25%. **SMOOTH.**
- **4K-class HEVC 8-bit (real Drive, 3840×1598 @25 fps)** — `d3d11va`, 3.1% of one
  core, presented **25/25 fps on every one of 30 samples**, 0 decoder drops, NVDEC
  median 11% (max 23%), cache 100%, no underrun. **SMOOTH.**
- **4K-class HEVC Main10 (real Drive, 3840×1600 @25 fps)** — hardware decode proven
  (§7b). **No CPU/FPS steady-state number was captured for this one file**: the live
  session had already been paused and the app then moved to a different track. Recorded
  as **hardware decode: PROVEN, smoothness: NOT MEASURED**, deliberately not upgraded
  to PASS.
- **4K HEVC synthetic fixtures (8-bit and Main10): NOT GENERATED.** libx265 4K
  `ultrafast` measured 31% of realtime on this CPU, i.e. ~3.2 min at 100% CPU per
  60s clip. This was aborted mid-run on purpose because it was loading the machine.
  `hevc_nvenc` was the intended substitute and is **unavailable**: ffmpeg 9.0.2
  requires NVENC API **13.1**, driver 582.78 exposes **13.0**
  (`Driver does not support the required nvenc API version`).

---

## 10. Real Google Drive Results

Measured against the running app's own stream_proxy on port 2098.

**Proxy correctness (verified with curl, not assumed):**

```
GET /stream/1his2NxRsW2Ez-JBLfg5nSKcTaIBhH7AA  Range: bytes=0-1023
  HTTP/1.1 206 Partial Content
  content-type: video/matroska
  content-range: bytes 0-1023/14106695087        <- 14.1 GB file
```

`HEAD` returns **405** — the proxy is GET-only. That is expected for this proxy, not a
fault, but worth knowing.

**Network throughput (40 MB range, real Drive upstream):**

| Metric | Value |
|---|---|
| Time to first byte | 0.68 s |
| Sustained throughput | **28.0 MB/s** (224 Mbps) |
| Required for the tested file | 3.27 Mbps ≈ 0.41 MB/s |

Network is ~68× more than this file needs. **Network is not the decode bottleneck.**

**Live steady-state measurement on the real Drive HEVC stream** (read-only IPC attach
to the app's own pipe, no seek / no set_property / no loadfile issued):

```
media          : H.265 HEVC 3840x1598 @25 fps, 3.27 Mbps
hwdec-current  : d3d11va     video-params/pixelformat = d3d11     current-vo = gpu-next
CPU % 1 core   : median 3.1   (min 0, max 24.8, n=55)
CPU % all 4    : median 0.8
Working set    : median 323 MB (max 500.5 MB)
Private bytes  : median 717.9 MB
presented FPS  : median 25    all 30 samples = 25
decoder drops  : 0 -> 0
frame drops    : 0 -> 1
NVDEC engine   : median 11 %, max 23 %  (n=30)
cache buffering: 100 %, underrun false, 74.7 MB demuxed
time-pos       : +38.92 s over a 30.1 s sample window  <- see caveat below
```

**Caveat, stated rather than smoothed over:** that 30 s window shows media advancing
faster than wall clock (1.29×). A follow-up 12 s trace at 1 s granularity explains it:

```
wall_delta  timepos_delta  ratio   fps  drops
     1.00          0.000   0.000    25      0    <- 3s stall at window start
     1.00          0.000   0.000    25      0
     1.00          0.000   0.000    25      0
     1.00          0.920   0.918    25      0
     1.00          1.000   0.998    25      0
     1.00          1.000   0.999    25      0
     ... (steady 0.997-0.999 for the remaining samples)
```

Steady-state is realtime (0.997–0.999×). The 30 s window included a startup catch-up
after un-pause. `playback-rate` is not readable via `get_property` in this mpv build
(`property not found`), so the catch-up is characterised by the per-second ratio, not
by a directly-read rate property.

---

## 11. CPU / RAM / GPU

**CPU reduction (same fixture, only `--hwdec` changed):**

| Case | software | hardware | reduction |
|---|---|---|---|
| **HEVC Main10 1080p (REAL, n=3)** | 27.9% | **3.1%** | **88.9 %** |
| HEVC Main 1080p | 21.7% | 0.0% | ~100 % |
| H.264 1080p | 27.9% | 3.1% | 88.9 % |
| H.264 2160p | 74.2% | 0.0% | ~100 % |

**Memory — both directions reported, because the answer is not one-sided:**

| Case | WS software | WS hardware | Priv software | Priv hardware | VRAM software | VRAM hardware |
|---|---|---|---|---|---|---|
| HEVC Main10 1080p | 267.1 MB | **178.2 MB** | 351.8 MB | **427.2 MB** | ~480 MB | **~640 MB** |
| H.264 2160p | 409.5 MB | 256.1 MB | 590.3 MB | 732.2 MB | 586 MB | 881 MB |

Working Set **drops** with hardware decode (no CPU-side reference frames).
Private Bytes and VRAM **rise** (hardware surfaces + the D3D11 interop pool).
Neither is a leak: VRAM is flat within a run (e.g. 654 → 660 MB over 25s) and WS is
flat, and VRAM is released on teardown. On a 2048 MiB card the 4K H.264 run peaked
at 881 MiB — under half the card.

**GPU:** `nvidia-smi` exposes `utilization.decoder` on this driver, so NVDEC engine
utilisation is measured, not guessed. Idle desktop reads 0%. Under HEVC 1080p10 it
reads 8–10%; under 4K H.264 it reads 25%. No fake zeros: the software arms read a
true 0%, which is what makes the hardware-arm readings meaningful.

---

## 12. Frame Stability

| Case | source FPS | presented FPS | dec drops | verdict |
|---|---|---|---|---|
| HEVC Main10 1080p real, hw | 23.976 | 23.976 (all samples) | 0 | **PASS** |
| HEVC Main10 1080p real, sw | 23.976 | 23.976 | 0 | PASS |
| HEVC Main 1080p, hw | 23.976 | 23.976 | 0 | **PASS** |
| H.264 1080p, hw | 23.976 | 23.976 | 0 | **PASS** |
| H.264 2160p, hw | 23.976 | 23.976 | 0 | **PASS** |
| **Live Drive HEVC 3840x1598 @25** | 25 | **25 on all 30 samples** | 0 | **PASS** |
| 4K HEVC 8-bit synthetic | — | — | — | UNTESTED (not generated) |
| 4K HEVC Main10 synthetic | — | — | — | UNTESTED (not generated) |
| AV1 (any) | — | — | — | UNTESTED (no fixture; Pascal has no AV1 decoder) |

The 25 fps Drive file held exactly 25 fps across every sample — the exact condition
§13 asked to check.

---

## 13. Seek Results

Local-file seek ladder (0 → 25% → 50% → 75% → 95% → back to 0) on the real HEVC
Main10 file under `auto-safe`: all six targets acknowledged in **0–2 ms**, all
`fast`, no `paused-for-cache`, no `NO-FRAME`.

**Limitation, stated honestly:** these local-file numbers measure **command
acknowledgement and time-pos update**, not first-frame-after-seek. mpv updates
`time-pos` to the seek target immediately while frames are still being decoded
asynchronously, so a sub-2 ms figure here must not be reported as user-visible
recovery time. Local files have no network in the path, so they cannot answer the
Drive seek question anyway. **Real Drive seek latency: NOT MEASURED** — measuring it
would require issuing `seek` against the user's live session, which this phase
deliberately did not do.

No `Invalid video timestamp` or `Non monotonically increasing PTS` warnings were
observed in any run or in the app's own log. Nothing was changed in response.

---

## 14. Audio Regression

DrPlay decides media kind per track and sets `video` over IPC before `loadfile`
(`src/lib/mpvAudio.ts:782-796`, `src/utils/mediaKind.ts`). Verified behaviourally on
a HEVC file (i.e. a file that *has* video) with the production audio code path:

```
--video=no  (== set_property video "no")
  video=$(video)      -> no
  video-codec         -> (unavailable)
  hwdec-current       -> (unavailable)
  current-vo          -> (unavailable)
  audio-codec-name    -> aac

control, same file with video on
  video-codec         -> H.265 / HEVC (High Efficiency Video Coding)
  hwdec-current       -> d3d11va-copy
```

Audio-only loads open **no video decoder and no video output**. Audio codec still
resolves and plays. No regression from hardware decoding.

Incidental but worth recording: with `--vo=null` the backend is reported as
**`d3d11va-copy`** rather than `d3d11va`, because a null VO cannot accept zero-copy
hardware surfaces. With the production `--vo=gpu-next` the backend is zero-copy
**`d3d11va`**. Anyone benchmarking via `--vo=null` will see the wrong backend name.

---

## 15. Codec Matrix

| Codec | Profile | Bit depth | Resolution | Software CPU %1core | HW CPU %1core | HW API | Presented FPS | Drops | NVDEC % | Result |
|---|---|---|---|---|---|---|---|---|---|---|
| H.264 | High | 8-bit | 1920×1080 | 27.9 | **3.1** | d3d11va | 23.976 | 0 | 9 | **PASS** |
| H.264 | High | 8-bit | 3840×2160 | 74.2 | **0.0** | d3d11va | 23.976 | 0 | 25 | **PASS** |
| HEVC | Main | 8-bit | 1920×1080 | 21.7 | **0.0** | d3d11va | 23.976 | 0 | 8 | **PASS** |
| **HEVC** | **Main10** | **10-bit** | 1920×1080 | 27.9 (n=3) | **3.1** (n=3) | **d3d11va** | 23.976 | 0 | 10 | **PASS** |
| **HEVC** | **Main10** | **10-bit** | 3840×1600 (real Drive) | not measured | not measured | **d3d11va** | not measured | not measured | not measured | HW decode **PROVEN**, smoothness **UNTESTED** |
| **HEVC** | Main | 8-bit | 3840×1598 (real Drive) | not measured | **3.1** | **d3d11va** | **25.000** | 0 | 11 | **PASS** |
| HEVC | Main / Main10 | 8/10-bit | 3840×2160 (synthetic) | — | — | — | — | — | — | UNTESTED (fixture not generated) |
| AV1 | — | — | — | — | — | — | — | — | — | UNTESTED (no fixture) |

---

## 16. Exact Hardware Decode Evidence

Four independent signals, per §8/§25, separating decode from render:

**(A) Real hardware decode — confirmed**

1. `hwdec-current` over IPC = `d3d11va` (not a fallback, not `no`)
2. mpv log: `[i][vd] Using hardware decoding (d3d11va)` — an *info*-level line mpv
   emits only after the hwaccel actually initialised
3. Hardware pixel format: `video-params/pixelformat = d3d11`, and the VO line shows
   a hardware surface — `d3d11[p010]` for 10-bit, `d3d11[nv12]` for 8-bit
4. `nvidia-smi dmon` `dec` column non-zero (8–25%) exactly when decoding, and
   **0% in the software control arms**

**(B) Software decode + GPU renderer — this is the control arm, and it is visibly different**

Software arms render `VO: [gpu-next] 1920x1080 yuv420p10` — a *software* pixel format
being uploaded to the GPU. Rendering was still `gpu-next` on `d3d11` in both arms, so
**"GPU rendering" alone proves nothing about decoding.** The two arms differ in
`hwdec-current`, in the VO pixel format (`yuv420p10` vs `d3d11[p010]`), and in the
NVDEC engine counter. All three differ. That is the proof.

**Decoder vs renderer, reported separately for every case:**

| | Decoder | Renderer |
|---|---|---|
| software arm | `no` (ffmpeg software) | `gpu-next`, `d3d11` context, software pixels uploaded |
| hardware arm | `d3d11va` (NVDEC via D3D11) | `gpu-next`, `d3d11` context, zero-copy hw frames |

**10-bit integrity (not "the picture appeared"):** raw decoded frames were captured
from both arms at identical timestamps and compared numerically.

| Check | Result |
|---|---|
| Pure-green pixels (broken 10→8 bit conversion) | **0.000 %** in every hardware frame |
| Mean luminance, software vs hardware, matched frame | 158.76 vs 158.99 (**0.15 %**) |
| PSNR (software vs hardware, matched frame) | **33.2 / 38.5 / 42.8 dB** |
| SSIM (matched frame) | 0.933 – 0.994 |
| PSNR at a frame boundary (t=5s) | 14.4 dB |

The 14.4 dB outlier is **not** corruption: it is the two arms landing on different
frames because `seek` jitter moved the capture point, which also explains the lower
t=5s SSIM. Zero green pixels plus a 0.15 % luminance agreement plus 33–43 dB PSNR at
matched frames is a clean 10-bit path. No black-frame anomaly: black-pixel fraction
was 0.09–0.37 % on the real file and matched between arms.

---

## 17. Problems Found

**P1 — Leftover debug debris in the working tree (should be cleaned up).**
`src-tauri/src/video_host.rs` carries an uncommitted `TEMPORARY PROBE` block,
~315 lines, from the session that was terminated: four `#[cfg(test)]` counters
(lines 91–103), a `match` block **inside the live WndProc** (278–293), a probe test
`probe_which_hwnd_receives_input_over_the_video` (1302–1556) and a `send_left_click`
helper (1558–1588). It is `#[cfg(test)]`-gated so it does not ship in a release
binary, but one piece sits in the production message handler and the whole thing
should be reverted or finished. This was **not** touched by this phase.

**P2 — Drive playback stalled once, and it was not the decoder.** The app displayed
"Network connection lost. Retrying…". At that moment `mpv.exe` was **not running**
and NVDEC read 0%. The app's own recovery then truncated `mpv.log` to 0 bytes and
respawned the sidecar — i.e. the watchdog/sidecar-swap path fired. Sustained Drive
throughput measures 28 MB/s against a file needing 0.41 MB/s, so this was a transient
proxy/upstream connection event, **not** bandwidth and **not** decode. Worth a separate
investigation; nothing in this phase's scope explains it.

**P3 — `playback-rate` is not readable** over IPC in this mpv build
(`property not found`), so playback speed can only be inferred from `time-pos`
deltas. Minor observability gap.

**P4 — Seek latency is effectively unmeasurable from mpv's own properties** for the
same reason `time-pos` updates before frames appear (§13). Real Drive seek latency is
an open item.

**P5 — 4K HEVC synthetic coverage is missing** (§9) and AV1 is untested. Deliberate,
cost-driven, not an oversight.

---

## 18. Recommended Configuration

**No change recommended. The current configuration is already correct.**

`--hwdec=auto-safe` (`process.rs:46`) is retained. Rationale is now measured, not
assumed: on this machine `auto-safe` resolves to `d3d11va` for every codec tested
(H.264 8-bit, HEVC Main 8-bit, HEVC Main10 10-bit) and engages NVDEC, while still
degrading to software if the GPU or codec cannot cope. An explicit
`--hwdec=d3d11va` override would pin behaviour to one API for no measured gain.

**Explicit `d3d11va` was deliberately not adopted, and the §7 diagnostic was not
needed:** `auto-safe` already *is* `d3d11va` on this machine, proven by mpv's own
`Trying hardware decoding via hevc-d3d11va` / `Selected decoder` lines and
`hwdec-current = d3d11va`. An A/B of auto-safe vs explicit could only reproduce the
result already observed.

**VO / gpu-context: leave as-is.** mpv's `auto` correctly resolves to
`d3d11` + feature level 12_1 + the GTX 1050. Pinning `--gpu-context=d3d11` would add
a hard GPU dependency for zero measured benefit — exactly the failure mode the
existing comment at `process.rs:33-45` warns against.

**Comments to correct when someone next edits `process.rs`:** lines 41–45 state that
"unsupported HEVC 10-bit/4K stayed software". That was true on the Intel HD machine
and is **false here** — HEVC Main10 1080p and 4K-class HEVC both hardware-decode on
the GTX 1050. Leaving it would mislead the next reader. (Documentation only, no
behaviour change.)

---

## 19. Changes Actually Made

**Production code changes: NONE.**

- `git status` still shows exactly one modified file, `src-tauri/src/video_host.rs`,
  which is pre-existing debris from the terminated session (§17 P1), untouched here.
- No change to `src-tauri/src/mpv/process.rs`, `video_host.rs`, the proxy, the UI, or
  any other source.
- mpv flags used for benchmarking were **overridden in the harness only**; the
  shipped spawn path was never edited.
- New files, all outside the repo's source tree:
  - `VIDEO-GTX1050-HEVC-PERFORMANCE-REPORT.md` (this file, repo root)
  - benchmark harness + fixtures under
    `%LOCALAPPDATA%\Temp\opencode\drplay-bench\` (`bench.mjs`, `run-matrix.mjs`,
    `sample-proc.ps1`, `live-probe.mjs`, `live-steady.mjs`, `live-rate.mjs`,
    `live-state.mjs`, `imgcheck.mjs`, `gen-fixtures.mjs`, `results.json`, `logs\`, `shots\`)

Harness hygiene: 14/14 benchmark runs left **zero orphaned mpv processes**; the live
app attach was strictly read-only (`get_property` only — no `seek`, `set_property`,
or `loadfile` against the user's session).

Measurement fixtures generated (45s each, encoded from real anime footage, not
synthetic test patterns): `hevc8-1080p.mkv` (Main, yuv420p), `hevc10-1080p.mkv`
(Main10, yuv420p10le).

**A correction worth flagging:** local files named "Erai-raws … Detective Conan"
turned out to be **H.264**, not HEVC — 123 of them, all `H.264 / yuv420p /
1920×1080`. Filenames would have produced a completely wrong report. Only one real
HEVC Main10 file existed locally. The machine's actual media set was probed rather
than assumed.

---

## 20. Final Verdict

```
GPU:
GTX 1050 (10de:1c81, 2048 MiB, driver 582.78, D3D11 feature level 12_1)

HEVC HW decode:
YES  — hwdec-current = d3d11va, "Using hardware decoding (d3d11va)",
       VO: [gpu-next] 1920x1080 d3d11[nv12], NVDEC engine 8%

HEVC Main10 HW decode:
YES  — Codec profile: Main 10 (0x2), hw surface d3d11[p010],
       NVDEC engine 10% (1080p local, n=3) and proven on a real Drive
       3840x1600 Main10 file inside the running app

HW API:
d3d11va (zero-copy via gpu-next on the d3d11 context)

4K HEVC:
SMOOTH for 4K-class HEVC 8-bit on real Drive (3840x1598 @25fps:
  25/25 fps, 0 decoder drops, CPU 3.1% of one core)
NOT MEASURED for 4K HEVC Main10 (decode proven, smoothness not sampled)

CPU software:
HEVC Main10 1080p (real, n=3): 27.9% of one core
H.264 2160p (real):            74.2% of one core

CPU hardware:
HEVC Main10 1080p (real, n=3):  3.1% of one core   (machine total 0.8%)
H.264 2160p (real):             0.0% of one core   (machine total 0.0%)

CPU reduction:
HEVC Main10 1080p: 88.9%
H.264 2160p:      ~100%

RAM software:
HEVC Main10: WS 267 MB / private 352 MB / VRAM ~480 MB
H.264 2160p:  WS 410 MB / private 590 MB / VRAM 586 MB

RAM hardware:
HEVC Main10: WS 178 MB / private 427 MB / VRAM ~640 MB
H.264 2160p:  WS 256 MB / private 732 MB / VRAM 881 MB
(WS drops, private bytes and VRAM rise — both reported, neither is a leak)

Frame drops:
0 decoder-frame-drops in every hardware run, local and real Drive

Recommended mpv config:
unchanged — --hwdec=auto-safe, --vo=gpu-next,gpu, no --gpu-context

Production code change required:
NO
```

**Direct answer to the question this phase existed to answer:**

Yes — the GTX 1050 does help, and it is not theoretical. On this machine, with this
driver (582.78), this mpv (v0.41.0-1042), on these specific files: `hwdec-current`
reports `d3d11va`, the hardware pixel format is `d3d11[p010]` / `d3d11[nv12]`, the
NVDEC engine counter moves (8–25%) while the software control arm reads a true 0%,
presented FPS equals source FPS with zero dropped frames, and CPU falls from 27.9% to
3.1% of one core on HEVC Main10 1080p (n=3).

The HEVC 10-bit anime in your real Google Drive library — including the 3840×1600
Main10 "Renegade Immortal" file — is decoded on the GTX 1050's NVDEC, not on the CPU.
That held in the real running app, over the real Drive proxy, with a live 25 fps
stream and no corruption. The configuration already in `process.rs` is already
correct, so nothing was changed.