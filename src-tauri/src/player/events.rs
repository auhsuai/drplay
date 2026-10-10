//! Pure wire-mapping helpers: `mpv_node` -> `serde_json::Value` and the
//! `end-file` reason/error mapping, byte-for-byte identical to what mpv's JSON
//! IPC emits (`mpv_event_to_node`, player/client.c:1964-1998 of the adopted
//! revision) — the legacy sidecar wire contract (mpv/ipc/wire.rs:27-58).

use std::ffi::{c_int, CStr};

use serde_json::{Map, Number, Value};

use super::engine::EngineError;
use super::ffi::{
    MpvNode, MPV_END_FILE_REASON_EOF, MPV_END_FILE_REASON_ERROR, MPV_END_FILE_REASON_QUIT,
    MPV_END_FILE_REASON_REDIRECT, MPV_END_FILE_REASON_STOP, MPV_FORMAT_DOUBLE, MPV_FORMAT_FLAG,
    MPV_FORMAT_INT64, MPV_FORMAT_NODE_ARRAY, MPV_FORMAT_NODE_MAP, MPV_FORMAT_NONE,
    MPV_FORMAT_OSD_STRING, MPV_FORMAT_STRING,
};

/// Bound on node nesting before conversion refuses. mpv's own values are
/// shallow (demuxer-cache-state is 2 levels); the cap only guards against a
/// pathological/hostile node overflowing the stack.
pub(crate) const MAX_NODE_DEPTH: usize = 64;

/// Convert one mpv node to the JSON shape the wire carries. Mirrors the JSON
/// IPC writer's node conversion; `BYTE_ARRAY` has no JSON form and errors.
pub(crate) fn node_to_json(node: &MpvNode) -> Result<Value, EngineError> {
    node_to_json_at_depth(node, 0)
}

fn node_to_json_at_depth(node: &MpvNode, depth: usize) -> Result<Value, EngineError> {
    if depth > MAX_NODE_DEPTH {
        return Err(EngineError::Convert {
            message: format!("node nesting exceeds {MAX_NODE_DEPTH} levels"),
        });
    }
    match node.format {
        MPV_FORMAT_NONE => Ok(Value::Null),
        MPV_FORMAT_STRING | MPV_FORMAT_OSD_STRING => {
            // SAFETY: format says `u.string` is a valid C string or NULL.
            let pointer = unsafe { node.u.string };
            if pointer.is_null() {
                return Ok(Value::Null);
            }
            Ok(Value::String(unsafe { CStr::from_ptr(pointer) }.to_string_lossy().into_owned()))
        }
        MPV_FORMAT_FLAG => Ok(Value::Bool(unsafe { node.u.flag } != 0)),
        MPV_FORMAT_INT64 => Ok(Value::Number(unsafe { node.u.int64 }.into())),
        MPV_FORMAT_DOUBLE => Ok(double_to_json(unsafe { node.u.double_ })),
        MPV_FORMAT_NODE_ARRAY => node_array_to_json(node, depth),
        MPV_FORMAT_NODE_MAP => node_map_to_json(node, depth),
        other => Err(EngineError::Convert {
            message: format!("mpv node format {other} has no JSON representation"),
        }),
    }
}

/// Non-finite doubles cannot be JSON numbers; mpv's own IPC writer emits null.
fn double_to_json(value: f64) -> Value {
    Number::from_f64(value).map(Value::Number).unwrap_or(Value::Null)
}

fn node_array_to_json(node: &MpvNode, depth: usize) -> Result<Value, EngineError> {
    // SAFETY: format says `u.list` is a valid mpv_node_list* or NULL.
    let Some(list) = (unsafe { node.u.list.as_ref() }) else {
        return Ok(Value::Array(Vec::new()));
    };
    if list.num <= 0 {
        return Ok(Value::Array(Vec::new()));
    }
    if list.values.is_null() {
        return Err(EngineError::Convert {
            message: format!("array node claims {} entries but has no values", list.num),
        });
    }
    let mut out = Vec::with_capacity(list.num as usize);
    for index in 0..list.num as usize {
        // SAFETY: values[0..num] are valid per the node contract.
        let entry = unsafe { &*list.values.add(index) };
        out.push(node_to_json_at_depth(entry, depth + 1)?);
    }
    Ok(Value::Array(out))
}

