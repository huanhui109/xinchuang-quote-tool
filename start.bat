@echo off
cd /d "%~dp0"

echo Starting Server Config Workbench ...
echo.

where python >nul 2>nul
if %errorlevel%==0 (
  echo [info] Launching with Python...
  python server.py
  if errorlevel 1 (
    echo.
    echo Python launch failed, trying Node fallback...
    goto :use_node
  )
  goto :eof
)

where python3 >nul 2>nul
if %errorlevel%==0 (
  echo [info] Launching with python3...
  python3 server.py
  if errorlevel 1 (
    echo.
    echo python3 launch failed, trying Node fallback...
    goto :use_node
  )
  goto :eof
)

:use_node
where node >nul 2>nul
if %errorlevel%==0 (
  echo [info] Launching with Node...
  node server.js
  if errorlevel 1 (
    goto :no_runtime
  )
  goto :eof
)

:no_runtime
echo.
echo ============================================================
echo  Failed to start: neither Python nor Node was found.
echo.
echo  Please install one of the following and ensure it is on PATH:
echo    - Python 3.10+   https://www.python.org/downloads/
echo    - Node.js 18+    https://nodejs.org/
echo.
echo  Then double-click this file again.
echo ============================================================
pause
