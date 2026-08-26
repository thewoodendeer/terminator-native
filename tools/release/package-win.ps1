# PACKAGE THE WINDOWS APP — build the payload and compile the NSIS installer.
#
# The Windows counterpart of tools/release/package-mac.sh, and deliberately the same shape: it produces an
# artefact in release\win\ and uploads NOTHING. What it cannot do is sign — there is no Windows certificate yet
# (Phase 9.2), so the installer is SmartScreen-unsigned exactly like the 2.x builds.
#
#   pwsh tools/release/package-win.ps1 [-NoBuild] [-SkipProbe]
#
# Needs: an x64 Native Tools shell (MSVC), and makensis on PATH (`choco install nsis` / winget).
$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $RepoRoot

# Flags are read from $args rather than a param() block: this file is invoked as a plain script from CI and
# from an x64 Native Tools shell, and param() has to be the first statement, which the $RepoRoot setup above is.
$NoBuild   = $args -contains "-NoBuild"
$SkipProbe = $args -contains "-SkipProbe"

$Preset  = "win-release"
$AppDir  = "build\$Preset\app\Terminator_artefacts\Release"
$OutDir  = "release\win"

function Step($m) { Write-Host "`n== $m" -ForegroundColor White }
function Die($m)  { Write-Host "`nFAILED: $m" -ForegroundColor Red; exit 1 }

if (-not $NoBuild) {
  Step "building $Preset"
  cmake --preset $Preset
  if ($LASTEXITCODE -ne 0) { Die "configure failed" }
  cmake --build --preset $Preset
  if ($LASTEXITCODE -ne 0) { Die "build failed" }
}
if (-not (Test-Path "$AppDir\Terminator.exe")) { Die "no app at $AppDir — run without -NoBuild" }

# ── what did we build? ────────────────────────────────────────────────────────────────────────────────────────
$Version = (Select-String -Path "build\$Preset\CMakeCache.txt" -Pattern '^TERMINATOR_VERSION_STRING:STRING=(.*)$').Matches.Groups[1].Value
if (-not $Version) { Die "could not read TERMINATOR_VERSION_STRING from the CMake cache" }
Step "Terminator $Version (windows x64)"

# WHAT MUST BE BESIDE THE EXE. Same reasoning as the Mac gate: a build made with the tools or the stem runtime
# switched off ships an app quietly missing YouTube import, MP3 export, stems or updates, and nothing says so.
foreach ($required in @("bin\ytdlp", "bin\qjs", "bin\lame.exe", "onnxruntime.dll", "WinSparkle.dll", "ui")) {
  if (-not (Test-Path "$AppDir\$required")) {
    Die "$required is missing from the build — shipping this would quietly remove a feature"
  }
}
if (-not (Test-Path "$AppDir\drums-flac")) {
  Write-Host "   NOTE: no drums-flac in this build — the app would need the network for drums." -ForegroundColor Yellow
  Write-Host "         Provision it with `node tools/fetch-drums.mjs` and rebuild before shipping." -ForegroundColor Yellow
}

# ── does it RUN? the rule that exists because a release once shipped and crashed on launch ────────────────────
if (-not $SkipProbe) {
  Step "smoke-testing the built app"
  $probe = "build\probe-win-release.json"
  $env:TERMINATOR_PROBE_FILE = $probe
  $env:TERMINATOR_NULL_AUDIO = "auto"
  $env:TERMINATOR_LICENSE_FAKE = "unlocked:probe@terminator.test"
  $env:TERMINATOR_PROBE_UPDATER = "1"
  if (Test-Path $probe) { Remove-Item $probe }
  $p = Start-Process -FilePath "$AppDir\Terminator.exe" -PassThru
  if (-not $p.WaitForExit(240000)) { $p.Kill(); Die "the app did not quit in 240 s" }
  if (-not (Test-Path $probe)) { Die "no probe file written — the app never reached its final read" }
  foreach ($c in @(
      @('"enginePrepared": ?true',                 'the engine never reached a device'),
      @('"lockedWithoutAccount": ?true',           'with no account the app was still unlocked'),
      @('"updater": ?\{[^}]*"started": ?true',     'the updater did not start'),
      @('"webViewDataDir": ?"[^"]*Terminator3',    "the page's localStorage is not with the app's data"))) {
    if (-not (Select-String -Path $probe -Pattern $c[0] -Quiet)) { Die "packaged probe: $($c[1])" }
  }
  Write-Host "   PROBE OK"
}

# ── the installer ─────────────────────────────────────────────────────────────────────────────────────────────
Step "compiling the installer"
# NSIS's installer does not put makensis on PATH, so look where it actually lives before giving up.
$Nsis = (Get-Command makensis -ErrorAction SilentlyContinue).Source
if (-not $Nsis) {
  foreach ($c in @("$env:ProgramFiles\NSIS\makensis.exe", "${env:ProgramFiles(x86)}\NSIS\makensis.exe")) {
    if (Test-Path $c) { $Nsis = $c; break }
  }
}
if (-not $Nsis) { Die "makensis not found — install NSIS (choco install nsis) or put it on PATH" }
Write-Host "   makensis: $Nsis"
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$Payload = (Resolve-Path $AppDir).Path
$OutFile = Join-Path (Resolve-Path $OutDir).Path "Terminator-Setup-$Version.exe"
if (Test-Path $OutFile) { Remove-Item $OutFile }
& $Nsis /DVERSION="$Version" /DPAYLOAD="$Payload" /DOUTFILE="$OutFile" "tools\release\installer\terminator.nsi"
if ($LASTEXITCODE -ne 0) { Die "makensis failed" }
if (-not (Test-Path $OutFile)) { Die "makensis reported success but produced no installer" }

# ── what to feed the updater ──────────────────────────────────────────────────────────────────────────────────
Step "artefact"
$len = (Get-Item $OutFile).Length
$sha = [Convert]::ToBase64String([Security.Cryptography.SHA512]::Create().ComputeHash([IO.File]::ReadAllBytes($OutFile)))
Write-Host "   $OutFile"
Write-Host "      $len bytes"
Write-Host "      sha512 $sha"
Write-Host "`nPACKAGED OK — $Version (windows x64, UNSIGNED — SmartScreen will warn)" -ForegroundColor Green
Write-Host "Nothing has been uploaded. Binaries FIRST, verify, appcast LAST — docs/native/RELEASE-CYCLES-NATIVE.md."
