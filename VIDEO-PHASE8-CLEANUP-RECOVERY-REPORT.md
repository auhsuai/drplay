# VIDEO-PHASE8-CLEANUP-RECOVERY-REPORT.md

DrPlay — Phase 8 · Probe-debris cleanup + real Drive stream recovery diagnosis
Date: 2026-10-08 · Repo `E:\drplay` @ `deeee90` (branch `main`)

**Scope actually performed:** Task A (cleanup) + Task B (diagnosis) only.
No performance re-benchmark, no UI work, no decode-policy change.

---

## 1. Current State

### Repository before this phase

```
 M src-tauri/src/video_host.rs        +318 / -0   (uncommitted)
?? VIDEO-GTX1050-HEVC-PERFORMANCE-REPORT.md
```

The Phase 7 report claimed `video_host.rs` carried ~315 lines of `TEMPORARY PROBE`
debris. Verified against the real diff:

| Check | Result |
|---|---|
| `git diff --numstat` | **318 additions, 0 deletions** |
| Hunk locations | `+91`, `+278`, `+1301` — exactly the probe regions |
| `TEMPORARY PROBE` in `HEAD` | **absent** |
| `PROBE_MOUSEACTIVATE` in `HEAD` | **absent** |
| `probe_which_hwnd` in `HEAD` | **absent** |
| `send_left_click` in `HEAD` | **absent** |

**Zero deletions** is the decisive fact: no committed line was modified or removed.
The entire uncommitted diff was purely additive probe debris, so reverting the file
to `HEAD` is provably lossless for production code.

### Repository after this phase

```
?? VIDEO-GTX1050-HEVC-PERFORMANCE-REPORT.md
```

`src-tauri/src/video_host.rs` is byte-identical to `HEAD` (1183 lines both sides).
No other file is modified.

---

## 2. Cleanup

### What was removed

Everything below was inside the single uncommitted diff and is gone:

| Removed | Lines | Purpose |
|---|---|---|
| 4 `#[cfg(test)] static PROBE_*` atomic counters + "TEMPORARY PROBE COUNTERS" doc comment | 14 | Count WM_MOUSEACTIVATE / WM_LBUTTONDOWN / WM_SETFOCUS / WM_KILLFOCUS |
| `#[cfg(test)] match message { … }` block **inside the live `video_input_wnd_proc`** | 16 | Increment those counters on every message |
| `#[test] fn probe_which_hwnd_receives_input_over_the_video` + nested helpers `pump`, `rect_of`, `class_of`, `thread_focus` | 288 | Spawn the shipped mpv with a hardcoded flag list, hit-test windows, `SendInput` a synthetic left click, assert which HWND got focus |
| `fn send_left_click` test helper | 31 | `SendInput(LEFTDOWN/LEFTUP)` |
| **Total** | **318** | |

Method: `git checkout -- src-tauri/src/video_host.rs` (preferred over hand-editing
because the diff is proven to be pure additions, so revert ≡ removal, with no
collateral risk).

### What was retained

All production behaviour, unchanged:

- native video host HWND creation (`create_child`, `ensure`), class `DrPlayVideoHost`,
  parented to the Tauri main window
- host rect / visibility (`set_rect_raw`, `set_visible_raw`, `video_host_set_rect`,
  `video_host_set_visible`, `clamp_rect`)
- subclassing (`install_subclass`, `restore_subclass`, `previous_proc`)
- `video_input_wnd_proc` itself — `WM_MOUSEACTIVATE => MA_NOACTIVATE`, right-click →
  `emit_context_menu_event`, `WM_RBUTTONUP => 0`, everything else forwarded to the
  previous proc
- `mpv_child`, `window_process`, `attach_input_subclass`, `focus_webview`, `destroy`
- lifecycle: acquire / destroy / app-exit teardown
- shared test helpers used by other tests, deliberately kept: `throwaway_parent`,
  `set_rect_raw`, `set_visible_raw`, `window_process`, `mpv_child`, `install_subclass`

