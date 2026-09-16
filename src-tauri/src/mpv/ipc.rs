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
use tokio::io::{AsyncReadExt, AsyncWriteExt, WriteHalf};
use tokio::net::windows::named_pipe::NamedPipeClient;
use tokio::sync::oneshot;
use tokio::sync::Mutex as AsyncMutex;

/// Upper bound for awaiting a command reply (mpv replies fast locally; this
/// only protects against a hung or silent pipe).
const IPC_COMMAND_TIMEOUT_SECS: u64 = 10;
/// Upper bound for the write phase of one command. A frame is a few hundred
/// bytes that mpv drains instantly, so a write still blocked after this means
/// mpv stopped reading the pipe. Failing the command here (instead of parking
/// on the writer mutex) keeps every later command — including the recovery
/// reads — from queueing forever behind a wedged pipe.
const IPC_WRITE_TIMEOUT_SECS: u64 = 5;
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
    /// `error` carries mpv's failure string when the event has one.
    MpvEvent { event: String, reason: Option<String>, error: Option<String> },
    /// The pipe ended (mpv exited or the read failed). `cause` is `"eof"` or
    /// the read error; the frontend resets its engine state on this signal.
    ConnectionClosed { cause: String },
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
                // `file_error` first: mpv docs state the generic `error` field
                // will be unset for end-file in the future.
                error: value
                    .get("file_error")
                    .and_then(Value::as_str)
                    .or_else(|| value.get("error").and_then(Value::as_str))
                    .map(str::to_string),
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

        let write_result = write_frame_bounded(
            &self.writer,
            frame.as_bytes(),
            Duration::from_secs(IPC_WRITE_TIMEOUT_SECS),
        )
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

/// Write one framed command, bounded by `timeout`. A frame is a few hundred
/// bytes, so mpv drains it instantly; a stall past the deadline means mpv
/// stopped reading the pipe. The command must fail instead of holding the
/// writer mutex forever — a wedged mutex queues every later command
/// (pause/seek/loadfile/recovery get_property) behind it indefinitely.
async fn write_frame_bounded<W: tokio::io::AsyncWrite + Unpin>(
    writer: &AsyncMutex<W>,
    frame: &[u8],
    timeout: Duration,
) -> Result<(), String> {
    // On expiry `timeout` drops the inner future, and the `AsyncMutex` guard
    // acquired inside goes with it: the writer is never held past the deadline.
    tokio::time::timeout(timeout, async {
        let mut writer = writer.lock().await;
        writer
            .write_all(frame)
            .await
            .map_err(|write_error| format!("mpv IPC: failed to write command to pipe: {write_error}"))?;
        writer
            .flush()
            .await
            .map_err(|flush_error| format!("mpv IPC: failed to flush command to pipe: {flush_error}"))?;
        Ok(())
    })
    .await
    .map_err(|_elapsed| {
        format!("mpv IPC: write timed out after {timeout:?} (mpv not draining the pipe)")
    })?
}

