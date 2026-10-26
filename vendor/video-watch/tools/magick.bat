@echo off
rem magick.bat -- wrapper so vw.py's VW_MAGICK can exec magick.cjs
rem (Python subprocess needs a directly executable target; .cjs is not one)
setlocal
set "SCRIPT=%~dp0magick.cjs"
node "%SCRIPT%" %*
exit /b %ERRORLEVEL%
