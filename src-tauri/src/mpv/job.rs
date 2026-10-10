//! Windows Job Object pinning the mpv sidecar to the app's lifetime.
//!
//! Why this exists: `tokio::process::Child` with `kill_on_drop(true)` only
//! dies when the `Child` value is actually dropped in order. On abrupt exits
//! (`taskkill /F`, crash, MSI Restart Manager kill) destructors never run and
//! the sidecar orphans, locking `mpv.exe` against reinstall. A Job Object
//! with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` moves the guarantee into the OS:
//! when the last job handle closes — which the kernel does on ANY parent
//! death — every process in the job is terminated. No userspace teardown runs.

use std::sync::atomic::{AtomicU64, Ordering};
use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, HANDLE};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JobObjectExtendedLimitInformation,
};

/// Process-wide monotonic job id, handed out at creation. Deliberately NOT the
/// raw HANDLE: a log line must never carry a live address, and this id is what
/// ties one job's `created` / `assigned` / close lines together.
static NEXT_JOB_ID: AtomicU64 = AtomicU64::new(1);

/// Label recorded when a job is released with no teardown site having named it.
/// Per the ownership trace the only such close is the app-state drop at process
/// exit; naming it "unlabelled" keeps the record honest instead of guessing a
/// path that may not be the real one. Tests only — in production an unnamed
/// close simply has no log line (see the Drop note).
#[cfg(test)]
pub(crate) const UNLABELLED_CLOSE: &str = "unlabelled";

/// RAII owner of one kill-on-close job. The handle must stay alive as long as
/// the sidecar runs: closing the last handle terminates the job's processes,
/// so dropping this early would kill mpv mid-session.
pub(crate) struct JobHandle {
    raw: HANDLE,
    /// Monotonic process-wide id, fixed at creation. See `NEXT_JOB_ID`.
    pub(crate) id: u64,
    /// Which teardown path owns the upcoming close. `None` while the job is
    /// still normally owned; `mark_teardown` names it so the close record
    /// attributes the close to a path instead of leaving it anonymous.
    #[allow(dead_code)] // read only by the cfg(test) close record in `Drop`
    reason: Option<&'static str>,
}

// The raw HANDLE is only touched via kernel calls that are thread-safe; the
// owning struct is moved between the spawn site and the shared state slot.
unsafe impl Send for JobHandle {}
unsafe impl Sync for JobHandle {}

