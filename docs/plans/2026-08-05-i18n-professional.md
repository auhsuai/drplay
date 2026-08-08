# PLAN: i18n chuyên nghiệp chuẩn app lớn — type-safe + copy rewrite — 2026-08-05

> Trạng thái: PLAN CHI TIẾT — sẵn sàng implement. Ngày: 2026-08-05
> Nguồn: dossier review i18n (i18n-aspect-b.md + i18n-aspect-e.md, 2026-08-05) + Material Design Communication Principles (codelabs.developers.google.com/codelabs/material-communication-guidance + m2.material.io/design/communication/writing.html — fetch 2026-08-05) + i18next docs (typescript, configuration-options, i18next-cli).
> Cách dùng: mỗi slice dispatch ĐÚNG 1 subagent, TUẦN TỰ (1 → 2 → 3 — slice 2 và 3 cùng chạm translation.json + test, cấm song song), TDD đỏ→xanh, verify thật.

---

## 0. NGUYÊN TẮC VĂN PHONG (Material UX Writing — áp dụng slice 3)

**Voice:** helpful, human, concise — không máy móc, không lảm nhảm.

| Nguyên tắc | Không nên (AI slop) | Nên (app lớn) |
|---|---|---|
| Concise | "Hãy thư giãn cơ thể nào!" | "You've been very active today. Take a break." |
| Direct, second person | "Các mục này sẽ được chuyển vào Thùng rác" | "This moves them to Google Drive Trash." |
| Error: nêu vấn đề + giải pháp | "Lỗi khi tạo danh sách phát" | "Couldn't create playlist. Try again." |
| Không cường điệu | "Tải xuống hoàn tất!" | "Download complete" |
| Không ngôi lẫn | "bạn"/"tôi" cùng câu | nhất quán 1 ngôi |
| Empty state: hướng dẫn tiếp | "Ở đây hơi trống vắng..." | "No songs yet. Tap the heart on any song to save it." |
| Không dấu ! thừa | "Đã sao chép!" | "Copied" |
| Không "nhé"/"nào!"/emoji | "chút nhé", "nhé!" | bỏ hẳn |

**LƯU Ý test:** nhiều test assert text CŨ (VD FullRecentView.sorting.test.tsx assert "Ngày"/"Kích thước"/"A-Z", LikedSongs assert "bài hát"...) — khi đổi copy PHẢI cập nhật test theo (được phép — text là behavior hiển thị đã chốt).

---

## 1. HIỆN TRẠNG (dossier — bằng chứng)

| Hạng mục | Trạng thái | Vị trí |
|---|---|---|
| en = vi = 256 keys, parity 100% | ✅ | translation.json |
| fallbackLng/supportedLngs/localStorage guard/html lang | ✅ chuẩn | i18n.ts |
| `upload.uploaded` MISSING (không defaultValue → raw key vào aria-label) | 🐛 | SongCard.tsx:487 |
| 3 key missing kẹt EN default (now_playing.progress, sort.menu, upload.disabled_title) | 🐛 | NowPlayingView.tsx:158, SortDropdown.tsx:62, UploadButton.tsx:158 |
| 7 toast hardcoded (favorites.ts 2 VI + playlists.ts 5 EN) | 🐛 | favorites.ts:55,72; playlists.ts:91,107,138,165,189 |
| KHÔNG type-safe key (thiếu i18next.d.ts) | ⚠️ | toàn repo |
| KHÔNG missing-key detection (i18next-cli CI) | ⚠️ | package.json |
| Plural thủ công (2 file) | ⚠️ | LikedSongs.tsx:114, PlaylistView.tsx:248 |
| 34/113 defaultValue tiếng Việt trong code | ⚠️ bẫy latent | ~16 file |
| 42 dead keys + 4 cache.label.* dùng động (KHÔNG xóa) | ⚠️ | locales |
| Copy nhiều chỗ AI-slop (rate_limit_title "Time for a break!", playlist.empty_state_title "It's a bit empty here...", liked_songs empty, vi "chút nhé"/"nào!") | ⚠️ | locales |

---

## 2. SLICES — SPEC CHI TIẾT