### Why it was safe — evidence

All 14 real `video_host::tests::*` still pass after removal:

```
the_created_host_is_a_hidden_child_window ... ok
ensure_creates_exactly_one_child_and_is_idempotent ... ok
installing_the_subclass_replaces_the_window_procedure_and_restores_it ... ok
the_subclass_refuses_activation_and_swallows_the_right_button_release ... ok
only_the_right_button_press_opens_the_context_menu ... ok
a_right_click_emits_exactly_one_event ... ok
mouse_move_wheel_and_left_button_are_never_the_context_menu_click ... ok
screen_point_is_absolute_not_client_space ... ok
the_mpv_child_is_discovered_only_once_it_exists ... ok
visibility_toggles_and_stays_put_when_repeated ... ok
clamp_rect_keeps_a_valid_rect_untouched ... ok
clamp_rect_rejects_a_negative_size_and_overflowing_coordinates ... ok
client_point_sign_extends_the_lparam_words ... ok
wide_nul_terminates_the_utf16_encoding ... ok
```

Debris grep after cleanup: **0 matches** for `TEMPORARY PROBE | PROBE_* |
probe_which_hwnd | send_left_click`.

### RED → GREEN

| | Command | Result |
|---|---|---|
| **RED** (before) | `cargo test --lib -- --test-threads=1` | `test result: FAILED. 172 passed; **1 failed**; 15 ignored` — `probe_which_hwnd_receives_input_over_the_video` panicked at `src\video_host.rs:1460:37: mpv must create its child inside the host` |
| **GREEN** (after) | `cargo test --lib -- --test-threads=1` | `test result: **ok**. 172 passed; **0 failed**; 15 ignored; 0 measured; 0 filtered out; finished in 38.47s` |

Test count 172 → 172: exactly one test removed (the probe), nothing else lost.

### The probe test was not merely dead code — it was actively harmful

Two independent defects, both observed:

1. **It fails in this environment.** It calls `SetCursorPos`, which returned `0`
   (failure) — there is no interactive desktop attached for the test harness, so
   mpv never creates its child window inside the host and the `.expect()` panics.
2. **It leaks an orphaned `mpv.exe`.** The panic at line 1460 happens *before* the
   test's `sidecar.kill()` cleanup, so the mpv it spawned survives. Found live in
   the process table:

```
mpvPid=1464  parentPid=9128  parentName="" (parent gone) -> ORPHAN
cmdline: target\debug\mpv.exe --no-config --load-scripts=no --idle=yes --osc=no
          --osd-level=0 --input-cursor=no --input-default-bindings=no
          --input-vo-keyboard=no --player-operation-mode=cplayer --no-terminal --wid=984212
```

Matched 10/10 of the probe's hardcoded flags, had `--wid=`, and had **no** `--vo=`
and **no** `--hwdec=` — because the probe bypassed `mpv_flags()`. A second orphan
(`pid 5216`) appeared identically during the subagent's test run. Both were killed;
both are gone. Removing the probe removes both failure modes.

---

## 3. Incident Summary

**Exact observed symptom:** the UI displayed *"Network connection lost. Retrying..."*
while playing a real Google Drive stream.

**That string is a translation key, and it is the app's own wording:**

```
src/locales/**/translation.json:144
  "network_interrupted": "Network connection lost. Retrying..."
```

**State at the moment of observation (Phase 7):**

- no `mpv.exe` process existed
- NVDEC read 0 %
- the app had respawned the sidecar, and `mpv.log` was truncated to 0 bytes
- measured Drive throughput elsewhere: **28 MB/s** sustained against a file needing
  **0.41 MB/s**

So the Phase 7 conclusion — "not a decode bottleneck, not bandwidth" — was right, but
it was still a guess about *which layer*, because the app's own label said "network".

---

## 4. Failure Timeline

From `DrPlay.log` (Rust-side, wall-clock UTC) and the app's rotated `mpv.1`.
Times shown UTC; add 7 h for local.

