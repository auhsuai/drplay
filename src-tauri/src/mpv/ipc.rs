//! mpv JSON IPC: line-delimited JSON over a Windows named pipe
//! (protocol: mpv `DOCS/man/ipc.rst`).
//!
//! Framing rules enforced here:
//! - every outgoing message is ONE line of compact JSON terminated by `\n`;
//! - incoming bytes are split on `\n`; unparseable lines are dropped
//!   (logged), they never crash the reader.

mod wire;

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, WriteHalf};
use tokio::net::windows::named_pipe::NamedPipeClient;
use tokio::sync::oneshot;
use tokio::sync::Mutex as AsyncMutex;

pub(crate) use wire::frame_message;
use wire::{parse_line, write_frame_bounded, Incoming};

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

/// Callback invoked for every mpv event the reader task receives, together
/// with the load epoch current at dispatch time AND the identity of the
/// connection that produced it. The epoch increments once per dispatched
/// `loadfile` reply (see `IpcCore::dispatch`), so consumers can drop messages
/// that predate the latest requested load; the connection id is minted once
/// per connection (never reset), so consumers can also drop every message of
/// a replaced connection — the epoch base resets on respawn and would
/// otherwise let old-connection events through (B1/RC-1).
pub(crate) type EventSink = Arc<dyn Fn(IpcMessage, u64, u64) + Send + Sync>;

/// Process-wide source of connection ids (R2.2). Starts at 1 and is never
/// reset: every `MpvIpc` (one spawned sidecar's connection) gets a strictly
/// greater id than all previous ones, so a restarted sidecar's events can
/// never alias the replaced connection's identity.
static NEXT_CONNECTION_ID: AtomicU64 = AtomicU64::new(1);

struct IpcCore {
    pending: Mutex<HashMap<u64, oneshot::Sender<MpvReply>>>,
    /// Request ids of in-flight `loadfile` commands. The reply resolving one
    /// of them is what advances `load_epoch`: bumping in the single reader
    /// task keeps the wire order exact (events parsed before the reply carry
    /// the old epoch, events parsed after carry the new one).
    loadfile_requests: Mutex<HashSet<u64>>,
    /// Monotonic per-connection load counter, attached to every dispatched
    /// event and returned by `mpv_command` (see `MpvIpc::current_epoch`).
    load_epoch: AtomicU64,
    /// Identity of this connection (R2.2): attached to every dispatched
    /// event next to the load epoch; a replacement connection gets a new id.
    conn: u64,
    event_sink: EventSink,
    /// Set before a commanded shutdown (`mpv_shutdown`, used by the frontend's
    /// load-deadline sidecar restart): the pipe ending that follows is
    /// expected, so the reader must not report it as an engine failure — the
    /// frontend treats `ipc-closed` as "mpv died unexpectedly".
    shutdown_requested: AtomicBool,
}

impl IpcCore {
    fn new(conn: u64, event_sink: EventSink) -> Self {
        Self {
            pending: Mutex::new(HashMap::new()),
            loadfile_requests: Mutex::new(HashSet::new()),
            load_epoch: AtomicU64::new(0),
            conn,
            event_sink,
            shutdown_requested: AtomicBool::new(false),
        }
    }

    /// True once the owner commanded mpv to shut down: the connection close
    /// that follows is expected, not an engine failure.
    fn shutdown_was_requested(&self) -> bool {
        self.shutdown_requested.load(Ordering::Relaxed)
    }

    /// Recover from poisoning instead of panicking: the map holds only
    /// channel senders, no invariant can be broken by a mid-insert panic.
    fn lock_pending(&self) -> std::sync::MutexGuard<'_, HashMap<u64, oneshot::Sender<MpvReply>>> {
        self.pending.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn register(&self, request_id: u64, sender: oneshot::Sender<MpvReply>) {
        self.lock_pending().insert(request_id, sender);
    }

    /// Recover from poisoning instead of panicking (same rationale as
    /// `lock_pending`: the set holds plain ids, no invariant can be broken).
    fn lock_loadfile_requests(&self) -> std::sync::MutexGuard<'_, HashSet<u64>> {
        self.loadfile_requests.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Mark an outgoing `loadfile` so its reply advances `load_epoch`.
    fn register_loadfile_request(&self, request_id: u64) {
        self.lock_loadfile_requests().insert(request_id);
    }

    /// Epoch of the latest dispatched `loadfile` reply (0 before the first).
    fn load_epoch(&self) -> u64 {
        self.load_epoch.load(Ordering::SeqCst)
    }

    /// Drop every pending sender (pipe died): awaiting commands observe
    /// "connection closed" instead of hanging until timeout.
    fn fail_all_pending(&self) {
        self.lock_pending().clear();
    }

