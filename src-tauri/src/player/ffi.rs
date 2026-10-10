//! Minimal hand-rolled FFI surface for libmpv (no bindgen).
//!
//! Declarations copied from the header shipped with the adopted DLL
//! (`vendor/mpv/include/mpv/client.h`, mpv v0.41.0-1050-ge76a35ec9, client
//! API 2.5 = 131077). The `layout` test module pins the struct sizes/offsets
//! to the C ABI; re-check it against that header whenever this file changes.

#![allow(dead_code)] // full documented surface; S2/S3 consume more of it

use std::ffi::{c_char, c_double, c_int, c_ulong, c_void};
use std::path::{Path, PathBuf};

use super::engine::EngineError;

/// Client API version the adopted DLL reports (MPV_MAKE_VERSION(2, 5)).
pub(crate) const API_VERSION_EXPECTED: c_ulong = (2 << 16) | 5;
/// Oldest client API this engine accepts (MPV_MAKE_VERSION(2, 1)).
pub(crate) const API_VERSION_MIN: c_ulong = (2 << 16) | 1;

/// Environment override for the DLL path (tests and dev runs).
pub(crate) const LIBMPV_PATH_ENV: &str = "DRPLAY_LIBMPV_PATH";
/// DLL file name, resolved like the sidecar exe (next to the app binary).
pub(crate) const LIBMPV_DLL_NAME: &str = "libmpv-2.dll";

/// Opaque `mpv_handle*` (client.h).
#[repr(C)]
pub(crate) struct MpvHandle {
    _opaque: [u8; 0],
}

pub(crate) type MpvFormat = c_int;
pub(crate) const MPV_FORMAT_NONE: MpvFormat = 0;
pub(crate) const MPV_FORMAT_STRING: MpvFormat = 1;
pub(crate) const MPV_FORMAT_OSD_STRING: MpvFormat = 2;
pub(crate) const MPV_FORMAT_FLAG: MpvFormat = 3;
pub(crate) const MPV_FORMAT_INT64: MpvFormat = 4;
pub(crate) const MPV_FORMAT_DOUBLE: MpvFormat = 5;
pub(crate) const MPV_FORMAT_NODE: MpvFormat = 6;
pub(crate) const MPV_FORMAT_NODE_ARRAY: MpvFormat = 7;
pub(crate) const MPV_FORMAT_NODE_MAP: MpvFormat = 8;

pub(crate) type MpvEventId = c_int;
pub(crate) const MPV_EVENT_NONE: MpvEventId = 0;
pub(crate) const MPV_EVENT_SHUTDOWN: MpvEventId = 1;
pub(crate) const MPV_EVENT_LOG_MESSAGE: MpvEventId = 2;
pub(crate) const MPV_EVENT_END_FILE: MpvEventId = 7;
pub(crate) const MPV_EVENT_FILE_LOADED: MpvEventId = 8;
pub(crate) const MPV_EVENT_PROPERTY_CHANGE: MpvEventId = 22;

/// Numeric log levels (`enum mpv_log_level`); lower = more important.
pub(crate) const MPV_LOG_LEVEL_FATAL: c_int = 10;
pub(crate) const MPV_LOG_LEVEL_ERROR: c_int = 20;
pub(crate) const MPV_LOG_LEVEL_WARN: c_int = 30;

// `enum mpv_error` codes referenced by the wire mapping and its tests.
pub(crate) const MPV_ERROR_INVALID_PARAMETER: c_int = -4;
pub(crate) const MPV_ERROR_PROPERTY_NOT_FOUND: c_int = -8;
pub(crate) const MPV_ERROR_LOADING_FAILED: c_int = -13;
pub(crate) const MPV_ERROR_NOTHING_TO_PLAY: c_int = -16;
pub(crate) const MPV_ERROR_UNKNOWN_FORMAT: c_int = -17;
pub(crate) const MPV_ERROR_GENERIC: c_int = -20;

// `enum mpv_end_file_reason` (client.h).
pub(crate) const MPV_END_FILE_REASON_EOF: c_int = 0;
pub(crate) const MPV_END_FILE_REASON_STOP: c_int = 2;
pub(crate) const MPV_END_FILE_REASON_QUIT: c_int = 3;
pub(crate) const MPV_END_FILE_REASON_ERROR: c_int = 4;
pub(crate) const MPV_END_FILE_REASON_REDIRECT: c_int = 5;

