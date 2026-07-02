@echo off
title DrPlay Development Environment
echo =======================================
echo    Starting DrPlay Tauri + React UI
echo =======================================
echo.
echo Please wait while the development server starts...
echo (Hot-reload is enabled for both React and Rust code)
echo.

call npm run tauri dev

echo.
pause
