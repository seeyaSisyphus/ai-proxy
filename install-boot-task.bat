@echo off
REM 双击本文件：弹出 UAC -> 以管理员注册 ai-proxy-watchdog 开机任务
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','%~dp0install-boot-task.ps1'"
