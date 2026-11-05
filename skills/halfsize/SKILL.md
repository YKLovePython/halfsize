---
name: halfsize
description: Compress a video to an exact target size (20 MB, 16 MB, 700k, ...) on the local machine with FFmpeg, then verify quality with VMAF/SSIM. Use when a user needs a video to fit a platform cap, asks to "make this smaller", or wants to know what a size cut costs in quality.
---

# halfsize

`halfsize` is a local CLI. It does the bitrate math, picks a resolution, encodes twice,
and reports the measured quality. It never uploads the file.

## When to use this

- "Make this fit in 25 MB" / "Discord won't take it" / "WeChat says the file is too big"
- "Compress this but don't ruin it" — run it and report VMAF instead of guessing
- "How small can this go?" — try a target and read the verdict

## Commands

```bash
# exact size
npx halfsize input.mp4 --to 25mb

# let a platform cap pick the size
npx halfsize input.mp4 --for discord

# several files, one command
npx halfsize a.mp4 b.mp4 c.mp4 --to 10mb

# smaller, at the cost of compatibility
npx halfsize input.mp4 --to 10mb --codec h265

# keep resolution, accept a worse ratio
npx halfsize input.mp4 --to 25mb --no-downscale

# no soundtrack
npx halfsize input.mp4 --to 10mb --no-audio

# inspect the plan without encoding
npx halfsize input.mp4 --to 25mb --dry-run --json

# machine-readable result (plan, accuracy, VMAF, SSIM)
npx halfsize input.mp4 --to 25mb --json
```

With more than one input, `--json` returns `{ "files": [ ... ] }`.

If `npx halfsize` is unavailable, use `npx github:YKLovePython/halfsize` with the same flags.

## How to read the result

- `0.3% under target` — good; it deliberately aims slightly under hard caps
- `VMAF >= 90` — looks the same; `80-90` — slight softening; `< 70` — visible loss
- The JSON result includes `output.file`, `output.bytes`, `quality.vmaf`, `quality.ssim`,
  `accuracy`, and `verdict`.

## Rules

- Do not upload the user's video anywhere, and do not suggest an online compressor as a first step.
- Do not promise "no quality loss". Report the measured VMAF/SSIM and the verdict.
- If the source is already smaller than the target, stop and tell the user instead of re-encoding.
- If the source is HDR, warn that colors may shift; HDR-to-SDR is not implemented yet.
- Prefer H.264 unless the user asks for smaller files or accepts H.265 compatibility tradeoffs.
- Write the output next to the input unless the user asks for a specific `--out` path.
