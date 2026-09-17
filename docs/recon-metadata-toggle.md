# BÁO CÁO RECON — drplay metadata toggle

Phạm vi: đọc code thật tại `E:\drplay` (Tauri + React 19 + TS + Zustand + Tailwind, test vitest).
Mục tiêu: chuẩn bị plan feature "thêm công tắc gạt trong Settings để bật/tắt fetch metadata của file nhạc, mặc định BẬT".
Mọi kết luận dưới đây kèm `file:line`. Không có suy đoán không nguồn.

## 1. Settings UI hiện tại

### 1.1 Cấu trúc render — `src/ui/Settings/SettingsTab.tsx` (278 dòng)

3 section chính, mỗi section là `<div className="flex flex-col gap-2 [mt-6]">` + `<h2 className="text-sm font-bold text-brand-text uppercase tracking-wider mb-2">{t("settings.<section>")}</h2>`:

| Section | i18n key | Dòng | Nội dung |
|---|---|---|---|
| Music Library | `settings.music_library` | 58-83 | row `google_drive_folder` + nút "Change Folder" (mở folder selection) |
| Preferences | `settings.preferences` | 85-176 | language (89-101), theme (103-115), minimize_to_tray toggle (117-143), download_location (145-175) |
| Data Management | `settings.data_management` | 178-262 | trash (183-216), clear cache (218-238), import seed (240-261) |

Sau 3 section: `<CreditsSection />` (264) + `<ErrorLogSection />` (266) + `<CacheManagerModal open={showCacheManager} .../>` (269-274).

### 1.2 Pattern của 1 setting row (bằng chứng nguyên văn)

Row chuẩn (ví dụ language, `SettingsTab.tsx:89-101`):

```tsx
<div className="flex items-center justify-between py-4 pb-6">
  <div className="flex items-center gap-4">
    <div className="w-12 h-12 rounded-xl bg-brand-primary/10 flex items-center justify-center shrink-0">
      <Globe className="w-6 h-6 text-brand-text" />
    </div>
    <div>
      <p className="text-base font-semibold text-gray-900 dark:text-gray-100">
        {t("settings.language")}
      </p>
    </div>
  </div>
  <LanguageDropdown />
</div>
```

- Icon lấy từ `lucide-react` (import tại `SettingsTab.tsx:1-10`).
- Row có description (subtitle) mẫu: download_location (`SettingsTab.tsx:151-161`) — `<p>{t("settings.download_location")}</p>` + `<p className="text-sm text-gray-500 ... truncate max-w-[280px] ...">{truncatePathMiddle(downloadPath)}</p>`.
- Row hành động (button): clear cache `SettingsTab.tsx:230-237`; import seed `SettingsTab.tsx:252-260`; trash `SettingsTab.tsx:208-215`.
- Đây chính là khuôn để thêm row toggle mới: copy khối toggle minimize_to_tray (xem mục 2), đổi icon + key i18n.

### 1.3 Toggle mẫu sẵn có trong chính SettingsTab (`SettingsTab.tsx:117-143`)

```tsx
{/* Close Behavior Setting */}
<div className="flex items-center justify-between py-4 pb-6">
  <div className="flex items-center gap-4">
    <div className="w-12 h-12 rounded-xl bg-brand-primary/10 flex items-center justify-center shrink-0">
      <MonitorDown className="w-6 h-6 text-brand-text" />
    </div>
    <div>
      <p className="text-base font-semibold text-gray-900 dark:text-gray-100">
        {t("settings.minimize_to_tray")}
      </p>
    </div>
  </div>
  <label className="relative inline-flex items-center cursor-pointer">
    <span className="sr-only">{t("settings.minimize_to_tray")}</span>
    <input
      type="checkbox"
      checked={minimizeToTray}
      onChange={(e) => { setMinimizeToTray(e.target.checked); }}
      className="sr-only peer"
    />
    <div className="w-11 h-6 bg-gray-200 dark:bg-[#2A2A2A] peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-brand-primary"></div>
  </label>
</div>
```

### 1.4 Props/state của SettingsTab — từ đâu, ai render

Props interface (`SettingsTab.tsx:24-31`):

```tsx
interface SettingsTabProps {
  theme: ThemeType;
  setTheme: (t: ThemeType) => void;
  minimizeToTray: boolean;
  setMinimizeToTray: (minimize: boolean) => void;
  setShowFolderSelection: (val: boolean) => void;
  setShowTrashScreen: (val: boolean) => void;
}
```

