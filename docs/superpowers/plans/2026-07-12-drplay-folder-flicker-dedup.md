# drplay Folder-Flicker & Track-Dedup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix two correctness bugs in drplay: (A) the loading spinner flickers off / shows an empty folder when switching Drive folders quickly, and (B) two different audio tracks that happen to share the same byte size get merged into one DB entry (wrong title/artist/cover, second track un-addable).

**Architecture:** (A) Extract a tiny request-id guard so only the *latest* in-flight folder fetch is allowed to touch the shared `isLoadingTracks` state and the deletion-sync step. (B) Change the Rust dedup key from `size_bytes` alone to an exact Drive `file_id` match (stored as `drive://{id}` in `file_path`), removing the size-only fallback that merged different tracks.

**Tech Stack:** React 19 + TypeScript (Vite), Tauri 2 (Rust/rusqlite), Dexie. TypeScript must pass `tsc --noEmit`. Rust must pass `cargo test` in `src-tauri`.

## Global Constraints

- TypeScript: `npx tsc --noEmit -p tsconfig.json` must finish with **no errors**.
- Rust: `cd src-tauri && cargo test` must pass. Do not alter the Tauri command list beyond adding/renaming args shown.
- Do **not** change UI, copy, or user-facing strings — only behavior.
- Follow existing patterns: React state via `useState`; Rust DB access via `pool.get()` + `rusqlite`; frontend↔backend via `invoke("<command>", {...})`.
- One new dev dependency is allowed: `vitest` (for the TS guard unit test). No new runtime dependencies.

## File Structure

- **Create** `src/utils/folderFetchGuard.ts` — pure, testable latest-request guard. No React/Dexie deps.
- **Modify** `src/App.tsx` — module-level guard instance + use it inside `fetchFolderContentsToDexie` to gate every `setIsLoadingTracks` and the deletion block.
- **Create** `src/utils/folderFetchGuard.test.ts` — vitest unit test for the guard.
- **Modify** `src-tauri/src/lib.rs` — `get_local_metadata_internal` gains a `drive_id` param and uses exact `drive://{id}` match; callers `get_local_metadata` (command) and `add_drive_track_to_db` updated. Add `#[cfg(test)]` unit test.
- **Modify** `src/utils/metadata.ts` — `getTrackMetadata` passes `drive_id` to the `get_local_metadata` invoke.

---

### Task 1: Add vitest + the folder-fetch guard module

**Files:**
- Create: `src/utils/folderFetchGuard.ts`
- Create: `src/utils/folderFetchGuard.test.ts`
- Modify: `package.json` (add `vitest` devDep + `test` script)

**Interfaces:**
- Produces: `createFolderFetchGuard(): { start(): number; isLatest(id: number): boolean }` — `start()` returns a strictly increasing id and marks it latest; `isLatest(id)` is true only for the most recent `start()`.

- [ ] **Step 1: Write the failing test**

`src/utils/folderFetchGuard.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { createFolderFetchGuard } from './folderFetchGuard';

describe('createFolderFetchGuard', () => {
  it('only the latest started request is reported as latest', () => {
    const g = createFolderFetchGuard();
    const a = g.start();
    const b = g.start();
    expect(g.isLatest(a)).toBe(false);
    expect(g.isLatest(b)).toBe(true);
  });

  it('returns strictly increasing ids', () => {
    const g = createFolderFetchGuard();
    expect(g.start()).toBeLessThan(g.start());
  });

  it('a superseded request stops being latest after a newer one starts', () => {
    const g = createFolderFetchGuard();
    const a = g.start();
    g.start();
    expect(g.isLatest(a)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/utils/folderFetchGuard.test.ts`
Expected: FAIL — `Cannot find module './folderFetchGuard'`

- [ ] **Step 3: Install vitest and write the implementation**

`package.json` — add to `devDependencies`:
```json
"vitest": "^2.1.0"
```
and add a script:
```json
"test": "vitest run"
```

