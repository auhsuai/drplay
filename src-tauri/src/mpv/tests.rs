use super::*;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};

type TestServer = tokio::net::windows::named_pipe::NamedPipeServer;

/// A live `MpvHandle` around a test pipe, plus the server half so the test
/// plays mpv's side. The child is a placeholder pinned to a kill-on-close
/// job; nothing here talks to it — the IPC pipe is the test's own.
async fn test_handle(pipe_name: &str) -> (MpvHandle, TestServer) {
    let server = tokio::net::windows::named_pipe::ServerOptions::new()
        .create(pipe_name)
        .expect("test pipe server must be created");
    let client = tokio::net::windows::named_pipe::ClientOptions::new()
        .open(pipe_name)
        .expect("test pipe client must connect");
    let sink: EventSink = Arc::new(|_, _, _| {});
    let ipc = MpvIpc::new(client, sink);
    let child = tokio::process::Command::new("cmd")
        .args(["/C", "ping -n 30 127.0.0.1 >NUL"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("dummy child must spawn");
    let job = job::JobHandle::create_with_kill_on_close().expect("job must be created");
    job.assign(&child).expect("dummy child must join the job");
    (MpvHandle { ipc: Arc::new(ipc), child, job, pipe_name: pipe_name.to_string() }, server)
}

/// Play mpv's side of one command round-trip: read the frame, report it
/// (`frame_seen`), wait for the go-ahead, then reply success with `data: 7`.
async fn answer_one_command(
    server: TestServer,
    frame_seen: tokio::sync::oneshot::Sender<()>,
    reply_go: tokio::sync::oneshot::Receiver<()>,
) {
    server.connect().await.expect("server must accept the client");
    let (read_half, mut write_half) = tokio::io::split(server);
    let mut reader = tokio::io::BufReader::new(read_half);
    let mut frame = String::new();
    reader.read_line(&mut frame).await.expect("the command frame must arrive");
    let request_id = serde_json::from_str::<Value>(frame.trim_end())
        .expect("the frame must be JSON")["request_id"]
        .as_u64()
        .expect("the frame must carry a request_id");
    frame_seen.send(()).expect("the test must still be waiting");
    reply_go.await.expect("the test must release the reply");
    let reply = format!(r#"{{"error":"success","data":7,"request_id":{request_id}}}"#);
    write_half.write_all(reply.as_bytes()).await.expect("the reply must be writable");
    write_half.write_all(b"\n").await.expect("the reply newline must be writable");
    write_half.flush().await.expect("the reply must flush");
}

/// Regression (R9): while a command round-trip is in flight the state lock
/// must be free — `mpv_spawn` / `mpv_shutdown` take it and used to queue
/// behind every command for up to the IPC timeout.
#[tokio::test]
async fn command_round_trip_does_not_hold_the_state_lock() {
    let pipe_name = format!(r"\\.\pipe\drplay-mpv-lock-scope-{}", std::process::id());
    let (handle, server) = test_handle(&pipe_name).await;
    let state: SharedMpv = Arc::new(Mutex::new(Some(handle)));

    // Exactly what a command call site does: resolve the IPC handle...
    let ipc = running_ipc_from_state(&state).await.expect("a running sidecar must resolve");

    // ...then run the round-trip. The server reads the frame and holds the
    // reply back, so the command is in flight during the assertion.
    let (frame_seen_tx, frame_seen_rx) = tokio::sync::oneshot::channel();
    let (reply_go_tx, reply_go_rx) = tokio::sync::oneshot::channel();
    let responder = tokio::spawn(answer_one_command(server, frame_seen_tx, reply_go_rx));

    let command = tokio::spawn(async move { ipc.send_command(vec![json!("pause")]).await });
    frame_seen_rx.await.expect("the command must reach the peer");

    assert!(
        state.try_lock().is_ok(),
        "the state lock must be released while a command round-trip is in flight"
    );

    reply_go_tx.send(()).expect("the responder must be waiting");
    let data =
        command.await.expect("the command task must not panic").expect("the command must succeed");
    assert_eq!(data, json!(7));
    responder.await.expect("the responder must finish");
}

/// A resolved handle must outlive a slot swap: the restart path takes the
/// handle out of the slot while a command may still be in flight, and the
/// clone's connection must stay usable on its own.
#[tokio::test]
async fn a_resolved_handle_survives_a_slot_swap() {
    let pipe_name = format!(r"\\.\pipe\drplay-mpv-swap-{}", std::process::id());
    let (handle, server) = test_handle(&pipe_name).await;
    let state: SharedMpv = Arc::new(Mutex::new(Some(handle)));

    let ipc = running_ipc_from_state(&state).await.expect("a running sidecar must resolve");
    // The control path (shutdown/spawn) empties the slot; that lock is
    // free because the command call site already released it.
    assert!(state.lock().await.take().is_some(), "the test must own one handle");

    let (frame_seen_tx, _frame_seen_rx) = tokio::sync::oneshot::channel();
    let (reply_go_tx, reply_go_rx) = tokio::sync::oneshot::channel();
    let responder = tokio::spawn(answer_one_command(server, frame_seen_tx, reply_go_rx));
    reply_go_tx.send(()).expect("the responder must accept the go signal");

    let data = ipc
        .send_command(vec![json!("get_property"), json!("pause")])
        .await
        .expect("the connection held by the clone must stay usable after the slot swap");
    assert_eq!(data, json!(7));
    responder.await.expect("the responder must finish");
}

// --- connection identity (R2.2 — RC-6) -----------------------------------

/// The `mpv_spawn` reply must carry the new connection's identity so the
/// frontend can filter engine events by it (B1/RC-1): events of a replaced
/// connection never drive the fresh engine state.
#[tokio::test]
async fn spawn_reply_carries_the_connection_identity() {
    let pipe_name = format!(r"\\.\pipe\drplay-mpv-spawn-reply-{}", std::process::id());
    let (handle, _server) = test_handle(&pipe_name).await;

    let reply = handle.spawn_reply();

    let conn = reply["conn"].as_u64().expect("the reply must carry a numeric conn");
    assert_eq!(conn, handle.ipc.current_conn(), "conn must be the handle's own connection");
    assert!(conn >= 1, "connection ids start at 1, got {conn}");
}

/// The rejection path must not keep the lock either.
#[tokio::test]
async fn running_ipc_rejects_when_no_sidecar_is_spawned() {
    let state: SharedMpv = Arc::new(Mutex::new(None));
    let error = match running_ipc_from_state(&state).await {
        Ok(_) => panic!("an empty slot must reject the command"),
        Err(error) => error,
    };
    assert!(error.contains("mpv is not running"), "got: {error}");
    assert!(state.try_lock().is_ok(), "the rejection path must not keep the lock");
}
