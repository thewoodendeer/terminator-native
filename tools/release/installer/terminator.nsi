; TERMINATOR 3.0 — the Windows installer (Phase 9.1 / 9.4b).
;
; This is not a generic installer. It has to be able to REPLACE an electron-builder NSIS install of Terminator
; 2.2.3 in place, because that is how existing Windows users cross over to 3.0: electron-updater downloads this
; .exe from the 2.x feed and runs it with `--updated /S --force-run`. Three things must match what
; electron-builder did, or the crossing leaves two Terminators on the machine:
;   * the uninstall registry GUID (see TERMINATOR_GUID below),
;   * the install location  %LOCALAPPDATA%\Programs\Terminator,
;   * the shortcut names    "Terminator" in the Start menu and on the desktop.
; And it must honour electron-updater's exact arguments: /S silent, --force-run relaunch, --updated no welcome.
;
; Built by tools/release/package-win.ps1, which passes -DVERSION / -DPAYLOAD / -DOUTFILE.

Unicode true
ManifestDPIAware true

; Before ANY use: ${GetParameters} / ${GetOptions} / ${GetSize} come from FileFunc, ${If} from LogicLib.
; NSIS is a one-pass preprocessor — an include after the first use of its macros is a compile error.
!include "FileFunc.nsh"
!include "LogicLib.nsh"

!ifndef VERSION
  !error "VERSION not defined — build through tools/release/package-win.ps1"
!endif
!ifndef PAYLOAD
  !error "PAYLOAD not defined (the folder holding Terminator.exe and everything beside it)"
!endif
!ifndef OUTFILE
  !error "OUTFILE not defined"
!endif

!define APPNAME     "Terminator"
!define COMPANY     "Killavic Cheat Codes"
; The uninstall key electron-builder wrote for appId com.terminator.audio: UUID v5 of the appId in
; electron-builder's own namespace 50e065bc-3134-11e6-9bab-38c9862bdaf3 (NsisTarget.js:26). Computed with
; electron-builder's own UUID.v5 — NOT with a stock RFC-4122 helper, which produces a different and wrong value.
; VERIFY on a real installed 2.2.3 before shipping the handover:
;   reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall" /s /f Terminator
!define TERMINATOR_GUID "{57BAB645-AFD8-5C3D-8FD0-03C8A1FC01D8}"
!define UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${TERMINATOR_GUID}"

Name "${APPNAME}"
OutFile "${OUTFILE}"
; PER-USER, exactly like the 2.x build: no elevation prompt, and it upgrades what is already there.
RequestExecutionLevel user
InstallDir "$LOCALAPPDATA\Programs\Terminator"
SetCompressor /SOLID lzma
ShowInstDetails hide
ShowUnInstDetails hide

VIProductVersion "3.0.0.0"
VIAddVersionKey "ProductName"     "${APPNAME}"
VIAddVersionKey "CompanyName"     "${COMPANY}"
VIAddVersionKey "FileDescription" "${APPNAME} installer"
VIAddVersionKey "FileVersion"     "${VERSION}"
VIAddVersionKey "ProductVersion"  "${VERSION}"
VIAddVersionKey "LegalCopyright"  "Copyright (c) 2026 ${COMPANY}"

Var ForceRun          ; --force-run : relaunch the app when we are done (electron-updater passes this)
Var WasUpdated        ; --updated   : this is an update, not a first install — no welcome, no noise

; ── the arguments electron-updater will hand us ──────────────────────────────────────────────────────────────
Function .onInit
  StrCpy $ForceRun 0
  StrCpy $WasUpdated 0
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "--force-run" $R1
  IfErrors +2 0
  StrCpy $ForceRun 1
  ClearErrors
  ${GetOptions} $R0 "--updated" $R1
  IfErrors +2 0
  StrCpy $WasUpdated 1
  ClearErrors
FunctionEnd

; ── kill a running copy, or the files cannot be replaced ─────────────────────────────────────────────────────
; electron-updater runs this WHILE the old app is quitting, so a short wait is normal rather than exceptional.
Function CloseRunningApp
  StrCpy $R2 0
  loop:
    nsExec::Exec 'cmd /c tasklist /FI "IMAGENAME eq Terminator.exe" /NH | find /I "Terminator.exe"'
    Pop $R3
    ${If} $R3 != 0
      Return                                  ; not running — carry on
    ${EndIf}
    IntOp $R2 $R2 + 1
    ${If} $R2 > 20                            ; ~10 s, then insist
      nsExec::Exec 'taskkill /F /IM Terminator.exe'
      Sleep 500
      Return
    ${EndIf}
    Sleep 500
    Goto loop