Chuỗi truyền prop (prop drilling, KHÔNG có context/store settings):
1. `src/App.tsx:171` — `const [minimizeToTray, setMinimizeToTray] = useState(loadMinimizeToTrayState);`
2. `src/App.tsx:373-400` — truyền vào `TabContentRouter` qua prop `tabContent` (`minimizeToTray={minimizeToTray}` dòng 395, `setMinimizeToTray` dòng 396; `theme/setTheme` dòng 393-394).
3. `src/ui/layouts/TabContentRouter.tsx:56-59` khai báo props; `:184-192` render khi `activeTab === TABS.settings`:
```tsx
) : activeTab === TABS.settings ? (
  <SettingsTab
    theme={theme}
    setTheme={setTheme}
    minimizeToTray={minimizeToTray}
    setMinimizeToTray={setMinimizeToTray}
    setShowFolderSelection={setShowFolderSelection}
    setShowTrashScreen={setShowTrashScreen}
  />
```
State nội bộ của SettingsTab: `showCacheManager` (dòng 42); hook tự chứa `useDownloadPathSetting()` (43-44), `useSeedImport()` (45).

Side-effect của minimize_to_tray nằm ở App (`App.tsx:265-275`): mỗi lần đổi → `saveMinimizeToTrayState(...)` + `invoke("update_minimize_to_tray", { minimize })` báo Rust. Đây là precedent cho "setting có side effect ngoài React".

## 2. Toggle/switch components có sẵn

Kết quả grep/glob toàn repo:

- `src/**/*{Toggle,Switch,toggle,switch}*` → **No files found** (không có component tái sử dụng tên Toggle/Switch).
- `grep 'peer-checked|type="checkbox"|role="switch"'` trên `*.tsx` → đúng 6 match / 3 file:
  1. `src/ui/Settings/SettingsTab.tsx:134` (`type="checkbox"`) + `:141` (div track `peer-checked:after:translate-x-full ...`) — toggle gạt duy nhất.
  2. `src/ui/Settings/components/CacheManagerModal.tsx:209` (`type="checkbox"`) + `:217` (`peer-checked:opacity-100` cho icon Check) — checkbox vuông category, không phải gạt.
  3. `src/ui/PlayerBar/QueueRow.tsx:48` + `:60` — `QueueRowCheckbox` chọn item, không phải gạt.
- `role="switch"` → 0 match.
- Không có file generic `Toggle.tsx`/`Switch.tsx` trong `src/ui/components/` (liệt kê thư mục: ImageCropperModal, MoreMenu, SeekBar, SeekClock, SeekRail, Skeleton, SortDropdown, useSeek* — không có toggle).

Kết luận: công tắc mới phải copy nguyên khối `label > input.sr-only.peer + div.w-11.h-6` của `SettingsTab.tsx:129-142` (không có component chung để tái dùng). Props pattern cho toggle hiện có: `checked` + `onChange` nhận `e.target.checked`, được set từ state cha (`minimizeToTray`/`setMinimizeToTray`).
## 3. Settings persistence pattern chuẩn

### 3.1 Cơ chế đang dùng (liệt kê hết — có 4 nhóm song song)

1. **localStorage trực tiếp (CHUẨN hiện hành cho Settings UI)** — key prefix `drplay_*`:
   - SSOT helper bọc try/catch + log warn: `src/utils/storageKeys.ts:40-88` (`safeLocalStorageGet` / `safeLocalStorageSet` / `safeLocalStorageRemove`; message contract `<label>-failed:<err.name|unknown>`, source do caller truyền).
   - Key dùng chung khai tại `storageKeys.ts:4-20`: `drplay_current_user_email`, `drplay_language`, `drplay_root_folder`, `drplay_current_folder_id`, `drplay_current_folder_name`, `drplay_folder_history`, `drplay_sort_option`, `drplay_nav_state`, `drplay_access_token`, `drplay_refresh_token`, `drplay_token_time`, `drplay_refresh_token_newer`.
   - Key module-specific khai tại module sở hữu:
     - `src/appUiState.ts:15` — `LS_MINIMIZE_TO_TRAY = "drplay_minimize_to_tray"`.
     - `src/utils/sidebarState.ts:7` — `LS_SIDEBAR_OPEN = "drplay_sidebar_open"`.
     - `src/utils/downloadPath.ts:4` — `STORAGE_KEY = "drplay_download_path"`.
     - `src/hooks/useTheme.ts:12` — hardcode `localStorage.getItem("drplay_theme")` (không dùng helper).
