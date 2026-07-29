# Native Player Engine — Summary

## Objective
Native Rust audio player streaming into a bounded RAM ring buffer — no full-file download, no disk I/O, no Range requests.

---

## Architecture

```
cmd_play(file_id)
  ↓
  resolve_download_url(file_id)
    → Head request (no redirect) to Drive API → capture final URL + total_size
  ↓
  Create BufferState { VecDeque<u8>, window_start=0, write_end=0, total, finished }
  Wrap in Arc<(Mutex<BufferState>, reader_Condvar, writer_Condvar)>
  ↓
  Spawn background thread:
    → HTTP/1.1 GET resolved URL (sequential, no Range)
    → For each chunk:
        if data.len() + chunk.len() > RING_CAPACITY: wait(writer_cvar)
        data.extend(chunk); write_end += chunk.len(); notify(reader_cvar)
    → finished=true; notify_all
  ↓
  Wait for INITIAL_BUFFER (64 KB)
  ↓
  RamSong { state, pos: 0 } — implements Read + Seek
    Reader: blocks via reader_cvar when data not available
            after reading, trim consumed data from VecDeque front
            if trimmed > RING_CAPACITY/4, notify(writer_cvar) for backpressure
    Seek: clamps pos ≥ window_start (can't seek before discarded data)
  ↓
  Decoder::new(RamSong) in spawn_blocking
  ↓
  sink.append(decoder) → plays immediately
```

## Ring Buffer Constants
| Constant | Value | Meaning |
|---|---|---|
| `INITIAL_BUFFER_BYTES` | 64 KB | Start playback after this much data arrives |
| `RING_CAPACITY` | 3 MB | Max RAM usage (~40s at 600kbps, ~3min at 128kbps) |

## Key Behaviors
- **Streaming**: download and decode run in parallel, producer-consumer via Condvar
- **Bounded RAM**: VecDeque drains consumed data from front; writer pauses when buffer full
- **No disk**: zero writes to filesystem
- **Seek forward**: within buffer → instant; beyond buffer → reader blocks until download reaches that position
- **Seek backward**: only within remaining buffer (data before `window_start` has been discarded)

## Build Status
- 0 errors, 0 warnings
- 0 unused imports/constants
- Dependencies: `reqwest 0.12`, `rodio 0.19` (symphonia), `tokio`, `futures`

## Context
- Project: `C:\Users\thinkpad\Desktop\Antigravity\refactor`
- Branch: `refactor/native-player-engine`
- Player module: `src-tauri/src/player/mod.rs` (~430 lines)
