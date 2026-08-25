@echo off
REM ============================================================================
REM Launch Chrome with remote debugging for the IG Research scraper.
REM Uses a dedicated profile dir so it won't conflict with your normal Chrome.
REM The FIRST time, log into Instagram in this window. The login persists.
REM ============================================================================

set "CHROME=C:\Program Files\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"

if not exist "%CHROME%" (
  echo Could not find chrome.exe. Edit this file and set CHROME to your Chrome path.
  pause
  exit /b 1
)

echo Launching Chrome with remote debugging on port 9222...
echo Profile: %USERPROFILE%\ig-research-chrome
echo.
echo Leave this Chrome window OPEN while scraping.
echo If this is your first run, log into Instagram now.
echo.

start "" "%CHROME%" --remote-debugging-port=9222 --user-data-dir="%USERPROFILE%\ig-research-chrome" https://www.instagram.com/
