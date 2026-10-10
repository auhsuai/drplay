# VIDEO-PHASE9-ENGINE-DEATH-JOB-LIFECYCLE-REPORT.md

DrPlay — Phase 9 · Engine-death error classification + mpv Job Object lifecycle
Date: 2026-10-08 · Repo `E:\drplay` @ `deeee90` (branch `main`)

---

## 1. Current Architecture

Unchanged from Phase 7/8 and re-verified against source, not assumed:

```
Drive -> OAuth2 (refresh token in Credential Manager, access token in webview localStorage)
      -> stream_proxy (hyper, 127.0.0.1:ephemeral, GET-only, Range passthrough, 206 mirrored)
      -> mpv sidecar (one per session, named-pipe IPC, kill-on-close Job Object)
      -> native video host HWND (--wid, class DrPlayVideoHost)
      -> React UI (VideoSurface measuring div + PlayerBar + context menu)
```

Failure-relevant Rust module ownership:

| Piece | Where |
|---|---|
| sidecar spawn + flags | `mpv/process.rs` (`mpv_flags`) |
| job object | `mpv/job.rs` (`JobHandle`) |
| shared engine state | `mpv/mod.rs:42` `SharedMpv = Arc<Mutex<Option<MpvHandle>>>` |
| state accessor | `mpv/handle.rs:31` `mpv_state(app)` |
| IPC reader / pipe EOF | `mpv/ipc.rs` |
| frontend engine facade | `src/lib/mpvAudio.ts` |

---

## 2. Error Classification Bug

### Old flow (the defect)

```
mpv IPC pipe EOF
  -> Rust: ConnectionClosed  ("[mpv-ipc] pipe closed by mpv")
  -> event "ipc-closed"                        (mpvProtocol.ts, MPV_EVENTS.ipcClosed)
  -> onEngineClosed(cause)                     (mpvAudio.ts, onEngineClosed)
  -> playbackFailure("mpv-engine-closed", cause)
  -> emit("error", { code: "network_interrupted" })
  -> UI: "Network connection lost. Retrying..."
```

`classifyEndFileError()` — which does distinguish network from format — was reached
only from the `end-file` path. The `ipc-closed` path never consulted it, so **every**
engine death was reported as a network failure. A pipe EOF says nothing about the
network: mpv can die on a wedged chain, an OOM, or a crash mid-download.

### New flow

`playbackFailure` gained a defaulted `code` parameter:

```ts
// src/lib/mpvAudio.ts
private playbackFailure(
  where: string, e: unknown, trackIdOverride?: string,
  code: string = "network_interrupted",
): void { ... emit("error", { message: ..., code }, trackIdOverride) }
```

Only the engine-death call site passes the new code:

```ts
// src/lib/mpvAudio.ts:322
this.playbackFailure("mpv-engine-closed", cause, undefined, "engine_closed");
```

The other three callers are untouched and keep `network_interrupted` via the default:
`end-file-network-error`, `play-track-failed`, `failTerminal`.

Resulting semantics:

| Situation | Code | Source of the decision |
|---|---|---|
| stream / proxy / HTTP / network failure | `network_interrupted` | `classifyEndFileError` on `end-file`, plus the transport-ish callers |
| mpv engine or process died outside a commanded shutdown | `engine_closed` | `ipc-closed` |
| commanded shutdown | *(no error at all)* | Rust `mark_shutdown_requested()` suppresses `ipc-closed` |

### UI copy

Added to **both** locale files (`en`, `vi`) — only these two exist:

- `en`: `"The player stopped unexpectedly. Retrying..."`
- `vi`: `"Trình phát đã dừng đột ngột. Đang thử lại..."`

Rendering proof — `src/ui/PlayerBar/ErrorToast.tsx:45-53` is an explicit code→key
ternary chain. Without a new branch, `engine_closed` would have fallen through to the
raw engine message and the fix would have been invisible. `ErrorToast` is the single
surface, used by both `PlayerBar.tsx:157` and `NowPlayingView.tsx:236`.
`PlayerErrorInfo.code` is a plain `string`, so no type change was needed, and no
English was hard-coded into player code.

The toast icon also distinguishes the two classes: `WifiOff` for
`network_interrupted`, `TriangleAlert` for `engine_closed`.

