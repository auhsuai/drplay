//! mpv JSON IPC: line-delimited JSON over a Windows named pipe
//! (protocol: mpv `DOCS/man/ipc.rst`).
//!
//! Framing rules enforced here:
//! - every outgoing message is ONE line of compact JSON terminated by `\n`;
//! - incoming bytes are split on `\n`; unparseable lines are dropped
//!   (logged), they never crash the reader.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt, ReadHalf, WriteHalf};
use tokio::net::windows::named_pipe::NamedPipeClient;
use tokio::sync::oneshot;
use tokio::sync::Mutex as AsyncMutex;

/// Upper bound for awaiting a command reply (mpv replies fast locally; this
/// only protects against a hung or silent pipe).
const IPC_COMMAND_TIMEOUT_SECS: u64 = 10;
/// Byte chunk the IPC reader pulls from the pipe per read.
const IPC_READ_CHUNK_SIZE: usize = 4096;

/// Payload resolved for one pending command.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct MpvReply {
    pub(crate) error: String,
    pub(crate) data: Value,
}

/// Messages pushed from the reader task to the owner of the connection.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum IpcMessage {
    /// mpv `property-change` event.
    PropertyChange { name: String, data: Value },
    /// Any other mpv event (`end-file`, `shutdown`, ...), `reason` if present.
    MpvEvent { event: String, reason: Option<String> },
}

/// Callback invoked for every mpv event the reader task receives.
pub(crate) type EventSink = Arc<dyn Fn(IpcMessage) + Send + Sync>;

/// One line received from mpv, classified.
enum Incoming {
    Reply { request_id: u64, error: String, data: Value },
    Event(IpcMessage),
}

/// Frame one outgoing message: compact JSON + terminating `\n`. mpv rejects
/// multi-line messages, and `serde_json::to_string` escapes any newline that
/// appears inside string values, so the frame is always a single line.
pub(crate) fn frame_message(value: &Value) -> Result<String, String> {
    let mut line = serde_json::to_string(value)
        .map_err(|serialize_error| format!("mpv IPC: failed to serialize message: {serialize_error}"))?;
    line.push('\n');
    Ok(line)
}

/// Classify a raw line. `None` = nothing actionable (garbage, empty line, or
/// JSON without `event`/`request_id`) — callers skip it without crashing.
fn parse_line(line: &str) -> Option<Incoming> {
    let value: Value = serde_json::from_str(line).ok()?;
    if let Some(event) = value.get("event").and_then(Value::as_str) {
        return Some(Incoming::Event(match event {
            "property-change" => {
                let name = value.get("name").and_then(Value::as_str)?.to_string();
                IpcMessage::PropertyChange {
                    name,
                    data: value.get("data").cloned().unwrap_or(Value::Null),
                }
            }
            _ => IpcMessage::MpvEvent {
                event: event.to_string(),
                reason: value.get("reason").and_then(Value::as_str).map(str::to_string),
            },
        }));
    }
    if let Some(request_id) = value.get("request_id").and_then(Value::as_u64) {
        return Some(Incoming::Reply {
            request_id,
            error: value.get("error").and_then(Value::as_str).unwrap_or("success").to_string(),
            data: value.get("data").cloned().unwrap_or(Value::Null),
        });
    }
    None
}

struct IpcCore {
    pending: Mutex<HashMap<u64, oneshot::Sender<MpvReply>>>,
    event_sink: EventSink,
}

impl IpcCore {
    fn new(event_sink: EventSink) -> Self {
        Self { pending: Mutex::new(HashMap::new()), event_sink }
    }

    /// Recover from poisoning instead of panicking: the map holds only
    /// channel senders, no invariant can be broken by a mid-insert panic.
    fn lock_pending(&self) -> std::sync::MutexGuard<'_, HashMap<u64, oneshot::Sender<MpvReply>>> {
        self.pending.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn register(&self, request_id: u64, sender: oneshot::Sender<MpvReply>) {
        self.lock_pending().insert(request_id, sender);
    }

    /// Drop every pending sender (pipe died): awaiting commands observe
    /// "connection closed" instead of hanging until timeout.
    fn fail_all_pending(&self) {
        self.lock_pending().clear();
    }

