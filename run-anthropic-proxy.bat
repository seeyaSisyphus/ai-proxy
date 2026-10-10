@echo off
chcp 65001 >nul
cd /d %~dp0
node anthropic-server.js > "%~dp0logs\anthropic-proxy-console.log" 2>&1