### One consequential side-change, reviewed deliberately

`src/hooks/player/usePlayerPlaybackPolicy.ts` matches the code string exactly and
drives `isPlaying`. Renaming the code alone would have left `isPlaying === true` after
mpv died — a real regression introduced by the rename. `engine_closed` was added to
that matcher so prior observable behaviour is preserved. This is UI-state projection,
not recovery, and two tests lock it in.

---

## 3. Job Object Ownership

### Who creates

`pin_to_job` (`mpv/process.rs:296`) → `JobHandle::create_with_kill_on_close()`
(`mpv/job.rs`). Called from exactly one place: `spawn_mpv`.

### Who owns

`SpawnedSidecar { child, job }` (`mpv/process.rs:229`) → moved into
`MpvHandle { ipc, child, job, pipe_name }` (`mpv/mod.rs:155`) → `*slot = Some(handle)`
(`mpv/mod.rs:157`), stored in `Arc<Mutex<Option<MpvHandle>>>` on the Tauri app
(`mpv/handle.rs:35`).

`JobHandle.job` has **no `Clone` and no `Arc`** — the crate-wide search for
`JobHandle`/`MpvHandle` found 6 construction/field sites, only 2 of them live.
`running_ipc_from_state` clones only `Arc<MpvIpc>`, so a resolved IPC handle can
neither keep the job alive nor kill mpv. **Exactly one owner, always.**

### Who can drop the last reference

| # | Path | Sidecar still expected alive? |
|---|---|---|
| 1 | `mpv_shutdown` → `take_labelled("mpv_shutdown")`, local drops at fn end | No — commanded |
| 2 | `mpv_spawn` reaping a dead predecessor → `mpv_spawn_respawn` | No — already exited |
| 3 | `mpv_spawn` pipe-connect failure → `mpv_spawn_pipe_connect_failed` | No — spawn failed |
| 4 | `mpv_spawn` observe-property failure → `mpv_spawn_observe_failed` | No — spawn failed |
| 5 | `pin_to_job` assign failure, `job` local drops | No — child already killed |
| 6 | app-state drop at teardown (`lib.rs:277-284`) | No — app is exiting |
| 7 | `video_lifecycle.rs` test harness `Session` | test-only |

Paths 1–5 `start_kill()` the child **before** the job closes, so the close is a
backstop, not the kill.

**No code path was found that drops the job while the sidecar is alive.**

Two sharp edges worth recording, both **not** bugs:
- `mpv_spawn`'s `Err(poll_error)` branch closes the job when the liveness *poll
  failed* — i.e. when liveness is genuinely **unknown**, not known-dead.
- path 4 returns without `wait()`, relying on the job close for reaping.

---

## 4. Instrumentation

Lifecycle transitions only. Zero per-frame, per-rect, per-poll or per-Range lines.

| Log line | Where |
|---|---|
| `[mpv-job] created job {id} (kill-on-close)` | `job.rs` |
| `[mpv-job] assigned job {id} to child pid {pid}` | `job.rs` |
| `[mpv-job] job {id} released by {reason}` | `job.rs` (`mark_teardown`) |
| `[mpv] sidecar exited (pid {pid}, {status}); respawning` | `mpv/mod.rs` |
| `[mpv] sidecar exited (pid {pid}, {status}) before the app-exit kill` | `mpv/handle.rs` |
| `[mpv] failed to poll the sidecar during the app-exit kill: {err}` | `mpv/handle.rs` |
| `[mpv-ipc] pipe closed by mpv` | unchanged, `mpv/ipc.rs` |

`{id}` is a process-wide monotonic counter — deliberately **not** the raw `HANDLE`,
so no address is leaked into logs. `{reason}` ∈ `mpv_shutdown`,
`mpv_spawn_respawn`, `mpv_spawn_pipe_connect_failed`, `mpv_spawn_observe_failed`.

Previously the exit status was only logged *inside* `mpv_spawn` — i.e. too late, and
only if something happened to spawn again. It is now logged where it is observed.

### Drop-logging safety — the original caution was investigated, not deleted