    fn dispatch(&self, line: &str) {
        match parse_line(line) {
            Some(Incoming::Reply { request_id, error, data }) => {
                let sender = self.lock_pending().remove(&request_id);
                match sender {
                    Some(sender) => {
                        let _ = sender.send(MpvReply { error, data });
                    }
                    None => {
                        log::warn!("[mpv-ipc] reply for unknown request_id={request_id} (error={error})")
                    }
                }
            }
            Some(Incoming::Event(message)) => (self.event_sink)(message),
            None => {
                let preview: String = line.chars().take(80).collect();
                log::debug!("[mpv-ipc] ignoring non-JSON line: {preview:?}");
            }
        }
    }
}

pub(crate) struct MpvIpc {
    core: Arc<IpcCore>,
    writer: Arc<AsyncMutex<WriteHalf<NamedPipeClient>>>,
    next_request_id: AtomicU64,
}

impl MpvIpc {
    /// Take ownership of the connected pipe: spawn the reader task and keep
    /// the write half for outgoing commands.
    pub(crate) fn new(client: NamedPipeClient, event_sink: EventSink) -> Self {
        let core = Arc::new(IpcCore::new(event_sink));
        let (read_half, write_half) = tokio::io::split(client);
        let reader_core = Arc::clone(&core);
        tokio::spawn(async move { read_loop(read_half, reader_core).await });
        Self {
            core,
            writer: Arc::new(AsyncMutex::new(write_half)),
            next_request_id: AtomicU64::new(1),
        }
    }

    /// Send one command and await its reply. Timeout-guarded; the pending
    /// entry is registered BEFORE the write so a fast reply cannot race us.
    pub(crate) async fn send_command(&self, args: Vec<Value>) -> Result<Value, String> {
        let request_id = self.next_request_id.fetch_add(1, Ordering::Relaxed);
        let frame = frame_message(&json!({ "command": args, "request_id": request_id }))?;
        let (sender, receiver) = oneshot::channel();
        self.core.register(request_id, sender);

        let write_result: Result<(), String> = async {
            let mut writer = self.writer.lock().await;
            writer
                .write_all(frame.as_bytes())
                .await
                .map_err(|write_error| format!("mpv IPC: failed to write command to pipe: {write_error}"))?;
            writer
                .flush()
                .await
                .map_err(|flush_error| format!("mpv IPC: failed to flush command to pipe: {flush_error}"))?;
            Ok(())
        }
        .await;

        if let Err(write_error) = write_result {
            self.core.lock_pending().remove(&request_id);
            return Err(write_error);
        }

        let reply = match tokio::time::timeout(Duration::from_secs(IPC_COMMAND_TIMEOUT_SECS), receiver).await {
            Ok(Ok(reply)) => reply,
            Ok(Err(_sender_dropped)) => {
                // fail_all_pending dropped the sender: the pipe died mid-flight.
                self.core.lock_pending().remove(&request_id);
                return Err("mpv IPC: connection closed before a reply arrived (mpv exited?)".to_string());
            }
            Err(_elapsed) => {
                self.core.lock_pending().remove(&request_id);
                return Err(format!("mpv IPC: no reply within {IPC_COMMAND_TIMEOUT_SECS}s"));
            }
        };

        if reply.error == "success" {
            Ok(reply.data)
        } else {
            Err(format!("mpv error: {}", reply.error))
        }
    }
}

