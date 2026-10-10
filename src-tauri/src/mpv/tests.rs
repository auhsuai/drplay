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

// --- kill-on-close job lifecycle (Phase 9 TASK B) ---------------------------

/// JOB-003: the commanded-shutdown path must close the job AND say so. This
/// drives `take_labelled` — the exact teardown code `mpv_shutdown` calls — so
/// a close in the app log can be attributed to a path instead of appearing
/// anonymous.
#[tokio::test]
async fn a_commanded_shutdown_closes_the_job_with_its_reason() {
    let pipe_name = format!(r"\\.\pipe\drplay-mpv-job-shutdown-{}", std::process::id());
    let (handle, _server) = test_handle(&pipe_name).await;
    let job_id = handle.job.id;
    let state: SharedMpv = Arc::new(Mutex::new(Some(handle)));

    // Exactly `mpv_shutdown`'s lock scope.
    let mut slot = state.lock().await;
    let Some(handle) = take_labelled(&mut slot, "mpv_shutdown") else {
        panic!("the slot must hold the sidecar handle");
    };
    handle.ipc.mark_shutdown_requested();
    drop(handle); // the last reference — closing the job is the kill
    drop(slot);

    assert_eq!(
        job::recorded_close(job_id),
        Some("mpv_shutdown"),
        "the job close must be recorded against the shutdown path"
    );
}

/// JOB-004: an engine that dies on its own must never look like a commanded
/// shutdown. Two independent pieces of evidence must agree: the connection
/// stays un-commanded (so the pipe close is still reported as a failure), and
/// the job close carries the reaping path's reason — never `mpv_shutdown`.
#[tokio::test]
async fn an_unexpected_child_death_is_not_recorded_as_a_commanded_shutdown() {
    let pipe_name = format!(r"\\.\pipe\drplay-mpv-job-unexpected-{}", std::process::id());
    let (mut handle, _server) = test_handle(&pipe_name).await;
    let job_id = handle.job.id;
    // The engine dies without anyone commanding a shutdown — the shape of the
    // Phase 8 failure (exit 0xFFFFFFFF, pipe EOF, `mpv_shutdown` never called).
    handle
        .child
        .start_kill()
        .expect("the unexpected-death simulation must signal the child");
    let state: SharedMpv = Arc::new(Mutex::new(Some(handle)));

    let mut slot = state.lock().await;
    assert!(
        !slot.as_ref().expect("the slot must hold the handle").ipc.shutdown_was_requested(),
        "nobody commanded this shutdown, so the flag must stay false"
    );
    drop(take_labelled(&mut slot, "mpv_spawn_respawn"));
    drop(slot);

    assert_eq!(
        job::recorded_close(job_id),
        Some("mpv_spawn_respawn"),
        "an unexpected death must be attributed to the reaping path, not to a shutdown"
    );
}

/// JOB-006: closing the job kills mpv, so a normal load/command round-trip must
/// leave the job open. If a round-trip ever dropped the last reference the
/// engine would die mid-playback — the failure this instrumentation exists to
/// investigate. Asserts both that the handle is still owned and that the job
/// has no close record.
#[tokio::test]
async fn the_job_stays_open_across_a_command_round_trip() {
    let pipe_name = format!(r"\\.\pipe\drplay-mpv-job-alive-{}", std::process::id());
    let (handle, server) = test_handle(&pipe_name).await;
    let job_id = handle.job.id;
    let state: SharedMpv = Arc::new(Mutex::new(Some(handle)));

    let ipc = running_ipc_from_state(&state).await.expect("a running sidecar must resolve");
    let (frame_seen_tx, frame_seen_rx) = tokio::sync::oneshot::channel();
    let (reply_go_tx, reply_go_rx) = tokio::sync::oneshot::channel();
    let responder = tokio::spawn(answer_one_command(server, frame_seen_tx, reply_go_rx));

    let command =
        tokio::spawn(async move { ipc.send_command(vec![json!("get_property"), json!("pause")]).await });
    frame_seen_rx.await.expect("the command must reach the peer");
    reply_go_tx.send(()).expect("the responder must accept the go signal");
    let data = command.await.expect("the command task must not panic").expect("the round trip must succeed");
    assert_eq!(data, json!(7));
    responder.await.expect("the responder must finish");

    assert!(
        state.lock().await.is_some(),
        "the sidecar handle must still be owned after the round trip"
    );
    assert_eq!(
        job::recorded_close(job_id),
        None,
        "the kill-on-close job must still be open — closing it would kill mpv mid-playback"
    );
}