The pre-existing comment said logging from `Drop` risks deadlock because "Drop runs on
teardown paths (incl. process exit)". Investigated: the app's logger is
`tauri-plugin-log` writing to a file plus stdout (`lib.rs:174-188`), so a `log::`
call from `Drop` can block the dropping thread on that plugin's file lock or on disk,
on either a tokio worker or the main thread during App teardown — exactly where a
blocking destructor can hang process exit.

Rather than gamble, the log line moved to `mark_teardown` (`job.rs`), called from
ordinary command code where logging is safe. `Drop` still logs nothing; it records the
close into a `#[cfg(test)]`-only `Mutex<Vec<(id, reason)>>`, poisoned-lock-recovered,
which no caller can already hold. Production evidence for a close is therefore
`[mpv-job] job N released by <reason>`.

---

## 5. Reproduction

### Live instrumented run

Build: `cargo test --lib` → `ok. 178 passed; 0 failed; 15 ignored` (baseline 172, +6).
App relaunched with the instrumented binary and observed:

```
[14:16:48] [mpv-job] created job 1 (kill-on-close)
[14:16:48] [mpv-job] assigned job 1 to child pid 148
```

### Experiment T1 — external kill (the decisive one)

`Stop-Process -Force` on the live mpv, watching the log:

```
[14:06:09] [mpv-job] created job 1 (kill-on-close)
[14:06:09] [mpv-job] assigned job 1 to child pid 7256
      ... playback ...
[14:10:03] [mpv-ipc] pipe closed by mpv                                  <- death
[14:10:20] [mpv] sidecar exited (pid 7256, exit code: 0xffffffff); respawning
[14:10:20] [mpv-job] job 1 released by mpv_spawn_respawn                <- job closed 17s LATER
[14:10:20] [mpv] spawning sidecar ...
[14:10:20] [mpv-job] created job 2 (kill-on-close)
[14:10:20] [mpv-job] assigned job 2 to child pid 12044
```

**The job was closed AFTER the death, not before.** The Job Object was still open and
still owned by the app when mpv died.

Also observed: after the kill, `mpv` count stayed `0` for at least 100 s — no
auto-respawn. Confirms Phase 8's finding that recovery is **reactive**, not automatic.

### Experiment T2 — graceful window close

`CloseMainWindow()` (WM_CLOSE, not force-kill):

```
[14:16:48] [mpv-job] created job 1 ... assigned job 1 to child pid 148
(graceful close -> app closed, mpv=0)
--- log lines produced: only the two spawn lines ---
```

No `mpv-job released by ...` at all. Reason found in source — app exit does **not**
use `mpv_shutdown`:

```rust
// src-tauri/src/lib.rs:277-290
tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
    // mpv now (sync; cannot await mpv_shutdown here) ...
    mpv_kill_sync_best_effort(app_handle);
    video_host::destroy();
}
```

`mpv_kill_sync_best_effort` holds the handle in the slot, so the job closes
silently when the app state drops. mpv was correctly terminated (`mpv=0`), but the
close is **unlabelled and therefore invisible in production logs**.

---

## 6. Failure Timeline

Original incident, from `DrPlay.log` + the rotated `mpv.1` (UTC; +7 h for local):

```
11:54:55 [mpv] spawning sidecar (pipe ...6b721df0)      app start
11:54:56 [stream-proxy] started on 127.0.0.1:2098
   ... playback, no proxy errors ...
12:11:24 [mpv-ipc] pipe closed by mpv                  *** ENGINE DIED #1 ***
12:12:34 [mpv] previous sidecar exited (exit code: 0xffffffff); respawning
   ... ~4.5 min ...
12:17:08 [mpv-ipc] pipe closed by mpv                  *** ENGINE DIED #2 ***  (= mpv.1)
12:30:55 [mpv] previous sidecar exited (exit code: 0xffffffff); respawning
```

Detection-to-respawn: **70 s** and **13 min 47 s**. The dying session's log stops
mid-buffering after a subtitle switch and a texture recreate:

```
[269.811][i][cplayer] Track switched: ● Video (hevc [Main 10] 3840x1600 25 fps)
[269.861][d][vo/gpu-next/libplacebo] (Re)creating 1896x790x0 texture rgba16hf
[269.891][i][cplayer] Enter buffering (buffer went from 100% -> 0%)
<log ends>
```

No `end-file`, no error, no exit marker.

