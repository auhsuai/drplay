//! Windows Job Object pinning the mpv sidecar to the app's lifetime.
//!
//! Why this exists: `tokio::process::Child` with `kill_on_drop(true)` only
//! dies when the `Child` value is actually dropped in order. On abrupt exits
//! (`taskkill /F`, crash, MSI Restart Manager kill) destructors never run and
//! the sidecar orphans, locking `mpv.exe` against reinstall. A Job Object
//! with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` moves the guarantee into the OS:
//! when the last job handle closes — which the kernel does on ANY parent
//! death — every process in the job is terminated. No userspace teardown runs.

use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, HANDLE};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JobObjectExtendedLimitInformation,
};

/// RAII owner of one kill-on-close job. The handle must stay alive as long as
/// the sidecar runs: closing the last handle terminates the job's processes,
/// so dropping this early would kill mpv mid-session.
pub(crate) struct JobHandle {
    raw: HANDLE,
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
        Ok(Self { raw: job })
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
        Ok(())
    }
}

impl Drop for JobHandle {
    fn drop(&mut self) {
        // why no log here: Drop runs on teardown paths (incl. process exit)
        // where logging can deadlock; the kernel kill is the guarantee.
        unsafe {
            CloseHandle(self.raw);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::JobHandle;

    /// Bound for the OS to reap the child after the job closes (local kill is
    /// ~instant; the budget only absorbs CI scheduling jitter).
    const JOB_REAP_TIMEOUT_SECS: u64 = 5;

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