```
[2026-10-08][11:54:55] [mpv] spawning sidecar (25 flags, pipe ...6b721df0)
[2026-10-08][11:54:56] [mpv] sidecar ready
[2026-10-08][11:54:56] [stream-proxy] started on 127.0.0.1:2098
      ... normal playback, no proxy errors ...
[2026-10-08][12:11:24] [mpv::ipc][WARN] [mpv-ipc] pipe closed by mpv      ★ ENGINE DIED #1
[2026-10-08][12:12:34] [mpv][WARN] previous sidecar exited (exit code: 0xffffffff); respawning
[2026-10-08][12:12:34] [mpv] spawning sidecar (25 flags, pipe ...84718db4)
[2026-10-08][12:12:34] [mpv] sidecar ready
      ... ~4.5 min of playback ...
[2026-10-08][12:17:08] [mpv::ipc][WARN] [mpv-ipc] pipe closed by mpv      ★ ENGINE DIED #2
                                   (this session's log is the surviving mpv.1)
[2026-10-08][12:30:55] [mpv][WARN] previous sidecar exited (exit code: 0xffffffff); respawning
[2026-10-08][12:30:55] [mpv] spawning sidecar (25 flags, pipe ...79628bfb)
[2026-10-08][12:30:56] [mpv] sidecar ready
```

