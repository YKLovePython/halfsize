# Chocolatey package

Installs `halfsize.exe` and its FFmpeg from the GitHub release ZIP. No Node.js, no
npm, no first-run download.

## Files

- `halfsize.nuspec` — metadata and the description shown on community.chocolatey.org.
- `tools/chocolateyInstall.ps1` — downloads `halfsize-<version>-win-x64-full.zip`
  with a sha256, unzips it into the package's `tools` directory, shims
  `halfsize.exe`, then runs `--doctor` so a broken FFmpeg is reported during
  install rather than on the first video.

## Bumping the version

1. Build the Windows ZIP (`npm run build:exe`) or let `.github/workflows/exe.yml`
   do it, and attach it to the GitHub release.
2. Set `<version>` in `halfsize.nuspec`.
3. Read `sha256` from `build/artifact.json` (or
   `(Get-FileHash .\halfsize-<version>-win-x64-full.zip -Algorithm SHA256).Hash.ToLower()`)
   and put it in `$checksum` in `tools/chocolateyInstall.ps1`.
4. Pack and test locally, then push.

The release must already exist: the install script downloads by version number.

## Pack and test

```powershell
choco pack
choco install halfsize -s . -f -y
halfsize --version
halfsize --doctor
halfsize input.mp4 --to 5mb
choco uninstall halfsize -y
```

`choco install -s .` installs from the local folder; `-f` makes repeated tests
cheap. Uninstall and reinstall once before pushing: a leftover `halfsize.exe` or
`ffmpeg.exe` in `tools` is the failure mode this layout is meant to avoid.

## Push

Needs a community.chocolatey.org API key (account → API keys):

```powershell
choco apikey --key <KEY> --source https://push.chocolatey.org/
choco push halfsize.<version>.nupkg --source https://push.chocolatey.org/
```

Moderation usually takes a few days.