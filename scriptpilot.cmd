@echo off
setlocal

set "ROOT=%~dp0"
set "NODE=%ROOT%runtime\node\active\node.exe"

if not exist "%NODE%" (
  set "NODE=node"
)

"%NODE%" "%ROOT%src\main\cli.js" %*
exit /b %ERRORLEVEL%
