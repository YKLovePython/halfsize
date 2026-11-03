# Changelog

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
