@echo off
rem Called by the "OTA Rank Tracker" scheduled task. Appends output to tracker.log.
cd /d "%~dp0"
echo ===== %DATE% %TIME% ===== >> tracker.log
call npm run track >> tracker.log 2>&1