`src/utils/folderFetchGuard.ts`:
```ts
export type FolderFetchGuard = {
  start: () => number;
  isLatest: (id: number) => boolean;
};

export function createFolderFetchGuard(): FolderFetchGuard {
  let latest = 0;
  return {
    start: () => {
      latest += 1;
      return latest;
    },
    isLatest: (id: number) => id === latest,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/utils/folderFetchGuard.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/utils/folderFetchGuard.ts src/utils/folderFetchGuard.test.ts package.json package-lock.json
git commit -m "test: add folder-fetch latest-request guard"
```

---

### Task 2: Wire the guard into fetchFolderContentsToDexie

**Files:**
- Modify: `src/App.tsx` (imports + module-level guard + `fetchFolderContentsToDexie` body)

**Interfaces:**
- Consumes: `createFolderFetchGuard()` from `./utils/folderFetchGuard`.
- Produces: no new exports; behavior change only — only the latest in-flight fetch may call `setIsLoadingTracks` or run the deletion-sync `bulkDelete`.

- [ ] **Step 1: Add import + module-level guard instance**

At the top of `src/App.tsx`, after the existing imports (e.g. after `import { metadataCache } from "./utils/metadata";`):
```ts
import { createFolderFetchGuard } from "./utils/folderFetchGuard";

const folderFetchGuard = createFolderFetchGuard();
```
(Place `const folderFetchGuard = ...` at **module scope**, outside the `function App()` body.)

- [ ] **Step 2: Capture a request id at the start of the function**

In `fetchFolderContentsToDexie`, make the first line:
```ts
  async function fetchFolderContentsToDexie(token: string, folderId: string) {
    const myId = folderFetchGuard.start();
    let fetchCompleted = true;
    try {
```

- [ ] **Step 3: Guard the early spinner-hide**

Replace:
```ts
        // Hide loading spinner early if we have something to show
        if (isFirstPage && pageToken && existingCount === 0) {
          setIsLoadingTracks(false);
        }
```
with:
```ts
        // Hide loading spinner early only if THIS request is still the latest one
        if (isFirstPage && pageToken && existingCount === 0 && folderFetchGuard.isLatest(myId)) {
          setIsLoadingTracks(false);
        }
```

- [ ] **Step 4: Guard the deletion-sync block**

Replace:
```ts
      if (fetchCompleted && !pageToken) {
```
with:
```ts
      if (fetchCompleted && !pageToken && folderFetchGuard.isLatest(myId)) {
```

- [ ] **Step 5: Guard the finally block**

Replace:
```ts
    } finally {
      setIsLoadingTracks(false);
    }
```
with:
```ts
    } finally {
      if (folderFetchGuard.isLatest(myId)) {
        setIsLoadingTracks(false);
      }
    }
```

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors

- [ ] **Step 7: Commit**

```bash
git add src/App.tsx
git commit -m "fix: only latest folder fetch controls loading state and deletion"
```

---

### Task 3: Manual verification — folder flicker (Bug A)

**Files:** none (manual, in the running app)

- [ ] **Step 1: Build/run the UI**
Run: `cd drplay && npm run dev` (Tauri dev window opens).
- [ ] **Step 2: Reproduce the old flicker**
Log into Google Drive, open a folder with many tracks (forces multiple pages). Rapidly click between two folders (A → B → A → B) several times.
- [ ] **Step 3: Verify fix**
Spinner must stay visible until the **current** folder's content actually loads; it must **not** vanish mid-switch showing an empty list, and no folder's songs disappear. Switching back to a previously viewed folder shows its correct (cached) contents.

---

### Task 4: Rust — dedup by exact Drive id (Bug B)

**Files:**
- Modify: `src-tauri/src/lib.rs` — `get_local_metadata_internal` (lines ~316–357) and its two call sites (`get_local_metadata` ~360–367, `add_drive_track_to_db` ~401).

**Interfaces:**
- Produces: `get_local_metadata_internal(size: i64, name: &str, drive_id: &str, conn: &rusqlite::Connection) -> Option<LocalMetadata>` (new `drive_id` param). `get_local_metadata` command gains `drive_id: String`. `add_drive_track_to_db` now dedups on exact `drive://{drive_id}` match.

- [ ] **Step 1: Replace `get_local_metadata_internal`**

