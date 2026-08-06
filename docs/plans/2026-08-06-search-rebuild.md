# Search Rebuild (Industry-Standard) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace all 4 search mechanisms (global My Drive, folder picker, playlist submenu, recent view) with one industry-standard search engine (MiniSearch, relevance-ranked, Vietnamese-aware, worker-hosted, scale to any library size) — keeping every existing UI component and hook interface unchanged.

**Architecture:** Pure engine module (`src/search/searchEngine.ts`) wraps MiniSearch over normalized Vietnamese text (existing `normalizeText`); a Web Worker (`src/search/search.worker.ts`) owns the index and rebuilds it lazily when invalidated by data-change events (Dexie hooks on main thread + pro-sync progress events), so queries never block the UI at any library size; a hook (`src/hooks/useSearchWorker.ts`) debounces input and talks to the worker (with an inline fallback when `Worker` is unavailable, e.g. vitest jsdom). The 4 entry points consume the engine via the same props/UI as today.

**Tech Stack:** minisearch ^7.2.0 (new dep), dexie 4.4.4, React 19.2, Vite 7 worker pattern (`new Worker(new URL(...), {type:'module'})` — precedent: `src/utils/proSyncManager.ts`), vitest + fake-indexeddb.

## Global Constraints

- UI/UX files and component props MUST NOT change (user requirement): `TopNavigationBar`, `SongCard`, `VirtualizedSongList`, `MainContent` props/state flow, `FolderSelectionScreen` markup, `PlaylistsSubmenu` markup, `FullRecentView` markup stay untouched.
- Hook interface of `useDriveExplorer` MUST stay identical: returns `{ searchQuery, setSearchQuery, currentPage, setCurrentPage, totalPages, currentItems, filteredItems, ...bulk ops }`.
- `normalizeText` (src/utils/normalizeText.ts) is the single normalization source — reuse, do not re-implement.
- Real metadata rule: only IDB metadataCache entries with `entry.version === 2 && entry.data.v < V_PLACEHOLDER (9)` are "real" (metadata.ts:10,76). Placeholders (v:9, title=filename, artist="Unknown Artist") MUST NOT be indexed or displayed as searchable content.
- Behavior contract (BẢO TOÀN / deliberate changes — report deviations BEFORE making them):
  - KEEP: diacritics-insensitive match (query "doi" → "Đổi thay.mp3")
  - KEEP: multi-word AND ("anh yeu" = both tokens must match)
  - KEEP: ID3 title/artist searchable when real (data source moves from memory LRU `metadataCache` to IDB `db.metadataCache`)
  - KEEP: folders searchable by name; folders render before files in results
  - KEEP: global limit 500 (GLOBAL_SEARCH_LIMIT), pagination 50/page (ITEMS_PER_PAGE)
  - KEEP: empty query → normal folder listing (no search)
  - CHANGED (deliberate): results ranked by relevance (exact > prefix > fuzzy; name > title > artist) instead of alphabetical — folder-grouped first, relevance within group
  - CHANGED (deliberate): word-prefix semantics (query "oi" no longer matches mid-word "Đổi"; typos covered by fuzzy 0.2) — industry standard
  - CHANGED (deliberate): folder picker API search fires whenever query ≥ 2 chars even when local matches exist (fixes "can't search folder" gating bug); local + API results both render
  - CHANGED (deliberate): playlist submenu + recent view now diacritics-insensitive (were plain toLowerCase)
- Error handling (AGENTS.md Luật 4): every async path try/catch with classified errors, `captureError` logging (no console), no silent swallowing; worker errors surface as `{type:'error'}` and the hook keeps last-good results.
- TypeScript strict: no `as any`, no `e: any`; named constants, no magic strings.
- Functions ≤ 100 lines, files ≤ 400 lines; English comments explaining "why".

---

### Task 1: Search engine core (pure module)

**Files:**
- Modify: `package.json` (add dependency `minisearch`)
- Create: `src/search/searchEngine.ts`
- Create: `src/search/searchEngine.test.ts`

