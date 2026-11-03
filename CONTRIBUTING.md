# Contributing

Thanks for wanting to help. Small, focused pull requests are the easiest to review and merge.

## Good first issues

- Try `halfsize` on a real video and tell us what looked wrong. A sample file plus the exact
  command is the most useful bug report you can send.
- Add a platform preset (a named cap for WeChat, Discord, email, X, Bluesky).
- Improve the resolution ladder or bits-per-pixel targets with measured VMAF data.
- Translate the UI into another language. `web/index.html` keeps every string in one `I18N` object.

## Development

```bash
npm install
npm test
node bin/halfsize.mjs --web
```

`npm test` runs unit tests plus one real end-to-end encode. It needs FFmpeg; the test skips
itself if the bundled binary cannot run.

## Guidelines

- Keep the zero-dependency goal for the runtime. FFmpeg binaries are the only dependencies.
- Never add telemetry, analytics, accounts, or network calls. "Your file never leaves your
  machine" is the product.
- New user-facing behavior needs a test and a line in both READMEs.
- Match the existing style: ES modules, `node:` imports, no build step.

## Reporting a bug

Please include:

1. `npx halfsize --doctor`
2. The exact command
3. The input's `ffprobe` summary (resolution, duration, codec, size)
4. What you expected and what happened

If the output looks bad, mention whether `--no-downscale` changes it.
