use super::*;
use tokio::io::AsyncWriteExt;

type Collected = Arc<Mutex<Vec<(IpcMessage, u64, u64)>>>;

/// Fixed connection id used by the direct-dispatch test cores; the event
/// plumbing is what these tests exercise, not the id minting.
const TEST_CONN: u64 = 7;

fn sink_with_collector() -> (EventSink, Collected) {
    let collected: Collected = Arc::new(Mutex::new(Vec::new()));
    let sink: EventSink = {
        let collected = Arc::clone(&collected);
        Arc::new(move |message, epoch, conn| {
            collected.lock().unwrap().push((message, epoch, conn))
        })
    };
    (sink, collected)
}

fn core_with_collector() -> (IpcCore, Collected) {
    let (sink, collected) = sink_with_collector();
    (IpcCore::new(TEST_CONN, sink), collected)
}

/// The messages alone, for assertions that do not care about the epoch.
fn collected_messages(collected: &Collected) -> Vec<IpcMessage> {
    collected.lock().unwrap().iter().map(|(message, _, _)| message.clone()).collect()
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
    assert_eq!(
        collected_messages(&collected),
        [IpcMessage::PropertyChange { name: "time-pos".to_string(), data: json!(12.5) }]
    );
}

#[test]
fn end_file_event_is_parsed_with_reason() {
    let (core, collected) = core_with_collector();
    core.dispatch(r#"{"event":"end-file","reason":"eof","playlist_entry_id":1}"#);
    assert_eq!(
        collected_messages(&collected),
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
    assert_eq!(
        collected_messages(&collected),
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
    assert_eq!(
        collected_messages(&collected),
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
    assert_eq!(
        collected_messages(&collected),
        [IpcMessage::ConnectionClosed { cause: "eof".to_string() }]
    );
}

#[tokio::test]
async fn reader_stays_silent_when_the_shutdown_was_requested() {
    // The owner commanded the shutdown (the load-deadline sidecar
    // restart): the pipe ending is expected and must NOT surface as the
    // `ipc-closed` engine failure the frontend reacts to.
    let (core, collected) = core_with_collector();
    core.shutdown_requested.store(true, Ordering::Relaxed);
    let empty: &[u8] = &[];
    read_loop(empty, Arc::new(core)).await;
    let collected = collected.lock().unwrap();
    assert!(
        collected.is_empty(),
        "a commanded shutdown must not be reported as an engine failure, got {:?}",
        collected.as_slice()
    );
}

#[tokio::test]
async fn reader_stays_silent_about_a_read_error_after_a_requested_shutdown() {
    // Killing mpv can also surface as a read error instead of a clean EOF.
    let (core, collected) = core_with_collector();
    core.shutdown_requested.store(true, Ordering::Relaxed);
    read_loop(FailingReader, Arc::new(core)).await;
    let collected = collected.lock().unwrap();
    assert!(
        collected.is_empty(),
        "a commanded shutdown must not be reported as an engine failure, got {:?}",
        collected.as_slice()
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
    assert_eq!(
        collected_messages(&collected),
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
    assert_eq!(
        collected_messages(&collected),
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
    let sink: EventSink = Arc::new(|_, _, _| {});
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

// --- load epoch (Fix 5A — stale event identity at the IPC boundary) ------

#[test]
fn loadfile_reply_bumps_the_load_epoch_exactly_once() {
    let (core, _collected) = core_with_collector();
    assert_eq!(core.load_epoch(), 0, "a fresh connection starts at epoch 0");

    let (sender, mut receiver) = oneshot::channel();
    core.register(11, sender);
    core.register_loadfile_request(11);
    core.dispatch(r#"{"error":"success","data":null,"request_id":11}"#);
    let _ = receiver.try_recv().expect("the loadfile reply must resolve its waiter");
    assert_eq!(core.load_epoch(), 1, "a dispatched loadfile reply must bump the epoch");

    // A duplicate reply for the same id must not bump a second time.
    core.dispatch(r#"{"error":"success","data":null,"request_id":11}"#);
    assert_eq!(core.load_epoch(), 1, "a loadfile request must bump at most once");
}

#[test]
fn non_loadfile_reply_does_not_bump_the_load_epoch() {
    let (core, _collected) = core_with_collector();
    let (sender, mut receiver) = oneshot::channel();
    core.register(5, sender);
    core.dispatch(r#"{"error":"success","data":null,"request_id":5}"#);
    let _ = receiver.try_recv().expect("the reply must resolve its waiter");
    assert_eq!(core.load_epoch(), 0, "only loadfile replies may bump the epoch");
}

#[test]
fn events_carry_the_epoch_current_at_dispatch_time() {
    let (core, collected) = core_with_collector();

    // Event of the old track, before the new loadfile's reply is parsed.
    core.dispatch(r#"{"event":"end-file","reason":"eof"}"#);

    let (sender, mut receiver) = oneshot::channel();
    core.register(21, sender);
    core.register_loadfile_request(21);
    core.dispatch(r#"{"error":"success","data":null,"request_id":21}"#);
    let _ = receiver.try_recv().expect("the loadfile reply must resolve its waiter");

    // Event of the new track, parsed after the loadfile reply.
    core.dispatch(r#"{"event":"file-loaded"}"#);

    let epochs: Vec<u64> =
        collected.lock().unwrap().iter().map(|(_, epoch, _)| *epoch).collect();
    assert_eq!(
        epochs,
        [0, 1],
        "an event before the loadfile reply carries the old epoch, one after carries the new"
    );
}

#[tokio::test]
async fn send_command_tracks_a_loadfile_and_bumps_when_its_reply_arrives() {
    // Success path over a real named pipe: the test plays mpv's side.
    let pipe_name = format!(r"\\.\pipe\drplay-ipc-epoch-{}", std::process::id());
    let server = tokio::net::windows::named_pipe::ServerOptions::new()
        .create(&pipe_name)
        .expect("test pipe server must be created");
    let client = tokio::net::windows::named_pipe::ClientOptions::new()
        .open(&pipe_name)
        .expect("test pipe client must connect");
    let (sink, _collected) = sink_with_collector();
    let ipc = MpvIpc::new(client, sink);

    let responder = tokio::spawn(async move {
        server.connect().await.expect("server must accept the client");
        let (read_half, mut write_half) = tokio::io::split(server);
        let mut reader = tokio::io::BufReader::new(read_half);
        let mut frame = String::new();
        tokio::io::AsyncBufReadExt::read_line(&mut reader, &mut frame)
            .await
            .expect("the framed command must arrive");
        let request_id = serde_json::from_str::<Value>(frame.trim_end())
            .expect("the frame must be JSON")["request_id"]
            .as_u64()
            .expect("the frame must carry a request_id");
        let reply = format!(r#"{{"error":"success","data":null,"request_id":{request_id}}}"#);
        write_half.write_all(reply.as_bytes()).await.expect("the reply must be writable");
        write_half.write_all(b"\n").await.expect("the frame newline must be writable");
        write_half.flush().await.expect("the reply must flush");
    });

    let data = ipc
        .send_command(vec![json!("loadfile"), json!("http://host/a"), json!("replace")])
        .await
        .expect("the loadfile must succeed");
    assert_eq!(data, Value::Null);
    responder.await.expect("the responder must finish");

    assert_eq!(
        ipc.current_epoch(),
        1,
        "the loadfile reply must bump the epoch before the command resolves"
    );
    assert!(
        ipc.core.lock_loadfile_requests().is_empty(),
        "a dispatched loadfile must be removed from the tracking set"
    );
}

#[tokio::test]
async fn send_command_clears_loadfile_tracking_when_the_write_fails() {
    let pipe_name = format!(r"\\.\pipe\drplay-ipc-epoch-fail-{}", std::process::id());
    let server = tokio::net::windows::named_pipe::ServerOptions::new()
        .create(&pipe_name)
        .expect("test pipe server must be created");
    let client = tokio::net::windows::named_pipe::ClientOptions::new()
        .open(&pipe_name)
        .expect("test pipe client must connect");
    let (sink, _collected) = sink_with_collector();
    let ipc = MpvIpc::new(client, sink);

    drop(server); // kill the peer: the next write must fail

    let error = ipc
        .send_command(vec![json!("loadfile"), json!("http://host/a"), json!("replace")])
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
    assert!(
        ipc.core.lock_loadfile_requests().is_empty(),
        "a failed loadfile write must not leave a tracked request behind"
    );
}

#[tokio::test]
async fn send_command_clears_loadfile_tracking_when_the_connection_closes_mid_flight() {
    let pipe_name = format!(r"\\.\pipe\drplay-ipc-epoch-eof-{}", std::process::id());
    let server = tokio::net::windows::named_pipe::ServerOptions::new()
        .create(&pipe_name)
        .expect("test pipe server must be created");
    let client = tokio::net::windows::named_pipe::ClientOptions::new()
        .open(&pipe_name)
        .expect("test pipe client must connect");
    let (sink, _collected) = sink_with_collector();
    let ipc = MpvIpc::new(client, sink);

    let closer = tokio::spawn(async move {
        let mut server = server;
        server.connect().await.expect("server must accept the client");
        let mut frame = [0u8; 1024];
        let _ = server.read(&mut frame).await; // consume the command, never reply
        drop(server); // closing makes the client reader report the pipe gone
    });

    let error = ipc
        .send_command(vec![json!("loadfile"), json!("http://host/a"), json!("replace")])
        .await
        .expect_err("a pipe closed before the reply must fail the command");
    assert!(
        error.contains("connection closed before a reply arrived"),
        "the failure must name the closed connection, got: {error}"
    );
    closer.await.expect("the closer task must finish");
    assert!(
        ipc.core.lock_pending().is_empty(),
        "a mid-flight close must not leave a pending entry behind"
    );
    assert!(
        ipc.core.lock_loadfile_requests().is_empty(),
        "a mid-flight close must not leave a tracked loadfile request behind"
    );
}

// --- connection identity (R2.2 — RC-6) -----------------------------------

/// Every dispatched message is tagged with the connection it came from.
/// The frontend drops events whose connection id is not the live one, so a
/// late event of a replaced connection can never drive the new engine
/// state (B1/RC-1) — even when its per-connection epoch would pass.
#[test]
fn events_carry_the_connection_id_of_their_connection() {
    let (sink, collected) = sink_with_collector();
    let core = IpcCore::new(42, sink);

    core.dispatch(r#"{"event":"property-change","id":1,"name":"time-pos","data":1}"#);
    core.dispatch(r#"{"event":"file-loaded"}"#);

    let conns: Vec<u64> = collected.lock().unwrap().iter().map(|(_, _, conn)| *conn).collect();
    assert_eq!(conns, [42, 42], "every event must carry its connection's identity");
}

/// Connection ids are minted monotonically for the whole process: a
/// respawn gets a NEW id — a per-connection restart (1, 2, ...) would let
/// events of the replaced connection alias the new one.
#[tokio::test]
async fn connection_ids_are_monotonic_and_never_repeat() {
    let (first, _first_server) = test_pipe("conn-mono-a");
    let (second, _second_server) = test_pipe("conn-mono-b");
    let first = MpvIpc::new(first, Arc::new(|_, _, _| {}));
    let second = MpvIpc::new(second, Arc::new(|_, _, _| {}));

    assert!(first.current_conn() >= 1, "ids start at 1, got {}", first.current_conn());
    assert!(
        second.current_conn() > first.current_conn(),
        "a newer connection must get a strictly greater id ({} -> {})",
        first.current_conn(),
        second.current_conn()
    );
}

/// Create one connected named-pipe pair; the server half is returned so the
/// test keeps the connection open.
fn test_pipe(
    purpose: &str,
) -> (NamedPipeClient, tokio::net::windows::named_pipe::NamedPipeServer) {
    let pipe_name = format!(r"\\.\pipe\drplay-ipc-{}-{}", purpose, std::process::id());
    let server = tokio::net::windows::named_pipe::ServerOptions::new()
        .create(&pipe_name)
        .expect("test pipe server must be created");
    let client = tokio::net::windows::named_pipe::ClientOptions::new()
        .open(&pipe_name)
        .expect("test pipe client must connect");
    (client, server)
}

#[tokio::test]
async fn send_command_clears_loadfile_tracking_when_the_reply_times_out() {
    let pipe_name = format!(r"\\.\pipe\drplay-ipc-epoch-timeout-{}", std::process::id());
    let server = tokio::net::windows::named_pipe::ServerOptions::new()
        .create(&pipe_name)
        .expect("test pipe server must be created");
    let client = tokio::net::windows::named_pipe::ClientOptions::new()
        .open(&pipe_name)
        .expect("test pipe client must connect");
    let (sink, _collected) = sink_with_collector();
    let ipc = MpvIpc::new(client, sink);

    // Hold the pipe open without ever replying: the command must fail at
    // its own deadline (IPC_COMMAND_TIMEOUT_SECS) and clean up after.
    let mute = tokio::spawn(async move {
        let mut server = server;
        server.connect().await.expect("server must accept the client");
        let mut frame = [0u8; 1024];
        let _ = server.read(&mut frame).await;
        tokio::time::sleep(Duration::from_secs(IPC_COMMAND_TIMEOUT_SECS + 5)).await;
    });

    let error = ipc
        .send_command(vec![json!("loadfile"), json!("http://host/a"), json!("replace")])
        .await
        .expect_err("a missing reply must fail the command at the deadline");
    assert!(
        error.contains("no reply within"),
        "the failure must name the deadline, got: {error}"
    );
    assert!(
        ipc.core.lock_pending().is_empty(),
        "a timed-out command must not leave a pending entry behind"
    );
    assert!(
        ipc.core.lock_loadfile_requests().is_empty(),
        "a timed-out loadfile must not leave a tracked request behind"
    );
    mute.abort();
}
