@echo off
rem Launches the production server detached from any terminal. Called by
rem watchdog.ps1; safe to run by hand: scripts\start-gateway.cmd 3000
cd /d "%~dp0.."
if not exist logs mkdir logs
node node_modules\next\dist\bin\next start -p %1 >> logs\gateway.out.log 2>&1