/// `mpv_node` (client.h): a tagged union. Only the members named by
/// `format` may be read.
#[repr(C)]
pub(crate) struct MpvNode {
    pub(crate) u: MpvNodeUnion,
    pub(crate) format: MpvFormat,
}

#[repr(C)]
pub(crate) union MpvNodeUnion {
    pub(crate) string: *mut c_char,
    pub(crate) flag: c_int,
    pub(crate) int64: i64,
    pub(crate) double_: c_double,
    pub(crate) list: *mut MpvNodeList,
    pub(crate) ba: *mut MpvByteArray,
}

#[repr(C)]
pub(crate) struct MpvNodeList {
    pub(crate) num: c_int,
    pub(crate) values: *mut MpvNode,
    pub(crate) keys: *mut *mut c_char,
}

#[repr(C)]
pub(crate) struct MpvByteArray {
    pub(crate) data: *mut c_void,
    pub(crate) size: usize,
}

impl Default for MpvNode {
    fn default() -> Self {
        // A zeroed node is what the C API expects for an out-parameter: the
        // NONE format carries no union member.
        Self { u: MpvNodeUnion { string: std::ptr::null_mut() }, format: MPV_FORMAT_NONE }
    }
}

/// `mpv_event` (client.h).
#[repr(C)]
pub(crate) struct MpvEvent {
    pub(crate) event_id: MpvEventId,
    pub(crate) error: c_int,
    pub(crate) reply_userdata: u64,
    pub(crate) data: *mut c_void,
}

/// `mpv_event_property` (client.h).
#[repr(C)]
pub(crate) struct MpvEventProperty {
    pub(crate) name: *const c_char,
    pub(crate) format: MpvFormat,
    pub(crate) data: *mut c_void,
}

/// `mpv_event_log_message` (client.h).
#[repr(C)]
pub(crate) struct MpvEventLogMessage {
    pub(crate) prefix: *const c_char,
    pub(crate) level: *const c_char,
    pub(crate) text: *const c_char,
    pub(crate) log_level: c_int,
}

/// `mpv_event_end_file` (client.h).
#[repr(C)]
pub(crate) struct MpvEventEndFile {
    pub(crate) reason: c_int,
    pub(crate) error: c_int,
    pub(crate) playlist_entry_id: i64,
    pub(crate) playlist_insert_id: i64,
    pub(crate) playlist_insert_num_entries: c_int,
}

/// Resolved symbols of one loaded libmpv DLL. The library is kept alive for
/// the lifetime of the value; the fn pointers are copied out of the loader
/// (checked against client.h signatures).
pub(crate) struct Api {
    pub(crate) create: unsafe extern "C" fn() -> *mut MpvHandle,
    pub(crate) initialize: unsafe extern "C" fn(*mut MpvHandle) -> c_int,
    pub(crate) destroy: unsafe extern "C" fn(*mut MpvHandle),
    pub(crate) set_option_string:
        unsafe extern "C" fn(*mut MpvHandle, *const c_char, *const c_char) -> c_int,
    pub(crate) set_property_string:
        unsafe extern "C" fn(*mut MpvHandle, *const c_char, *const c_char) -> c_int,
    pub(crate) set_property:
        unsafe extern "C" fn(*mut MpvHandle, *const c_char, MpvFormat, *mut c_void) -> c_int,
    pub(crate) get_property:
        unsafe extern "C" fn(*mut MpvHandle, *const c_char, MpvFormat, *mut c_void) -> c_int,
    pub(crate) command_ret:
        unsafe extern "C" fn(*mut MpvHandle, *const *const c_char, *mut MpvNode) -> c_int,
    pub(crate) observe_property:
        unsafe extern "C" fn(*mut MpvHandle, u64, *const c_char, MpvFormat) -> c_int,
    pub(crate) unobserve_property: unsafe extern "C" fn(*mut MpvHandle, u64) -> c_int,
    pub(crate) wait_event: unsafe extern "C" fn(*mut MpvHandle, c_double) -> *mut MpvEvent,
    pub(crate) wakeup: unsafe extern "C" fn(*mut MpvHandle),
    pub(crate) error_string: unsafe extern "C" fn(c_int) -> *const c_char,
    pub(crate) event_name: unsafe extern "C" fn(MpvEventId) -> *const c_char,
    pub(crate) client_api_version: unsafe extern "C" fn() -> c_ulong,
    pub(crate) free_node_contents: unsafe extern "C" fn(*mut MpvNode),
    pub(crate) free: unsafe extern "C" fn(*mut c_void),
    pub(crate) request_log_messages: unsafe extern "C" fn(*mut MpvHandle, *const c_char) -> c_int,
    /// Owning loader handle; dropped last so the pointers above stay valid.
    _library: libloading::Library,
}