### SLICE 1 — Fix bug i18n (keys missing + toast hardcoded) [BUGFIX]
- **File**: `src/locales/en/translation.json` + `src/locales/vi/translation.json` + `src/utils/favorites.ts` + `src/utils/playlists.ts` + test liên quan.
- **Thay đổi**:
  1. Thêm key missing (en + vi, theo văn phong mới — slice 1 dùng text CHẤP NHẬN ĐƯỢC, slice 3 sẽ polish toàn bộ):
     - `upload.uploaded`: en "Uploaded" / vi "Đã tải lên"
     - `now_playing.progress`: en "Playback progress" / vi "Tiến độ phát"
     - `sort.menu`: en "Sort options" / vi "Tùy chọn sắp xếp"
     - `upload.disabled_title`: en "Open My Drive to upload" / vi "Mở Kho của tôi để tải lên"
  2. favorites.ts:55,72 → `showErrorToast(t("liked_songs.add_failed"))` + `showErrorToast(t("liked_songs.remove_failed"))` — thêm key mới `liked_songs.add_failed` (en "Couldn't add to favorites. Try again." / vi "Không thể thêm vào yêu thích. Vui lòng thử lại.") — XEM code thật: favorites.ts là util thuần (không phải hook) — cần i18n.t() hoặc truyền t qua param; đọc code thật + chọn cách ít phá nhất, BÁO CÁO.
  3. playlists.ts 5 toast → `t(...)` (đọc code thật — playlists.ts cũng là util thuần; nếu không có i18n import → thêm `import i18n from "../i18n"` hoặc truyền param — đọc callers, chọn cách khả thi nhất).
  4. Thêm keys mới cho 5 toast playlists (en/vi) — VD: `playlist.create_error` (đã có create_playlist_error ở sidebar — tái dùng nếu phù hợp, BÁO CÁO), `playlist.delete_error` (đã có!), `playlist.update_error` (mới), `playlist.add_track_error` (mới), `playlist.remove_track_error` (mới — hoặc tái dùng playlist.remove_error).
- **Behavior contract**: UI EN không còn chữ Việt; UI VI không còn chữ Anh trong 7 toast; aria-label SongCard không còn raw key.
- **Test (TDD)**: (a) favorites fail → toast đúng key (mock t); (b) playlists fail → toast đúng key; (c) SongCard aria-label = "Uploaded" (mock t trả key — assert key gọi đúng); (d) en/vi parity giữ 100% (script so khớp); (e) full suite xanh.
- **Done**: test xanh + tsc + full suite.

### SLICE 2 — Type-safe keys + missing-key detection [MODERNIZE]
- **File**: `src/i18next.d.ts` (MỚI) + `src/i18n.ts` + `package.json` (+ test).
- **Thay đổi**:
  1. Tạo `src/i18next.d.ts`: module augmentation `CustomTypeOptions.resources` với `{ translation: typeof import("./locales/en/translation.json") }` — ĐỌC i18next docs typescript trước (version 26.3.6) — xác nhận pattern đúng cho v26 (parseInterpolation type-check biến {{var}}).
  2. `src/i18n.ts`: thêm `missingKeyHandler` (dev-only — `import.meta.env.DEV`): log qua captureError warn `i18n-missing-key key=<key> lng=<lng>` — KHÔNG dùng saveMissing (tránh CVE-2026-48713 fs-backend; project không dùng backend file). LƯU Ý: missingKeyHandler cần `saveMissing: true`? ĐỌC docs — i18next: "missingKeyHandler called when translation missing, needs saveMissing set" → set saveMissing: true + missingKeyHandler log (KHÔNG save file). Xác nhận + báo cáo.
  3. `package.json`: thêm script `i18n:check` = `i18next-cli extract --ci` ... ĐỌC i18next-cli docs hiện tại (2026): lệnh `extract --ci` check missing keys trong code vs json, `status --ci` check locales lệch. Nếu i18next-cli chưa cài → thêm devDependency. CẨN THẬN: tool phải parse được pattern t() hiện tại (template literal cache.label.${id} — check config/options, có thể cần exclude hoặc false-positive; BÁO CÁO). KHÔNG chạy trong pre-commit nếu quá nhiều false-positive — chỉ thêm script + verify chạy được.
  4. Fix các key sai do type-check phát hiện (nếu tsc nổi lỗi sau khi thêm d.ts — VD key không tồn tại) — liệt kê + sửa.
- **Behavior contract**: typo key = lỗi tsc (chặn từ bây giờ); missing key runtime → log warn (không đổi UI).
- **Test (TDD)**: (a) tsc clean sau khi thêm d.ts (toàn repo — 0 error); (b) i18n.test.ts thêm test: missingKeyHandler gọi captureError khi key không tồn tại (mock i18n.t với key lạ trong dev); (c) script `npm run i18n:check` chạy được + kết quả báo cáo.
- **Done**: tsc clean + test xanh + i18n:check chạy được + full suite.