/// Pull bytes from the pipe forever, split them into `\n` lines and route
/// each line through the core. Ends (notifying the sink + clearing all pending
/// requests) when the pipe closes or errors.
async fn read_loop<R: tokio::io::AsyncRead + Unpin>(mut reader: R, core: Arc<IpcCore>) {
    let mut buffer: Vec<u8> = Vec::with_capacity(IPC_READ_CHUNK_SIZE);
    let mut chunk = [0u8; IPC_READ_CHUNK_SIZE];
    loop {
        match reader.read(&mut chunk).await {
            Ok(0) => {
                log::warn!("[mpv-ipc] pipe closed by mpv");
                (core.event_sink)(IpcMessage::ConnectionClosed { cause: "eof".to_string() });
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
                (core.event_sink)(IpcMessage::ConnectionClosed {
                    cause: format!("read error: {read_error}"),
                });
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
                error: None,
            }]
        );
    }

    #[test]
    fn end_file_event_prefers_file_error_over_error() {
        let (core, collected) = core_with_collector();
        core.dispatch(
            r#"{"event":"end-file","reason":"error","error":"generic failure","file_error":"connection timed out"}"#,
        );
        let collected = collected.lock().unwrap();
        assert_eq!(
            collected.as_slice(),
            [IpcMessage::MpvEvent {
                event: "end-file".to_string(),
                reason: Some("error".to_string()),
                error: Some("connection timed out".to_string()),
            }]
        );
    }

    #[test]
    fn end_file_event_falls_back_to_error_field() {
        let (core, collected) = core_with_collector();
        core.dispatch(r#"{"event":"end-file","reason":"error","error":"Connection reset by peer"}"#);
        let collected = collected.lock().unwrap();
        assert_eq!(
            collected.as_slice(),
            [IpcMessage::MpvEvent {
                event: "end-file".to_string(),
                reason: Some("error".to_string()),
                error: Some("Connection reset by peer".to_string()),
            }]
        );
    }

    #[tokio::test]
    async fn reader_eof_notifies_sink_that_the_connection_closed() {
        let (core, collected) = core_with_collector();
        let empty: &[u8] = &[];
        read_loop(empty, Arc::new(core)).await;
        let collected = collected.lock().unwrap();
        assert_eq!(
            collected.as_slice(),
            [IpcMessage::ConnectionClosed { cause: "eof".to_string() }]
        );
    }

    struct FailingReader;

    impl tokio::io::AsyncRead for FailingReader {
        fn poll_read(
            self: std::pin::Pin<&mut Self>,
            _context: &mut std::task::Context<'_>,
            _buffer: &mut tokio::io::ReadBuf<'_>,
        ) -> std::task::Poll<std::io::Result<()>> {
            std::task::Poll::Ready(Err(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "pipe gone",
            )))
        }
    }

    #[tokio::test]
    async fn reader_error_notifies_sink_with_the_read_error_as_cause() {
        let (core, collected) = core_with_collector();
        read_loop(FailingReader, Arc::new(core)).await;
        let collected = collected.lock().unwrap();
        assert_eq!(
            collected.as_slice(),
            [IpcMessage::ConnectionClosed { cause: "read error: pipe gone".to_string() }]
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

    /// Guard around helper calls in tests: the helper must return at its own
    /// millisecond deadline, so a regression to an unbounded write fails the
    /// test instead of hanging it.
    const TEST_OUTER_GUARD: Duration = Duration::from_secs(2);

    #[tokio::test]
    async fn write_frame_bounded_times_out_when_the_peer_never_drains() {
        // 1-byte pipe with the read half kept alive: `write_all` fills the
        // buffer and then parks forever waiting for the peer to consume.
        let (client, _server) = tokio::io::duplex(1);
        let writer = AsyncMutex::new(client);
        let started = std::time::Instant::now();

        let write = tokio::time::timeout(
            TEST_OUTER_GUARD,
            write_frame_bounded(&writer, b"a frame the peer never reads\n", Duration::from_millis(50)),
        )
        .await
        .expect("write_frame_bounded must return at its own deadline (unbounded write -> this guard fired)");

        let error = write.expect_err("a write the peer never drains must fail, not block forever");
        assert!(
            error.starts_with("mpv IPC: write timed out"),
            "the timeout must be distinguishable from other write errors, got: {error}"
        );
        assert!(
            started.elapsed() < TEST_OUTER_GUARD,
            "the deadline must come from the helper, not the outer guard"
        );
    }

    #[tokio::test]
    async fn writer_is_reusable_after_a_write_timeout() {
        // 16-byte pipe: the first frame (24 bytes) cannot fit and blocks; the
        // second one fits once the buffered prefix has been drained.
        let (client, mut server) = tokio::io::duplex(16);
        let writer = AsyncMutex::new(client);

        let first = tokio::time::timeout(
            TEST_OUTER_GUARD,
            write_frame_bounded(&writer, b"a frame the peer never reads\n", Duration::from_millis(50)),
        )
        .await
        .expect("the first write must return at its own deadline");
        assert!(first.is_err(), "the first write must time out exactly as asserted above");

        // Free the pipe, then send the next command: if the timed-out write
        // still held the mutex, this second call would park on the lock and
        // only the outer guard could stop it.
        let mut drain = [0u8; 32];
        let drained = server.read(&mut drain).await.expect("draining the buffered prefix must work");
        assert!(drained > 0, "the blocked write must have buffered a prefix");

        let second = tokio::time::timeout(
            TEST_OUTER_GUARD,
            write_frame_bounded(&writer, b"second\n", Duration::from_millis(500)),
        )
        .await
        .expect("the writer lock must be released when the timed-out write is dropped");
        assert!(second.is_ok(), "the next command must write normally, got: {second:?}");
    }

    /// End-to-end guard: when the write phase fails, `send_command` must
    /// return the error and leave no pending entry behind (the timeout is one
    /// such write-phase error — see `write_frame_bounded` tests for the
    /// deadline itself, which a local pipe fixture cannot wedge: Windows
    /// absorbs large writes into a growing buffer when nobody reads, so the
    /// write never parks).
    #[tokio::test]
    async fn send_command_clears_the_pending_entry_when_the_write_fails() {
        let pipe_name = format!(r"\\.\pipe\drplay-ipc-closed-{}", std::process::id());
        let server = tokio::net::windows::named_pipe::ServerOptions::new()
            .create(&pipe_name)
            .expect("test pipe server must be created");
        let client = tokio::net::windows::named_pipe::ClientOptions::new()
            .open(&pipe_name)
            .expect("test pipe client must connect");
        let sink: EventSink = Arc::new(|_| {});
        let ipc = MpvIpc::new(client, sink);

        // Kill the peer: the next write must fail instead of reaching mpv.
        drop(server);

        let error = ipc
            .send_command(vec![json!("pause")])
            .await
            .expect_err("a write to a dead pipe must fail the command");
        assert!(
            error.starts_with("mpv IPC: failed to write command to pipe"),
            "the failure must name the write phase, got: {error}"
        );
        assert!(
            ipc.core.lock_pending().is_empty(),
            "a failed write must not leave a pending entry behind"
        );
    }
}
