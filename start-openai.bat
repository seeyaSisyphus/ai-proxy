@echo off
chcp 65001 >nul
cd /d %~dp0
echo [ai-proxy] 正在启动 OpenAI 兼容代理服务 (端口 3719)...
node openai-server.js
pause