### SLICE 3 — Copy rewrite chuẩn app lớn + dọn dead keys + plural + defaultValue [REFACTOR]
- **File**: `src/locales/en/translation.json` + `src/locales/vi/translation.json` + test assert text + 2 file plural (LikedSongs.tsx, PlaylistView.tsx) + defaultValue cleanup (~16 file — ĐỌC list từ dossier).
- **Thay đổi**:
  1. **Copy rewrite**: viết lại TOÀN BỘ 256 keys × 2 ngôn ngữ theo nguyên tắc Material (bảng mục 0):
     - Error messages: "Couldn't <action>. Try again." (EN) / "Không thể <hành động>. Vui lòng thử lại." (VI) — KHÔNG "Lỗi khi..."
     - Empty states: mô tả + hướng dẫn hành động tiếp theo
     - Bỏ: "!", emoji, "nhé", "nào!", "chút nhé", "vắng vẻ", "chăm chỉ", "Nghỉ ngơi chút nhé", "Hôm nay bạn đã hoạt động nhiều rồi"
     - Success: không dấu "!" ("Download complete" thay "Download complete!")
     - NGUYÊN TẮC: mỗi key dịch 1-1, giữ placeholder {{count}}/{{var}} NGUYÊN VẸN, giữ nghĩa kỹ thuật (Drive, Trash, buffer, cache...).
  2. **Dọn 42 dead keys** (liệt kê từ dossier — KHÔNG xóa cache.label.* 4 keys dùng động).
  3. **Plural built-in**: LikedSongs.tsx:114 + PlaylistView.tsx:248 → `t("song", { count: n })` + key `song_one`/`song_other` (en), `song_other`/`song` (vi — CLDR only "other": xác nhận cấu trúc đúng với i18next v26). Cập nhật json.
  4. **DefaultValue chuẩn hóa**: bỏ defaultValue trong code → thuần `t("key")` (key giờ type-safe + missing-key log) — ĐỌC từng file trong list dossier, xóa arg thừa. Với test assert "Ngày"/"Kích thước" (FullRecentView.sorting.test.tsx:229-256) → CẬP NHẬT test theo text mới.
  5. **Key structure**: KHÔNG tách namespace (256 keys, roadmap không rõ) — chỉ ghi chú. KHÔNG đổi tên key (tránh vỡ).
- **Behavior contract**: text hiển thị đổi (có chủ đích); KHÔNG đổi key name; placeholder giữ nguyên; parity en/vi 100%; KHÔNG xóa cache.label.*; plural hoạt động đúng count 1 vs n.
- **Test (TDD)**: (a) script so khớp en/vi 100% (giữ); (b) test cũ assert text → cập nhật theo text mới (liệt kê từng test file đụng); (c) plural: test LikedSongs count 1 → "1 song", count 5 → "5 songs" (mock t); (d) full suite xanh; (e) rg: không còn defaultValue chứa tiếng Việt trong code; (f) eslint . clean.
- **Done**: test xanh + tsc + full suite + eslint . = 0 + mojibake 0.

---

## 3. ĐỊNH NGHĨA DONE (toàn plan)
- [ ] Slice 1-3 APPROVE (TDD đỏ→xanh, report đủ mục skill)
- [ ] Full suite xanh + tsc clean + eslint . = 0 (verify thật)
- [ ] parity en/vi = 100% (script), mojibake 0 (file vi có dấu — CẤM Set-Content)
- [ ] Không còn hardcoded toast i18n; không defaultValue tiếng Việt trong code
- [ ] codebase-memory ghi
- [ ] Commit gợi ý: `feat(i18n): type-safe keys, missing-key CI, professional copy (Material UX writing)`

## 4. NGUỒN THAM KHẢO
- codelabs.developers.google.com/codelabs/material-communication-guidance — Material Communication Principles (concise, direct, second person, essential details, tone map)
- m2.material.io/design/communication/writing.html — Writing guidelines
- www.i18next.com/overview/typescript — CustomTypeOptions, parseInterpolation
- www.i18next.com/overview/configuration-options — missingKeyHandler/saveMissing
- github.com/i18next/i18next-cli — extract/status --ci
- Dossier: i18n-aspect-b.md + i18n-aspect-e.md (2026-08-05, cross-verified)