Replace the whole function (lines 316–357) with:
```rust
fn get_local_metadata_internal(
    size: i64,
    name: &str,
    drive_id: &str,
    conn: &rusqlite::Connection,
) -> Option<LocalMetadata> {
    let has_file_type = HAS_FILE_TYPE.get_or_init(|| {
        conn.prepare("SELECT file_type FROM tracks LIMIT 1").is_ok()
    });

    let query = if *has_file_type {
        "SELECT title, artist, album, duration, file_path, cover_art IS NOT NULL, file_type, id FROM tracks WHERE size_bytes = ?"
    } else {
        "SELECT title, artist, album, duration, file_path, cover_art IS NOT NULL, '', id FROM tracks WHERE size_bytes = ?"
    };

    let mut stmt = conn.prepare(query).ok()?;
    let mut rows = stmt.query([size]).ok()?;

    let mut name_match = None;
    while let Ok(Some(row)) = rows.next() {
        let file_path: String = row.get(4).unwrap_or_default();
        let meta = LocalMetadata {
            title: row.get(0).unwrap_or_default(),
            artist: row.get(1).unwrap_or_default(),
            album: row.get(2).unwrap_or_default(),
            duration: row.get(3).unwrap_or_default(),
            has_cover: row.get(5).unwrap_or(false),
            file_type: row.get(6).unwrap_or_default(),
            id: row.get(7).unwrap_or_default(),
        };

        // Exact identity: Drive tracks store their id in file_path as
        // drive://{id}. This prevents two different tracks that happen to
        // share a byte size from being merged into one entry.
        if !drive_id.is_empty() && file_path == format!("drive://{}", drive_id) {
            return Some(meta);
        }

        // Soft fallback: only treat a same-size row as a match when the name
        // or title actually aligns. Never fall back to an arbitrary first row.
        if name_match.is_none()
            && (file_path.contains(name) || meta.title.contains(name) || name.contains(&meta.title))
        {
            name_match = Some(meta);
        }
    }

    name_match
}
```

- [ ] **Step 2: Update the `get_local_metadata` command signature**

In `get_local_metadata` (around line 360), change the signature and the internal call:
```rust
#[tauri::command]
fn get_local_metadata(
    size: i64,
    name: String,
    drive_id: String,
    pool: tauri::State<'_, r2d2::Pool<r2d2_sqlite::SqliteConnectionManager>>,
    app_handle: tauri::AppHandle,
) -> Option<LocalMetadata> {
    let conn = pool.get().ok()?;
    let mut meta = get_local_metadata_internal(size, &name, &drive_id, &conn)?;
```
(the rest of the function body stays unchanged)

- [ ] **Step 3: Update the `add_drive_track_to_db` dedup call**

In `add_drive_track_to_db`, change (around line 401):
```rust
    if let Some(existing) = get_local_metadata_internal(size, &name, &conn) {
```
to:
```rust
    if let Some(existing) = get_local_metadata_internal(size, &name, &file_id, &conn) {
```

- [ ] **Step 4: Compile**

Run: `cd src-tauri && cargo build`
Expected: compiles with no errors (warnings OK).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "fix(rust): dedup tracks by exact drive id, not byte size"
```

---

### Task 5: Frontend — pass `drive_id` to the Rust command

**Files:**
- Modify: `src/utils/metadata.ts` — `getTrackMetadata` invoke call (lines ~292–295)

**Interfaces:**
- Consumes: `get_local_metadata` command now requires `drive_id: String` (added in Task 4).
- Produces: no new exports.

- [ ] **Step 1: Add `drive_id` to the invoke payload**

Replace:
```ts
      const local = await invoke<{ id: string; title: string; artist: string; album: string; duration: number; has_cover: boolean; file_type: string } | null>('get_local_metadata', {
        size: Number(safeSize),
        name: safeName,
      });
```
with:
```ts
      const local = await invoke<{ id: string; title: string; artist: string; album: string; duration: number; has_cover: boolean; file_type: string } | null>('get_local_metadata', {
        size: Number(safeSize),
        name: safeName,
        drive_id: fileId,
      });
