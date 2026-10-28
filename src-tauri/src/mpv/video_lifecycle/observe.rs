// ---------------------------------------------------------------------------
// Process / window / memory observation
// ---------------------------------------------------------------------------

#[cfg(windows)]
mod win {
    use windows_sys::Win32::Foundation::{BOOL, FILETIME, HWND, LPARAM};
    use windows_sys::Win32::System::ProcessStatus::{
        GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX,
    };
    use windows_sys::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, PROCESS_QUERY_INFORMATION,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible,
    };

    /// Pid the `EnumWindows` callback filters on. `EnumWindowsProcW` is a plain
    /// fn pointer with no environment, so the target rides in a static and the
    /// collected titles ride in `LPARAM`.
    static ENUM_PID: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

    /// Every VISIBLE top-level window owned by `pid`, with its title. This is
    /// the ground truth for "did mpv open a video window" — a window class or an
    /// assumption about gpu-next would not be evidence, the OS window list is.
    pub fn visible_windows(pid: u32) -> Vec<String> {
        extern "system" fn visit(hwnd: HWND, param: LPARAM) -> BOOL {
            let titles = unsafe { &mut *(param as *mut Vec<String>) };
            let mut owner = 0u32;
            unsafe { GetWindowThreadProcessId(hwnd, &mut owner) };
            let wanted = ENUM_PID.load(std::sync::atomic::Ordering::SeqCst);
            if owner == wanted && unsafe { IsWindowVisible(hwnd) } != 0 {
                let mut buffer = [0u16; 512];
                let length = unsafe { GetWindowTextW(hwnd, buffer.as_mut_ptr(), buffer.len() as i32) };
                if length > 0 {
                    titles.push(String::from_utf16_lossy(&buffer[..length as usize]));
                }
            }
            1
        }

        ENUM_PID.store(pid, std::sync::atomic::Ordering::SeqCst);
        let mut titles: Vec<String> = Vec::new();
        let ok = unsafe { EnumWindows(Some(visit), (&mut titles as *mut Vec<String>) as LPARAM) };
        assert_ne!(ok, 0, "EnumWindows must enumerate (desktop window list unavailable)");
        titles
    }

    /// WorkingSet / PrivateUsage in bytes for `pid`.
    pub fn memory(pid: u32) -> Option<(u64, u64)> {
        let handle = unsafe { OpenProcess(PROCESS_QUERY_INFORMATION, 0, pid) };
        if handle.is_null() {
            return None;
        }
        let mut counters: PROCESS_MEMORY_COUNTERS_EX = unsafe { std::mem::zeroed() };
        counters.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32;
        let ok = unsafe {
            GetProcessMemoryInfo(
                handle,
                (&raw mut counters).cast::<PROCESS_MEMORY_COUNTERS>(),
                std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32,
            )
        };
        unsafe { windows_sys::Win32::Foundation::CloseHandle(handle) };
        (ok != 0).then_some((counters.WorkingSetSize as u64, counters.PrivateUsage as u64))
    }

    /// (kernel + user) CPU seconds consumed by `pid` so far.
    pub fn cpu_secs(pid: u32) -> Option<f64> {
        let handle = unsafe { OpenProcess(PROCESS_QUERY_INFORMATION, 0, pid) };
        if handle.is_null() {
            return None;
        }
        let mut times = [
            FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 },
            FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 },
            FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 },
            FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 },
        ];
        let ok = unsafe {
            GetProcessTimes(handle, &mut times[0], &mut times[1], &mut times[2], &mut times[3])
        };
        unsafe { windows_sys::Win32::Foundation::CloseHandle(handle) };
        if ok == 0 {
            return None;
        }
        let ticks = |value: FILETIME| {
            (((value.dwHighDateTime as u64) << 32) | value.dwLowDateTime as u64) as f64 / 10_000_000.0
        };
        Some(ticks(times[2]) + ticks(times[3]))
    }

    /// Every live process whose image is `image`, as pids.
    ///
    /// ToolHelp rather than `tasklist`: a test harness must not depend on a
    /// subprocess to answer "is there an orphan engine", and this is the same
    /// enumeration the task manager does.
    pub fn pids_named(image: &str) -> Vec<u32> {
        use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
        use windows_sys::Win32::System::Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
            TH32CS_SNAPPROCESS,
        };
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
        if snapshot == INVALID_HANDLE_VALUE {
            return Vec::new();
        }
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..unsafe { std::mem::zeroed() }
        };
        let mut pids = Vec::new();
        let mut ok = unsafe { Process32FirstW(snapshot, &mut entry) } != 0;
        while ok {
            let end = entry
                .szExeFile
                .iter()
                .position(|unit| *unit == 0)
                .unwrap_or(entry.szExeFile.len());
            if String::from_utf16_lossy(&entry.szExeFile[..end]).eq_ignore_ascii_case(image) {
                pids.push(entry.th32ProcessID);
            }
            ok = unsafe { Process32NextW(snapshot, &mut entry) } != 0;
        }
        unsafe { windows_sys::Win32::Foundation::CloseHandle(snapshot) };
        pids
    }
}

pub(super) fn first_window(pid: u32) -> Option<String> {
    #[cfg(windows)]
    {
        win::visible_windows(pid).into_iter().next()
    }
    #[cfg(not(windows))]
    {
        let _ = pid;
        None
    }
}

pub(super) fn all_windows(pid: u32) -> Vec<String> {
    #[cfg(windows)]
    {
        win::visible_windows(pid)
    }
    #[cfg(not(windows))]
    {
        let _ = pid;
        Vec::new()
    }
}

pub(super) fn memory_mb(pid: u32) -> Option<(f64, f64)> {
    #[cfg(windows)]
    {
        win::memory(pid).map(|(working, private)| (working as f64 / 1048576.0, private as f64 / 1048576.0))
    }
    #[cfg(not(windows))]
    {
        let _ = pid;
        None
    }
}

pub(super) fn cpu_secs(pid: u32) -> Option<f64> {
    #[cfg(windows)]
    {
        win::cpu_secs(pid)
    }
    #[cfg(not(windows))]
    {
        let _ = pid;
        None
    }
}

/// pids of every live `mpv.exe` on the box.
pub(super) fn mpv_pids() -> Vec<u32> {
    #[cfg(windows)]
    {
        win::pids_named("mpv.exe")
    }
    #[cfg(not(windows))]
    {
        Vec::new()
    }
}

/// pids of every live `drplay.exe` on the box.
pub(super) fn drplay_pids() -> Vec<u32> {
    #[cfg(windows)]
    {
        win::pids_named("drplay.exe")
    }
    #[cfg(not(windows))]
    {
        Vec::new()
    }
}

pub(super) fn report(label: impl std::fmt::Display, value: impl std::fmt::Display) {
    println!("[evidence] {label}: {value}");
}

pub(super) async fn assert_no_mpv(context: &str) {
    let pids = mpv_pids();
    report(format!("{context}: mpv.exe pids"), format!("{pids:?}"));
    assert!(pids.is_empty(), "no mpv.exe may survive {context}, got {pids:?}");
}
