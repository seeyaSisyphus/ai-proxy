@echo off
chcp 65001 >nul
cd /d %~dp0
echo [ai-proxy] 正在启动 Codex 多路由代理服务 (端口 3722)...
node codex-server.js
pause