impl JobHandle {
    /// Create an empty job that terminates its processes when closed.
    pub(crate) fn create_with_kill_on_close() -> Result<Self, String> {
        // why zeroed: only LimitFlags carries meaning here; every other
        // limit field must be 0/absent or the kernel enforces garbage caps.
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION =
            unsafe { std::mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

        // SAFETY: null attributes/name = anonymous, inheritable job; `limits`
        // outlives the synchronous SetInformationJobObject call below.
        let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if job.is_null() {
            let code = unsafe { GetLastError() };
            return Err(format!(
                "mpv job: CreateJobObjectW failed (GetLastError={code})"
            ));
        }
        let applied = unsafe {
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if applied == 0 {
            let code = unsafe { GetLastError() };
            unsafe {
                CloseHandle(job);
            }
            return Err(format!(
                "mpv job: SetInformationJobObject(KILL_ON_JOB_CLOSE) failed (GetLastError={code})"
            ));
        }
        let id = NEXT_JOB_ID.fetch_add(1, Ordering::Relaxed);
        log::info!("[mpv-job] created job {id} (kill-on-close)");
        Ok(Self {
            raw: job,
            id,
            reason: None,
        })
    }

    /// Pin a spawned child into this job. Must run immediately after spawn so
    /// the pre-assign window (orphanable on instant parent death) stays ~ms.
    /// Fails loud on purpose: a child outside any job is a future orphan, so
    /// the caller must kill it and surface the Err instead of continuing.
    pub(crate) fn assign(&self, child: &tokio::process::Child) -> Result<(), String> {
        // why Option: tokio reports None once the child was reaped — assigning
        // a dead process would silently succeed at nothing, so fail loud.
        let Some(raw) = child.raw_handle() else {
            return Err(
                "mpv job: cannot assign the sidecar, it already exited (no live process handle); \
                 refusing to leave it outside the kill-on-close job"
                    .to_string(),
            );
        };
        let child_handle = raw as HANDLE;
        // SAFETY: both handles are live (borrowed) for the duration of the call.
        let ok = unsafe { AssignProcessToJobObject(self.raw, child_handle) };
        if ok == 0 {
            let code = unsafe { GetLastError() };
            return Err(format!(
                "mpv job: AssignProcessToJobObject failed (GetLastError={code}); \
                 refusing to leave the sidecar outside the kill-on-close job"
            ));
        }
        log::info!(
            "[mpv-job] assigned job {} to child pid {}",
            self.id,
            child.id().unwrap_or_default()
        );
        Ok(())
    }

    /// Name the teardown path that is about to release this job. Closing the
    /// last job handle IS the kill, so a close must name the path that caused
    /// it; `Drop` records this label (see the note there).
    ///
    /// The `log::info!` lives HERE, not in `Drop`: teardown sites are ordinary
    /// command code (an async command body, a respawn branch), where a log
    /// call cannot deadlock.
    pub(crate) fn mark_teardown(&mut self, reason: &'static str) {
        self.reason = Some(reason);
        log::info!("[mpv-job] job {} released by {reason}", self.id);
    }
}

/// Close records, tests only: `(job id, reason)`, newest last. `Drop` cannot
/// log (see below) and nothing in production reads this, so it exists purely so
/// a test can assert *which* path closed a job and that a live one is still
/// open. The lock is taken and released inside these two functions only, so no
/// caller can already hold it; a poisoned lock is recovered from, never
/// propagated.
#[cfg(test)]
static CLOSED_JOBS: std::sync::Mutex<Vec<(u64, &'static str)>> = std::sync::Mutex::new(Vec::new());

#[cfg(test)]
fn lock_closed_jobs() -> std::sync::MutexGuard<'static, Vec<(u64, &'static str)>> {
    CLOSED_JOBS.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Reason the close record gives for `id`, or `None` while that job is still
/// open (its last reference has not been dropped yet).
#[cfg(test)]
pub(crate) fn recorded_close(id: u64) -> Option<&'static str> {
    lock_closed_jobs().iter().rev().find(|(closed_id, _)| *closed_id == id).map(|(_, reason)| *reason)
}

impl Drop for JobHandle {
    fn drop(&mut self) {
        // why no log here: Drop runs on teardown paths (incl. process exit)
        // where logging can deadlock; the kernel kill is the guarantee.
        //
        // Concretely (investigated, not assumed): the app's logger is
        // tauri-plugin-log writing to a file in the app log dir plus stdout
        // (lib.rs:174), so a log call from here can block the dropping thread
        // on the plugin's own file lock or on disk. This Drop may run on a
        // tokio worker or on the main thread while the Tauri App state is
        // torn down, i.e. exactly where a blocking destructor can hang process
        // exit — the one path that must never hang. So the close is recorded
        // WITHOUT logging (a lock the caller cannot already hold) and is named
        // at the teardown sites via `mark_teardown`, which log from ordinary
        // command code instead. Production evidence for a close is therefore
        // `[mpv-job] job N released by <reason>`; tests additionally read the
        // close record through `recorded_close`.
        #[cfg(test)]
        lock_closed_jobs().push((self.id, self.reason.unwrap_or(UNLABELLED_CLOSE)));
        unsafe {
            CloseHandle(self.raw);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{recorded_close, JobHandle, UNLABELLED_CLOSE};

    /// Bound for the OS to reap the child after the job closes (local kill is
    /// ~instant; the budget only absorbs CI scheduling jitter).
    const JOB_REAP_TIMEOUT_SECS: u64 = 5;

    /// Spawn a long-lived dummy child (so nothing exits on its own mid-test)
    /// and pin it to `job`, returning both.
    async fn dummy_child_in_job() -> (tokio::process::Child, JobHandle) {
        let child = tokio::process::Command::new("cmd")
            .args(["/C", "ping -n 30 127.0.0.1 >NUL"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("dummy child must spawn");
        let job = JobHandle::create_with_kill_on_close().expect("job object must be created");
        job.assign(&child).expect("child must join the job");
        (child, job)
    }

    /// JOB-001: every job gets a stable id of its own, which is what the
    /// `created` / `assigned` / close log lines are correlated by. The id must
    /// be monotonic and never collide — two jobs sharing an id would make a
    /// close record ambiguous.
    #[test]
    fn job_creation_hands_out_unique_monotonic_ids() {
        let first = JobHandle::create_with_kill_on_close().expect("job object must be created");
        let second = JobHandle::create_with_kill_on_close().expect("job object must be created");

        assert!(first.id >= 1, "job ids start at 1, got {}", first.id);
        assert!(
            second.id > first.id,
            "job ids must be monotonic, got {} then {}",
            first.id,
            second.id
        );
    }

    /// JOB-002: assigning a live child succeeds AND leaves the job open —
    /// "assign returned Ok" must be observable as a job nobody has closed yet,
    /// otherwise a successful assign would be indistinguishable from a job that
    /// was closed right after.
    #[tokio::test]
    async fn job_assignment_to_a_live_child_succeeds_and_leaves_the_job_open() {
        let (_child, job) = dummy_child_in_job().await;

        assert_eq!(
            recorded_close(job.id),
            None,
            "a job whose child was just assigned must still be open"
        );
        drop(job); // kill-on-close takes the dummy child with it
    }

    /// JOB-005: the drop of the LAST reference is the evidence this whole
    /// instrumentation exists to produce, so it must be recorded with both the
    /// job id and the reason its teardown site gave. Also pins the unlabelled
    /// default: a close nobody named must say so rather than look attributed.
    #[test]
    fn dropping_the_last_reference_records_the_id_and_reason() {
        let mut labelled = JobHandle::create_with_kill_on_close().expect("job must be created");
        let labelled_id = labelled.id;
        labelled.mark_teardown("mpv_shutdown");
        drop(labelled);

        let plain = JobHandle::create_with_kill_on_close().expect("job must be created");
        let plain_id = plain.id;
        drop(plain);

        assert_eq!(
            recorded_close(labelled_id),
            Some("mpv_shutdown"),
            "the close must carry the reason its teardown site set"
        );
        assert_eq!(
            recorded_close(plain_id),
            Some(UNLABELLED_CLOSE),
            "a close no teardown site named must record that, not guess a path"
        );
    }

    /// OS guarantee: closing the job must terminate the child even when the
    /// parent never issues an explicit kill (taskkill /F, crash, MSI restart).
    /// The child runs far longer than the reap budget on purpose: the only way
    /// this test can pass is the job close actually killing it (a natural exit
    /// would time out, and the strict elapsed bound would catch a near-budget
    /// flake).
    #[tokio::test]
    async fn job_close_terminates_child_without_explicit_kill() {
        let mut child = tokio::process::Command::new("cmd")
            .args(["/C", "ping -n 30 127.0.0.1 >NUL"]) // ~30s natural runtime
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("dummy child must spawn");
        let job =
            JobHandle::create_with_kill_on_close().expect("job object must be created");
        job.assign(&child).expect("child must join the job");
        let started = std::time::Instant::now();
        drop(job); // closing the last job handle must kill the child
        tokio::time::timeout(
            std::time::Duration::from_secs(JOB_REAP_TIMEOUT_SECS),
            child.wait(),
        )
        .await
        .expect("child must exit within the reap budget of the job closing")
        .expect("child wait must not fail");
        assert!(
            started.elapsed() < std::time::Duration::from_secs(2),
            "child must be killed promptly by the job close (took {:?})",
            started.elapsed()
        );
    }

    /// Fail-loud guarantee: assigning a child that already exited must return
    /// a typed Err (never a silent orphan outside any job).
    #[tokio::test]
    async fn job_assign_to_exited_child_returns_err() {
        let mut child = tokio::process::Command::new("cmd")
            .args(["/C", "exit 0"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("dummy child must spawn");
        let _ = child.wait().await.expect("child must exit");
        let job =
            JobHandle::create_with_kill_on_close().expect("job object must be created");
        assert!(
            job.assign(&child).is_err(),
            "assigning an exited child must fail loud, not silently orphan"
        );
    }
}
