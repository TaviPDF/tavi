@echo off
chcp 65001 >nul
title Tavi - Installer bauen
cd /d "%~dp0"

echo.
echo  ==========================================
echo    Tavi - Windows-Installer wird gebaut
echo  ==========================================
echo.

where npm >nul 2>nul
if errorlevel 1 (
  echo  Node.js fehlt noch.
  echo  Bitte installiere die LTS-Version von https://nodejs.org
  echo  und starte diese Datei danach erneut.
  echo.
  start "" https://nodejs.org
  pause
  exit /b 1
)

echo  [1/3] Lade benoetigte Teile herunter (beim ersten Mal ein paar Minuten) ...
call npm install
if errorlevel 1 goto fehler

echo.
echo  [2/3] Bereite Windows-Werkzeuge vor ...
rem electron-builder bricht ohne Adminrechte beim Entpacken von winCodeSign ab,
rem weil das Archiv Mac-Verknuepfungen enthaelt. Wir entpacken es selbst und
rem ignorieren diese Mac-Dateien, die unter Windows nicht gebraucht werden.
set "WCSROOT=%LOCALAPPDATA%\electron-builder\Cache\winCodeSign"
set "WCS=%WCSROOT%\winCodeSign-2.6.0"
if exist "%WCS%\rcedit-x64.exe" goto bereit
if exist "%WCSROOT%" rmdir /s /q "%WCSROOT%"
mkdir "%WCS%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/electron-userland/electron-builder-binaries/releases/download/winCodeSign-2.6.0/winCodeSign-2.6.0.7z' -OutFile \"$env:TEMP\winCodeSign-2.6.0.7z\""
if errorlevel 1 goto fehler
"node_modules\7zip-bin\win\x64\7za.exe" x -y -bd "%TEMP%\winCodeSign-2.6.0.7z" "-o%WCS%" >nul 2>nul
del "%TEMP%\winCodeSign-2.6.0.7z" >nul 2>nul
if not exist "%WCS%\rcedit-x64.exe" goto fehler
:bereit
echo  Erledigt.

echo.
echo  [3/3] Baue den Installer ...
call npm run build:win
if errorlevel 1 goto fehler

echo.
echo  Fertig! Der Installer liegt im Ordner "dist":
dir /b dist\*.exe
echo.
explorer dist
pause
exit /b 0

:fehler
echo.
echo  Da ist etwas schiefgelaufen. Die Meldungen oben zeigen den Grund.
echo  Tipp: Rechtsklick auf diese Datei und "Als Administrator ausfuehren" probieren.
pause
exit /b 1
