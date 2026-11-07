Unicode true
ManifestDPIAware true
!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "LogicLib.nsh"

!define APP      "Tavi"
!ifndef VER
  !define VER    "1.0.5"
!endif
!define UNKEY    "Software\Microsoft\Windows\CurrentVersion\Uninstall\Tavi"

Name "${APP}"
OutFile "Tavi-Setup-${VER}.exe"
InstallDir "$LOCALAPPDATA\Programs\Tavi"
InstallDirRegKey HKCU "${UNKEY}" "InstallLocation"
RequestExecutionLevel user
SetCompressor /SOLID lzma
SetCompressorDictSize 64
BrandingText "${APP} ${VER}"

!define MUI_ICON "icon.ico"
!define MUI_UNICON "icon.ico"
!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "Willkommen bei Tavi ${VER}"
!define MUI_WELCOMEPAGE_TEXT "Tavi ist ein PDF-Reader mit KI-Assistent: Texte zusammenfassen und erklären lassen, PDFs zusammenführen und in Word, PowerPoint, Excel oder JPEG umwandeln.$\r$\n$\r$\nEine vorhandene Tavi-Installation wird dabei aktualisiert. Deine Einstellungen bleiben erhalten.$\r$\n$\r$\nKlicke auf Weiter, um fortzufahren."
!define MUI_FINISHPAGE_RUN "$INSTDIR\Tavi.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Tavi jetzt starten"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "German"

VIProductVersion "${VER}.0"
VIAddVersionKey /LANG=${LANG_GERMAN} "ProductName" "${APP}"
VIAddVersionKey /LANG=${LANG_GERMAN} "FileDescription" "Tavi Installationsprogramm"
VIAddVersionKey /LANG=${LANG_GERMAN} "FileVersion" "${VER}"
VIAddVersionKey /LANG=${LANG_GERMAN} "ProductVersion" "${VER}"
VIAddVersionKey /LANG=${LANG_GERMAN} "LegalCopyright" "Tavi"

; Eine ältere Installation (auch aus dem früheren Installer) wiederfinden
Function .onInit
  StrCpy $0 0
  loop:
    EnumRegKey $1 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall" $0
    StrCmp $1 "" done
    IntOp $0 $0 + 1
    ReadRegStr $2 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\$1" "DisplayName"
    StrCpy $3 $2 4
    StrCmp $3 "Tavi" 0 loop
    ReadRegStr $4 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\$1" "InstallLocation"
    StrCmp $4 "" loop
    IfFileExists "$4\Tavi.exe" 0 loop
    StrCpy $INSTDIR $4
  done:
FunctionEnd

!macro CloseTavi
  nsExec::Exec 'taskkill /f /im Tavi.exe'
  Pop $R0
  nsExec::Exec 'taskkill /f /im Lesepult.exe'
  Pop $R0
  Sleep 1000
!macroend

; Frühere Versionen hießen „Lesepult“: Programm, Verknüpfungen und Einträge entfernen.
; Die Einstellungen (API-Schlüssel) übernimmt Tavi beim ersten Start selbst.
Function RemoveLesepult
  StrCpy $5 0
  lp_loop:
    EnumRegKey $6 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall" $5
    StrCmp $6 "" lp_done
    ReadRegStr $7 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\$6" "DisplayName"
    StrCpy $8 $7 8
    ${If} $8 == "Lesepult"
      ReadRegStr $9 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\$6" "InstallLocation"
      ${If} $9 != ""
      ${AndIf} $9 != $INSTDIR
        RMDir /r "$9"
      ${EndIf}
      DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\$6"
      Goto lp_loop
    ${EndIf}
    IntOp $5 $5 + 1
    Goto lp_loop
  lp_done:
  IfFileExists "$LOCALAPPDATA\Programs\Lesepult\Lesepult.exe" 0 +2
    RMDir /r "$LOCALAPPDATA\Programs\Lesepult"
  Delete "$DESKTOP\Lesepult.lnk"
  Delete "$SMPROGRAMS\Lesepult.lnk"
  DeleteRegKey HKCU "Software\Classes\Lesepult.pdf"
  DeleteRegValue HKCU "Software\Classes\.pdf\OpenWithProgids" "Lesepult.pdf"
  DeleteRegKey HKCU "Software\Classes\Applications\Lesepult.exe"
FunctionEnd