impl Api {
    /// Load the DLL and resolve every symbol the engine uses. Failures name
    /// the exact symbol so a wrong-version DLL is obvious in the error.
    pub(crate) fn load(path: &Path) -> Result<Api, EngineError> {
        // SAFETY: `Library::new` just maps the DLL image; every symbol is
        // signature-checked against the vendored client.h below.
        let library = unsafe { libloading::Library::new(path) }
            .map_err(|load_error| EngineError::Load {
                path: path.to_path_buf(),
                message: load_error.to_string(),
            })?;
        macro_rules! resolve {
            ($name:literal, $type:ty) => {
                *unsafe { library.get::<$type>(concat!($name, "\0").as_bytes()) }.map_err(
                    |symbol_error| EngineError::Symbol {
                        name: $name.to_string(),
                        message: symbol_error.to_string(),
                    },
                )?
            };
        }

        let client_api_version: unsafe extern "C" fn() -> c_ulong =
            resolve!("mpv_client_api_version", unsafe extern "C" fn() -> c_ulong);
        // SAFETY: plain extern getter, no preconditions.
        let api_version = unsafe { client_api_version() };
        if api_version < API_VERSION_MIN {
            return Err(EngineError::ApiVersion { found: api_version, required: API_VERSION_MIN });
        }
        log::info!("[player] libmpv client API version {api_version} (expected {API_VERSION_EXPECTED})");

        Ok(Api {
            create: resolve!("mpv_create", unsafe extern "C" fn() -> *mut MpvHandle),
            initialize: resolve!("mpv_initialize", unsafe extern "C" fn(*mut MpvHandle) -> c_int),
            destroy: resolve!("mpv_destroy", unsafe extern "C" fn(*mut MpvHandle)),
            set_option_string: resolve!(
                "mpv_set_option_string",
                unsafe extern "C" fn(*mut MpvHandle, *const c_char, *const c_char) -> c_int
            ),
            set_property_string: resolve!(
                "mpv_set_property_string",
                unsafe extern "C" fn(*mut MpvHandle, *const c_char, *const c_char) -> c_int
            ),
            set_property: resolve!(
                "mpv_set_property",
                unsafe extern "C" fn(*mut MpvHandle, *const c_char, MpvFormat, *mut c_void) -> c_int
            ),
            get_property: resolve!(
                "mpv_get_property",
                unsafe extern "C" fn(*mut MpvHandle, *const c_char, MpvFormat, *mut c_void) -> c_int
            ),
            command_ret: resolve!(
                "mpv_command_ret",
                unsafe extern "C" fn(*mut MpvHandle, *const *const c_char, *mut MpvNode) -> c_int
            ),
            observe_property: resolve!(
                "mpv_observe_property",
                unsafe extern "C" fn(*mut MpvHandle, u64, *const c_char, MpvFormat) -> c_int
            ),
            unobserve_property: resolve!(
                "mpv_unobserve_property",
                unsafe extern "C" fn(*mut MpvHandle, u64) -> c_int
            ),
            wait_event: resolve!(
                "mpv_wait_event",
                unsafe extern "C" fn(*mut MpvHandle, c_double) -> *mut MpvEvent
            ),
            wakeup: resolve!("mpv_wakeup", unsafe extern "C" fn(*mut MpvHandle)),
            error_string: resolve!("mpv_error_string", unsafe extern "C" fn(c_int) -> *const c_char),
            event_name: resolve!(
                "mpv_event_name",
                unsafe extern "C" fn(MpvEventId) -> *const c_char
            ),
            client_api_version: resolve!(
                "mpv_client_api_version",
                unsafe extern "C" fn() -> c_ulong
            ),
            free_node_contents: resolve!(
                "mpv_free_node_contents",
                unsafe extern "C" fn(*mut MpvNode)
            ),
            free: resolve!("mpv_free", unsafe extern "C" fn(*mut c_void)),
            request_log_messages: resolve!(
                "mpv_request_log_messages",
                unsafe extern "C" fn(*mut MpvHandle, *const c_char) -> c_int
            ),
            _library: library,
        })
    }
}

