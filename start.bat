@echo off
cd /d "%~dp0"
where npm >nul 2>nul || (echo Node.js fehlt. Bitte von https://nodejs.org installieren. & pause & exit /b)
if not exist node_modules (echo Installiere einmalig ... & call npm install)
call npm start
