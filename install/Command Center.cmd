@echo off
REM Double-clickable entry point. The real work is in command-center.ps1;
REM this exists so nobody has to think about PowerShell execution policy.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0command-center.ps1"