2. **IndexedDB `kv` table** — `src/db/kv.ts:23-39` (get/set/del, log warn rồi rethrow); bảng `kv` khai `src/db/db.ts:89`. Chỉ dùng cho session player: `src/store/queueOps.ts:2` (playMode/queue), `src/hooks/player/usePlayerLifecycle.ts:6`, `src/hooks/player/usePlayerSession.ts:2`. KHÔNG dùng cho Settings UI.
3. **Rust-side state**: `App.tsx:267` `invoke("update_minimize_to_tray", ...)` — hành vi tray do Rust giữ, JS chỉ ghi giá trị.
4. **Không có** zustand `persist(` (grep → No files found), không có settings Context/store, không có file "settings store".

### 3.2 Pattern chuẩn để thêm 1 setting boolean mới

Precedent gần nhất — `src/appUiState.ts:24-39`:

```ts
export function loadMinimizeToTrayState(): boolean {
  const saved = safeLocalStorageGet(LS_MINIMIZE_TO_TRAY, "minimize-to-tray-read", "appUiState");
  return saved === null ? true : saved === "true";   // missing -> default TRUE
}
export function saveMinimizeToTrayState(minimize: boolean): void {
  safeLocalStorageSet(LS_MINIMIZE_TO_TRAY, String(minimize), "tray-write", "appUiState");
}
```

- Default value = xử lý tại READER (missing key → default; literal `'true'`/`'false'` mới tin, giá trị rác → default). Mẫu default-BẬT y hệt feature này: `appUiState.ts:30` (`saved === null ? true : saved === "true"`).
- Sidebar cũng cùng khuôn nhưng default-open: `sidebarState.ts:14-24` (`!== "false"` → open) + `saveSidebarOpenState` `:26-33`.
- Theme: đọc có guard type + default "system" (`useTheme.ts:10-17`), ghi trong `changeTheme` (`:66-77`).
- Test mẫu đầy đủ cho boolean setting: `src/appUiState.test.ts:15-89` (default khi missing; 'true' → true; 'false'/garbage → false; SecurityError → default + log; QuotaExceededError khi write → không throw + log). Bản webview vẫn cần jsdom pragma `// @vitest-environment jsdom`.
- **Subscription/event cho module khác**: hiện KHÔNG có cơ chế subscribe cho settings. Precedent event-bus trong repo khi cần thông báo thay đổi từ module ngoài React: `src/utils/favorites.ts:80,108` (`FAVORITES_UPDATED_EVENT`), `src/utils/playlists.ts:83` (`playlists-updated`), `src/utils/tokenRefresh.ts:308-309` (`token-updated`), `src/utils/history.ts:90` (`recent-updated`). Một module setting muốn "bật lại là fetch ngay" sẽ cần dạng CustomEvent tương tự hoặc đưa toggle vào deps của consumer.

## 4. Metadata fetch pipeline

### 4.1 "Fetch metadata" chính xác là gì

- Là **đọc tag nhạc (ID3v2 / Vorbis / MP4 moov / duration / cover embedded) bằng lib `music-metadata`, parse trực tiếp trên byte tải từ Google Drive** — KHÔNG đọc file local (app stream từ Drive).
  - `src/utils/metadata/fetchPipeline.ts:1` — `import { parseFromTokenizer } from "music-metadata";`
  - `fetchPipeline.ts:114` — `new DriveRangeTokenizer(fileId, parseSize, ...)`; `fetchPipeline.ts:168-185` — `parseFromTokenizer(tokenizer, { skipCovers:false, duration:false, skipPostHeaders:true })`.
  - `src/utils/driveRangeTokenizer.ts:62-67` (comment nguyên văn): "Random-access tokenizer for music-metadata's parseFromTokenizer. All reads are served from an aligned-chunk LRU cache; a miss fetches the covering 64KB-aligned chunk through the SW /drive-stream/ proxy with a Range header."
  - Tầng HTTP: `src/utils/driveRangeChunkFetcher.ts:1-7` (semaphore CONCURRENCY=3, retry, circuit breaker) + `:23-31` (CONCURRENCY=3, timeout 45s, MAX_RETRIES=2).
- **Liên quan `src-tauri` (Rust)**: chỉ 2 nhánh, KHÔNG có nhánh fetch:
  1. Disk-first seed import: `src/utils/metadata/parse.ts:61-76` gọi `invoke("read_metadata_disk", { fileId })` ← Rust `src-tauri/src/seed.rs:110-114` (`read_metadata_disk`) đọc `<app_cache_dir>/metadata/{fileId}.json`; import zip `seed.rs:74` (`import_metadata_seed`, nút Settings dòng 231 translation).
  2. Cover bytes đẩy sang Rust disk cache: `src/utils/metadata/cover.ts:70` và `:91` — `postCoverToCache(fileId, ..., ...)` (JPEG-only, fire-and-forget).
