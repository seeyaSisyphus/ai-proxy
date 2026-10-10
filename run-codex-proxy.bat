@echo off
chcp 65001 >nul
cd /d %~dp0
node codex-server.js > "%~dp0logs\codex-proxy-console.log" 2>&1
