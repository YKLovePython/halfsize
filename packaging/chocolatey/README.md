# Chocolatey package

Wraps the published npm tarball so `choco install halfsize` works on Windows without
a global npm install.

## Files

- `halfsize.nuspec` — metadata, `nodejs-lts` dependency, description shown on
  community.chocolatey.org.
- `tools/chocolateyInstall.ps1` — downloads the tarball with a checksum, installs it
  into the package's `tools` directory, shims `halfsize.cmd`, then runs `--doctor` so
  a missing FFmpeg is reported during install rather than on the first video.

## Bumping the version

1. Publish the npm version first.
2. Set `<version>` in `halfsize.nuspec`.
3. Download the tarball and compute its SHA-256:

   ```powershell
   node --use-system-ca -e "const fs=require('fs');fetch('https://registry.npmjs.org/halfsize/-/halfsize-<version>.tgz').then(async r=>{if(!r.ok)throw new Error(r.status);fs.writeFileSync('halfsize-<version>.tgz',Buffer.from(await r.arrayBuffer()))})"
   (Get-FileHash .\halfsize-<version>.tgz -Algorithm SHA256).Hash.ToLower()
   ```

4. Replace `$checksum` in `tools/chocolateyInstall.ps1`.
5. Pack and test locally, then push.

## Pack and test

```powershell
choco pack
choco install halfsize -s . -f -y
halfsize --version
halfsize --doctor
choco uninstall halfsize -y
```

`choco install -s .` installs from the local folder; the `-f` flag makes repeated
tests cheap. Uninstall and reinstall once before pushing: leftover files in
`tools\node_modules` are the failure mode this layout is meant to avoid.

## Push

Needs a community.chocolatey.org API key (account → API keys):

```powershell
choco apikey --key <KEY> --source https://push.chocolatey.org/
choco push halfsize.<version>.nupkg --source https://push.chocolatey.org/
```

Moderation usually takes a few days. The version in the nuspec must match an npm
version that exists, because the install script fetches it by version number.