- Byte trung gian: SW proxy `/drive-stream/` (`src/utils/driveRangeChunkFetcher.ts:21` import `DRIVE_STREAM_PREFIX` từ `streamPrefetcher`).

### 4.2 Sơ đồ luồng ngắn

```
ENTRY A (cards)  useTrackMetadata.ts:97 fetchMetadata()
ENTRY B (play)   usePlayerTrackPlayback.ts:197 getTrackMetadata()  [defer after first-audio]
        |
        v
api.ts:32  getTrackMetadata(fileId, token?, size?, name?, signal?, forceNetwork=false)
   |-- :40-44  mem cache hit (metadataCache Map) -> return
   |-- :48-61  inflight dedupe (key = fileId|size|name)
   v
fetchPipeline.ts:52  getTrackMetadataImpl
   |-- :61-64  mem cache (lần 2, phòng race)
   |-- :68     readCachedEntry()
   |             parse.ts:22-53  IDB row `metadata_<fileId>` (+ seed full-picture LRU)
   |             parse.ts:55-76  DISK seed qua invoke("read_metadata_disk")  [Rust]
   |-- :73-80  size<=0 -> placeholder v:9, setMetadataCache, return (no network)
   |-- :86-95  per-file network cooldown 60s (cooldown.ts) -> placeholder, no network
   |-- :97-110 LARGE_FILE_THRESHOLD 100MB -> clamp parse size = HEAD_BYTES 128KB
   |-- :113-127 DriveRangeTokenizer + prefetchHead (min(1.5MB, parseSize))
   |-- :129-156 format detect (mp3/flac/aac/m4a/unknown) + prefetch tag/picture/m4a tail
   |-- :166-218 parseFromTokenizer (skipCovers retry nếu BudgetExceededError)
   |-- :220-263 build entry (title/artist/album/duration/bitrate/size...) v:8 REAL_METADATA_VERSION
   |-- :269     processCovers -> cover.ts:27-114 nén thumb(256px)+full(2000px), POST Rust disk
   |-- :278-297 m4a box walk -> entry.streamUnplayable + prefetchAndScanM4aTail
   |-- :301-312 db.files.update([email,fileId], { metadata:{format, streamUnplayable:true} })
   |-- :320-324 cacheTrackMetadata -> mem Map + IDB `metadata_` + LRU localStorage (cache.ts:167-184, 322-353)
   v-- :325-359 catch -> makePlaceholder v:9 (pipelineHelpers.ts:80-95);
                RangeFetchNetworkError -> setNetworkCooldown 60s (không pin placeholder);
                abort -> placeholder cho caller này, KHÔNG log/không pin
```

### 4.3 TẤT CẢ entry points (production, grep `getTrackMetadata(`)

Chỉ có **2** call site thật:

1. `src/hooks/useTrackMetadata.ts:97-105` — hook chung "track metadata lifecycle" (AbortController + debounce + cover blob + cleanup). Guard `enabled` tại `:91`:
```ts
useEffect(() => {
  if (!enabled || !fileId) return;
  ...
  const metadata = await getTrackMetadata(fileId, token ?? undefined, size, originalName, controller.signal);
```
   5 consumers (tất cả truyền `enabled`):
   - `src/ui/MainContent/hooks/useSongCardMetadata.ts:95-105` — `enabled: !item.isFolder && !!token`, `debounceMs: TRACK_METADATA_DEBOUNCE_MS` (150ms, `useTrackMetadata.ts:16`).
   - `src/ui/HomeTab/components/PremiumCard.tsx:53-68` — `enabled: !!token`, debounce 150ms.
   - `src/ui/PlayerBar/TrackInfo.tsx:106-115` — `enabled: !!currentTrack && !!authToken`.
   - `src/ui/PlayerBar/QueueRow.tsx:131-141` — `enabled: !!authToken`, debounce 150ms.
   - `src/ui/NowPlaying/hooks/useNowPlayingMetadata.ts:149-161` — `enabled: !!trackId`, `refreshKey: trackStreamUrl`.
2. `src/hooks/player/usePlayerTrackPlayback.ts:186-230` — sau khi set streamUrl, đăng ký `onceAfterFirstAudio(metadataAudio, signal, { fallbackMs: METADATA_DEFER_FALLBACK_MS (9_000, khai :27), onFire: ... getTrackMetadata(...) :197-203 ... })`; mục đích là `restoreDuration` (SeekBar trước khi audio chạy) — comment :180-185 nói rõ defer để không giành quota Drive với first-byte.

