//! Windows `FileVersion` / `ProductVersion` reader.
//!
//! `GetFileVersionInfoSizeW` -> `GetFileVersionInfoW` -> `VerQueryValueW` against
//! the fixed `VS_FIXEDFILEINFO` block. Only `dwFileVersionMS`/`dwFileVersionLS`
//! are read: they are the four `u16` components every PE linker writes, and they
//! are what distinguishes a real Windows executable from a file of the right
//! size full of junk.
//!
//! No new crate: the `windows` crate is already a dependency (and already
//! carries `Win32_Storage_FileSystem` for other call sites).

use std::path::Path;

/// Version components read out of the resource, already formatted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileVersion {
    pub major: u16,
    pub minor: u16,
    pub patch: u16,
    pub build: u16,
}

impl FileVersion {
    /// `major.minor.patch.build`, the same shape Explorer shows.
    pub fn to_display(&self) -> String {
        format!("{}.{}.{}.{}", self.major, self.minor, self.patch, self.build)
    }

    /// A version is only meaningful if at least one component is non-zero:
    /// a PE with an empty `VS_FIXEDFILEINFO` reports four zeroes.
    pub fn is_meaningful(&self) -> bool {
        self.major != 0 || self.minor != 0 || self.patch != 0 || self.build != 0
    }
}

#[cfg(windows)]
pub fn read_file_version(path: &Path) -> Result<FileVersion, String> {
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{
        GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW, VS_FIXEDFILEINFO,
    };

    let wide = to_wide_null(path)?;

    // SAFETY: `wide` is a NUL-terminated UTF-16 buffer that outlives every call
    // below; `handle` is unused afterwards; the `version_data` buffer is sized by
    // the API itself and only read within that size.
    unsafe {
        let size = GetFileVersionInfoSizeW(PCWSTR(wide.as_ptr()), None);
        if size == 0 {
            return Err(format!(
                "no version resource ({})",
                std::io::Error::last_os_error()
            ));
        }

        let mut data = vec![0u8; size as usize];
        if GetFileVersionInfoW(PCWSTR(wide.as_ptr()), None, size, data.as_mut_ptr().cast()).is_err() {
            return Err(format!(
                "version resource unreadable ({})",
                std::io::Error::last_os_error()
            ));
        }

        // Root block: `\\` selects the VS_FIXEDFILEINFO of the file itself.
        let root: Vec<u16> = "\\\0".encode_utf16().collect();
        let mut info_ptr: *mut core::ffi::c_void = core::ptr::null_mut();
        let mut info_len: u32 = 0;
        if !VerQueryValueW(
            data.as_ptr().cast(),
            PCWSTR(root.as_ptr()),
            &mut info_ptr,
            &mut info_len,
        )
        .as_bool()
            || info_ptr.is_null()
        {
            return Err(format!(
                "version resource has no fixed info ({})",
                std::io::Error::last_os_error()
            ));
        }
        if (info_len as usize) < std::mem::size_of::<VS_FIXEDFILEINFO>() {
            return Err(format!(
                "fixed info block is truncated ({info_len} bytes, need {})",
                std::mem::size_of::<VS_FIXEDFILEINFO>()
            ));
        }

        let info = &*(info_ptr as *const VS_FIXEDFILEINFO);
        // VS_FFI_SIGNATURE == 0xFEEF04BD. Without it the block is not a
        // VS_FIXEDFILEINFO and the version words below are meaningless.
        const VS_FFI_SIGNATURE: u32 = 0xFEEF04BD;
        if info.dwSignature != VS_FFI_SIGNATURE {
            return Err(format!("fixed info signature mismatch (0x{:08X})", info.dwSignature));
        }

        Ok(FileVersion {
            major: (info.dwFileVersionMS >> 16) as u16,
            minor: (info.dwFileVersionMS & 0xFFFF) as u16,
            patch: (info.dwFileVersionLS >> 16) as u16,
            build: (info.dwFileVersionLS & 0xFFFF) as u16,
        })
    }
}

/// Non-Windows: there is no version resource concept, so the caller is told
/// plainly instead of being handed a fake version.
#[cfg(not(windows))]
pub fn read_file_version(_path: &Path) -> Result<FileVersion, String> {
    Err("Windows version resources are not available on this platform".to_string())
}

#[cfg(windows)]
fn to_wide_null(path: &Path) -> Result<Vec<u16>, String> {
    use std::os::windows::ffi::OsStrExt;
    let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
    if wide.contains(&0) {
        return Err("path contains an embedded NUL".to_string());
    }
    wide.push(0);
    Ok(wide)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_is_four_dotted_components() {
        let v = FileVersion { major: 1, minor: 2, patch: 3, build: 4 };
        assert_eq!(v.to_display(), "1.2.3.4");
        assert!(v.is_meaningful());
    }

    #[test]
    fn all_zero_versions_are_not_meaningful() {
        assert!(!FileVersion { major: 0, minor: 0, patch: 0, build: 0 }.is_meaningful());
    }

    #[cfg(windows)]
    #[test]
    fn reads_a_real_windows_binary_version() {
        // kernel32.dll always carries a version resource on a supported Windows.
        let target = std::env::var("SystemRoot")
            .map(|root| Path::new(&root).join("System32").join("kernel32.dll"))
            .expect("SystemRoot must be set on Windows");
        let version = read_file_version(&target).expect("kernel32.dll must have a version");
        assert!(version.is_meaningful(), "{version:?} must not be all zeroes");
        assert_eq!(version.to_display().split('.').count(), 4);
    }

    #[cfg(windows)]
    #[test]
    fn junk_bytes_have_no_readable_version() {
        use crate::playback_runtime::test_support::temp_scope_dir;
        let dir = temp_scope_dir("winver_junk");
        let target = dir.join("fake.exe");
        std::fs::write(&target, vec![0x4Du8; 4096]).unwrap();
        let err = read_file_version(&target).expect_err("junk cannot carry a version resource");
        assert!(!err.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn missing_file_is_an_error_not_a_version() {
        let err = read_file_version(Path::new(r"C:\definitely\not\here\mpv.exe"))
            .expect_err("a missing file cannot have a version");
        assert!(!err.is_empty());
    }
}
