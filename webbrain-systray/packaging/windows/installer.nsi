; WebBrain Companion installer (NSIS 3). One setup.exe for x64 and Arm64: it
; installs the build matching the machine, per user (no administrator prompt),
; adds a Start menu entry and an entry in Settings, Apps.
;
; Built by scripts/build.sh:
;   makensis -DVERSION=0.1.0 -DNUMVER=0.1.0.0 -DSRC_X64=... -DSRC_ARM64=...
;            -DICON=... -DLICENSE=... -DREADME=... -DOUTFILE=... installer.nsi

Unicode True
SetCompressor /SOLID lzma
RequestExecutionLevel user
ManifestDPIAware true

!include "MUI2.nsh"
!include "x64.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"

!define APPNAME "WebBrain Companion"
!define EXE "WebBrainCompanion.exe"
!define UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\WebBrainCompanion"
!define RUNKEY "Software\Microsoft\Windows\CurrentVersion\Run"

Name "${APPNAME}"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Programs\${APPNAME}"
InstallDirRegKey HKCU "${UNINSTKEY}" "InstallLocation"
BrandingText "${APPNAME} ${VERSION}"

VIProductVersion "${NUMVER}"
VIAddVersionKey /LANG=0 "ProductName" "${APPNAME}"
VIAddVersionKey /LANG=0 "FileDescription" "${APPNAME} Setup"
VIAddVersionKey /LANG=0 "CompanyName" "WebBrain"
VIAddVersionKey /LANG=0 "LegalCopyright" "Copyright 2026 Emre Sokullu"
VIAddVersionKey /LANG=0 "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=0 "ProductVersion" "${VERSION}"

!define MUI_ICON "${ICON}"
!define MUI_UNICON "${ICON}"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\${EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "$(OpenApp)"
!define MUI_FINISHPAGE_TEXT "$(FinishText)"

!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

; The first language is the fallback; Windows picks Turkish on Turkish systems.
!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "Turkish"

LangString OpenApp ${LANG_ENGLISH} "Open WebBrain Companion"
LangString OpenApp ${LANG_TURKISH} "WebBrain Companion'ı aç"
LangString FinishText ${LANG_ENGLISH} "WebBrain Companion runs in the notification area next to the clock. Windows may tuck its icon under the ^ arrow; drag it onto the taskbar to keep it in view. Open WebBrain Companion from the Start menu any time to see its panel."
LangString FinishText ${LANG_TURKISH} "WebBrain Companion, saatin yanındaki bildirim alanında çalışır. Windows simgesini ^ okunun altına gizleyebilir; görünür kalması için görev çubuğuna sürükle. Panelini görmek için WebBrain Companion'ı istediğin zaman Başlat menüsünden aç."
LangString RemoveData ${LANG_ENGLISH} "Also delete your WebBrain Companion settings, sign-ins and downloaded models?"
LangString RemoveData ${LANG_TURKISH} "WebBrain Companion ayarların, girişlerin ve indirilen modeller de silinsin mi?"

; Stops a running copy (and the local model server it started) so its files
; can be replaced.
!macro CloseRunning
  nsExec::Exec 'taskkill /F /T /IM "${EXE}"'
  Pop $0
  Sleep 600
!macroend

Section "Install"
  SetOutPath "$INSTDIR"
  !insertmacro CloseRunning
  ${If} ${IsNativeARM64}
    File "/oname=${EXE}" "${SRC_ARM64}"
  ${Else}
    File "/oname=${EXE}" "${SRC_X64}"
  ${EndIf}
  File "/oname=LICENSE.txt" "${LICENSE}"
  File "/oname=README.md" "${README}"
  WriteUninstaller "$INSTDIR\Uninstall.exe"

  CreateShortcut "$SMPROGRAMS\${APPNAME}.lnk" "$INSTDIR\${EXE}"

  WriteRegStr HKCU "${UNINSTKEY}" "DisplayName" "${APPNAME}"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINSTKEY}" "Publisher" "WebBrain"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayIcon" "$INSTDIR\${EXE}"
  WriteRegStr HKCU "${UNINSTKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTKEY}" "URLInfoAbout" "https://webbrain.one/companion/"
  WriteRegStr HKCU "${UNINSTKEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "${UNINSTKEY}" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
  WriteRegDWORD HKCU "${UNINSTKEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTKEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKCU "${UNINSTKEY}" "EstimatedSize" "$0"
SectionEnd

Section "Uninstall"
  !insertmacro CloseRunning
  Delete "$INSTDIR\${EXE}"
  Delete "$INSTDIR\LICENSE.txt"
  Delete "$INSTDIR\README.md"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  Delete "$SMPROGRAMS\${APPNAME}.lnk"
  DeleteRegValue HKCU "${RUNKEY}" "${APPNAME}"
  DeleteRegKey HKCU "${UNINSTKEY}"

  MessageBox MB_YESNO|MB_ICONQUESTION "$(RemoveData)" /SD IDNO IDNO keep
    RMDir /r "$APPDATA\${APPNAME}"
    RMDir /r "$LOCALAPPDATA\${APPNAME}"
  keep:
SectionEnd