Không còn entry point nào khác (các match còn lại của grep nằm trong test/mock). Không có fetch metadata trong worker/sync/scan folder.
## 5. Cờ/defer tương tự đã có

- **Không có cờ bật/tắt metadata toàn cục.** Grep `metadataEnabled|enableMetadata|fetchMetadata|disableMetadata|skipMetadata|metadataToggle|metadata_enabled` → chỉ 3 match, đều là tên hàm local `fetchMetadata` trong `useTrackMetadata.ts:97,159,162`.
- Các cơ chế "gần giống" đang có:
  1. `enabled?: boolean` per-consumer của `useTrackMetadata` — `useTrackMetadata.ts:26-27` (JSDoc: "Guard flag: when false the effect does nothing") + guard `:91`. Đây là điểm chặn tự nhiên cho 5 card/cover consumers.
  2. `debounceMs` 150ms (`useTrackMetadata.ts:16`, `:156-163`) — chống fetch khi grid mount nhiều card.
  3. Defer-until-first-audio: `src/hooks/player/deferOnce.ts:28-74` (`onceAfterFirstAudio` — fire đúng 1 lần khi `first-audio` hoặc fallback timer; drop khi `error`/abort/unmount). Dùng 2 chỗ trong `usePlayerTrackPlayback.ts`: metadata `:186-230` (fallback 9s) và SW prefetch next track `:244-262` (KHÔNG fallback — chờ signal mãi). Test: `usePlayer.metadataDefer.test.ts` + `usePlayer.prefetchDefer.test.ts`.
  4. Per-file network cooldown 60s — `metadata/cooldown.ts:15-37`; hằng số `constants.ts:44` (`METADATA_NETWORK_COOLDOWN_MS = 60_000`).
  5. Circuit breaker Drive toàn app — `driveRangeCircuitBreaker.ts:14-16` (3 failures / 30s → mở 60s, fail-fast).
  6. `forceNetwork` param — `api.ts:38` bypass mem cache + IDB/disk (`parse.ts:22,61`) + cooldown (`fetchPipeline.ts:62,86`). Grep production: **không có UI nào gọi `forceNetwork=true`** (chỉ test + comment nhắc "RefreshCw button" — nguồn có thể đã lỗi thời, xem mục 10).

**Cảnh báo thiết kế quan trọng (từ code thật):** trong `usePlayerTrackPlayback.ts`, `setIsDownloading(false)` nằm BÊN TRONG `onFire` (`:194`) và `onDrop` (`:227-229`). Nếu feature tắt metadata bằng cách bỏ qua hẳn `onceAfterFirstAudio(...)` (khối :186-230) thì spinner/khóa nút play (`setIsDownloading(true)` ở `:140`) sẽ KHÔNG bao giờ được gỡ. Muốn tắt fetch nhưng vẫn giữ UX loading, phải giữ đường thoát: ví dụ vẫn gọi `onceAfterFirstAudio` với `onFire` chỉ `setIsDownloading(false)`, hoặc chuyển `setIsDownloading(false)` ra ngoài nhánh metadata.

## 6. Fallback khi không có metadata (hiện trạng)

Tên file = `stripAudioExtension(name)` — SSOT `src/utils/pathUtils.ts:9-11` (`name.replace(/\.[^.]+$/, "")`), được `useDriveListing.ts:87-88,104` gọi để tạo `item.title`/`trackInfo.title`; placeholder trong pipeline cũng dùng (`pipelineHelpers.ts:21,80-95`).

| UI | Fallback khi metadata không về | Evidence |
|---|---|---|
| SongCard | title = `item.title` (tên file bỏ ext); dòng duration/size ẩn (`meta.loaded=false`) | `useSongCardMetadata.ts:44-51`; `SongCard.tsx:195,197-218` |
| QueueRow | title = `track.title`; duration/size ẩn | `QueueRow.tsx:85-93,195-212` |
| PlayerBar TrackInfo | `displayTitle/Artist = null` → hiển thị `currentTrack.title/artist` | `TrackInfo.tsx:33-41,122-131` |
| NowPlaying | giữ title/artist của track; cover = null → không palette | `useNowPlayingMetadata.ts:166-175`; palette reset `:96-101` |
| PremiumCard | title/artist khởi tạo từ track; cover null → nền màu hash id + icon Music | `PremiumCard.tsx:34-35,41-42,84-101` |
| SeekBar duration | sau khi phát: lấy từ engine `timeupdate` (`SeekBar.tsx:166-168`); `restoreDuration` chỉ dùng trước khi audio chạy (`:131-136`, `:241-275`) |
| Search | index vẫn có `name` (tên file gốc, boost 3); title fallback = tên file bỏ ext | `searchEngine.ts:41-43,104-124,162-165` |
| Sort listing | `cachedTitle(a.id) || a.title` | `useDriveListing.ts:20-21,42-44,68-73` |
| Home Discover | chỉ liệt kê entry v:8 thật — không có metadata thì không có item nào | `history.ts:209-255` (đặc biệt `:242` `isRealCacheEntry`) |

