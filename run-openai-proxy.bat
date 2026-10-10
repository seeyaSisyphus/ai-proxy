@echo off
chcp 65001 >nul
cd /d %~dp0
node openai-server.js > "%~dp0logs\openai-proxy-console.log" 2>&1
