use super::*;

type Collected = Arc<Mutex<Vec<(IpcMessage, u64, u64)>>>;

fn collector() -> (EventSink, Collected) {
    let collected: Collected = Arc::new(Mutex::new(Vec::new()));
    let sink: EventSink = {
        let collected = Arc::clone(&collected);
        Arc::new(move |message, epoch, conn| {
            collected.lock().unwrap().push((message, epoch, conn))
        })
    };
    (sink, collected)
}

#[test]
fn loadfile_reply_bumps_the_load_epoch_exactly_once() {
    let (sink, _collected) = collector();
    let core = WireState::new(sink);
    assert_eq!(core.load_epoch(), 0, "a fresh engine starts at epoch 0");

    assert_eq!(
        core.note_command_reply(LOADFILE_COMMAND),
        1,
        "a dispatched loadfile reply must bump the epoch"
    );
    assert_eq!(core.load_epoch(), 1);

    // One synchronous call = one reply = one bump; a second loadfile is a
    // second load and bumps again (mirrors the per-request bumping).
    assert_eq!(core.note_command_reply(LOADFILE_COMMAND), 2);
    assert_eq!(core.load_epoch(), 2);
}

#[test]
fn non_loadfile_reply_does_not_bump_the_load_epoch() {
    let (sink, _collected) = collector();
    let core = WireState::new(sink);
    for command in ["get_property", "set_property", "seek", "stop", "observe_property"] {
        assert_eq!(
            core.note_command_reply(command),
            0,
            "only loadfile replies may bump the epoch"
        );
    }
    assert_eq!(core.load_epoch(), 0);
}

#[test]
fn events_carry_the_epoch_current_at_dispatch_time() {
    let (sink, collected) = collector();
    let core = WireState::new(sink);

    // Event of the old track, before the new loadfile's reply is handled.
    core.emit(IpcMessage::MpvEvent {
        event: "end-file".to_string(),
        reason: Some("eof".to_string()),
        error: None,
    });

    core.note_command_reply(LOADFILE_COMMAND);

    // Event of the new track, dispatched after the loadfile reply.
    core.emit(IpcMessage::MpvEvent {
        event: "file-loaded".to_string(),
        reason: None,
        error: None,
    });

    let epochs: Vec<u64> =
        collected.lock().unwrap().iter().map(|(_, epoch, _)| *epoch).collect();
    assert_eq!(
        epochs,
        [0, 1],
        "an event before the loadfile reply carries the old epoch, one after carries the new"
    );
}

#[test]
fn events_carry_the_connection_id_of_their_engine() {
    let (sink, collected) = collector();
    let core = WireState::new(sink);
    core.emit(IpcMessage::PropertyChange {
        name: "time-pos".to_string(),
        data: serde_json::json!(1.0),
    });
    core.emit(IpcMessage::MpvEvent {
        event: "file-loaded".to_string(),
        reason: None,
        error: None,
    });
    let conns: Vec<u64> = collected.lock().unwrap().iter().map(|(_, _, conn)| *conn).collect();
    assert_eq!(conns, [core.conn(), core.conn()], "every event must carry its engine's identity");
}

#[test]
fn connection_ids_are_monotonic_and_never_repeat() {
    let (sink_a, _a) = collector();
    let (sink_b, _b) = collector();
    let first = WireState::new(sink_a);
    let second = WireState::new(sink_b);
    assert!(first.conn() >= 1, "ids start at 1, got {}", first.conn());
    assert!(
        second.conn() > first.conn(),
        "a newer engine must get a strictly greater id ({} -> {})",
        first.conn(),
        second.conn()
    );
}

#[test]
fn commanded_shutdown_makes_close_emission_silent() {
    let (sink, collected) = collector();
    let core = WireState::new(sink);
    core.mark_shutdown_requested();
    assert!(core.is_shutdown_requested());
    assert!(!core.emit_close_once(), "a commanded teardown must not report engine loss");
    let closes = collected
        .lock()
        .unwrap()
        .iter()
        .filter(|(message, _, _)| matches!(message, IpcMessage::ConnectionClosed { .. }))
        .count();
    assert_eq!(closes, 0, "a commanded shutdown must stay silent on the wire");
}

#[test]
fn uncommanded_close_is_emitted_exactly_once_with_the_eof_cause() {
    let (sink, collected) = collector();
    let core = WireState::new(sink);
    assert!(core.emit_close_once(), "an un-commanded teardown must report engine loss");
    assert!(!core.emit_close_once(), "engine loss must be reported at most once");
    let closes: Vec<(IpcMessage, u64, u64)> = collected
        .lock()
        .unwrap()
        .iter()
        .filter(|(message, _, _)| matches!(message, IpcMessage::ConnectionClosed { .. }))
        .cloned()
        .collect();
    assert_eq!(closes.len(), 1, "exactly one ipc-closed signal");
    assert_eq!(
        closes[0].0,
        IpcMessage::ConnectionClosed { cause: "eof".to_string() },
        "the close cause mirrors the wire's pipe-eof vocabulary"
    );
    assert_eq!(closes[0].2, core.conn(), "the close event carries the engine identity");
}