Nguồn title/artist "đẹp" khi CÓ metadata: NowPlaying (`useNowPlayingMetadata.ts:88-89`), TrackInfo + store (`TrackInfo.tsx:63-80`), Search index (`searchEngine.ts:117-123`), Home card (`PremiumCard.tsx:41-42`), SongCard (`useSongCardMetadata.ts:56-58`).

## 7. Tests hiện có

### 7.1 `src/ui/Settings/SettingsTab.test.tsx` (415 dòng, jsdom)

- Mock `react-i18next` bằng resolver đọc thẳng `src/locales/en/translation.json` (dòng 21-52) → assertion khớp bản dịch thật; mock `@tauri-apps/plugin-dialog`, `@tauri-apps/api/core`, `simpleToast`, `utils/cache`, `utils/downloadPath`, `utils/errorLog`; stub child sections (LanguageDropdown/ThemeDropdown/CreditsSection/ErrorLogSection) dòng 99-106.
- `baseProps` dòng 111-118 (gồm `minimizeToTray:false`, `setMinimizeToTray: vi.fn()`).
- Pattern assert: `screen.getByRole("button", { name: "Change Path" })` (dòng 201-203, 225), `await screen.findByTitle(LONG_PATH)` (133), `captureError` toHaveBeenCalledWith objectContaining (163-171), nút disabled khi dialog mở (208-219).
- KHÔNG dùng fake-indexeddb ở file này (mọi deps nặng đều mock).

### 7.2 `src/ui/Settings/SettingsTab.toast.test.tsx` (113 dòng)

Flow clear-cache qua modal thật + toast thật append vào `document.body` (`.app-toast--success`, text "Cache cleared") — dòng 98-112. Không liên quan toggle nhưng cho thấy modal cũng nằm trong SettingsTab.

### 7.3 `src/hooks/usePlayer.metadataDefer.test.ts` (294 dòng, jsdom) — CHÌA KHÓA

Test cơ chế defer qua `renderHook(() => usePlayer("test-token"))`, fake timers, mock bus event của `AudioController` (`audioMock.on` + `emitAudio`, dòng 77-107), mock `../utils/metadata` (dòng 28-31).

Các case (assert nguyên văn):
- `:151-179` — "REGRESSION: play track -> ZERO metadata request before first-audio; fires on first-audio with same args": sau `handlePlayTrack` + 3000ms → `expect(meta).not.toHaveBeenCalled()`; emit `first-audio` → `toHaveBeenCalledTimes(1)` với args `("t1","test-token",undefined,undefined,expect.anything())`.
- `:181-218` — track change trước signal → track cũ không bao giờ fetch, track mới fetch 1 lần.
- `:220-244` — không có signal → fallback 8999ms chưa fire, mốc 9000ms fire đúng 1 lần.
- `:246-260` — double signal/timeout race → đúng 1 fetch.
- `:262-275` — playback error trước signal → drop, không fetch muộn.
- `:277-293` — unmount → clear timer, unsubscribe cả `first-audio` lẫn `error`.

Đây là file sẽ phải mở rộng cho case "toggle OFF" (ví dụ: disabled → 0 fetch dù first-audio fire, nhưng `isDownloading` vẫn được gỡ).

### 7.4 Các test metadata khác