/// Pull bytes from the pipe forever, split them into `\n` lines and route
/// each line through the core. Ends (clearing all pending requests) when the
/// pipe closes or errors.
async fn read_loop(mut reader: ReadHalf<NamedPipeClient>, core: Arc<IpcCore>) {
    let mut buffer: Vec<u8> = Vec::with_capacity(IPC_READ_CHUNK_SIZE);
    let mut chunk = [0u8; IPC_READ_CHUNK_SIZE];
    loop {
        match reader.read(&mut chunk).await {
            Ok(0) => {
                log::warn!("[mpv-ipc] pipe closed by mpv");
                core.fail_all_pending();
                return;
            }
            Ok(bytes_read) => {
                buffer.extend_from_slice(&chunk[..bytes_read]);
                while let Some(newline_index) = buffer.iter().position(|&byte| byte == b'\n') {
                    let line: Vec<u8> = buffer.drain(..=newline_index).collect();
                    let line = String::from_utf8_lossy(&line[..line.len() - 1]);
                    core.dispatch(line.trim_end_matches('\r'));
                }
            }
            Err(read_error) => {
                log::error!("[mpv-ipc] pipe read failed: {read_error}");
                core.fail_all_pending();
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    type Collected = Arc<Mutex<Vec<IpcMessage>>>;

    fn core_with_collector() -> (IpcCore, Collected) {
        let collected: Collected = Arc::new(Mutex::new(Vec::new()));
        let sink: EventSink = {
            let collected = Arc::clone(&collected);
            Arc::new(move |message| collected.lock().unwrap().push(message))
        };
        (IpcCore::new(sink), collected)
    }

    #[test]
    fn frame_command_is_single_line_ending_with_newline() {
        let frame = frame_message(&json!({
            "command": ["loadfile", "http://host/a\nb?c=1", "replace"],
            "request_id": 1
        }))
        .expect("a plain Value must always frame");
        assert!(frame.ends_with('\n'), "frame must end with a newline");
        let payload = &frame[..frame.len() - 1];
        assert!(!payload.contains('\n'), "message body must not contain raw newlines");
        assert!(!payload.contains('\r'), "message body must not contain carriage returns");
        let parsed: Value = serde_json::from_str(payload).expect("framed payload must parse back");
        assert_eq!(parsed["command"], json!(["loadfile", "http://host/a\nb?c=1", "replace"]));
        assert_eq!(parsed["request_id"], json!(1));
    }

    #[test]
    fn reply_with_request_id_resolves_pending_request() {
        let (core, _collected) = core_with_collector();
        let (sender, mut receiver) = oneshot::channel();
        core.register(7, sender);
        core.dispatch(r#"{"error":"success","data":3,"request_id":7}"#);
        let reply = receiver.try_recv().expect("pending request must be resolved by its reply");
        assert_eq!(reply.error, "success");
        assert_eq!(reply.data, json!(3));
    }

    #[test]
    fn reply_error_is_propagated_not_treated_as_success() {
        let (core, _collected) = core_with_collector();
        let (sender, mut receiver) = oneshot::channel();
        core.register(1, sender);
        core.dispatch(r#"{"error":"invalid parameter","request_id":1}"#);
        let reply = receiver.try_recv().expect("error replies must still resolve the waiter");
        assert_eq!(reply.error, "invalid parameter");
        assert_eq!(reply.data, Value::Null);
    }

    #[test]
    fn property_change_event_is_parsed_with_name_and_data() {
        let (core, collected) = core_with_collector();
        core.dispatch(r#"{"event":"property-change","id":2,"name":"time-pos","data":12.5}"#);
        let collected = collected.lock().unwrap();
        assert_eq!(
            collected.as_slice(),
            [IpcMessage::PropertyChange { name: "time-pos".to_string(), data: json!(12.5) }]
        );
    }

    #[test]
    fn end_file_event_is_parsed_with_reason() {
        let (core, collected) = core_with_collector();
        core.dispatch(r#"{"event":"end-file","reason":"eof","playlist_entry_id":1}"#);
        let collected = collected.lock().unwrap();
        assert_eq!(
            collected.as_slice(),
            [IpcMessage::MpvEvent {
                event: "end-file".to_string(),
                reason: Some("eof".to_string()),
            }]
        );
    }

    #[test]
    fn garbage_lines_are_skipped_without_crashing_or_emitting() {
        let (core, collected) = core_with_collector();
        core.dispatch("this is not json");
        core.dispatch("");
        core.dispatch("[1, 2, 3]"); // valid JSON, but not a message
        core.dispatch(r#"{"event":"property-change","id":1}"#); // property change without a name
        core.dispatch(r#"{"error":"success","request_id":42}"#); // reply for an unknown id
        core.dispatch(r#"{"event":"property-change","id":5,"name":"pause","data":true}"#);
        let collected = collected.lock().unwrap();
        assert_eq!(
            collected.as_slice(),
            [IpcMessage::PropertyChange { name: "pause".to_string(), data: json!(true) }]
        );
    }
}
