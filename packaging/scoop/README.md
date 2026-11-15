# Scoop manifest

Install straight from this repository — no bucket, no maintainer approval:

```powershell
scoop install https://raw.githubusercontent.com/YKLovePython/halfsize/main/packaging/scoop/halfsize.json
halfsize video.mp4 --to 20mb
```

Scoop needs PowerShell 5.1+ and installs into `%USERPROFILE%\scoop`; no admin rights are
involved. `nodejs-lts` is pulled in as a dependency.

## What the manifest does

1. Downloads the published npm tarball at a fixed URL.
2. Checks it against the `sha256:` of that exact tarball, so the bytes Scoop installs are the
   bytes npm served.
3. Extracts `package/`, runs `npm install --omit=dev` for the two optional dependencies
   (the FFmpeg and FFprobe builds).
4. Writes a `halfsize.cmd` wrapper, because a `.cmd` is something every Scoop version knows
   how to shim.

## Why not the Extras bucket

`scoop install <url>` is the shortest path that works today, and the manifest lives next to
the package it describes. Submitting to `ScoopInstaller/Extras` is possible later; that queue
wants a `checkver`/`autoupdate` pair it can run, and for an npm tarball the hash has to come
from somewhere stable, which usually means a checksums file in a release.

## Keeping it current

Both `version` and `hash` are per-release values. After `npm publish`, update:

```powershell
$v = (npm view halfsize version)
$url = "https://registry.npmjs.org/halfsize/-/halfsize-$v.tgz"
$tmp = "$env:TEMP\halfsize-$v.tgz"
Invoke-WebRequest $url -OutFile $tmp -UseBasicParsing
"sha256:$(Get-FileHash $tmp -Algorithm SHA256).Hash.ToLower()"
```

## Verified locally

On 2026-11-16, with 0.1.11, using the same steps the manifest runs: hash matched, extraction
produced `package/`, `npm install --omit=dev` finished in 7 s from a warm cache, `halfsize.cmd
--version` printed `0.1.11`, `--doctor` found both bundled binaries, and `--fix` correctly
answered "nothing to fix".
