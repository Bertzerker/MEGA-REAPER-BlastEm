param(
    [Parameter(Mandatory=$true)][string]$Archive,
    [Parameter(Mandatory=$true)][string]$Rom,
    [ValidateRange(1,65532)][int]$Port=8912
)
$ErrorActionPreference='Stop'
$archivePath=(Resolve-Path -LiteralPath $Archive).Path
$romPath=(Resolve-Path -LiteralPath $Rom).Path
if (@(Get-Process -Name 'blastem*' -ErrorAction SilentlyContinue).Count) { throw 'BlastEm is running. Close it before testing; this test never launches a second instance.' }
$testRoot=Join-Path $PSScriptRoot ("test-output\portable smoke Ω "+[Guid]::NewGuid().ToString('N'))
Expand-Archive -LiteralPath $archivePath -DestinationPath $testRoot
$folders=@(Get-ChildItem -LiteralPath $testRoot -Directory)
if($folders.Count -ne 1) { throw 'Expected one package directory in the ZIP.' }
$package=$folders[0].FullName
$manifest=Get-Content -Raw -LiteralPath (Join-Path $package 'build-manifest.json') | ConvertFrom-Json
foreach($file in $manifest.files){
    $actual=(Get-FileHash -LiteralPath (Join-Path $package $file.path) -Algorithm SHA256).Hash.ToLowerInvariant()
    if($actual -ne $file.sha256){throw "Packaged file checksum mismatch: $($file.path)"}
}
$originalPath=$env:PATH
$env:PATH="$env:SystemRoot\System32;$env:SystemRoot"
$launcher=$null
try {
    $node=Join-Path $package 'runtime\node.exe'
    if((& $node --version).Trim() -ne "v$($manifest.node_version)"){throw 'Bundled Node version mismatch.'}
    $launcher=Start-Process -FilePath (Join-Path $package 'MEGA REAPER.exe') -ArgumentList "--headless --rom `"$romPath`" --port $Port --duration-ms 12000" -WorkingDirectory $testRoot -WindowStyle Hidden -PassThru
    $deadline=[DateTime]::UtcNow.AddSeconds(10);$captured=$false
    while([DateTime]::UtcNow -lt $deadline -and !$launcher.HasExited){
        try{
            $snapshot=Invoke-RestMethod "http://127.0.0.1:$Port/api/snapshot" -TimeoutSec 1
            if($snapshot.frame -gt 3 -and $snapshot.raster.complete){
                [IO.File]::WriteAllText((Join-Path $testRoot 'capture.json'),($snapshot|ConvertTo-Json -Depth 8 -Compress),[Text.UTF8Encoding]::new($false))
                $captured=$true;break
            }
        }catch{}
        Start-Sleep -Milliseconds 150
    }
    if(!$captured){throw "Portable launcher produced no complete VDP capture. Check $package\logs."}
    if(@(Get-Process -Name 'blastem*' -ErrorAction SilentlyContinue).Count -ne 1){throw 'Expected exactly one packaged emulator.'}
    $duplicate=Start-Process -FilePath (Join-Path $package 'MEGA REAPER.exe') -ArgumentList "--headless --rom `"$romPath`" --port $($Port+2) --duration-ms 1000" -WorkingDirectory $testRoot -WindowStyle Hidden -PassThru
    if(!$duplicate.WaitForExit(3000) -or $duplicate.ExitCode -ne 1){throw 'Duplicate launcher was not rejected.'}
    if(@(Get-Process -Name 'blastem*' -ErrorAction SilentlyContinue).Count -ne 1){throw 'Duplicate launch changed the emulator count.'}
    $base="http://127.0.0.1:$Port"
    $origin=@{Origin=$base}
    $state=Invoke-RestMethod "$base/api/movie" -TimeoutSec 2
    if(!$state.available){throw 'Packaged native movie control is unavailable.'}
    $movie=Invoke-RestMethod "$base/api/movie" -Method Post -Headers $origin -ContentType 'application/json' -Body '{"action":"record","title":"Portable movie smoke test"}' -TimeoutSec 3
    Start-Sleep -Milliseconds 450
    $null=Invoke-RestMethod "$base/api/movie" -Method Post -Headers $origin -ContentType 'application/json' -Body '{"action":"pause"}' -TimeoutSec 3
    $evidence=Invoke-RestMethod "$base/api/snapshot" -TimeoutSec 2
    if($evidence.movie.id -ne $movie.id -or $evidence.movie.frame -lt 5){throw 'Packaged movie did not produce tagged frame captures.'}
    $noteBody=@{snapshot=$evidence.id;title='Portable frame evidence';markdown="Captured locally.`n`n~~~json`n{`"verified`":true}`n~~~`n"}|ConvertTo-Json
    $note=Invoke-RestMethod "$base/api/comments" -Method Post -Headers $origin -ContentType 'application/json' -Body $noteBody -TimeoutSec 3
    if($note.capture -ne $evidence.id -or $note.movie_frame -ne $evidence.movie.frame){throw 'Comment references another movie frame.'}
    Invoke-WebRequest "$base/api/comments/$($note.id)/snapshot.json.gz" -OutFile (Join-Path $testRoot 'movie-snapshot.json.gz') -TimeoutSec 3 | Out-Null
    $null=Invoke-RestMethod "$base/api/movie" -Method Post -Headers $origin -ContentType 'application/json' -Body '{"action":"stop"}' -TimeoutSec 3
    $replayBody=@{action='replay';id=$movie.id}|ConvertTo-Json
    $null=Invoke-RestMethod "$base/api/movie" -Method Post -Headers $origin -ContentType 'application/json' -Body $replayBody -TimeoutSec 3
    $replayDeadline=[DateTime]::UtcNow.AddSeconds(4)
    do {Start-Sleep -Milliseconds 75;$state=Invoke-RestMethod "$base/api/movie" -TimeoutSec 2} while($state.mode -ne 'ended' -and [DateTime]::UtcNow -lt $replayDeadline)
    if($state.mode -ne 'ended' -or $state.desync){throw 'Packaged movie failed deterministic replay.'}
    Invoke-WebRequest "$base/api/movies/$($movie.id)/export" -OutFile (Join-Path $testRoot 'movie-and-notes.zip') -TimeoutSec 3 | Out-Null
    $exportFolder=Join-Path $testRoot 'export verification'
    Expand-Archive -LiteralPath (Join-Path $testRoot 'movie-and-notes.zip') -DestinationPath $exportFolder
    if(!(Test-Path -LiteralPath (Join-Path $exportFolder "comments/$($note.id)/snapshot.json.gz"))){throw 'Exported movie ZIP is missing its frame evidence.'}
    $preview=Invoke-WebRequest "$base/vendor/notes.js" -TimeoutSec 2
    if($preview.StatusCode -ne 200){throw 'Offline Markdown/Mermaid preview is missing.'}
    if(!$launcher.WaitForExit(12000) -or $launcher.ExitCode -ne 0){throw 'Portable launcher did not stop normally.'}
    if(@(Get-Process -Name 'blastem*' -ErrorAction SilentlyContinue).Count){throw 'An emulator remained after launcher exit.'}
    & $node (Join-Path $PSScriptRoot 'verify_capture.mjs') (Join-Path $testRoot 'capture.json')
    if($LASTEXITCODE -ne 0){throw 'Packaged VDP output does not match the diagnostic ROM.'}
    Write-Output 'PASS: manifest hashes, bundled runtime, Unicode/space paths, no global Node, exact VDP pixels, movie recording/replay, frame comments/export, offline preview, duplicate rejection and child cleanup.'
}finally{
    $env:PATH=$originalPath
    if($launcher -and !$launcher.HasExited){$launcher.Kill();$launcher.WaitForExit(5000)|Out-Null}
}
