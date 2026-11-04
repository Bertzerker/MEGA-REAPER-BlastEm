param(
    [ValidatePattern('^[0-9]+\.[0-9]+\.[0-9]+$')][string]$Version='0.1.0',
    [string]$WslDistribution='Ubuntu',
    [switch]$BuildEmulator,
    [string]$PythonPath
)
$ErrorActionPreference='Stop'
$root=Split-Path $PSScriptRoot -Parent
$nodeVersion='24.20.0'
$nodeArchiveHash='6cac9ffbca8f6a47091e4b5c772e0606049c3871cb67d900c0cedde630e545ba'
$nodeExecutableHash='5c976096e04e5c2c1f091938926234cc9fbebfe9787ddd149351b3b0ecc707b5'
$name="MEGA-REAPER-BlastEm-$Version-windows-x64"
$dist=Join-Path $PSScriptRoot 'dist'
$package=Join-Path $dist $name
$zip=Join-Path $dist "$name.zip"
if ((Test-Path -LiteralPath $package) -or (Test-Path -LiteralPath $zip)) { throw 'Package output exists. Choose a new version or explicitly remove the previous output before rebuilding.' }
if ($BuildEmulator) {
    if (!$PythonPath) { throw '-PythonPath must name an installed Python interpreter as seen from WSL when -BuildEmulator is used.' }
    & wsl -d $WslDistribution --cd $root -- make -j4 PORTABLE=1 OS=Windows CPU=x86_64 SDL=sdl2 OBJDIR=obj/windows EXE=-raster.exe 'OPT=-O2 -flto=4' "PYTHON=$PythonPath" blastem-raster.exe
    if ($LASTEXITCODE -ne 0) { throw 'Native emulator build failed.' }
}
foreach ($required in @('blastem-raster.exe','SDL2.dll','default.cfg','rom.db','systems.cfg','gamecontrollerdb.txt','COPYING','COPYING.fork','glew\LICENSE.txt','sdl\LICENSE.txt')) {
    if (!(Test-Path -LiteralPath (Join-Path $root $required))) { throw "Missing build input: $required" }
}
$cache=Join-Path $PSScriptRoot 'deps'
New-Item -ItemType Directory -Force -Path $cache | Out-Null
$archive=Join-Path $cache "node-v$nodeVersion-win-x64.zip"
if (!(Test-Path -LiteralPath $archive)) {
    Invoke-WebRequest -Uri "https://nodejs.org/dist/v$nodeVersion/node-v$nodeVersion-win-x64.zip" -OutFile $archive -UseBasicParsing
}
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $nodeArchiveHash) { throw 'Official Node.js archive checksum mismatch.' }
$nodeRoot=Join-Path $cache "node-v$nodeVersion-win-x64"
if (!(Test-Path -LiteralPath (Join-Path $nodeRoot 'node.exe'))) { Expand-Archive -LiteralPath $archive -DestinationPath $cache }
if ((Get-FileHash -LiteralPath (Join-Path $nodeRoot 'node.exe') -Algorithm SHA256).Hash.ToLowerInvariant() -ne $nodeExecutableHash) { throw 'Extracted Node.js executable checksum mismatch.' }
if (!(Test-Path -LiteralPath (Join-Path $nodeRoot 'LICENSE'))) { throw 'Node.js license notices are missing.' }
New-Item -ItemType Directory -Force -Path $package,(Join-Path $package 'runtime'),(Join-Path $package 'licenses'),(Join-Path $package 'rea') | Out-Null
foreach ($file in @('blastem-raster.exe','SDL2.dll','default.cfg','rom.db','systems.cfg','gamecontrollerdb.txt','COPYING','COPYING.fork','README.md')) {
    Copy-Item -LiteralPath (Join-Path $root $file) -Destination $package
}
Copy-Item -LiteralPath (Join-Path $root 'README') -Destination (Join-Path $package 'UPSTREAM-README.txt')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'windows\README.txt') -Destination (Join-Path $package 'README.txt')
foreach ($directory in @('images','shaders')) { Copy-Item -LiteralPath (Join-Path $root $directory) -Destination $package -Recurse }
Copy-Item -LiteralPath (Join-Path $nodeRoot 'node.exe') -Destination (Join-Path $package 'runtime')
Copy-Item -LiteralPath (Join-Path $nodeRoot 'LICENSE') -Destination (Join-Path $package 'licenses\Node.js-LICENSE.txt')
Copy-Item -LiteralPath (Join-Path $root 'sdl\LICENSE.txt') -Destination (Join-Path $package 'licenses\SDL2-LICENSE.txt')
Copy-Item -LiteralPath (Join-Path $root 'glew\LICENSE.txt') -Destination (Join-Path $package 'licenses\GLEW-LICENSE.txt')
Copy-Item -LiteralPath (Join-Path $root 'nuklear_ui\Inter-LICENSE.txt') -Destination (Join-Path $package 'licenses\Inter-LICENSE.txt')
Copy-Item -LiteralPath (Join-Path $root 'zlib\LICENSE') -Destination (Join-Path $package 'licenses\zlib-LICENSE.txt')
Copy-Item -LiteralPath (Join-Path $root 'zstd\LICENSE') -Destination (Join-Path $package 'licenses\Zstandard-LICENSE.txt')
foreach ($file in @('server.mjs','atlas.mjs','protocol.mjs','package.json','package-lock.json','Start-REA.ps1','README.md','SPEC.md')) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $file) -Destination (Join-Path $package 'rea')
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'public') -Destination (Join-Path $package 'rea') -Recurse
# Install only the lockfile's production dependencies; do not run package scripts.
& (Join-Path $nodeRoot 'node.exe') (Join-Path $nodeRoot 'node_modules\npm\bin\npm-cli.js') ci --prefix (Join-Path $package 'rea') --omit=dev --ignore-scripts --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw 'Locked production dependency installation failed.' }
Copy-Item -LiteralPath (Join-Path $package 'rea\node_modules\ws\LICENSE') -Destination (Join-Path $package 'licenses\ws-LICENSE.txt')
$sourceUnix=(& wsl -d $WslDistribution -- wslpath -u (Join-Path $PSScriptRoot 'windows\launcher.c')).Trim()
$launcherUnix=(& wsl -d $WslDistribution -- wslpath -u (Join-Path $package 'MEGA REAPER.exe')).Trim()
& wsl -d $WslDistribution -- x86_64-w64-mingw32-gcc -std=c11 -O2 -Wall -Wextra -municode -mwindows -static-libgcc $sourceUnix -o $launcherUnix -lws2_32 -lcomdlg32 -lshell32 -luser32 -lgdi32
if ($LASTEXITCODE -ne 0) { throw 'Native Windows launcher build failed.' }
$sourceCommit=(& git -C $root rev-parse HEAD).Trim()
$manifest=[ordered]@{
    project='MEGA REAPER - BlastEm';version=$Version;platform='windows-x64';source_commit=$sourceCommit
    source_url="https://github.com/Bertzerker/MEGA-REAPER-BlastEm/tree/$sourceCommit"
    node_version=$nodeVersion;node_archive_sha256=$nodeArchiveHash;node_executable_sha256=$nodeExecutableHash
    ws_version=(Get-Content -Raw -LiteralPath (Join-Path $package 'rea\node_modules\ws\package.json') | ConvertFrom-Json).version
    built_utc=[DateTime]::UtcNow.ToString('o');files=@()
}
$manifest.files=@(Get-ChildItem -LiteralPath $package -Recurse -File | Sort-Object FullName | ForEach-Object {
    [ordered]@{path=$_.FullName.Substring($package.Length+1).Replace('\','/');sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}
})
$utf8=[Text.UTF8Encoding]::new($false)
[IO.File]::WriteAllText((Join-Path $package 'build-manifest.json'),($manifest|ConvertTo-Json -Depth 5),$utf8)
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory($package,$zip,[IO.Compression.CompressionLevel]::Optimal,$true)
$sum=(Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText("$zip.sha256","$sum  $name.zip`n",$utf8)
Write-Output "Windows package: $zip"
Write-Output "SHA-256: $sum"
