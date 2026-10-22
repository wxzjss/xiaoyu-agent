@echo off
rem Launch the 小鱼Agent desktop app.
set ELECTRON_RUN_AS_NODE=
cd /d "%~dp0"
start "" "%~dp0node_modules\electron\dist\electron.exe" .