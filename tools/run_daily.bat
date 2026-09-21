@echo off
chcp 65001 >nul
set "PY=C:\Users\lavie\.workbuddy\binaries\python\versions\3.13.12\python.exe"
set "ROOT=H:\AI project\demo7\llm-radar"
if not exist "%ROOT%\logs" mkdir "%ROOT%\logs"
echo.>>"%ROOT%\logs\run.log"
echo ===== %DATE% %TIME% =====>>"%ROOT%\logs\run.log"
"%PY%" "%ROOT%\tools\run_all.py">>"%ROOT%\logs\run.log" 2>&1
echo [exit %ERRORLEVEL%]>>"%ROOT%\logs\run.log"