fn node_map_to_json(node: &MpvNode, depth: usize) -> Result<Value, EngineError> {
    // SAFETY: format says `u.list` is a valid mpv_node_list* or NULL.
    let Some(list) = (unsafe { node.u.list.as_ref() }) else {
        return Ok(Value::Object(Map::new()));
    };
    if list.num <= 0 {
        return Ok(Value::Object(Map::new()));
    }
    if list.values.is_null() || list.keys.is_null() {
        return Err(EngineError::Convert {
            message: format!("map node claims {} entries but misses values/keys", list.num),
        });
    }
    let mut out = Map::with_capacity(list.num as usize);
    for index in 0..list.num as usize {
        // SAFETY: keys[0..num] are valid non-NULL C strings per the contract.
        let key_pointer = unsafe { *list.keys.add(index) };
        if key_pointer.is_null() {
            return Err(EngineError::Convert {
                message: format!("map node entry {index} has a null key"),
            });
        }
        let key = unsafe { CStr::from_ptr(key_pointer) }.to_string_lossy().into_owned();
        let value = node_to_json_at_depth(unsafe { &*list.values.add(index) }, depth + 1)?;
        out.insert(key, value);
    }
    Ok(Value::Object(out))
}

/// Legacy JSON IPC reason strings (`mpv_event_to_node`, player/client.c:
/// 1977-1986).
pub(crate) fn end_file_reason_name(reason: c_int) -> &'static str {
    match reason {
        MPV_END_FILE_REASON_EOF => "eof",
        MPV_END_FILE_REASON_STOP => "stop",
        MPV_END_FILE_REASON_QUIT => "quit",
        MPV_END_FILE_REASON_ERROR => "error",
        MPV_END_FILE_REASON_REDIRECT => "redirect",
        _ => "unknown",
    }
}

