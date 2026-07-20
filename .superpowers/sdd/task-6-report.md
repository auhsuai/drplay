# Task 6 Report — Dọn code idb-keyval CHẾT, NHƯNG GIỮ migration

## status
DONE

## commits
Không tạo commit (subagent implementer, user sẽ commit/push sau). Chỉ sửa working tree.

## test summary
- `npx tsc --noEmit` → exit 0 (clean)
- `npx vitest run --exclude '**/errorCapture.test.ts'` → 22 files, **116 passed** (0 failed)

## concerns
### File đã chạm vào
- `src/utils/playlists.ts:127` — sửa typo toast: `"Failed to remove track to playlist"` → `"Failed to remove track from playlist"`.

### Phân tích idb-keyval (theo `git grep -n "idb-keyval" -- 'src/**'`)
- `src/db/storage.ts:2` — `import { get as idbGet, keys as idbKeys } from 'idb-keyval';` → **GIỮ** (runStorageMigration, user yêu cầu).
- `src/utils/favorites.ts:1` — `import { get } from 'idb-keyval';` → **GIỮ**.
  - `migrateOldFavorites()` (lines 28-52) vẫn được gọi bởi `getFavorites/addFavorite/removeFavorite/isFavorite`. Đây là logic migration favorites ĐANG CHẠY THỰC TẾ, CHƯA redundant (storage.ts không migrate `drplay_favorites`). Không xoá theo chỉ dẫn "đừng xoá mù".
- `src/App.tsx:74,107` — chỉ là comment mô tả, không phải code chết. Giữ nguyên.

### Kết luận
Không có đoạn idb-keyval code CHẾT nào ngoài hai nơi trên. Sau Task 1-5, mọi import idb-keyval đều còn được dùng:
- storage.ts (migration reader — user giữ)
- favorites.ts (migration path favorites — vẫn active)

→ Không xoá thêm import nào, không xoá idb-keyval khỏi package.json.
