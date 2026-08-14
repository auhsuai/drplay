# GATE: SW trên Android — 2026-08-14

- Tauri version: 2.11.3
- WebView version: com.google.android.webview 149.0.7827.5 (Chromium)
- Device: AVD drplay-test (emulator-5554), API level 37 (android-37.1 x86_64)
- Origin: `http://tauri.localhost/` (bundled assets, debug APK)
- isSecureContext: **true** (Chromium 149 treats `*.localhost` as potentially trustworthy — root cause của audit cũ "không secure context" là SAI, đã hiệu chỉnh)
- SW supported: true (`'serviceWorker' in navigator`)
- SW controller: false
- SW register: **FAIL** — `Failed to register a ServiceWorker for scope ('http://tauri.localhost/') with script ('http://tauri.localhost/sw.js'): An unknown error occurred when fetching the script` (đã thử cả 2 lần: register('/sw.js') và register('/sw.js', {scope:'/'}) — cùng lỗi)
- Play thử: không thể (chưa có auth — OAuth chưa port)
- Kết luận nhánh: **B (SW chết)** — Tauri Android chưa hook ServiceWorkerController (wry#1710), script không đến được SW machinery dù secure context. Native audio (ExoPlayer) là đường playback CHÍNH trên Android; webview audio path KHÔNG dùng được. Theo dõi wry#1710 cho tương lai.

## Bằng chứng
- DevTools evaluate qua `adb forward tcp:9222 localabstract:webview_devtools_remote_5296`:
```
INFO: {"secure":true,"swSupported":true,"origin":"http://tauri.localhost","controller":false}
SW: SW_REGISTER_FAIL: Failed to register a ServiceWorker for scope ('http://tauri.localhost/') with script ('http://tauri.localhost/sw.js'): An unknown error occurred when fetching the script.
```
- File script: `C:\Users\thinkpad\AppData\Local\Temp\opencode\sw_eval.js`