Detection-to-respawn latency: **70 s** (death #1) and **13 min 47 s** (death #2).

### Proxy state at failure: clean

The only proxy warning anywhere in the log is unrelated and from 9.5 hours earlier:

```
[2026-10-08][02:32:09] [stream-proxy::server][WARN]
  upstream body idle for 20s (file 1Iouwn2MU2nC2b-8JTGkqX-IEQwSaH2gP) — aborting response
```

No `stream-proxy-error` event, no 401/429/5xx, no idle-abort, and no proxy restart
coincides with either death.

### The dying session's own log (`mpv.1`) — where it stops

```
[269.788][v][mkv] execute seek (to 862.280000 flags 32)
[269.788][v][curl] stream level seek from 1869809065 to 1767369289
[269.788][v][mkv] seek done
[269.811][i][cplayer] Track switched:  ● Video (hevc [Main 10] 3840x1600 25 fps)
[269.811][cplayer] Set property: sid="1" -> 1
[269.861][d][vo/gpu-next/libplacebo] (Re)creating 1896x790x0 texture with format rgba16hf
[269.891][d][ao/wasapi] Thread Pause
[269.891][i][cplayer] Enter buffering (buffer went from 100% -> 0%) [0.000000s].
<log ends>
```

**No `end-file`. No error. No graceful-exit marker. No stack trace.** The log simply
stops mid-buffering, which is the signature of a process terminated from outside,
not one that decided to quit.

---

## 5. Root Cause

### Layer: the mpv **process** layer. Definitively not network.

| Evidence | What it rules out |
|---|---|
| No `end-file` in mpv's log | rules out mpv-level stream/HTTP error |
| No `stream-proxy-error` in `DrPlay.log` at either death | rules out the proxy layer |
| No proxy restart / idle-abort / 401 / 429 / 5xx | rules out upstream + retry layer |
| 28 MB/s measured vs 0.41 MB/s required | rules out bandwidth |
| `pipe closed by mpv` logged by `mpv::ipc` | the named pipe reached EOF → the **process** ended |
| `previous sidecar exited (exit code: 0xffffffff)` | abnormal termination (`0xFFFFFFFF` = −1) |
| **No Windows Application Error / WER record** for `mpv.exe` since boot | **not** an unhandled exception / access violation |

### Not the commanded shutdown path

`mpv_shutdown` (`src-tauri/src/mpv/mod.rs`) calls `handle.ipc.mark_shutdown_requested()`
*before* killing, precisely so the reader stays quiet and the frontend does not see
`ipc-closed` (`mpv/ipc.rs` comments: *"the pipe ending that follows is expected, so the
reader must not report it as an engine failure"*). The reader **did** log
`[mpv-ipc] pipe closed by mpv`, therefore `shutdown_requested` was never set, therefore
`mpv_shutdown` was **not** the path. The sidecar also does not exit on its own terms:
`mpv_shutdown`'s own comment states mpv holds no persistent state and the app uses a
hard kill as the reliable shutdown path.

### Root cause part 1 — CONFIRMED BUG: the message is a misclassification

Traced end to end in source:

```
Rust ipc reader: pipe EOF
  → emits  "ipc-closed"                            (mpv/ipc.rs, ConnectionClosed)
  → mpvProtocol.ts:395  event === MPV_EVENTS.ipcClosed → onEngineClosed(cause)
  → mpvAudio.ts:305-323  onEngineClosed → this.playbackFailure("mpv-engine-closed", cause)
  → mpvAudio.ts:698-726  playbackFailure → emit("error", { code: "network_interrupted" })
  → UI renders translation.json "network_interrupted"
        = "Network connection lost. Retrying..."
```

**`onEngineClosed` unconditionally reports an engine/process death as
`network_interrupted`.** There is no branch on that path that consults
`classifyEndFileError` — that classifier (`mpvProtocol.ts`, used at
`mpvAudio.ts:296`) is only reached from the `end-file` path. So a crashed or killed
mpv is *always* labelled a network problem, no matter the real cause.

This is precisely the defect that sent Phase 7 looking for a network explanation.
`DrPlay.log` even carries the comment *"the frontend treats `ipc-closed` as 'mpv died
unexpectedly'"* — the architecture knows the distinction; the error code does not
express it.

### Root cause part 2 — NOT FULLY DETERMINED: why the process ended

`exit code 0xFFFFFFFF` with no crash record and no graceful exit means mpv was
terminated programmatically. The architecture provides exactly one hard-kill
mechanism: the kill-on-close Job Object (`src-tauri/src/mpv/job.rs`,
`KILL_ON_JOB_CLOSE`), pinned at spawn (`process.rs:296-315`). Closing that job handle
terminates every member — and that is the mechanism consistent with a `0xFFFFFFFF`
exit and a log that stops mid-write.

What is **not** proven: which code path dropped that job handle. The two deaths
occurred with no `mpv_shutdown` call and no app teardown in the log. Establishing
this would need instrumentation that the current code does not emit — deliberately
**not** added in this phase (see §11).

### Root cause part 3 — CONFIRMED (minor): respawn latency is unbounded

`mpv_spawn` (`mpv/mod.rs:83-93`) learns that the sidecar died only when the frontend
next asks for an engine:

```rust
match handle.child.try_wait() {
    Ok(None) => return Ok(handle.spawn_reply()),              // alive
    Ok(Some(status)) => log::warn!("[mpv] previous sidecar exited ({status}); respawning"),
```

Nothing polls. Between `pipe closed by mpv` and the next `mpv_spawn` there is no
engine at all, so the observed 70 s and 13 min 47 s gaps are simply "nobody asked
yet". Playback does not self-heal; it heals when a play/track/retry request arrives.
That is a design choice (it avoids spawning an engine nobody wants), not a fault, but
it means the recovery is **reactive, not automatic**, and the user sees the error
message rather than a silent self-repair.

---

## 6. Fix

**Production code changes made in this phase: none beyond restoring the committed
file.** Net effect on production source: **zero** — `video_host.rs` is byte-identical
to `deeee90`.

The misclassification in §5 part 1 is a real defect, but it is **not fixed here**, on
purpose:

- it changes user-visible copy, which is a product decision, not a cleanup;
- the authoritative notification path (PlayerBar error surface / toast) is UI, which
  this phase was explicitly told not to touch;
- the recovery behaviour underneath is already correct, so a copy change is not a
  correctness fix.

Exact minimal fix site, for whoever takes it: give `playbackFailure`
(`src/lib/mpvAudio.ts:698`) a code parameter and have `onEngineClosed`
(`src/lib/mpvAudio.ts:322`) pass a distinct `engine_closed`, plus one new
`translation.json` key. Regression test belongs alongside
`src/lib/mpvAudio.test.ts:684` (`ipc-closed: network_interrupted, ...`), which
currently *asserts the wrong code* and would have to be updated deliberately.

---

## 7. Recovery Behaviour

| Property | Observed | Verdict |
|---|---|---|
| Detect engine death | prompt — `pipe closed by mpv` within ~4 s | **correct** |
| Do not misreport a commanded shutdown as a failure | `mark_shutdown_requested()` suppresses `ipc-closed` | **correct** |
| Bounded restart budget | `LOADFILE_RESTART_MAX_ATTEMPTS = 1`, then `failTerminal` | **correct** |
| Restart is bounded in time | `LOADFILE_RESTART_TIMEOUT_MS = 10_000` per IPC call | **correct** |
| Restart re-bases connection identity | `engineEpoch = 0` + `noteSpawnReply(reply)` after the swap | **correct** |
| Video host re-acquired for the replacement | `ensureVideoHostAcquired()` inside `swapSidecar`, after shutdown, before spawn | **correct** |
| Stale listeners detached | `detachListeners` on `onEngineClosed` | **correct** |
| Playback actually resumes afterwards | observed — the app played again after each death | **correct** |
| Automatic self-heal | **no** — recovery waits for the next user/UI request | reactive, by design |
| Failure notification | an engine death is labelled a network fault | **BUGGY** (see §5) |

**No duplicate mpv was observed.** After the Phase 7 session there were exactly two
`mpv.exe` processes at one point; both were accounted for:

- `pid 4252` — parent `drplay` (pid 1868), the live sidecar
- `pid 1464` — parent dead, the probe test's leaked child (removed with the probe)

No stale named pipe, no lingering proxy port, no leftover video-host window.

### Log truncation — not a bug

`spawn_mpv` calls `rotate_mpv_log` (`process.rs:58-80`) *before* every spawn, which
renames the outgoing `mpv.log` to `mpv.1`. Confirmed on disk: the session that died
was preserved in full as `mpv.1` (236 932 bytes), which is where the timeline in §4
came from. mpv truncating its own `--log-file` is therefore not evidence loss —
the evidence survives one rotation. Two generations are retained; anything older is
lost, which is a reasonable bound and not worth changing.

---

## 8. Audio Regression

The cleanup removed test-only code from a Rust file. `video_host.rs` is byte-identical
to `deeee90`, so audio behaviour is unchanged **by construction**, not by assertion.
Verified anyway:

| Layer | Check | Result |
|---|---|---|
| Rust | `cargo test --lib` | 172 passed, 0 failed — includes cover/artwork, seed, media_controls, memory, proxy tests |
| Types | `npx tsc --noEmit` | **exit 0** |
| Frontend | `npx vitest run` | **2879 passed, 1 failed** — see below |

The single frontend failure is **not** audio and **not** video:

```
FAIL src/ui/layouts/TabContentRouter.test.tsx
  > TabContentRouter playlist remount (P2-13a-6)
  > đổi playlist_A → playlist_B remount PlaylistView (key=activeTab)
Error: [vitest-pool]: Failed to start forks worker for src/ui/HomeTab/HomeTab.test.tsx
```

Re-run in isolation it **passes** (`1 passed`, 2.20 s), which identifies it as a
flaky test induced by parallel-load resource exhaustion on this 4-core/4-thread box,
not a regression: the full suite forks many workers, the pool failed to start one, and
a sibling test then failed. No frontend file was modified in this phase, and a
playlist-remount test has no code path to a Rust WndProc.

Media-kind behaviour (`classifyMediaKind` → `set_property video "1"/"no"` before
`loadfile`) was not touched.

---

## 9. Process / Window Cleanup

Final state after all benchmarks, test runs and reproductions:

```
mpv.exe                      : 0
drplay.exe                  : 0
cargo.exe / rustc.exe       : 0 / 0
listening on 2098 / 1420    : 0 / 0
windows titled "DrPlay"     : 0
```

Two orphaned `mpv.exe` processes were found during this phase (`pid 1464`, `pid 5216`)
— both artifacts of the probe test, both killed. No orphan remains.

---

## 10. Tests

| Command | Result | Verdict |
|---|---|---|
| `cargo test --lib -- --test-threads=1` (before) | `FAILED. 172 passed; 1 failed; 15 ignored` | RED — probe test |
| `cargo test --lib -- --test-threads=1` (after) | `ok. 172 passed; 0 failed; 15 ignored` (38.47 s) | **PASS** |
| `npx tsc --noEmit` | exit 0 (48 s) | **PASS** |
| `npx vitest run` | 2879 passed, 1 failed, 195/196 files (250 s) | flaky sibling, passes in isolation |
| `npx vitest run src/ui/layouts/TabContentRouter.test.tsx` | `1 passed` (2.20 s) | confirms flakiness |

`cargo fmt` was **not** retained. Running it dirtied 22 unrelated files
(+1960/−680) because the tree at `HEAD` is not rustfmt-clean. That churn is unrelated
to this phase's scope and was rolled back with `git checkout -- src-tauri/`;
`video_host.rs` was already at `HEAD` so nothing intended was lost. Recorded as a
follow-up (§11), not fixed here.

### Operational finding: why backend commands appeared to hang

Worth recording because it cost real time and it is not a DrPlay bug:

`cargo build` / `check` / `test` **cannot run while DrPlay is open.** `tauri.conf.json`
declares `"externalBin": ["bin/mpv"]`, so `tauri-build` does this on every build:

```rust
// tauri-build-2.6.3/src/lib.rs:78-80
let dest = path.join(file_name);          // -> target/debug/mpv.exe
if dest.exists() {
    fs::remove_file(&dest).unwrap();       // panics here
}
```

`target\debug\mpv.exe` **is the running sidecar image**, and Windows refuses to
delete a running `.exe`:

```
thread 'main' panicked at tauri-build-2.6.3/src/lib.rs:80:30:
called `Result::unwrap()` on an `Err` value:
Os { code: 5, kind: PermissionDenied, message: "Access is denied." }
```

The build then dies silently and quickly, which reads as a hang. Verified both ways:
locked while the app ran, and `FREED` (exclusive-open probe) immediately after
closing it — after which the very same command compiled and ran in 153 s with zero
lock contention. An initial hypothesis of cargo file-lock contention was **wrong**
and is retracted; there was no lock wait, only this panic.

---

## 11. Remaining Risks

**In scope, unfixed:**

1. **Misclassified failure notification** (§5 part 1, §6). An engine death always
   surfaces as "Network connection lost". Costs diagnosis time on every future
   incident. Fix site and test location identified; not applied here (product/UI call).
2. **Proximate cause of the `0xFFFFFFFF` termination unknown** (§5 part 2). The
   kill-on-close Job Object is the only hard-kill mechanism in the architecture and
   is consistent with the evidence, but nothing logged *why* its handle was released.
   Reproducing this needs instrumentation that does not exist yet.
3. **Two-generation log retention.** `mpv.log` + `mpv.1` only. Adequate for the last
   failure, not for a multi-incident investigation.

**Follow-up findings (out of scope, not actioned):**

4. **Repo is not rustfmt-clean at `HEAD`.** Any `cargo fmt` produces ~1900 lines of
   churn across 22 files. Either the tree was never formatted or rustfmt config /
   version drifted. Needs a decision (format once in a dedicated change, or pin).
5. **`video-host` rect logging is extremely chatty.** `DrPlay.log` fills with
   `[video-host] rect 12,1013 1896x928` lines — dozens per second while the surface
   animates. This actively hurts diagnosis (it is why §4 needed log archaeology) and
   was visible in the Phase 7 terminal screenshot too. Not touched: it is a logging
   change to production.
6. **`[video-input] no 'Chrome_RenderWidgetHostHWND' child under window …`** repeats on
   every show. The host cannot find the WebView child to restore keyboard focus, so
   focus is left alone after a video is shown. Cosmetic/UX, not correctness.
7. **`playback-rate` is not readable** over IPC in this mpv build (`property not
   found`), so playback speed can only be inferred from `time-pos` deltas.
8. **Seek latency remains unmeasurable from mpv properties** — `time-pos` updates
   before frames render, so a sub-2 ms figure is command acknowledgement, not
   user-visible recovery. Real Drive seek latency is still open.

---

## 12. Final Verdict

```
Cleanup:
CLEAN  — 318 lines of probe debris removed; video_host.rs byte-identical to deeee90;
         grep 0 matches; cargo test 172/172 ok (RED 1-failed -> GREEN 0-failed)

Drive stall root cause:
PARTIALLY KNOWN
  Layer identified with certainty: the mpv PROCESS layer (engine terminated,
  exit code 0xFFFFFFFF, no end-file, no proxy error, no Windows crash record).
  The proximate reason for that termination is NOT determined.

Failure layer:
mpv process lifecycle — NOT Drive, NOT stream_proxy, NOT decode, NOT bandwidth,
NOT watchdog, NOT IPC, NOT log rotation.
Secondary (defect): error classification in the frontend.

Recovery:
CORRECT — detection is prompt, restart budget is bounded (1), identity is re-based,
video host is re-acquired, listeners are detached, playback resumes, no duplicates,
no orphans. It is REACTIVE (waits for the next request), not automatic.

Watchdog:
CORRECT — and not implicated. The load-deadline (30s) and stall reconciler (75s,
max 2) never fired in this incident. `mpv-ipc` detected the death in ~4s.

Logging:
NOT A BUG — rotate_mpv_log preserved the dead session in full as mpv.1,
which is where the whole timeline was recovered from.

Confirmed bug (not fixed):
engine/process death is reported to the user as "Network connection lost.
Retrying..." (network_interrupted). classifyEndFileError is never consulted
on the ipc-closed path.

Production changes:
NO  — net zero. The only source change was restoring video_host.rs to its
       committed state, plus rolling back cargo fmt churn in 22 files.

Audio regression:
PASS — audio behaviour unchanged by construction (file byte-identical to HEAD);
       cargo test 172/172; tsc exit 0; vitest 2879/2880 with the one failure
       being a flaky playlist test that passes in isolation.

Orphan processes:
FOUND then REMOVED — two leaked mpv.exe (pid 1464, pid 5216), both artifacts of
       the probe test, both from the code this phase deleted. Final state: none.

Remaining blocker:
NO
```

### Direct answers

**Is there debug debris left?** No. Zero matches, and the file is byte-identical to the
last commit.

**What exactly happened when the Drive stream dropped?** The mpv process ended
abnormally (exit code `0xFFFFFFFF`) with no `end-file` and no error of any kind. Drive
and the proxy were healthy throughout — no proxy error event, 28 MB/s measured. The
app noticed within seconds and later respawned the engine and resumed.

**Is the watchdog buggy?** No — it never fired. The actual detector was the IPC pipe
EOF, which is the correct signal.

**Is the recovery buggy?** No. It is bounded, it recovers, and it leaves no duplicates
or orphans.

**What is actually wrong?** The *message*. A dead mpv engine is unconditionally
labelled a network failure, which is why Phase 7 spent its time investigating Drive
bandwidth for an engine-process problem. That is worth fixing, and the fix is small
and located — it is a product-copy decision, so it is flagged rather than applied.

**Is `--hwdec=auto-safe` still correct?** Yes, untouched. Nothing in this phase
produced evidence to change it.