    fn dispatch(&self, line: &str) {
        match parse_line(line) {
            Some(Incoming::Reply { request_id, error, data }) => {
                // Bump BEFORE waking the waiter: the `loadfile` caller reads
                // `current_epoch()` right after its reply resolves, and every
                // event parsed from here on carries the new epoch (the single
                // reader task makes this the exact wire point of the load).
                if self.lock_loadfile_requests().remove(&request_id) {
                    self.load_epoch.fetch_add(1, Ordering::SeqCst);
                }
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
            Some(Incoming::Event(message)) => (self.event_sink)(message, self.load_epoch(), self.conn),
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
        let conn = NEXT_CONNECTION_ID.fetch_add(1, Ordering::SeqCst);
        let core = Arc::new(IpcCore::new(conn, event_sink));
        let (read_half, write_half) = tokio::io::split(client);
        let reader_core = Arc::clone(&core);
        tokio::spawn(async move { read_loop(read_half, reader_core).await });
        Self {
            core,
            writer: Arc::new(AsyncMutex::new(write_half)),
            next_request_id: AtomicU64::new(1),
        }
    }

    /// Mark the connection as deliberately closed BEFORE killing mpv: the
    /// reader then stays silent about the pipe ending instead of emitting the
    /// `ipc-closed` engine-failure signal the frontend reacts to.
    pub(crate) fn mark_shutdown_requested(&self) {
        self.core.shutdown_requested.store(true, Ordering::Relaxed);
    }

    /// Load epoch of the latest dispatched `loadfile` reply (0 before the
    /// first load). `mpv_command` includes it in its reply so the frontend
    /// can tag engine events.
    pub(crate) fn current_epoch(&self) -> u64 {
        self.core.load_epoch()
    }

    /// Identity of this connection (R2.2). Included in the `mpv_spawn` reply
    /// and attached to every emitted engine event, so the frontend can drop
    /// events of a replaced connection.
    pub(crate) fn current_conn(&self) -> u64 {
        self.core.conn
    }

    /// Send one command and await its reply. Timeout-guarded; the pending
    /// entry is registered BEFORE the write so a fast reply cannot race us.
    /// A `loadfile` is additionally tracked so its reply advances
    /// `load_epoch` (see `register_loadfile_request`); the tracking entry is
    /// dropped on every failure path so it cannot leak or bump later.
    pub(crate) async fn send_command(&self, args: Vec<Value>) -> Result<Value, String> {
        let request_id = self.next_request_id.fetch_add(1, Ordering::Relaxed);
        let is_loadfile = args.first().and_then(Value::as_str) == Some("loadfile");
        let frame = frame_message(&json!({ "command": args, "request_id": request_id }))?;
        let (sender, receiver) = oneshot::channel();
        self.core.register(request_id, sender);
        if is_loadfile {
            self.core.register_loadfile_request(request_id);
        }

        let write_result = write_frame_bounded(
            &self.writer,
            frame.as_bytes(),
            Duration::from_secs(IPC_WRITE_TIMEOUT_SECS),
        )
        .await;

        if let Err(write_error) = write_result {
            self.core.lock_pending().remove(&request_id);
            self.core.lock_loadfile_requests().remove(&request_id);
            return Err(write_error);
        }

        let reply = match tokio::time::timeout(Duration::from_secs(IPC_COMMAND_TIMEOUT_SECS), receiver).await {
            Ok(Ok(reply)) => reply,
            Ok(Err(_sender_dropped)) => {
                // fail_all_pending dropped the sender: the pipe died mid-flight.
                self.core.lock_pending().remove(&request_id);
                self.core.lock_loadfile_requests().remove(&request_id);
                return Err("mpv IPC: connection closed before a reply arrived (mpv exited?)".to_string());
            }
            Err(_elapsed) => {
                self.core.lock_pending().remove(&request_id);
                self.core.lock_loadfile_requests().remove(&request_id);
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
/// each line through the core. Ends (notifying the sink + clearing all pending
/// requests) when the pipe closes or errors — UNLESS the owner commanded the
/// shutdown first: a close we asked for is not an engine failure and must not
/// be reported as one.
async fn read_loop<R: tokio::io::AsyncRead + Unpin>(mut reader: R, core: Arc<IpcCore>) {
    let mut buffer: Vec<u8> = Vec::with_capacity(IPC_READ_CHUNK_SIZE);
    let mut chunk = [0u8; IPC_READ_CHUNK_SIZE];
    loop {
        match reader.read(&mut chunk).await {
            Ok(0) => {
                if core.shutdown_was_requested() {
                    log::info!("[mpv-ipc] pipe closed after a requested shutdown");
                } else {
                    log::warn!("[mpv-ipc] pipe closed by mpv");
                    (core.event_sink)(
                        IpcMessage::ConnectionClosed { cause: "eof".to_string() },
                        core.load_epoch(),
                        core.conn,
                    );
                }
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
                if core.shutdown_was_requested() {
                    log::info!(
                        "[mpv-ipc] pipe read ended after a requested shutdown: {read_error}"
                    );
                } else {
                    log::error!("[mpv-ipc] pipe read failed: {read_error}");
                    (core.event_sink)(
                        IpcMessage::ConnectionClosed {
                            cause: format!("read error: {read_error}"),
                        },
                        core.load_epoch(),
                        core.conn,
                    );
                }
                core.fail_all_pending();
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests;