Section "Tavi" SecMain
  SetShellVarContext current
  !insertmacro CloseTavi
  SetOutPath "$INSTDIR"

  ; Alte Programmteile entfernen (auch Reste früherer Versionen)
  RMDir /r "$INSTDIR\resources"
  RMDir /r "$INSTDIR\locales"
  Delete "$INSTDIR\Uninstall Tavi.exe"
  Delete "$INSTDIR\Lesepult.exe"

  File /r "win\*"
  File "icon.ico"

  Call RemoveLesepult
  WriteUninstaller "$INSTDIR\Tavi deinstallieren.exe"
  CreateShortCut "$DESKTOP\Tavi.lnk" "$INSTDIR\Tavi.exe" "" "$INSTDIR\Tavi.exe" 0
  CreateShortCut "$SMPROGRAMS\Tavi.lnk" "$INSTDIR\Tavi.exe" "" "$INSTDIR\Tavi.exe" 0

  ; Alte Einträge des früheren Installers aus „Apps“ entfernen
  StrCpy $0 0
  cleanup:
    EnumRegKey $1 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall" $0
    StrCmp $1 "" cleaned
    ReadRegStr $2 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\$1" "DisplayName"
    StrCpy $3 $2 4
    ${If} $3 == "Tavi"
    ${AndIf} $1 != "Tavi"
      DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\$1"
      Goto cleanup
    ${EndIf}
    IntOp $0 $0 + 1
    Goto cleanup
  cleaned:

  ; Eintrag unter Einstellungen > Apps
  WriteRegStr HKCU "${UNKEY}" "DisplayName" "${APP}"
  WriteRegStr HKCU "${UNKEY}" "DisplayVersion" "${VER}"
  WriteRegStr HKCU "${UNKEY}" "Publisher" "Tavi"
  WriteRegStr HKCU "${UNKEY}" "DisplayIcon" "$INSTDIR\Tavi.exe,0"
  WriteRegStr HKCU "${UNKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNKEY}" "UninstallString" '"$INSTDIR\Tavi deinstallieren.exe"'
  WriteRegStr HKCU "${UNKEY}" "QuietUninstallString" '"$INSTDIR\Tavi deinstallieren.exe" /S'
  WriteRegDWORD HKCU "${UNKEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNKEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKCU "${UNKEY}" "EstimatedSize" "$0"

  ; „Öffnen mit“ für PDF-Dateien (ändert NICHT das Standardprogramm)
  WriteRegStr HKCU "Software\Classes\Tavi.pdf" "" "PDF-Dokument"
  WriteRegStr HKCU "Software\Classes\Tavi.pdf\DefaultIcon" "" "$INSTDIR\Tavi.exe,0"
  WriteRegStr HKCU "Software\Classes\Tavi.pdf\shell\open\command" "" '"$INSTDIR\Tavi.exe" "%1"'
  WriteRegStr HKCU "Software\Classes\.pdf\OpenWithProgids" "Tavi.pdf" ""
  WriteRegStr HKCU "Software\Classes\Applications\Tavi.exe" "FriendlyAppName" "Tavi"
  WriteRegStr HKCU "Software\Classes\Applications\Tavi.exe\SupportedTypes" ".pdf" ""
  WriteRegStr HKCU "Software\Classes\Applications\Tavi.exe\shell\open\command" "" '"$INSTDIR\Tavi.exe" "%1"'
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'

  ; Nach einem automatischen Update (/S /RESTART) Tavi wieder starten
  ${GetParameters} $R1
  ClearErrors
  ${GetOptions} $R1 "/RESTART" $R2
  ${IfNot} ${Errors}
    Exec '"$INSTDIR\Tavi.exe"'
  ${EndIf}
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  !insertmacro CloseTavi
  Delete "$DESKTOP\Tavi.lnk"
  Delete "$SMPROGRAMS\Tavi.lnk"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "${UNKEY}"
  DeleteRegKey HKCU "Software\Classes\Tavi.pdf"
  DeleteRegValue HKCU "Software\Classes\.pdf\OpenWithProgids" "Tavi.pdf"
  DeleteRegKey HKCU "Software\Classes\Applications\Tavi.exe"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  IfSilent done
  MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Sollen auch deine Einstellungen und der gespeicherte API-Schlüssel gelöscht werden?" IDNO done
  RMDir /r "$APPDATA\Tavi"
  done:
SectionEnd