```
(`fileId` is already the first parameter of `getTrackMetadata`, so it is in scope.)

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/utils/metadata.ts
git commit -m "fix: pass drive_id to get_local_metadata for exact dedup"
```

---

### Task 6: Rust unit test — two same-size tracks are not merged

**Files:**
- Modify: `src-tauri/src/lib.rs` (append a `#[cfg(test)] mod tests` at the end of the file)

**Interfaces:**
- Consumes: `get_local_metadata_internal(size, name, drive_id, conn)` (Task 4).

- [ ] **Step 1: Append the test module**

At the end of `lib.rs`:
```rust
#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn setup() -> Connection {
        let conn = Connection::in_memory().unwrap();
        conn.execute(
            "CREATE TABLE tracks (
                id TEXT, title TEXT, artist TEXT, album TEXT,
                duration REAL, file_path TEXT, cover_art BLOB,
                file_type TEXT, size_bytes INTEGER
            )",
            [],
        )
        .unwrap();
        conn
    }

    #[test]
    fn dedup_by_drive_id_not_size() {
        let conn = setup();
        conn.execute(
            "INSERT INTO tracks (id, title, artist, duration, file_path, size_bytes) VALUES (?1,?2,?3,?4,?5,?6)",
            ["AAA", "Song A", "Artist A", 200.0, "drive://AAA", 1000],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO tracks (id, title, artist, duration, file_path, size_bytes) VALUES (?1,?2,?3,?4,?5,?6)",
            ["BBB", "Song B", "Artist B", 200.0, "drive://BBB", 1000],
        )
        .unwrap();

        // Lookup by drive_id AAA must return AAA even though BBB shares size.
        let m = get_local_metadata_internal(1000, "", "AAA", &conn).unwrap();
        assert_eq!(m.id, "AAA");

        // Lookup by drive_id BBB must return BBB.
        let m = get_local_metadata_internal(1000, "", "BBB", &conn).unwrap();
        assert_eq!(m.id, "BBB");
    }

    #[test]
    fn empty_drive_id_falls_back_to_name_match() {
        let conn = setup();
        conn.execute(
            "INSERT INTO tracks (id, title, artist, duration, file_path, size_bytes) VALUES (?1,?2,?3,?4,?5,?6)",
            ["XXX", "My Song", "Someone", 200.0, "drive://XXX", 1000],
        )
        .unwrap();

        // With empty drive_id and a matching name, the name match still works.
        let m = get_local_metadata_internal(1000, "My Song", "", &conn).unwrap();
        assert_eq!(m.id, "XXX");
    }
}
```

- [ ] **Step 2: Run the Rust tests**

Run: `cd src-tauri && cargo test`
Expected: `dedup_by_drive_id_not_size` and `empty_drive_id_falls_back_to_name_match` PASS; all other tests PASS.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "test(rust): cover drive-id dedup and name fallback"
```

---

### Task 7: Manual verification — track dedup (Bug B)

**Files:** none (manual, in the running app)

- [ ] **Step 1: Build the full app**
Run: `cd drplay && npm run tauri dev` (full Tauri build including Rust).
- [ ] **Step 2: Verify two same-size tracks stay separate**
Find or create two different audio files with the **same byte size** (e.g. two short clips trimmed to identical length). Add both to the library / Drive. Confirm both appear as separate entries with their **own** title, artist, and cover — neither overwrites the other.
- [ ] **Step 3: Verify re-add is stable**
Re-add a track that already exists (same Drive file). Confirm it reuses the existing entry (no duplicate row) rather than inserting a second one.

---

## Self-Review

1. **Spec coverage:** Bug A → Tasks 1–3. Bug B → Tasks 4–7. Both covered.
2. **Placeholder scan:** No TBD/TODO. Every code step shows full code. Test steps include real assertions and expected output.
3. **Type consistency:** `createFolderFetchGuard` signature matches its test (Task 1) and its use in App.tsx (Task 2). `get_local_metadata_internal(size, name, drive_id, conn)` matches all three call sites (Tasks 4, 5 command, 6 test). `get_local_metadata` invoke payload (Task 5) matches the Rust command signature (Task 4). ✅
