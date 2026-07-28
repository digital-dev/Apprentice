@echo off
setlocal
rem Launches Tamper without a terminal. Resolves the app location at run
rem time rather than being hardcoded, so this shortcut keeps working both
rem while the feature branch lives in .worktrees\ and after it is merged
rem into the repo root and the worktree is removed.

set "ROOT=%~dp0"
rem %~dp0 always ends in a backslash, and a trailing backslash immediately
rem before a closing quote escapes that quote — Electron would then receive
rem a mangled app path and open its error window. Strip it.
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

set "APP="
if exist "%ROOT%\out\main\index.js" (
  set "APP=%ROOT%"
) else if exist "%ROOT%\.worktrees\tamper-trainer\out\main\index.js" (
  set "APP=%ROOT%\.worktrees\tamper-trainer"
)

if not defined APP (
  echo Tamper is not built yet.
  echo Run "npm run build" in the project, then try again.
  pause
  exit /b 1
)

if not exist "%APP%\node_modules\electron\dist\electron.exe" (
  echo Electron is missing from %APP%
  echo Run "npm install" there, then try again.
  pause
  exit /b 1
)

start "" "%APP%\node_modules\electron\dist\electron.exe" "%APP%"