Proxy state at failure: clean. The only proxy warning in the log is from 9.5 h earlier
and a different file (`upstream body idle for 20s (file 1Iouwn2MU...)`). No
`stream-proxy-error`, no 401/429/5xx, no proxy restart at either death.

---

## 7. Root Cause

### Part 1 — CORRECTION of the Phase 8 hypothesis (evidence-based refutation)

Phase 8 concluded the kill-on-close Job Object was "the mechanism consistent with the
evidence", partly on the reasoning that exit code `0xFFFFFFFF` is that mechanism's
signature. **T1 refutes that reasoning on both counts:**

1. **The job was not closed before the death.** `[mpv-job] job 1 released by
   mpv_spawn_respawn` appears 17 s *after* `pipe closed by mpv`. When mpv died, the
   app still owned an open job.
2. **`0xFFFFFFFF` carries no information about the killer.** It appeared identically
   for an ordinary `Stop-Process -Force` from PowerShell. It is the generic Windows
   exit code for a force-terminated process, not a Job-Object-specific signature.

So the Job Object is **exonerated** for this failure mode, and `0xFFFFFFFF` must not
be read as evidence about the cause. This is a correction of my own earlier reasoning,
not a refinement.

### Part 2 — Engine death classification: FIXED

See §2. Confirmed defect, fixed with regression coverage in both directions.

### Part 3 — Proximate cause of the original death: still UNKNOWN

What is established:

- the death is in the mpv **process** layer, not Drive, proxy, decode, bandwidth,
  watchdog or IPC
- it was **not** a commanded shutdown (`shutdown_requested` was not set, proven by the
  reader logging `pipe closed by mpv`)
- it was **not** the kill-on-close Job Object (T1)
- it was **not** an unhandled exception (no Windows Application Error / WER record)
- it was **not** bandwidth (28 MB/s measured against 0.41 MB/s required)

What is not established: **who sent the termination.** Remaining candidates, none
currently supported by evidence:

- an external actor (another process, task manager, session change)
- mpv's own fatal internal exit path
- a Windows/driver event

The instrumentation is now in place, so the **next** occurrence will carry the answer
(`[mpv-job] ... released by ...` immediately before or after `[mpv-ipc] pipe closed`,
and the exit status with the pid). This incident itself is not retroactively solvable.

---

## 8. Fix

### Applied

| File | Change |
|---|---|
| `src/lib/mpvAudio.ts` | `playbackFailure` gained a defaulted `code` param; engine-death call site passes `engine_closed` |
| `src/ui/PlayerBar/ErrorToast.tsx` | new `engine_closed` branch + `TriangleAlert` icon |
| `src/hooks/player/usePlayerPlaybackPolicy.ts` | `engine_closed` added to the code matcher, preserving `isPlaying` |
| `src/locales/en/translation.json`, `src/locales/vi/translation.json` | new `engine_closed` key |
| `src-tauri/src/mpv/{job.rs,handle.rs,mod.rs,ipc.rs,tests.rs}` | lifecycle instrumentation, non-semantic job id + teardown reason label, 6 tests |

**No recovery behaviour was changed.** Engine epoch, `swapSidecar`,
`loadRestarts`/`LOADFILE_RESTART_MAX_ATTEMPTS`, stale-listener detach,
`ensureVideoHostAcquired()`, `mark_shutdown_requested` semantics, buffering settle —
all untouched. `--hwdec=auto-safe`, VO, gpu-context and the proxy are untouched.

### Not applied (deliberate)

Labelling the app-exit teardown path. `lib.rs:284` closes the job with no log line
(§5 T2), so an app exit is indistinguishable from an unexpected job release in
production logs. Adding `mark_teardown("app_exit")` there is a two-line change, but it
was not requested and this phase's brief says not to widen scope. Recorded as the
top follow-up in §16.

---

## 9. Recovery

Unchanged and re-confirmed against the instrumented build:

