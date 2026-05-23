@echo off
REM Double-click to start the local dev server on LAN (port 8080).
REM After it's running, open http://<your-PC-IP>:8080/ on your phone (same Wi-Fi).
REM Close this window to stop the server.

cd /d "%~dp0"
echo Starting RunPlanner dev server on http://0.0.0.0:8080
echo.
echo Open on phone (same Wi-Fi as this PC):
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /C:"IPv4 Address"') do (
    set IP=%%a
    setlocal enabledelayedexpansion
    echo   http://!IP:~1!:8080/
    endlocal
)
echo.
echo Press Ctrl+C or close this window to stop.
echo.
"C:\Users\iTon\AppData\Local\Python\bin\python.exe" -m http.server 8080 --bind 0.0.0.0
pause