/// `(reason, error)` for an `end-file` wire event. `error` mirrors the legacy
/// `file_error` field: mpv sets it ONLY when `reason == ERROR`, as
/// `mpv_error_string(eef->error)` (player/client.c:1996-1997), and the wire
/// parser prefers `file_error` over `error` (mpv/ipc/wire.rs:41-47) — so this
/// single string is what the frontend's `classifyEndFileError`
/// (src/lib/mpvProtocol.ts:297-316) receives.
pub(crate) fn end_file_payload(
    reason: c_int,
    error: c_int,
    error_string: impl Fn(c_int) -> String,
) -> (String, Option<String>) {
    let reason_name = end_file_reason_name(reason).to_string();
    let error_field =
        if reason == MPV_END_FILE_REASON_ERROR { Some(error_string(error)) } else { None };
    (reason_name, error_field)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::player::ffi::{MpvNodeList, MpvNodeUnion};
    use std::ffi::c_char;

    fn string_node(value: &CStr) -> MpvNode {
        MpvNode { u: MpvNodeUnion { string: value.as_ptr() as *mut c_char }, format: MPV_FORMAT_STRING }
    }
    fn int_node(value: i64) -> MpvNode {
        MpvNode { u: MpvNodeUnion { int64: value }, format: MPV_FORMAT_INT64 }
    }
    fn double_node(value: f64) -> MpvNode {
        MpvNode { u: MpvNodeUnion { double_: value }, format: MPV_FORMAT_DOUBLE }
    }
    fn flag_node(value: bool) -> MpvNode {
        MpvNode { u: MpvNodeUnion { flag: c_int::from(value) }, format: MPV_FORMAT_FLAG }
    }
    fn array_node(list: &mut MpvNodeList) -> MpvNode {
        MpvNode { u: MpvNodeUnion { list }, format: MPV_FORMAT_NODE_ARRAY }
    }
    fn map_node(list: &mut MpvNodeList) -> MpvNode {
        MpvNode { u: MpvNodeUnion { list }, format: MPV_FORMAT_NODE_MAP }
    }

    #[test]
    fn node_scalars_convert_like_the_json_ipc_writer() {
        assert_eq!(node_to_json(&MpvNode::default()).unwrap(), Value::Null);
        let text = std::ffi::CString::new("hello").unwrap();
        assert_eq!(node_to_json(&string_node(&text)).unwrap(), Value::String("hello".into()));
        assert_eq!(node_to_json(&int_node(-7)).unwrap(), serde_json::json!(-7));
        assert_eq!(node_to_json(&double_node(12.5)).unwrap(), serde_json::json!(12.5));
        assert_eq!(node_to_json(&flag_node(true)).unwrap(), Value::Bool(true));
        assert_eq!(node_to_json(&flag_node(false)).unwrap(), Value::Bool(false));
        // A null string pointer can only mean "no value"; the wire saw null.
        let null_string = MpvNode {
            u: MpvNodeUnion { string: std::ptr::null_mut() },
            format: MPV_FORMAT_STRING,
        };
        assert_eq!(node_to_json(&null_string).unwrap(), Value::Null);
        // Non-finite doubles cannot be JSON numbers; IPC would emit null.
        assert_eq!(node_to_json(&double_node(f64::NAN)).unwrap(), Value::Null);
        // OSD strings are plain strings when they appear inside a node.
        let osd = MpvNode { u: MpvNodeUnion { string: text.as_ptr() as *mut c_char }, format: MPV_FORMAT_OSD_STRING };
        assert_eq!(node_to_json(&osd).unwrap(), Value::String("hello".into()));
    }

    #[test]
    fn node_arrays_and_maps_convert_including_nesting() {
        let mut values = [int_node(1), int_node(2), int_node(3)];
        let mut list = MpvNodeList { num: 3, values: values.as_mut_ptr(), keys: std::ptr::null_mut() };
        assert_eq!(node_to_json(&array_node(&mut list)).unwrap(), serde_json::json!([1, 2, 3]));

        let key_a = std::ffi::CString::new("start").unwrap();
        let key_b = std::ffi::CString::new("end").unwrap();
        let mut keys = [key_a.as_ptr() as *mut c_char, key_b.as_ptr() as *mut c_char];
        let mut map_values = [double_node(1.5), double_node(9.25)];
        let mut map_list =
            MpvNodeList { num: 2, values: map_values.as_mut_ptr(), keys: keys.as_mut_ptr() };
        assert_eq!(
            node_to_json(&map_node(&mut map_list)).unwrap(),
            serde_json::json!({ "start": 1.5, "end": 9.25 })
        );

        // demuxer-cache-state shape: a map with a nested array of maps.
        let range_key = std::ffi::CString::new("start").unwrap();
        let mut range_keys = [range_key.as_ptr() as *mut c_char];
        let mut range_values = [double_node(4.0)];
        let mut range_list =
            MpvNodeList { num: 1, values: range_values.as_mut_ptr(), keys: range_keys.as_mut_ptr() };
        let mut ranges = [map_node(&mut range_list)];
        let ranges_key = std::ffi::CString::new("seekable-ranges").unwrap();
        let mut ranges_keys = [ranges_key.as_ptr() as *mut c_char];
        let mut ranges_list =
            MpvNodeList { num: 1, values: ranges.as_mut_ptr(), keys: ranges_keys.as_mut_ptr() };
        let mut outer_values = [array_node(&mut ranges_list)];
        let outer_key = std::ffi::CString::new("cache").unwrap();
        let mut outer_keys = [outer_key.as_ptr() as *mut c_char];
        let mut outer_list =
            MpvNodeList { num: 1, values: outer_values.as_mut_ptr(), keys: outer_keys.as_mut_ptr() };
        assert_eq!(
            node_to_json(&map_node(&mut outer_list)).unwrap(),
            serde_json::json!({ "cache": [{ "start": 4.0 }] })
        );

        // Empty containers.
        let mut empty = MpvNodeList { num: 0, values: std::ptr::null_mut(), keys: std::ptr::null_mut() };
        assert_eq!(node_to_json(&array_node(&mut empty)).unwrap(), serde_json::json!([]));
        assert_eq!(node_to_json(&map_node(&mut empty)).unwrap(), serde_json::json!({}));
    }

    #[test]
    fn end_file_reason_names_match_the_json_ipc_wire() {
        assert_eq!(end_file_reason_name(MPV_END_FILE_REASON_EOF), "eof");
        assert_eq!(end_file_reason_name(MPV_END_FILE_REASON_STOP), "stop");
        assert_eq!(end_file_reason_name(MPV_END_FILE_REASON_QUIT), "quit");
        assert_eq!(end_file_reason_name(MPV_END_FILE_REASON_ERROR), "error");
        assert_eq!(end_file_reason_name(MPV_END_FILE_REASON_REDIRECT), "redirect");
        assert_eq!(end_file_reason_name(1), "unknown", "unused enum values are unknown");
        assert_eq!(end_file_reason_name(99), "unknown");
    }

    /// The `file_error` string the frontend's `classifyEndFileError` receives
    /// must bucket exactly like the legacy sidecar's. The corpus strings are
    /// the REAL `mpv_error_string` values (player/client.c:2064-2086); the
    /// oracle below mirrors mpvProtocol.ts:297-316 for the cases that matter.
    #[test]
    fn end_file_error_strings_bucket_like_classify_end_file_error() {
        fn classify(raw: &str) -> &'static str {
            if raw.trim().is_empty() {
                return "format";
            }
            if ["http error 4", "forbidden", "not found"].iter().any(|k| raw.to_lowercase().contains(k))
            {
                return "format";
            }
            let network_keywords = [
                "connection", "refus", "reset", "timeout", "timed out", "network", "unreachable",
                "no route", "broken pipe", "i/o error",
            ];
            if network_keywords.iter().any(|k| raw.to_lowercase().contains(k)) {
                return "network";
            }
            "format"
        }

        // (mpv code, real mpv_error_string, bucket classifyEndFileError yields)
        let corpus: &[(c_int, &str, &str)] = &[
            (crate::player::ffi::MPV_ERROR_LOADING_FAILED, "loading failed", "format"),
            (crate::player::ffi::MPV_ERROR_UNKNOWN_FORMAT, "unrecognized file format", "format"),
            (crate::player::ffi::MPV_ERROR_NOTHING_TO_PLAY, "no audio or video data played", "format"),
            (crate::player::ffi::MPV_ERROR_GENERIC, "something happened", "format"),
            (crate::player::ffi::MPV_ERROR_PROPERTY_NOT_FOUND, "property not found", "format"),
            (0, "success", "format"),
            // Transport-ish strings only ever arrive from the stream layer /
            // proxy today, but the mapping must pass them through untouched.
            (-100, "connection reset by peer", "network"),
            (-101, "HTTP error 404 Not Found", "format"),
        ];
        for &(code, string, bucket) in corpus {
            let resolver = |requested: c_int| {
                corpus
                    .iter()
                    .find(|(known, _, _)| *known == requested)
                    .map(|(_, known_string, _)| (*known_string).to_string())
                    .unwrap_or_else(|| panic!("unexpected code {requested}"))
            };
            let (reason, error) =
                end_file_payload(MPV_END_FILE_REASON_ERROR, code, resolver);
            assert_eq!(reason, "error");
            assert_eq!(error.as_deref(), Some(string), "code {code} must map to `file_error`");
            assert_eq!(classify(string), bucket, "classifyEndFileError({string:?})");
        }
    }

    /// Every non-error reason must stay error-free on the wire even when the
    /// numeric error field is junk (mpv guarantees 0 there, but the mapping
    /// must not leak it: legacy emits `file_error` ONLY for reason==ERROR).
    #[test]
    fn end_file_error_field_is_only_emitted_for_reason_error() {
        let resolver = |code: c_int| format!("code {code}");
        for reason in [
            MPV_END_FILE_REASON_EOF,
            MPV_END_FILE_REASON_STOP,
            MPV_END_FILE_REASON_QUIT,
            MPV_END_FILE_REASON_REDIRECT,
        ] {
            let (_, error) = end_file_payload(reason, crate::player::ffi::MPV_ERROR_LOADING_FAILED, resolver);
            assert_eq!(error, None, "reason {reason} must not carry an error");
        }
        let (reason, error) = end_file_payload(MPV_END_FILE_REASON_ERROR, 0, resolver);
        assert_eq!(reason, "error");
        assert_eq!(
            error.as_deref(),
            Some("code 0"),
            "legacy parity: reason==ERROR always emits mpv_error_string(error)"
        );
    }
}
