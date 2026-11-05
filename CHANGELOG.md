# Changelog

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
