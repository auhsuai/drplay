use std::ffi::{c_char, c_void, CString};
use std::ptr;

use serde_json::Value;

use super::super::events as wire_events;
use super::super::ffi::{self, MpvNode};
use super::events::mpv_error_message;
use super::{CommandReply, Engine, EngineError, LOADFILE_COMMAND};

impl Engine {
    /// Run one mpv command synchronously and return its result node plus the
    /// load epoch the caller must report. A `loadfile` bumps the epoch here,
    /// on the reply path (mpv/ipc.rs:144-163).
    ///
    /// `set_property` / `get_property` are NOT command-parser commands in mpv
    /// v0.41: the sidecar's JSON IPC handles them as client-API calls BEFORE
    /// the parser (input/ipc.c:194-246 of the adopted revision; the parser
    /// table renamed `set_property` to `set` and dropped `get_property`
    /// entirely — verified against the bundled sidecar on 2026-10-08).
    /// Mirroring the IPC special cases is what keeps the frozen command
    /// vocabulary (frontend: loadfile / seek / set_property) working.
    pub(crate) fn send_command(&self, args: &[String]) -> Result<CommandReply, EngineError> {
        let _guard = self.lock_read();
        self.ensure_running()?;
        // A new media item means the previous item's first-frame signal must not
        // count: re-arm the one-shot BEFORE the command goes out, so the next
        // present the render thread sees belongs to what is loading now. This is
        // a single atomic store (no GL, no mpv, no loop change) and it is a
        // no-op for an audio file.
        if args.first().map(String::as_str) == Some(LOADFILE_COMMAND) {
            if let Some(surface) = self.render.get() {
                surface.rearm_first_frame();
            }
        }
        match args.first().map(String::as_str).unwrap_or("") {
            "set_property" | "set_property_string" => self.set_property_node(args),
            "get_property" => self.get_property_reply(args),
            _ => self.run_mpv_command(args),
        }
    }

    /// IPC special-case parity (input/ipc.c:232-246): exactly 3 arguments; the
    /// value travels as an MPV_FORMAT_NODE built from the wire string, so
    /// "yes"/"no"/"1" parse exactly like the sidecar's.
    fn set_property_node(&self, args: &[String]) -> Result<CommandReply, EngineError> {
        let command = args.first().cloned().unwrap_or_default();
        if args.len() != 3 {
            return Err(EngineError::Command {
                command,
                code: ffi::MPV_ERROR_INVALID_PARAMETER,
                message: format!("set_property expects 3 arguments, got {}", args.len()),
            });
        }
        let name = CString::new(args[1].as_str()).map_err(|_nul| EngineError::Command {
            command: command.clone(),
            code: ffi::MPV_ERROR_INVALID_PARAMETER,
            message: "property name contains a NUL byte".to_string(),
        })?;
        let value = CString::new(args[2].as_str()).map_err(|_nul| EngineError::Command {
            command: command.clone(),
            code: ffi::MPV_ERROR_INVALID_PARAMETER,
            message: "property value contains a NUL byte".to_string(),
        })?;
        let mut node = MpvNode {
            u: ffi::MpvNodeUnion { string: value.as_ptr() as *mut c_char },
            format: ffi::MPV_FORMAT_STRING,
        };
        // SAFETY: name is NUL-terminated; the node borrows `value` (alive
        // through the call) and matches MPV_FORMAT_STRING.
        let code = unsafe {
            (self.api.set_property)(
                self.handle.0,
                name.as_ptr(),
                ffi::MPV_FORMAT_NODE,
                (&mut node as *mut MpvNode).cast::<c_void>(),
            )
        };
        if code < 0 {
            return Err(EngineError::Command {
                command,
                code,
                message: mpv_error_message(&self.api, code),
            });
        }
        // The legacy IPC reply for set_property carries no `data` (wire -> null)
        // and never bumps the load epoch.
        Ok(CommandReply { data: Value::Null, load_epoch: self.core.load_epoch() })
    }

    /// IPC special-case parity (input/ipc.c:194-212): exactly 2 arguments,
    /// reply data = the property node. The dedicated `mpv_get_property`
    /// command resolves through the same read path.
    fn get_property_reply(&self, args: &[String]) -> Result<CommandReply, EngineError> {
        if args.len() != 2 {
            return Err(EngineError::Command {
                command: "get_property".to_string(),
                code: ffi::MPV_ERROR_INVALID_PARAMETER,
                message: format!("get_property expects 2 arguments, got {}", args.len()),
            });
        }
        let data = self.read_property_node(&args[1])?;
        Ok(CommandReply { data, load_epoch: self.core.load_epoch() })
    }

    /// Read one mpv property as JSON (MPV_FORMAT_NODE -> serde_json::Value).
    pub(crate) fn get_property(&self, property: &str) -> Result<Value, EngineError> {
        let _guard = self.lock_read();
        self.ensure_running()?;
        self.read_property_node(property)
    }

    fn read_property_node(&self, property: &str) -> Result<Value, EngineError> {
        let name = CString::new(property).map_err(|_nul| EngineError::Property {
            property: property.to_string(),
            code: ffi::MPV_ERROR_INVALID_PARAMETER,
            message: "property name contains a NUL byte".to_string(),
        })?;
        let mut node = MpvNode::default();
        // SAFETY: name is NUL-terminated; node is an out-parameter we own.
        let code = unsafe {
            (self.api.get_property)(
                self.handle.0,
                name.as_ptr(),
                ffi::MPV_FORMAT_NODE,
                (&mut node as *mut MpvNode).cast::<c_void>(),
            )
        };
        if code < 0 {
            return Err(EngineError::Property {
                property: property.to_string(),
                code,
                message: mpv_error_message(&self.api, code),
            });
        }
        let value = wire_events::node_to_json(&node);
        // SAFETY: mpv filled the node on success; free its contents on both
        // paths (conversion failure included).
        unsafe { (self.api.free_node_contents)(&mut node) };
        value
    }

    /// Everything else goes through the real command parser, exactly like the
    /// IPC `command` request does (input/ipc.c:350).
    fn run_mpv_command(&self, args: &[String]) -> Result<CommandReply, EngineError> {
        let command_name = args.first().map(String::as_str).unwrap_or("").to_string();
        let mut arguments: Vec<CString> = Vec::with_capacity(args.len());
        for argument in args {
            arguments.push(CString::new(argument.as_str()).map_err(|_nul| {
                EngineError::Command {
                    command: command_name.clone(),
                    code: ffi::MPV_ERROR_INVALID_PARAMETER,
                    message: "command argument contains a NUL byte".to_string(),
                }
            })?);
        }
        let mut pointers: Vec<*const c_char> =
            arguments.iter().map(|argument| argument.as_ptr()).collect();
        pointers.push(ptr::null());
        let mut result = MpvNode::default();
        // SAFETY: pointers are a NULL-terminated argv of valid C strings; the
        // result node is an out-parameter we own and free below.
        let code = unsafe { (self.api.command_ret)(self.handle.0, pointers.as_ptr(), &mut result) };
        if code < 0 {
            return Err(EngineError::Command {
                command: command_name,
                code,
                message: mpv_error_message(&self.api, code),
            });
        }
        let data = wire_events::node_to_json(&result);
        // SAFETY: mpv filled the node on success; its contents are ours to
        // free. Freed on BOTH paths (conversion failure included).
        unsafe { (self.api.free_node_contents)(&mut result) };
        let data = data?;
        let load_epoch = self.core.note_command_reply(&command_name);
        Ok(CommandReply { data, load_epoch })
    }
}