**Interfaces:**
- Consumes: `DriveFile` (src/db/db.ts), `normalizeText` (src/utils/normalizeText.ts), `V_PLACEHOLDER` (src/utils/metadata.ts), MiniSearch v7 API.
- Produces (exact signatures later tasks depend on):
  - `export interface SearchDoc { id: string; name: string; isFolder: boolean; title?: string; artist?: string; parentId: string; mimeType: string; size?: number; modifiedTime?: string }`
  - `export interface SearchHit { id: string; score: number; name: string; isFolder: boolean; title: string; artist: string | null; parentId: string; mimeType: string; size?: number; modifiedTime?: string }`
  - `export function buildSearchIndex(files: DriveFile[], realMetadata: ReadonlyMap<string, CachedMetadata>): MiniSearch<SearchDoc>` — fields `['name','title','artist']`, storeFields all of SearchDoc, processTerm = normalizeText wrapper, boost `{name:3, title:2, artist:1.5}`, doc id = file id.
  - `export function loadRealMetadata(rows: MetadataCacheRow[]): Map<string, CachedMetadata>` — keeps only `entry.version === 2 && entry.data.v < V_PLACEHOLDER` (key `MetadataCacheRow.key` has prefix `metadata_` from metadata.ts:6; strip prefix → fileId).
  - `export function queryIndex(index: MiniSearch<SearchDoc>, query: string, limit: number): SearchHit[]` — split `query` on `/\s+/`, filter empty, normalize each token; call `index.search(tokens.join(' '), { combineWith:'AND', prefix:true, fuzzy:0.2 })`; map hits to SearchHit (title fallback = stripExt(name) when no real title; artist null).
  - `export function matchesNormalized(text: string, query: string): boolean` — for small in-memory lists: `query.split(/\s+/).filter(Boolean).every(t => normalizeText(text).includes(normalizeText(t)))` (substring on normalized — preserves old small-list semantics).

**TDD test cases (all must be written first, fail first):**
1. diacritics: query "doi" hits file name "Đổi thay.mp3"
2. multi-token AND: "anh yeu" hits "Anh dong vien - Yeu em.mp3", not "Doi thay.mp3"
3. relevance: query "anh" ranks exact name "Anh.mp3" above "Anh yeu em.mp3" above "Yeu anh.mp3"
4. prefix: "mo" hits "Motorcycle.mp3"; fuzzy: "ishmael" hits "Ishmael" (use Latin fixture, fuzzy 0.2)
5. real metadata only: entry v:5 title "Nỗi buồn" artist "Ca sĩ X" → query "noi buon" and "ca si" hit; placeholder v:9 ("Unknown Artist") → query "unknown artist" does NOT hit
6. folders: query matches folder name, isFolder=true, folders first in result order (mapping-layer stable sort is Task 3; engine returns both)
7. limit: 600 docs, query matches 600 → returns ≤ limit, top-ranked first
8. empty query → []
9. matchesNormalized: "doi" true for "Đổi thay", "anh yeu" AND semantics, "" → false/true per contract (empty query → false)
10. queryIndex tokens: whitespace-robust (multiple spaces, leading/trailing)

- [ ] **Step 1: Add dependency**
  Run: `npm install minisearch@^7.2.0` (verify `package.json` gains `"minisearch": "^7.x"`).
- [ ] **Step 2: Write failing tests** — `src/search/searchEngine.test.ts` (fake-indexeddb NOT needed — pure; import MiniSearch directly; fixture helper `makeFile(id, name, opts)` mirroring `src/hooks/useDriveExplorer.search.test.tsx:41`).
- [ ] **Step 3: Run tests → verify RED**
  Run: `npx vitest run src/search/searchEngine.test.ts` — expected FAIL (module not found).
- [ ] **Step 4: Implement** `src/search/searchEngine.ts` (constants: `NAME_BOOST=3`, `TITLE_BOOST=2`, `ARTIST_BOOST=1.5`, `FUZZY=0.2`, `METADATA_VERSION=2` — no magic numbers).
- [ ] **Step 5: Run tests → GREEN**
  Run: `npx vitest run src/search/searchEngine.test.ts` — all pass.
- [ ] **Step 6: Lint + commit**
  Run: `npx eslint src/search/searchEngine.ts src/search/searchEngine.test.ts` — clean. Commit: `feat(search): MiniSearch engine core with Vietnamese-aware relevance ranking`.

---

### Task 2: Search worker + client hook

**Files:**
- Create: `src/search/search.worker.ts`
- Create: `src/search/search.worker.test.ts`
- Create: `src/hooks/useSearchWorker.ts`
- Create: `src/hooks/useSearchWorker.test.tsx`

