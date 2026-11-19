$ErrorActionPreference = 'Stop'

$packageName = 'halfsize'
$version     = $env:chocolateyPackageVersion
$toolsDir    = Split-Path -Parent $MyInvocation.MyCommand.Definition

# The ZIP already contains ffmpeg.exe and ffprobe.exe next to halfsize.exe, so
# there is nothing to install afterwards and no first-run download to fail.
# Pinned by sha256 to the bytes that were attached to the GitHub release.
$url      = "https://github.com/YKLovePython/halfsize/releases/download/v$version/halfsize-$version-win-x64-full.zip"
$checksum = '37f3202490614ff316135ea0f42d7abe3bd789f0740db1b4bf9dd0116e28682e'

Install-ChocolateyZipPackage -PackageName $packageName `
                             -Url $url `
                             -UnzipLocation $toolsDir `
                             -Checksum $checksum `
                             -ChecksumType 'sha256'

$exe = Join-Path $toolsDir 'halfsize.exe'
if (-not (Test-Path $exe)) {
  throw "The ZIP installed but $exe is missing."
}

Install-BinFile -Name $packageName -Path $exe

# Prove the pair works before telling the user it does. --doctor exits non-zero
# when it cannot find an FFmpeg it can run.
$doctor = & $exe --doctor 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) {
  Write-Warning 'halfsize is installed, but it could not run its FFmpeg.'
  Write-Host $doctor
  throw "halfsize --doctor failed. The package files are in $toolsDir"
}

Write-Host 'halfsize is ready. Try: halfsize input.mp4 --to 20mb'