- `src/utils/metadata.test.ts` (3706 dòng): mock `db` in-memory (`metadataCache` Map + `files.update`, dòng 31-48), mock `invoke` Tauri (21-25), mock `compressCoverVariants`, mock `music-metadata.parseFromTokenizer` (76-79) và subclass `DriveRangeTokenizer` để đếm construction/budget (59-74). Test coverage khổng lồ: cache hit, size<=0, cooldown, budget, cover variants, m4a walk, disk metadata parse, forceNetwork...
- `src/utils/metadata.concurrency.test.ts` (530 dòng, jsdom): mock db in-memory (27-47), test LRU/inflight/wipe, `forceNetwork bypasses the cooldown and re-fetches` (:1352 trong metadata.test.ts, tương tự).
- `src/hooks/useTrackMetadata.test.ts` (484 dòng, jsdom): mock `../utils/metadata` (18-20) + `coverStore`; test lifecycle/debounce/`refreshKey`.
- `usePlayer.prefetchDefer.test.ts` (388 dòng): defer SW prefetch next-track (cơ chế riêng, không metadata) — dùng cùng khuôn để tham chiếu.
- Không dùng fake-indexeddb trong nhóm metadata tests (tự mock `db`). `fake-indexeddb/auto` xuất hiện ở db/history/favorites/search/useSearchWorker... (grep 23 match).
## 8. i18n

- Files: `src/locales/en/translation.json` (305 dòng) + `src/locales/vi/translation.json` (301 dòng); nạp tay (không backend) tại `src/i18n.ts:4-16`; fallback `en`, supportedLngs `["en","vi"]` (`i18n.ts:82-92`).
- Section Settings: `"settings"` bắt đầu `en:206`, `vi:202`. Naming convention: snake_case trong section `settings` (`minimize_to_tray` en:220/vi:216, `download_location`, `select_download_folder`, `import_seed`, `clear_cache_btn`...).
- Key sets hiện khớp 100% en/vi: đã chạy đối chiếu bằng node — 69 key `settings` mỗi bên, 0 key lệch; 30 section top-level khớp cả hai file (bao gồm `cache.label.*`).
- Script check: `package.json:17` → `"i18n:check": "i18next-cli extract --ci && i18next-cli status"`. Config `i18next.config.js`: locales `["en","vi"]`, primary en + secondary vi, `removeUnusedKeys:false`, `preservePatterns:["cache.label.*"]` (cho dynamic key `t(\`cache.label.${id}\`)` ở `CacheManagerModal.tsx:222`), ignore `*.test.ts(x)`.
- **Không bắt buộc tự động**: `.husky/pre-commit` chỉ chạy `npx lint-staged` (eslint+prettier); `.github/workflows/build.yml` chỉ build Tauri. `i18n:check` là script thủ công — nhưng việc thiếu key vi sẽ lộ ở runtime (`i18next.d.ts` type + missing-key log dev-only `i18n.ts:60-78`). Quy ước thực tế: thêm key phải thêm CẢ en + vi.
- Key mới đề xuất cho toggle (ví dụ): `settings.metadata_fetch` (title) + `settings.metadata_fetch_desc` (description) — theo convention hiện có.

## 9. Ảnh hưởng chéo (module khác đọc/ghi metadata)

1. **5 UI consumers của `useTrackMetadata`** — cover + real title/artist + palette: SongCard (`useSongCardMetadata.ts:95`), PremiumCard (`PremiumCard.tsx:53`), TrackInfo (`TrackInfo.tsx:106`), QueueRow (`QueueRow.tsx:131`), NowPlaying (`useNowPlayingMetadata.ts:149`).
2. **Search engine (worker + inline)** — rebuild đọc `db.metadataCache.toArray()` (`search.worker.ts:139-158`), lọc entry thật (`searchEngine.ts:61-70`), index title/artist + name (`searchEngine.ts:104-128`). Invalidation chỉ qua `db.files` Dexie hooks + proSync events (`useSearchWorker.ts:210-223`) — **không có event khi metadataCache ghi**, nên index tự refresh theo query sau đó. Tắt fetch → chỉ còn tên file.
3. **Home Discover** — `history.ts:209-255` random từ entry v:8 thật; tắt fetch → danh sách cạn/trống với file mới.
4. **Sort tên trong listing** — `useDriveListing.ts:20-21` (`cachedTitle`) → tắt fetch, sort thuần tên file.
5. **Pre-play gate streamUnplayable** — `usePlayerTrackPlayback.ts:107-125` đọc `metadataCache.get(track.id)?.streamUnplayable`; flag chỉ được set trong pipeline (`fetchPipeline.ts:289-294,301-312`). Tắt fetch → gate không bao giờ chặn trước, m4a non-faststart rơi vào lỗi format của mpv (toast + auto-next) như hành vi trước fix.
6. **Rust cover disk cache** — pipeline POST thumb/full JPEG (`cover.ts:70,91`); tắt fetch → không có cover mới POST, nhưng cover đã import/đã cache vẫn đọc được qua disk-first (`parse.ts:55-76` → `coverOnDisk` → `buildCoverUrl`, `useTrackMetadata.ts:113-133`).
7. **Cache manager** — category `metadata` (`utils/cache.ts:55-99,150-199`) và nút Clear Cache vẫn hoạt động độc lập; clear sẽ xóa IDB + mem + LRU + cooldown.
8. **Logout/wipe** — `useAuth.ts:262` gọi `wipePersistedMetadataCache` (`cache.ts:282-307`) — độc lập toggle.
9. **SW prefetch track kế tiếp** — `usePlayerTrackPlayback.ts:244-262` + `utils/swPrefetch.ts:4-12` — cơ chế RIÊNG (tải bytes file next), không phải metadata; toggle metadata không đụng tới nó (cần chốt sản phẩm có muốn giữ hay không).
10. **db.files.metadata field** — chỉ pipeline ghi `{format, streamUnplayable}` (`fetchPipeline.ts:304-306`); trường có sẵn từ schema `db.ts:14`.