**Interfaces:**
- Consumes: `buildSearchIndex`, `loadRealMetadata`, `queryIndex` (Task 1); `db` (src/db/db.ts); `captureError` (src/utils/errorLog.ts).
- Produces:
  - `export type SearchWorkerRequest = { type:'init' } | { type:'invalidate' } | { type:'query'; requestId: number; query: string; limit: number }`
  - `export type SearchWorkerResponse = { type:'ready' } | { type:'results'; requestId: number; hits: SearchHit[] } | { type:'error'; requestId?: number; message: string }`
  - `export function handleSearchWorkerMessage(msg: SearchWorkerRequest, deps: { db: typeof db; rebuild: () => Promise<MiniSearch<SearchDoc>>; post: (r: SearchWorkerResponse) => void; query: typeof queryIndex }): Promise<void>` — pure-ish, injectable for tests (precedent: `handleWorkerMessage` in src/utils/proSyncManager.ts).
  - `export function useSearchWorker(query: string, limit: number): { hits: SearchHit[] }` — React hook:
    - worker created once via `new Worker(new URL('../search/search.worker.ts', import.meta.url), { type:'module' })` when `typeof Worker !== 'undefined'`; else inline fallback (same rebuild+query path, run directly — makes vitest/jsdom testable).
    - 150ms debounce on query change (`DEBOUNCE_MS=150` — same value as current useDriveExplorer).
    - invalidation: subscribe `db.files.hook('creating','updating','deleting')` → throttled `{type:'invalidate'}` (300ms); also listen `window` CustomEvents `pro-sync-progress` / `pro-sync-complete` (proSyncManager.ts:7-13) → invalidate (covers proSync worker writes on its own connection).
    - stale/in-flight results: keep last-good hits while a query is in flight; a `requestId` guard drops out-of-order responses (no race).
    - worker errors → `captureError({level:'warn', source:'searchWorker', message})` + keep last results (no silent swallow, no crash).

**TDD test cases:**
1. worker protocol: init→ready; query→results with requestId echo; invalidate then query → rebuild called (deps spy)
2. race guard: two queries; older response arriving after newer → older dropped (injectable post queue)
3. query with diacritics through the protocol (inline path)
4. inline fallback path returns hits without Worker (jsdom env)
5. error path: rebuild throws → `{type:'error'}` posted, no unhandled rejection
6. empty query → `hits: []` without hitting worker/rebuild
7. hook debounce: rapid setQuery("a"),("ab"),("abc") → only "abc" query executed (fake timers)
8. invalidation: `db.files.put(...)` fires invalidate (throttled) → next query rebuilds fresh (fake-indexeddb + real db)

- [ ] **Step 1: Write failing tests** (both files).
- [ ] **Step 2: Run → verify RED** (`npx vitest run src/search src/hooks/useSearchWorker.test.tsx`).
- [ ] **Step 3: Implement** worker + hook (checkpoints: constants/protocol → worker handler → hook → inline fallback).
- [ ] **Step 4: Run → GREEN** (full search dir).
- [ ] **Step 5: Lint + commit** `feat(search): worker-hosted search index with debounce + invalidation`.

---

### Task 3: Integrate into useDriveExplorer (interface unchanged)

**Files:**
- Modify: `src/hooks/useDriveExplorer.ts` — replace lines ~144-203 (globalSearchItemsRaw/globalSearchItems) with `useSearchWorker`; keep mapping identical (stripExt title, trackInfo with parentName "Search Result", folders-first stable sort) EXCEPT sort: folders-first, then relevance (score desc) instead of title alphabetical.
- Modify: `src/hooks/useDriveExplorer.search.test.tsx` — seed real metadata via `db.metadataCache.put({key:'metadata_<id>', entry:{version:2, data:{...v:5...}, ts:Date.now()}})` instead of memory `metadataCache` map; add folder-search tests (folder found by name, folders before files); add relevance-order test.

**Interfaces:**
- Consumes: `useSearchWorker(query, GLOBAL_SEARCH_LIMIT)` (Task 2).
- Produces: unchanged `useDriveExplorer` return shape.
- Behavior: query non-empty → `hits` mapped to the same `DriveItem[]` shape; empty → `filteredItems = items` (normal listing), as today.

**TDD test cases (update/extend):**
1. existing: đ-normalization, ID3 title (via IDB now), artist, multi-token AND, limit>100 — all keep passing with new data seeding
2. NEW: folder "Nhạc Việt" found by query "nhac" with isFolder=true
3. NEW: folders sort before files in search results
4. NEW: relevance: exact name ranks above partial
5. NEW: placeholder metadata (v:9) NOT matched by "unknown artist"
6. currentItems pagination still 50/page, totalPages correct

- [ ] **Step 1: Update tests first** (seed via IDB; new cases) → run → verify RED for new cases.
- [ ] **Step 2: Implement** integration (keep `useDebouncedLiveQuery` import removal for Task 6 — but if it becomes orphan only after this task, remove import now and delete file in Task 6).
- [ ] **Step 3: Run full search-related suite** (`npx vitest run src/hooks/useDriveExplorer.search.test.tsx src/hooks/useDriveExplorer.uploadPin.test.tsx`) → GREEN.
- [ ] **Step 4: Lint + commit** `feat(search): wire global search to worker engine, relevance ranking`.

---

### Task 4: Folder picker logic (fix gating bug + unified matching)

