# DrPlay

**Trình phát nhạc desktop dành cho Google Drive của bạn — nhẹ, riêng tư, và hoàn toàn nằm trong tầm kiểm soát của bạn.**

DrPlay là một ứng dụng máy tính để bàn đa nền tảng (Windows, macOS, Linux) được xây dựng để
phát nhạc trực tiếp từ thư mục Google Drive cá nhân. Thay vì bắt bạn tải hàng trăm GB nhạc về
máy rồi mới nghe được, DrPlay kết nối tới Drive của bạn, xây dựng thư viện ngay trong ứng dụng
và phát nhạc theo kiểu streaming — nhưng mọi thứ vẫn được xử lý cục bộ, an toàn và không rò rỉ
dữ liệu đi đâu cả.

---

## Tại sao DrPlay khác biệt

Phần lớn trình phát nhạc hiện nay hoặc là web app phụ thuộc trình duyệt, hoặc là ứng dụng
Electron nặng nề gửi telemetry về máy chủ. DrPlay chọn một hướng đi khác.

### Chạy cục bộ, không phụ thuộc đám mây trung gian

DrPlay là ứng dụng desktop thuần, được dựng trên **Tauri** — một framework dùng **Rust** làm
backend thay vì trình duyệt Chromium. Toàn bộ giao diện người dùng (React/TypeScript) và logic
phát nhạc chạy ngay trên máy bạn.

Khi bạn bấm phát một bài, file không bị đẩy qua một máy chủ của nhà phát triển để rồi mới quay
về máy bạn. Thay vào đó, ứng dụng thiết lập một **proxy cục bộ** (`drplay.localhost`) đóng vai
trò như một "ổ đĩa ảo" — nó lấy dữ liệu trực tiếp từ Google Drive và cấp phát lại cho trình
phát nhạc ngay trong máy (`src-tauri/src/proxy.rs`, `src-tauri/src/protocol.rs`). Kết quả là
đường truyền media ngắn nhất có thể: Drive → máy bạn → loa của bạn.

Thư viện, playlist, danh sách yêu thích, lịch sử nghe và cache metadata đều được lưu vào
**IndexedDB (Dexie)** và `localStorage` trên chính thiết bị (`src/db/db.ts`,
`src/utils/favorites.ts`, `src/utils/playlists.ts`). Bạn gỡ cài đặt? Dữ liệu local đi cùng bạn,
không nằm trong tay ai khác.

### Không thu thập dữ liệu — cam kết, không phải khẩu hiệu

Chúng tôi đã quét toàn bộ mã nguồn và xác nhận: **DrPlay không tích hợp bất kỳ công cụ theo
dõi người dùng nào** — không PostHog, không Sentry, không Mixpanel, không Amplitude. Không có
mã nào gửi hành vi của bạn về máy chủ của nhà phát triển.

Điều này không chỉ là lời hứa suông, mà được ép buộc ở cấp độ cấu hình. Tập tin
`src-tauri/tauri.conf.json` định nghĩa một **Content Security Policy** chỉ cho phép kết nối tới
đúng hai nhóm đích: API của Google (`googleapis.com`, `*.googleusercontent.com`) và các địa
chỉ loopback cục bộ (`127.0.0.1`, `drplay.localhost`). Bất kỳ kết nối nào ngoài danh sách này
đều bị chặn bởi chính runtime của ứng dụng.

Token đăng nhập cũng được lưu trữ **trên máy bạn** thông qua `localStorage`
(`src/utils/apiClient.ts`, `src/hooks/useAuth.ts`). Khi bạn đăng xuất, token bị thu hồi trực
tiếp qua `oauth2.googleapis.com/revoke` và xoá sạch khỏi thiết bị — không lưu trữ phía server,
không bản sao lưu nào.

Quyền truy cập cũng được giới hạn ở phạm vi bạn cho phép: DrPlay chỉ làm việc với **thư mục
Drive do bạn chỉ định**, không tự ý quét toàn bộ tài khoản (`src/hooks/useDrive.ts`,
`src/ui/FolderSelection/FolderSelectionScreen.tsx`).

### Nhẹ đến mức bạn quên nó đang chạy

So với các ứng dụng desktop đóng gói Chromium (Electron), DrPlay với Tauri + Rust tiêu thụ
ít RAM và CPU hơn hẳn, khởi động trong nháy mắt và cho ra bản build có kích thước nhỏ. Danh
mục thư viện cũng được giữ tinh gọn — chỉ những gì thực sự cần thiết như React, Dexie,
`music-metadata` và `i18next` (`package.json`). Không runtime ẩn, không dependency phình to vô
lý.

---

## Tính năng

