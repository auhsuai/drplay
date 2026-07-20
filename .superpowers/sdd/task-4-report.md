# Task 4 Report — Migrate `playlists.ts` to `db.playlists`

## status
DONE

## commits
- `e4ce052` refactor: playlists -> Dexie playlists table

## test summary
Command: `npx vitest run src/utils/playlists`
Result: 8 passed (8)

Coverage: createPlaylist (scoped to userEmail), getPlaylists empty, addTrackToPlaylist (append + dedupe), removeTrackFromPlaylist, updatePlaylist (merge), deletePlaylist, per-user isolation (userEmail filtering), and `playlists-updated` dispatchEvent on mutations.

`npx tsc --noEmit` — clean.

## concerns
- The plan's Task 4 brief listed signatures (`addToPlaylist`/`removeFromPlaylist`/`subscribePlaylists`/`clearCache`) that do NOT exist in the real `src/utils/playlists.ts`. I implemented against the ACTUAL exported API: `getPlaylists`, `createPlaylist`, `deletePlaylist`, `updatePlaylist`, `addTrackToPlaylist`, `removeTrackFromPlaylist`, `getPlaylistById`, `Playlist`. No call sites rely on the brief's names.
- The real `PlaylistRow` schema (`src/db/db.ts:31`) has no `updatedAt` field, so I did not add one. `Playlist` now carries `userEmail` (read back from the table) so per-user rows are reconstructable; `userEmail` is preserved on `updatePlaylist` rather than overwritten.
- `idb-keyval` intentionally left installed (still used by storage.ts/cache.ts/favorites.ts until Task 6).
