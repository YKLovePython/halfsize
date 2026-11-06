# Changelog

## 0.1.8

Failure modes, mostly. The kind that leave you with a file you think is fine.

- A failed, cancelled, or interrupted encode no longer leaves a half-written video
  at the output path. It writes a hidden `.part` file next to the destination and
  only renames it once FFmpeg exits cleanly
- `Ctrl+C` stops the running FFmpeg instead of leaving it behind, and prints
  `cancelled` with exit code 130
- The local web app has a Cancel button, and closing the tab stops the encode
  after a ten-second grace period instead of letting FFmpeg run to completion
- Replacing an output that another program has open now fails with a clear message
  and keeps the finished file, instead of deleting it
- The version now comes from `package.json` alone. `scripts/bump-site.mjs` syncs
  the site and READMEs, and a test fails if they drift
- The local app refuses a text file, an image, or an empty file with a readable
  message, instead of accepting it and failing later with a path to ffprobe
- Uploaded file names are reduced to a bare file name, so nothing like
  `../../evil.mp4` can reach the download header
- Malformed request bodies return 400 instead of 500, and impossible byte ranges
  return 416 instead of a broken stream
- Both the CLI and the web app now say when tracks are dropped: extra audio tracks,
  subtitles, surround audio downmixed to stereo, and frame rates above 60 fps
- `--out` refuses to overwrite the input file, and `--crf`, `--preset`, `--codec`,
  and `--port` are validated before encoding starts
- Low-frame-rate sources are left alone. A 5 fps timelapse used to be forced up to
  10 fps, which duplicated frames and inflated the bitrate the planner assumed

## 0.1.7

- The bundled FFmpeg and FFprobe are now optional dependencies, so a blocked binary
  download no longer aborts `npm install` or `npx`. halfsize still starts and explains
  how to fix the binary instead of failing inside npm
- First-run guidance adds `NODE_OPTIONS=--use-system-ca` for TLS-inspecting proxies and
  antivirus, alongside the npmmirror binary mirror
- Verified with a fresh install on a network that rejects the GitHub certificate

## 0.1.6

- A missing FFmpeg now explains the three fixes: rebuild the bundled binary, use a
  system FFmpeg, or point at your own build, with the npmmirror mirror for slow networks
- `--doctor` reports Node, both binary paths, where FFmpeg came from, and whether
  libvmaf is available, so a first run can be diagnosed in one command
- `--web` checks FFmpeg before starting instead of failing on the first upload
- After a successful compression the CLI (TTY only) and the local web app show one
  quiet repository link; `HALFSIZE_NO_PROMO=1` hides it
- Install notes cover `npx` cache, global install, and China mirrors

## 0.1.5

- `--for discord` now targets 20 MB (Discord raised its free upload cap from 10 MB in August 2026)
- `--for wechat` now targets 20 MB (WeChat's chat-video cap, per its help center)
- The web app's presets and copy match the current caps
- `npx` installs behind a restrictive network can use the npmmirror FFmpeg mirror (see Install notes)

## 0.1.4

- Batch mode: `halfsize a.mp4 b.mp4 --to 10mb` compresses several files in a row
- `--for discord|whatsapp|wechat|email|twitter` picks the platform's upload cap for you
- `--no-audio` drops the audio track and spends the bits on video instead
- Streams are mapped explicitly, so cover art and extra tracks cannot be picked by mistake
- Mono audio stays mono instead of being silently upmixed to stereo

## 0.1.3

- Two-pass progress now spans both passes and shows `pass 1/2`
- `--web --port <n>` to pick a port
- Pass logs are cleaned up even when an encode fails

## 0.1.2

- npm release is live
- CI badge in the README

## 0.1.1

- `--version` no longer falls through to the help screen
- Force CFR so two-pass encodes of Matroska/VFR sources stay on target
- Always emit MP4 from the CLI, even for MKV/AVI sources

## 0.1.0

- First release: exact target size, resolution ladder, two-pass H.264/H.265
- SSIM sampling and VMAF measurement with a plain-language verdict
- Local web app with drag and drop, platform presets, and a share card
- `--json`, `--dry-run`, `--doctor`, and `--no-verify`
