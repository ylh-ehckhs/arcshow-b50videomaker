@echo off
chcp 65001 >nul
cd /d "%~dp0"
set ELECTRON_RUN_AS_NODE=
if exist "portable\arcshow-b50videomaker-0.5.17\arcshow-b50videomaker.exe" (
 start "" "portable\arcshow-b50videomaker-0.5.17\arcshow-b50videomaker.exe"
 exit /b
)
call npm start
if errorlevel 1 pause
