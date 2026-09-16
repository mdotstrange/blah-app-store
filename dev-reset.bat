@echo off
setlocal
rem ---------------------------------------------------------------------------
rem  Wipe the local test data written by dev.bat (chat history, to-do list and
rem  calendar notes) so you can start from an empty room again.
rem ---------------------------------------------------------------------------

set "ROOT=%~dp0"
if not defined BLAH_DATA set "BLAH_DATA=%ROOT%blah\data"

echo.
echo   This deletes the local test data in:
echo     %BLAH_DATA%
echo.
echo   messages.json  (chat history)
echo   board.json     (to-do list, calendar notes)
echo.

choice /c yn /n /m "  Delete them? [y/n] "
if errorlevel 2 goto :cancelled

del /q "%BLAH_DATA%\messages.json" 2>nul
del /q "%BLAH_DATA%\messages.json.tmp" 2>nul
del /q "%BLAH_DATA%\board.json" 2>nul
del /q "%BLAH_DATA%\board.json.tmp" 2>nul
del /q "%BLAH_DATA%\.write-test" 2>nul

echo.
echo   Done. The next run starts with an empty room.
echo.
goto :eof

:cancelled
echo.
echo   Nothing deleted.
echo.