/// Locate `libmpv-2.dll` in the same order the sidecar exe is resolved
/// (mpv/process.rs:203-223): `DRPLAY_LIBMPV_PATH` env override, then next to
/// the app binary (dev: `target/<profile>/`, production: install dir), then
/// the repo's `src-tauri/bin` reached by walking up from `target/<profile>`
/// when running under `cargo test`.
pub(crate) fn resolve_libmpv_dll() -> Result<PathBuf, EngineError> {
    if let Some(raw) = std::env::var_os(LIBMPV_PATH_ENV) {
        let path = PathBuf::from(raw);
        if path.is_file() {
            return Ok(path);
        }
        return Err(EngineError::Load {
            path,
            message: format!("{LIBMPV_PATH_ENV} is set but points to a missing file"),
        });
    }
    let current_exe = std::env::current_exe().map_err(|exe_error| EngineError::Load {
        path: PathBuf::from(LIBMPV_DLL_NAME),
        message: format!("cannot locate the app executable: {exe_error}"),
    })?;
    let mut dir = current_exe
        .parent()
        .ok_or_else(|| EngineError::Load {
            path: PathBuf::from(LIBMPV_DLL_NAME),
            message: "app executable has no parent directory".to_string(),
        })?
        .to_path_buf();
    if dir.ends_with("deps") {
        if let Some(parent) = dir.parent() {
            dir = parent.to_path_buf();
        }
    }
    let beside_exe = dir.join(LIBMPV_DLL_NAME);
    if beside_exe.is_file() {
        return Ok(beside_exe);
    }
    // Dev/repo layout: <crate>/target/<profile>[/deps] -> any ancestor with
    // a `bin/libmpv-2.dll` (i.e. src-tauri/bin, where the DLL is committed).
    for ancestor in dir.ancestors() {
        let candidate = ancestor.join("bin").join(LIBMPV_DLL_NAME);
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    Err(EngineError::Load {
        path: beside_exe,
        message: format!(
            "{LIBMPV_DLL_NAME} not found next to the app binary nor in any ancestor bin/ directory"
        ),
    })
}

#[cfg(test)]
mod layout {
    use super::*;
    use std::mem::{align_of, offset_of, size_of};

    /// Pins the Rust declarations to the C ABI of the shipped header. A drift
    /// here would corrupt every FFI call silently, so it is asserted, not
    /// assumed. Expected values derived from client.h (x86_64, MSVC: enums are
    /// 4-byte ints, pointers 8).
    #[test]
    fn struct_layouts_match_the_shipped_c_header() {
        assert_eq!(size_of::<MpvNode>(), 16);
        assert_eq!(align_of::<MpvNode>(), 8);
        assert_eq!(offset_of!(MpvNode, format), 8);

        assert_eq!(size_of::<MpvNodeList>(), 24);
        assert_eq!(offset_of!(MpvNodeList, num), 0);
        assert_eq!(offset_of!(MpvNodeList, values), 8);
        assert_eq!(offset_of!(MpvNodeList, keys), 16);

        assert_eq!(size_of::<MpvByteArray>(), 16);

        // mpv_event: event_id(4) error(4) reply_userdata(8) data(8)
        assert_eq!(size_of::<MpvEvent>(), 24);
        assert_eq!(offset_of!(MpvEvent, error), 4);
        assert_eq!(offset_of!(MpvEvent, reply_userdata), 8);
        assert_eq!(offset_of!(MpvEvent, data), 16);

        // mpv_event_property: name(8) format(4+pad) data(8)
        assert_eq!(size_of::<MpvEventProperty>(), 24);
        assert_eq!(offset_of!(MpvEventProperty, format), 8);
        assert_eq!(offset_of!(MpvEventProperty, data), 16);

        // mpv_event_log_message: prefix(8) level(8) text(8) log_level(4+pad)
        assert_eq!(size_of::<MpvEventLogMessage>(), 32);
        assert_eq!(offset_of!(MpvEventLogMessage, log_level), 24);

        // mpv_event_end_file: reason(4) error(4) 3x i64-ish fields
        assert_eq!(size_of::<MpvEventEndFile>(), 32);
        assert_eq!(offset_of!(MpvEventEndFile, error), 4);
        assert_eq!(offset_of!(MpvEventEndFile, playlist_entry_id), 8);
        assert_eq!(offset_of!(MpvEventEndFile, playlist_insert_id), 16);
        assert_eq!(offset_of!(MpvEventEndFile, playlist_insert_num_entries), 24);
    }
}