**Files:**
- Modify: `src/ui/FolderSelection/FolderSelectionScreen.tsx` — local filter (lines ~167-171) → `matchesNormalized`; API-search effect (lines ~285-294) drops the `filteredFolders.length > 0` gate; `apiSearchActive` (lines ~189-199) becomes `Boolean(searchQuery.trim())`; keep min-length 2 inside `searchSubfolders`, abort, escape, error toast.
- Modify: `src/ui/FolderSelection/FolderSelectionScreen.test.tsx` — add regression tests.

**Interfaces:**
- Consumes: `matchesNormalized` (Task 1); `searchSubfolders` unchanged signature.
- Produces: unchanged component props/markup.

**TDD test cases:**
1. NEW (regression for gating bug): local folder matches exist AND query ≥2 chars → `searchFolders` mock IS called (was NOT)
2. NEW: local + API results both render (both sections in DOM)
3. NEW: diacritics — query "doi" matches local folder "Đổi mới" (was broken)
4. KEEP passing: API-search branch with zero local matches, "Searching deeper..." state, abort on unmount/retry, escape handling, min-length 2 (no API call below 2 chars)

- [ ] **Step 1: Write new failing tests** → run → verify RED (gating test fails on current code).
- [ ] **Step 2: Implement** the three logic changes.
- [ ] **Step 3: Run file suite** → GREEN.
- [ ] **Step 4: Lint + commit** `fix(search): folder picker searches deeper even with local matches + diacritics`.

---

### Task 5: Playlist submenu + recent view unified matching

**Files:**
- Modify: `src/ui/components/MoreMenu/PlaylistsSubmenu.tsx` (line ~31) — `matchesNormalized(p.name, playlistSearchQuery)`.
- Modify: `src/ui/HomeTab/components/FullRecentView.tsx` (lines ~110-120) — `matchesNormalized(item.title, searchQuery)`; remove per-callback `toLowerCase` re-computation.
- Modify: `src/ui/HomeTab/components/FullRecentView.sorting.test.tsx` (existing search test must keep passing — "z" substring still matches).
- Create: `src/ui/components/MoreMenu/PlaylistsSubmenu.test.tsx` (filter behavior: plain + diacritics + AND).

**Interfaces:** Consumes `matchesNormalized`; produces unchanged props/markup.

- [ ] **Step 1: Write tests** (new PlaylistsSubmenu test; extend FullRecentView search test with a diacritics case) → RED for diacritics case.
- [ ] **Step 2: Implement** both changes.
- [ ] **Step 3: Run suites** → GREEN.
- [ ] **Step 4: Lint + commit** `fix(search): unified Vietnamese normalization in playlist + recent search`.

---

### Task 6: Dead code removal + full verification

**Files:**
- Delete: `src/hooks/useDebouncedLiveQuery.ts` (orphan — only consumer was useDriveExplorer search, replaced in Task 3; verify with `rg "useDebouncedLiveQuery" src` first).
- Modify: `src/hooks/useDriveExplorer.ts` — remove now-unused imports (`useDebouncedLiveQuery`, memory `metadataCache` if unused elsewhere — NOTE `cachedTitle` at ~line 376 still uses `metadataCache` for folder-list sort; keep that).
- Guard test (test sau khi xoá): `src/hooks/useDebouncedLiveQuery.removed.test.ts` — `import` of the module path resolves nothing / file absent (or assert no imports remain via rg in CI-style test). Simplest robust guard: a test that `useDriveExplorer` renders and searches without the hook (already covered by Task 3 suite) + an explicit "no imports remain" grep test.

**Verification (whole plan):**
- [ ] `npm run build` (tsc + vite build) — clean
- [ ] `npm test` (full vitest) — all green, no pre-existing failures introduced
- [ ] `npm run lint` — clean
- [ ] Manual behavior pass against the behavior contract in Global Constraints (search "Đổi", "anh yeu", a folder name, an artist from real legacy metadata; folder picker deep search with local matches present)
- [ ] Commit: `chore(search): remove orphaned useDebouncedLiveQuery after engine migration`

---

## Self-Review

- Spec coverage: all 4 entry points covered (Tasks 3,4,5); dead code (ID3 placeholder branch + orphaned hook) covered (Tasks 1 rule, 3, 6); industry-standard ranking/fuzzy/scale covered (Tasks 1,2,3); UI untouched enforced by Global Constraints.
- Placeholder scan: all steps carry concrete files/tests/commands; implementation specifics are TDD-driven per task.
- Type consistency: `SearchDoc`/`SearchHit`/`SearchWorkerRequest`/`SearchWorkerResponse`/`matchesNormalized` names are identical across Tasks 1-5.
- Known open risk: real legacy metadata (v<9) may be absent in production → ID3 search may return nothing for many libraries until the metadata pipeline is restored; behavior is honest (no fake hits), documented in Task 1 case 5.