| Property | Observed | Verdict |
|---|---|---|
| Detect engine death | `pipe closed by mpv` within ~1 s | correct |
| Distinguish commanded shutdown | reader suppression via `mark_shutdown_requested` | correct |
| Log the exit status at observation time | now logged with pid | improved |
| Bounded restart budget | 1 restart, then `failTerminal` | correct |
| Restart bounded in time | 10 s per IPC call | correct |
| Connection identity re-based | `engineEpoch = 0` + `noteSpawnReply` | correct |
| Video host re-acquired for the replacement | `ensureVideoHostAcquired()` after shutdown, before spawn | correct |
| Stale listeners detached | `detachListeners` | correct |
| Playback resumes | observed after both deaths and after T1 | correct |
| Automatic self-heal | none — waits for the next request | reactive, by design |
| Job closed while sidecar alive | never observed | correct |
| Duplicate mpv | none observed | correct |
| Orphan mpv | none | correct |

---

## 10. Normal Shutdown Control

`CloseMainWindow()` → app closed, `drplay=0`, `mpv=0`. Correct outcome, but the log
evidence is **missing**: no `mpv-job released by` line, because app exit uses
`mpv_kill_sync_best_effort` (`lib.rs:284`) and then a silent state drop, not
`mpv_shutdown`.

So the *behaviour* is correct and the *observability* is not. The unit test JOB-003
covers the `mpv_shutdown` path itself (`take_labelled("mpv_shutdown")`), but the live
app-exit path is a different code path and is currently uninstrumented.

## 11. Manual Kill Control

T1 above. Result: `engine_closed` semantics on the frontend side, exit status
`(pid 7256, exit code: 0xffffffff)`, job released afterwards as
`mpv_spawn_respawn`, new job created, playback recoverable, no duplicate, no orphan.
The instrumentation did **not** misreport this as a shutdown.

## 12. Network Failure Control

`network_interrupted` remains on every genuine transport path, verified by the
pre-existing tests that were left untouched and still pass: proxy 503, proxy 429
(rate limit), proxy 499 (mid-stream idle abort), and "Connection reset by peer".
The new paired test asserts the two codes appear as distinct events in one session
(`["engine_closed", "network_interrupted"]`).

`src-tauri` was not modified for this control; the proxy is out of scope and was not
touched.

---

## 13. Audio Regression

No production recovery logic changed and no Rust behaviour changed, only log lines
plus a non-semantic id/label. Verified anyway:

| Layer | Result |
|---|---|
| Rust | `cargo test --lib -- --test-threads=1` → `ok. 178 passed; 0 failed; 15 ignored` |
| Types | `npx tsc --noEmit` → exit 0 |
| Frontend | `npx vitest run src/lib src/hooks src/ui` → **1789 passed (131 files), 0 failed** |

Media-kind behaviour (`classifyMediaKind` → `set_property video "1"/"no"` before
`loadfile`) untouched. Media switches were not exercised interactively in this phase
— stated as a limitation rather than claimed.

---

## 14. Process / Window Cleanup

After both live experiments and the control test:

```
drplay.exe            0
mpv.exe               0
listening on 1420     1   (vite dev server, intentionally left running)
```

Two orphaned `mpv.exe` found during Phase 8 were already removed with the probe test.
None created in this phase.

---

## 15. Tests

| Suite | Result |
|---|---|
| `cargo test --lib -- --test-threads=1` | `ok. 178 passed; 0 failed; 15 ignored` (baseline 172 → +6 JOB tests) |
| `cargo check --lib --tests` | 0 errors, 0 warnings |
| `npx tsc --noEmit` | exit 0 |
| `npx eslint` on changed files | exit 0 |
| `npx vitest run src/lib` | 318 passed (24 files) |
| `npx vitest run src/lib src/hooks src/ui` | **1789 passed (131 files), 0 failed** |

New Rust tests (JOB-001…JOB-006), all passing:

```
job_creation_hands_out_unique_monotonic_ids                          JOB-001
job_assignment_to_a_live_child_succeeds_and_leaves_the_job_open       JOB-002
a_commanded_shutdown_closes_the_job_with_its_reason                   JOB-003
an_unexpected_child_death_is_not_recorded_as_a_commanded_shutdown     JOB-004
dropping_the_last_reference_records_the_id_and_reason                 JOB-005
the_job_stays_open_across_a_command_round_trip                       JOB-006
```

New frontend tests: `ipc-closed → engine_closed`, and a paired test proving engine
death and a real transport failure stay distinct in one session.

