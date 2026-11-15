$ErrorActionPreference = 'Stop'

$packageName = 'halfsize'
$version     = $env:chocolateyPackageVersion
$toolsDir    = Split-Path -Parent $MyInvocation.MyCommand.Definition

# Install from the published tarball rather than letting npm resolve the version,
# so Chocolatey verifies exactly the bytes that were published to npm.
$url      = "https://registry.npmjs.org/$packageName/-/$packageName-$version.tgz"
$tgz      = Join-Path $toolsDir "$packageName-$version.tgz"
$checksum = 'afafaea03deeed56ff8a6379ae86ce4c76b29f97378fc6b68e94f04cdbf9eb94'

Get-ChocolateyWebFile -PackageName $packageName `
                      -FileFullPath $tgz `
                      -Url $url `
                      -Checksum $checksum `
                      -ChecksumType 'sha256'

$npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
if (-not $npm) {
  $npm = Join-Path $env:ChocolateyInstall 'bin\npm.cmd'
  if (-not (Test-Path $npm)) {
    throw 'npm.cmd was not found. The nodejs-lts dependency should have installed it; open a new shell and retry.'
  }
}

# Install into the package tools directory instead of the user's global npm
# prefix, so uninstalling the package removes every file it created.
$npmArgs = @"
install --prefix "`"$toolsDir`"" "`"$tgz`"" --omit=dev --no-audit --no-fund --loglevel error
"@

Start-ChocolateyProcessAsAdmin `
  -ExeToRun $npm `
  -Statements $npmArgs `
  -WorkingDirectory $toolsDir

$wrapper = Join-Path $toolsDir 'node_modules\.bin\halfsize.cmd'
if (-not (Test-Path $wrapper)) {
  throw "npm finished but $wrapper was not created."
}

Install-BinFile -Name $packageName -Path $wrapper

Remove-Item $tgz -Force -ErrorAction SilentlyContinue

# Say it now rather than on the user's first video: the bundled FFmpeg download
# is an optional npm dependency, so a blocked network leaves a working CLI that
# cannot compress anything.
$doctor = & $wrapper --doctor 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) {
  Write-Warning 'halfsize is installed, but its bundled FFmpeg could not be downloaded.'
  Write-Host $doctor
  Write-Host 'Repair it in place, without reinstalling:'
  Write-Host '  halfsize --fix'
  Write-Host 'Or retry with a mirror, or point the CLI at an existing FFmpeg:'
  Write-Host '  $env:FFMPEG_BINARIES_URL="https://registry.npmmirror.com/-/binary/ffmpeg-static"; choco install halfsize -f'
}
else {
  Write-Host 'halfsize is ready. Try: halfsize input.mp4 --to 20mb'
}
