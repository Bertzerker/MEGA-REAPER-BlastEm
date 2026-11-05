param([Parameter(Mandatory=$true)][string]$Rom, [ValidateRange(1,65533)][int]$Port=8765,
    [ValidateRange(1,60)][int]$CaptureEvery=1, [switch]$NativeWindow, [switch]$NoCatalogCapture)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$romPath = (Resolve-Path -LiteralPath $Rom).Path
$exe = Join-Path $root 'blastem-raster.exe'
if (!(Test-Path -LiteralPath $exe)) { throw 'Build blastem-raster.exe first; see rea/README.md.' }
if (!(Test-Path -LiteralPath (Join-Path $root 'SDL2.dll'))) { throw 'Copy SDL2.dll beside blastem.exe; see rea/README.md.' }
$nodeExe = Join-Path $root 'runtime\node.exe'
if (!(Test-Path -LiteralPath $nodeExe)) {
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    if (!$nodeCommand) { throw 'Node.js is missing. Use the complete portable Windows ZIP or install Node.js for a source checkout.' }
    $nodeExe = $nodeCommand.Source
}
if (!(Test-Path -LiteralPath (Join-Path $PSScriptRoot 'node_modules\ws\index.js'))) { throw 'REA dependencies are missing. Extract the entire portable ZIP or run npm ci --prefix rea in a source checkout.' }
# Fail before launching a game when another inspector already owns either port.
foreach ($reaPort in @($Port,($Port+1),($Port+2))) {
    $probe = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,$reaPort)
    try { $probe.Start() }
    catch { throw "REA port $reaPort is already in use. Reuse the running inspector or choose -Port." }
    finally { $probe.Stop() }
}
$runningEmulators = @(Get-Process -Name 'blastem*' -ErrorAction SilentlyContinue)
if ($runningEmulators.Count) { throw "BlastEm is already running (PID $($runningEmulators.Id -join ', ')). Reuse it or close it before launching." }
$env:BLASTEM_REA_DIR = Join-Path $PSScriptRoot 'session'
$env:PORT = "$Port"
$env:BLASTEM_REA_CAPTURE_EVERY = "$CaptureEvery"
$env:BLASTEM_REA_CATALOG = if ($NoCatalogCapture) { '0' } else { '1' }
$env:BLASTEM_REA_STREAM_PORT = "$($Port+1)"
$env:BLASTEM_REA_CONTROL_PORT = "$($Port+2)"
$env:BLASTEM_REA_BROWSER_ONLY = if ($NativeWindow) { '0' } else { '1' }
New-Item -ItemType Directory -Force $env:BLASTEM_REA_DIR | Out-Null
# A stale capture must not appear to come from the new emulator instance.
$snapshot = Join-Path $env:BLASTEM_REA_DIR 'snapshot.json'
if (Test-Path -LiteralPath $snapshot) { Remove-Item -LiteralPath $snapshot }
$windowStyle = if ($NativeWindow) { 'Normal' } else { 'Hidden' }
$emulator = Start-Process -FilePath $exe -ArgumentList ('"' + $romPath + '"') -WorkingDirectory $root -PassThru -WindowStyle $windowStyle
Write-Host "Inspector: http://127.0.0.1:$Port"
Write-Host 'Open in the Codex in-app browser. Ctrl+C stops this inspector and its emulator.'
if (!$NativeWindow) { Write-Host 'Browser-only display; add -NativeWindow for native keyboard/gamepad interaction.' }
try { & $nodeExe (Join-Path $PSScriptRoot 'server.mjs') }
finally {
    if (!$emulator.HasExited) {
        $closeSent = $emulator.CloseMainWindow()
        if (!$closeSent -or !$emulator.WaitForExit(2000)) { Stop-Process -InputObject $emulator -ErrorAction SilentlyContinue }
        $emulator.WaitForExit(5000) | Out-Null
    }
}
