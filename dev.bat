@echo off
setlocal
rem ---------------------------------------------------------------------------
rem  Run BLAH on this PC so you can tweak the UI without pushing to GitHub or
rem  installing anything on the Umbrel.
rem
rem  Edits to blah\public\index.html and blah\icon.svg show up on a plain
rem  browser refresh (Ctrl+R). Edits to blah\server.js need a restart: Ctrl+C
rem  here and run this file again.
rem
rem  Optional overrides before running:
rem    set PORT=3848       use a different port (default 3747)
rem    set BLAH_DATA=D:\x  keep the test chat/board data somewhere else
rem ---------------------------------------------------------------------------

set "ROOT=%~dp0"
if not defined PORT set "PORT=3747"
if not defined BLAH_DATA set "BLAH_DATA=%ROOT%blah\data"
set "BLAH_DEV=1"
set "DATA_DIR=%BLAH_DATA%"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is not on your PATH.
  echo   Install the LTS build from https://nodejs.org/ and run this again.
  echo.
  pause
  exit /b 1
)

if not exist "%BLAH_DATA%" mkdir "%BLAH_DATA%"

echo.
echo   BLAH dev server
echo   ---------------
echo   url      http://localhost:%PORT%/
echo   data     %BLAH_DATA%
echo   reload   page and icon are re-read on every refresh
echo.
echo   Notifications work here too, because localhost counts as a secure
echo   address. Open a private/incognito window as well to test a second
echo   participant (and the shared to-do list) without touching your name.
echo.
echo   Ctrl+C in this window stops the server.
echo.

rem Open the browser a moment after the server starts. BLAH_NO_OPEN=1 skips it.
if not defined BLAH_NO_OPEN start "" /min "%COMSPEC%" /c "timeout /t 2 /nobreak >nul & start http://localhost:%PORT%/"

node "%ROOT%blah\server.js"
set "EXITCODE=%ERRORLEVEL%"

rem Ctrl+C is the normal way to stop this, so it is not an error
if "%EXITCODE%"=="0" goto :done
if "%EXITCODE%"=="-1073741510" goto :done
if "%EXITCODE%"=="3221225786" goto :done

echo.
echo   BLAH stopped with exit code %EXITCODE%.
echo   If the error mentions EADDRINUSE that port is already in use; set a
echo   different one first, for example:  set PORT=3848
echo.
pause

:done
endlocal & exit /b %EXITCODE%
