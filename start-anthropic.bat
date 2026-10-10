@echo off
chcp 65001 >nul
cd /d %~dp0
echo [ai-proxy] 正在启动 Anthropic 代理服务 (端口 3718)...
node anthropic-server.js
pause
