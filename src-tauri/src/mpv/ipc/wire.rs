use std::time::Duration;

use serde_json::Value;
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex as AsyncMutex;

use super::IpcMessage;

/// One line received from mpv, classified.
pub(super) enum Incoming {
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
pub(super) fn parse_line(line: &str) -> Option<Incoming> {
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

/// Write one framed command, bounded by `timeout`. A frame is a few hundred
/// bytes, so mpv drains it instantly; a stall past the deadline means mpv
/// stopped reading the pipe. The command must fail instead of holding the
/// writer mutex forever — a wedged mutex queues every later command
/// (pause/seek/loadfile/recovery get_property) behind it indefinitely.
pub(super) async fn write_frame_bounded<W: tokio::io::AsyncWrite + Unpin>(
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