FunctionEnd

Section "Install"
  Call CloseRunningApp
  SetOutPath "$INSTDIR"

  ; Remove the PREVIOUS payload's folders before laying down ours. Without this, a file that existed in 2.2.3
  ; and not in 3.0 is left behind for ever — and for the Electron install that means an entire `resources`
  ; tree and its own copy of the runtime sitting in the user's profile.
  RMDir /r "$INSTDIR\ui"
  RMDir /r "$INSTDIR\bin"
  RMDir /r "$INSTDIR\drums-flac"
  RMDir /r "$INSTDIR\resources"
  RMDir /r "$INSTDIR\locales"
  Delete "$INSTDIR\*.dll"
  Delete "$INSTDIR\*.exe"
  Delete "$INSTDIR\*.pak"
  Delete "$INSTDIR\*.bin"
  Delete "$INSTDIR\*.dat"
  Delete "$INSTDIR\*.json"

  File /r "${PAYLOAD}\*.*"
  WriteUninstaller "$INSTDIR\Uninstall Terminator.exe"

  ; Shortcuts — the SAME names electron-builder used, so pinned taskbar/Start items keep working.
  CreateShortCut "$SMPROGRAMS\Terminator.lnk" "$INSTDIR\Terminator.exe"
  CreateShortCut "$DESKTOP\Terminator.lnk" "$INSTDIR\Terminator.exe"

  ; The uninstall entry Windows and electron-updater both look for.
  WriteRegStr   HKCU "${UNINSTKEY}" "DisplayName"     "${APPNAME}"
  WriteRegStr   HKCU "${UNINSTKEY}" "DisplayVersion"  "${VERSION}"
  WriteRegStr   HKCU "${UNINSTKEY}" "Publisher"       "${COMPANY}"
  WriteRegStr   HKCU "${UNINSTKEY}" "DisplayIcon"     "$INSTDIR\Terminator.exe"
  WriteRegStr   HKCU "${UNINSTKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr   HKCU "${UNINSTKEY}" "UninstallString" '"$INSTDIR\Uninstall Terminator.exe"'
  WriteRegStr   HKCU "${UNINSTKEY}" "QuietUninstallString" '"$INSTDIR\Uninstall Terminator.exe" /S'
  WriteRegDWORD HKCU "${UNINSTKEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTKEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKCU "${UNINSTKEY}" "EstimatedSize" "$0"

  ; `terminator://` and the two project extensions. The APP claims these on every launch too
  ; (registerOsAssociations in Main.cpp) — this is so a machine that has never launched it still knows.
  WriteRegStr HKCU "Software\Classes\terminator" "" "URL:Terminator Protocol"
  WriteRegStr HKCU "Software\Classes\terminator" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\terminator\shell\open\command" "" '"$INSTDIR\Terminator.exe" "%1"'

  ${If} $ForceRun == 1
    ; electron-updater asked for a relaunch. Exec, never ExecShell — the installer must not wait on it.
    Exec '"$INSTDIR\Terminator.exe"'
  ${EndIf}
SectionEnd

Section "Uninstall"
  Call un.CloseRunningApp
  RMDir /r "$INSTDIR\ui"
  RMDir /r "$INSTDIR\bin"
  RMDir /r "$INSTDIR\drums-flac"
  Delete "$INSTDIR\*.exe"
  Delete "$INSTDIR\*.dll"
  RMDir /r "$INSTDIR"
  Delete "$SMPROGRAMS\Terminator.lnk"
  Delete "$DESKTOP\Terminator.lnk"
  DeleteRegKey HKCU "${UNINSTKEY}"
  DeleteRegKey HKCU "Software\Classes\terminator"
  ; The user's PROJECTS, library, settings and licence are deliberately NOT touched: %APPDATA%\terminator and
  ; %APPDATA%\Terminator3 survive an uninstall, so reinstalling finds everything exactly where it was.
SectionEnd

Function un.CloseRunningApp
  nsExec::Exec 'taskkill /F /IM Terminator.exe'
  Sleep 500
FunctionEnd
