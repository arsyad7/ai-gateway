@echo off
rem Starts a Cloudflare quick tunnel to the gateway. Called by watchdog.ps1.
rem A quick tunnel has no fixed hostname; see docs for the named-tunnel setup.
cd /d "%~dp0.."
if not exist logs mkdir logs
cloudflared tunnel --url http://localhost:%1 >> logs\tunnel.log 2>&1