**RED→GREEN were demonstrated, not assumed** — for the frontend fix by temporarily
reverting the call site (`2 failed | 96 passed` → `98 passed`), and for the Rust
instrumentation by neutering `mark_teardown` (`5 passed; 2 failed`, with
`left: Some("unlabelled")` vs `right: Some("mpv_shutdown")`) → restored to `178 ok`.

Not run: the full `npx vitest run`. On this 4-core box it previously hit
`[vitest-pool]: Failed to start forks worker` and produced a flaky sibling failure in
`TabContentRouter.test.tsx` that passes in isolation. That is a known environmental
issue (Phase 8), not a regression; no test was deleted or weakened.

---

## 16. Remaining Risks

**Top follow-up — the one real observability gap found this phase:**

1. **App-exit closes the job with no log line.** `lib.rs:284` uses
   `mpv_kill_sync_best_effort`, which keeps the handle in the slot, so the subsequent
   state drop closes the job unlabelled. Consequence: in production logs a normal app
   exit and an unexpected job release look identical, and the app-exit path is the
   one place the instrument cannot currently speak. Fix: `mark_teardown("app_exit")`
   at that site.

2. **Proximate cause of the original engine death remains unknown** (§7 part 3). The
   instrument now answers it, but only for the *next* occurrence. It cannot be
   determined retroactively from the retained two-generation logs.

3. **`mpv_spawn`'s `Err(poll_error)` branch** closes the job when liveness is
   *unknown*. It is not a bug today, but it is the one branch that could, in
   principle, close a job for a sidecar that is actually alive. Worth a follow-up
   decision on whether that branch should `start_kill()` first like the others.

4. **`0xFFFFFFFF` is uninformative.** Any forced termination looks identical. If
   attribution ever matters again, the only reliable source is the job lifecycle log.

5. **Pre-existing, untouched:** `[video-host] rect …` log spam; the
   `Chrome_RenderWidgetHostHWND` focus warning; `playback-rate` not readable over IPC;
   seek latency unmeasurable from mpv properties. None is implicated in this
   incident.

6. **Repo is not rustfmt-clean at `HEAD`.** `cargo fmt` still dirties ~22 files. Not
   actioned (Phase 8 finding, repeated here as a standing hazard).

---

## 17. Final Verdict

```
Error classification:
FIXED  — ipc-closed now reports engine_closed; network_interrupted retained for
        genuine transport failures; new en/vi copy; recovery untouched.

Engine death:
PARTIALLY KNOWN
  Layer: mpv PROCESS lifecycle (proven: pipe EOF, no end-file, no proxy error,
         no WER record, not bandwidth, not a commanded shutdown).
  Killer: UNKNOWN. Not the Job Object, not an exception.

Job Object:
CORRECT  — single owner, never dropped while the sidecar is alive (7 drop paths
           traced, all post-mortem or spawn-failure). Empirically exonerated:
           the job was still open 17s AFTER mpv died.

Watchdog:
NOT INVOLVED  — never fired in this incident or in either control experiment.

Recovery:
CORRECT  — prompt detection, bounded restart, identity re-based, host re-acquired,
           resumes, no duplicate, no orphan. Reactive, not automatic.

Network:
NOT ROOT CAUSE  — 28 MB/s measured vs 0.41 MB/s required; no proxy error event;
           no 401/429/5xx; proxy state clean at both deaths.

Audio regression:
PASS  — cargo 178/0, tsc 0, vitest 1789/0; no recovery logic changed.

Orphan:
NONE  — 0 mpv.exe, 0 drplay.exe after all experiments.

Production changes:
YES  — error classification fix (5 source files + 5 Rust instrumentation files).
       No recovery behaviour, no mpv flag, no proxy, no auth change.
```

### Direct answers

**Is an engine death still reported as a network error?** No. It now reports
`engine_closed` with copy that says the player stopped, and a distinct icon. A real
network failure still reports `network_interrupted`.

**Is the Job Object killing mpv?** No — and that is now proven rather than assumed.
The job stays open across the death and is released afterwards, as a reaping step.

**So why did mpv die?** Still unknown. What was eliminated this phase: the Job Object,
an unhandled exception, a commanded shutdown, the watchdog, bandwidth, and the proxy.
The instrumentation is in place, so the next occurrence will say.

**Is `--hwdec=auto-safe` still correct?** Yes. Untouched, and nothing this phase
produced evidence to change it.