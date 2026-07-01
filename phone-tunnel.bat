@echo off
title Laxorq Automate - phone/client access
echo Starting Laxorq Automate + secure public tunnel...
echo.
echo A https://xxxx.trycloudflare.com link will appear below.
echo Open it on your phone (and give it to clients), then Add to Home Screen / Install.
echo Keep this window open - closing it takes the link offline.
echo.
start "Laxorq Automate server" /min "C:\Program Files\nodejs\node.exe" "%~dp0server.js"
timeout /t 2 >nul
"C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel --url http://localhost:4000
pause