- **Đăng nhập Google Drive an toàn** — xác thực OAuth2 chuẩn, token tự động làm mới và lưu cục
  bộ (`src/hooks/useAuth.ts`, `src/utils/apiClient.ts`).
- **Chọn thư mục nhạc** — trỏ DrPlay tới bất kỳ thư mục nào trên Drive để làm thư viện.
- **Phát nhạc mượt mà** — điều khiển play/pause, seek, volume, cùng thanh PlayerBar đầy đủ
  (`src/ui/PlayerBar/`).
- **Streaming cục bộ có buffer & prefetch** — phát ngay cả với kết nối không ổn định, nhờ cơ
  chế tải trước các bài hiển thị (`src/utils/streamPrefetcher.ts`, `src/utils/safeAudio.ts`).
- **Crossfade** — chuyển tiếp giữa hai bài hát mượt mà thay vì cắt đứt đột ngột.
- **Playlist** — tạo, chỉnh sửa, xoá và quản lý danh sách phát (`src/ui/Playlist/PlaylistView.tsx`).
- **Bài hát yêu thích (Liked)** — đánh dấu và xem lại những bài bạn thích, lưu hoàn toàn cục bộ.
- **Cover & metadata** — tự động đọc tag ID3, sinh ảnh bìa thumbnail lưu trên máy
  (`src/utils/metadata.ts`, `src-tauri/src/thumbnail.rs`).
- **Thùng rác** — xem, khôi phục hoặc xoá hẳn file ngay trong Drive (`src/ui/Settings/TrashScreen.tsx`).
- **Đồng bộ hoá thư viện** — worker nền đồng bộ thay đổi với Drive thông qua page token
  (`src/workers/proSync.worker.ts`, `src/workers/scanner.worker.ts`).
- **Tuỳ biến** — chủ đề sáng/tối, đa ngôn ngữ (i18n), đường dẫn tải về, thu nhỏ vào khay hệ
  thống (`src/ui/Settings/SettingsTab.tsx`, `src/hooks/useTheme.ts`, `src/i18n.ts`).

---

## Kiến trúc

```
┌─────────────────────────────────────────────┐
│  Frontend · React + TypeScript  (src/)       │  Giao diện, hooks, tiện ích
└───────────────┬─────────────────────────────┘
                │  Tauri IPC / fetch cục bộ
┌───────────────▼─────────────────────────────┐
│  Backend  · Rust / Tauri  (src-tauri/)       │  OAuth, proxy stream,
│  lib.rs · proxy.rs · protocol.rs · thumbnail │  thumbnail, crossfade
└───────────────┬─────────────────────────────┘
                │  HTTPS (chỉ API Google)
        ┌───────▼────────────────┐
        │   Google Drive (của bạn)│  Nguồn file & xác thực
        └─────────────────────────┘

Lưu trữ cục bộ:  IndexedDB (Dexie) · localStorage
```

Mã nguồn chia làm hai tầng rõ rệt: tầng giao diện React (`src/`) và tầng hệ thống Rust
(`src-tauri/`). Logic cốt lõi được gom trong lớp `utils` — nơi tập trung hầu hết lời gọi từ UI
và hooks, giúp code dễ bảo trì và nhất quán. Phần Rust đóng gói xác thực, truyền phát và xử
lý ảnh bìa thành một module gắn kết chặt chẽ, ít phụ thuộc ra ngoài.

---

## Bắt đầu

```bash
npm install
npm run tauri dev      # chạy bản dev (yêu cầu Rust toolchain)
npm run tauri build    # đóng gói bản release
npm test               # chạy unit test (vitest)
```

**Yêu cầu**: Node.js, Rust toolchain và một tài khoản Google Drive. Ứng dụng chỉ thao tác trên
thư mục Drive bạn cấp quyền — không upload bất kỳ dữ liệu nào khác.

---

## Minh bạch

DrPlay là một *client* cho Google Drive của riêng bạn. Điều đó có nghĩa:

- Mọi dữ liệu sử dụng — thư viện, playlist, token — nằm trên máy bạn hoặc trên Drive của bạn.
- Không có máy chủ nào của nhà phát triển thu thập hành vi hay telemetry của bạn.
- Vì nguồn nhạc là Google Drive, ứng dụng cần quyền truy cập Drive và sẽ giao tiếp với máy chủ
  Google khi phát hoặc đồng bộ. Đó là kết nối bắt buộc với nhà cung cấp lưu trữ của bạn, không
  phải với bên thứ ba.

Nếu bạn tìm thấy bất kỳ kết nối mạng nào ngoài các domain đã nêu, đó là lỗi và chúng tôi muốn
biết ngay.