## 10. Rủi ro / điểm mù (cần main agent chốt hoặc xác minh thêm)

1. **Không có store/subscription settings sẵn** — repo chỉ có prop-drilling (minimizeToTray) và localStorage lazy-read (theme). Nếu toggle cần được module ngoài React (`utils/metadata`) đọc và phản ứng tức thời, phải chọn 1 trong: (a) module setting utils + CustomEvent (precedent `favorites-updated`), (b) đọc localStorage tại từng entry point (chậm 1 nhịp, không có event), (c) thêm zustand store mới (repo chưa có settings store). Chưa có precedent trực tiếp cho "settings toàn cục" → cần main agent quyết định kiến trúc.
2. **Định nghĩa "tắt fetch"**: chỉ chặn NETWORK hay chặn luôn CACHE? `readCachedEntry` (IDB + disk seed) chạy trước network và không phân biệt lý do (`parse.ts:22-76`). Nếu chỉ chặn network, file đã cache vẫn hiển thị metadata cũ (kể cả cover/palette) — có thể lệch kỳ vọng user "tắt metadata". Nếu chặn tất, cần sửa cả `useTrackMetadata` (đang nhận entry từ cache như nhau) và các nhánh `readCachedEntry`.
3. **Spinner/loading state** (đã nêu mục 5): bỏ `onceAfterFirstAudio` metadata phải giữ `setIsDownloading(false)`; nếu không nút play kẹt trạng thái loading.
4. **Bật lại giữa chừng**: `useTrackMetadata` chỉ fetch trong effect theo deps (`useTrackMetadata.ts:178-190`). Nếu toggle không được truyền vào deps/không ép remount, card đang mount sẽ không tự fetch lại; cần thiết kế (prop `enabled` xuống tận hook, hoặc event → `refreshKey`, hoặc remount Settings/grid). Chưa xác minh cách nào khả thi nhất vì phụ thuộc kiến trúc toggle được chọn.
5. **Session restore**: track khôi phục từ session (`usePlayerSession.ts:106` set `restoreDuration`) không tự fetch metadata khi bật toggle vì pipeline B chỉ chạy lúc play. Chấp nhận hay không cần chốt.
6. **Comment lỗi thời (mâu thuẫn nguồn)**: `cooldown.ts:11` và `metadata.test.ts:1303,1358` nói `forceNetwork` là "manual retry via RefreshCw", nhưng grep production không thấy call site nào truyền `forceNetwork=true` (chỉ test). Không ảnh hưởng feature nhưng đừng thiết kế dựa vào "đã có nút retry metadata".
7. **Số liệu dòng trong tài liệu này** lấy từ bản code hiện tại (working tree, chưa rõ trạng thái git); trước khi sửa từng file phải đọc lại file thật (quy tắc 5C.1).
8. **`metadataDefer.test.ts` mock `getTrackMetadata` toàn module** (`vi.mock("../utils/metadata")`) — khi thêm toggle phải mock cả module setting mới (nếu có) trong các test usePlayer/Settings; nếu không sẽ lỗi import hoặc rò trạng thái thật.
9. **Không có bằng chứng runtime** (chỉ đọc code): chưa chạy app để xác nhận UI fallback ngoài đời (đặc biệt SeekBar duration với mpv events, sort theo tên, Discover trống) — các kết luận ở mục 6 dựa trên đọc code + test hiện có.
10. **i18n keys mới**: `i18n:check` không nằm trong CI/husky → main agent phải tự chạy `npm run i18n:check` (hoặc ít nhất thêm key cả 2 file) trước khi commit, nếu không sẽ có missing-key runtime.

---

*Hết báo cáo. Không file code sản xuất nào bị sửa trong quá trình recon; file này chỉ là tài liệu trong `docs/`.*