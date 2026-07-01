@echo off
title Laxorq Automate
echo Starting Laxorq Automate on http://localhost:4000 ...
start "" http://localhost:4000
"C:\Program Files\nodejs\node.exe" "%~dp0server.js"
pause
