import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { probe } from "./probe.mjs";
import { planEncode, estimateBytes } from "./plan.mjs";
import { encode } from "./encode.mjs";
import { measureQuality, verdict } from "./quality.mjs";
import { bytes, duration, bitrate, ratio, parseSize, clock } from "./human.mjs";

const VERSION = "0.1.7";
const REPO_URL = "https://github.com/YKLovePython/halfsize";

let starPromptShown = false;

function prefersChinese() {
  const forced = String(process.env.HALFSIZE_LANG || "").toLowerCase();
  if (forced === "zh" || forced === "en") return forced === "zh";
  try {
    return String(Intl.DateTimeFormat().resolvedOptions().locale || "").toLowerCase().startsWith("zh");
  } catch {
    return false;
  }
}

function shouldShowStarPrompt() {
  if (starPromptShown) return false;
  if (process.env.HALFSIZE_NO_PROMO) return false;
  if (process.env.CI) return false;
  return Boolean(process.stdout.isTTY) || process.env.HALFSIZE_PROMO === "1";
}

// One quiet ask after a successful encode, never in --json/--dry-run output and
// never more than once per run. Set HALFSIZE_NO_PROMO=1 to silence it.
function printStarPrompt() {
  if (!shouldShowStarPrompt()) return;
  starPromptShown = true;
  console.log("");
  console.log(
    prefersChinese()
      ? "  如果这次帮你省掉了重新上传，点个 star 能让更多人找到它："
      : "  If this saved you a failed upload, a star helps others find it:",
  );
  console.log(`  ${REPO_URL}`);
  console.log("");
}

const HELP = `
  halfsize ${VERSION} - compress a video to an exact size, and prove it still looks the same.

  Usage
    halfsize <file> --to 25mb          Compress to a target size
    halfsize <file> --for discord      Use a platform's upload limit
    halfsize a.mp4 b.mp4 --to 10mb     Compress several files in a row
    halfsize <file> --to 25mb --codec h265
    halfsize <file> --crf 23           Quality-first mode
    halfsize --web                     Open the local app
    halfsize --web --port 8080         Use a different port
    halfsize --doctor                  Check FFmpeg and hardware encoders

  Options
    --to <size>       Target size: 25mb, 700k, 1.5gb
    --for <app>       Target cap for discord, whatsapp, wechat, email, twitter
    --crf <n>         Quality mode (18 best / 23 balanced / 28 small)
    --codec <name>    h264 (default, compatible) or h265 (smaller)
    --preset <name>   ultrafast..veryslow (default: medium)
    --out <file>      Output path
    --no-audio        Drop the audio track
    --no-verify       Skip the SSIM/VMAF check
    --no-downscale    Never reduce resolution
    --json            Machine-readable result
    --dry-run         Print the plan, do not encode
    --port <n>        Port for --web (default 4174)
    -h, --help        Show this help
    -v, --version     Show version

  Why
    "Just make it smaller" is easy. "Make it fit in 25 MB and still look identical"
    is the part everyone gets wrong. halfsize computes the bitrate, picks the
    resolution, encodes twice, then measures the result with SSIM and VMAF.

  Environment
    HALFSIZE_FFMPEG   Path to a specific FFmpeg binary
    HALFSIZE_NO_PROMO Set to 1 to hide the post-run repository link
`;

const DEFAULTS = { codec: "h264", preset: "medium", verify: true, downscale: true, audio: true };

// Current upload caps as people hit them (checked November 2026). Discord raised
// its free cap to 20 MB in August 2026 and WeChat's chat-video cap is 20 MB.
// Caps change, so --to always wins if a preset is wrong for your account tier.
export const PLATFORMS = {
  discord: { bytes: 20 * 1_000_000, label: "Discord free (20 MB)" },
  whatsapp: { bytes: 16 * 1_000_000, label: "WhatsApp media (16 MB)" },
  wechat: { bytes: 20 * 1_000_000, label: "WeChat video (20 MB)" },
  email: { bytes: 20 * 1_000_000, label: "Email attachment (20 MB)" },
  twitter: { bytes: 512 * 1_000_000, label: "X / Twitter (512 MB)" },
};

function platformFor(name) {
  const key = String(name || "").toLowerCase();
  const found = PLATFORMS[key];
  if (!found) {
    throw new Error(`Unknown platform "${name}". Use one of: ${Object.keys(PLATFORMS).join(", ")}.`);
  }
  return { key, ...found };
}

function parseArgs(argv) {
  const args = { _: [], flags: { ...DEFAULTS } };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") args.flags.help = true;
    else if (a === "-v" || a === "--version") args.flags.version = true;
    else if (a === "--json") args.flags.json = true;
    else if (a === "--dry-run") args.flags.dryRun = true;
    else if (a === "--no-verify") args.flags.verify = false;
    else if (a === "--no-downscale") args.flags.downscale = false;
    else if (a === "--no-audio") args.flags.audio = false;
    else if (a === "--web") args.flags.web = true;
    else if (a === "--doctor") args.flags.doctor = true;
    else if (a === "--port") args.flags.port = Number(argv[++i]);
    else if (a === "--to") args.flags.to = argv[++i];
    else if (a === "--for") args.flags.for = argv[++i];
    else if (a === "--crf") args.flags.crf = Number(argv[++i]);
    else if (a === "--codec") args.flags.codec = argv[++i];
    else if (a === "--preset") args.flags.preset = argv[++i];
    else if (a === "--out") args.flags.out = argv[++i];
    else if (a.startsWith("-")) throw new Error(`Unknown option ${a}`);
    else args._.push(a);
  }
  return args;
}

export async function main(argv) {
  const args = parseArgs(argv);
  const flags = args.flags;

  if (flags.version) {
    console.log(VERSION);
    return;
  }
  if (flags.help || (!args._.length && !flags.web && !flags.doctor)) {
    console.log(HELP);
    return;
  }
  if (flags.doctor) return doctor();
  if (flags.web) return startWeb(flags.port);

  if (flags.to && flags.for) throw new Error("Use --to or --for, not both.");
  const platform = flags.for ? platformFor(flags.for) : null;
  if (!flags.to && !platform && flags.crf === undefined) {
    throw new Error("Pick a target: --to 25mb, --for discord, or --crf 23 for quality mode.");
  }
  if (flags.out && args._.length > 1) {
    throw new Error("--out only works with one input file. It would overwrite itself in a batch.");
  }

  const inputs = args._.map((file) => path.resolve(file));
  const targetBytes = platform ? platform.bytes : flags.to ? parseSize(flags.to) : null;
  const batch = inputs.length > 1;

  const results = [];
  let failed = 0;
  for (const input of inputs) {
    try {
      results.push(await processFile(input, flags, targetBytes, platform, batch));
    } catch (err) {
      failed++;
      results.push({ input: { file: input }, error: err?.message || String(err) });
      if (!flags.json) console.error(`\n  x ${path.basename(input)}: ${err?.message || err}`);
      if (process.env.HALFSIZE_DEBUG) console.error(err?.stack);
    }
  }

  if (flags.json) {
    console.log(JSON.stringify(batch ? { files: results } : results[0], null, 2));
  } else if (batch && !flags.dryRun) {
    printBatch(results);
  }

  if (failed) process.exitCode = 1;
}

async function processFile(input, flags, targetBytes, platform, batch) {
  if (!fs.existsSync(input)) throw new Error(`File not found: ${input}`);

  const info = await probe(input);

  if (targetBytes && targetBytes >= info.sizeBytes) {
    if (batch) {
      console.log(`\n  ${path.basename(input)} already fits (${bytes(info.sizeBytes)}), skipped.`);
    } else {
      console.log(`\n  This file is already ${bytes(info.sizeBytes)}, smaller than the ${bytes(targetBytes)} target.\n`);
    }
    return { input: { file: input, bytes: info.sizeBytes }, targetBytes, skipped: "already-smaller" };
  }

  const plan = planEncode(info, {
    targetBytes,
    crf: flags.crf,
    codec: flags.codec,
    preset: flags.preset,
    downscale: flags.downscale,
    audio: flags.audio,
  });

  const outPath = flags.out ? path.resolve(flags.out) : defaultOutput(input, flags, plan);

  if (!flags.json) printPlan(info, plan, flags, outPath, platform, !batch);

  if (flags.dryRun) {
    return {
      info,
      plan,
      out: outPath,
      dryRun: true,
    };
  }

  const progress = new Progress(Boolean(process.stdout.isTTY) && !flags.json, info.duration);
  let result;
  try {
    result = await encode(input, outPath, plan, info, (p) => progress.update(p));
  } finally {
    progress.finish();
  }

  let quality = { ssim: null, vmaf: null };
  if (flags.verify) {
    if (!flags.json) process.stdout.write(`  measuring quality `);
    quality = await measureQuality(input, outPath, info.duration);
    if (!flags.json) process.stdout.write(`\r${" ".repeat(40)}\r`);
  }

  const summary = {
    input: { file: input, bytes: info.sizeBytes, ...info.video, duration: info.duration },
    output: { file: outPath, bytes: result.outputBytes },
    targetBytes,
    accuracy: targetBytes ? result.outputBytes / targetBytes - 1 : null,
    ratio: info.sizeBytes / result.outputBytes,
    saved: info.sizeBytes - result.outputBytes,
    plan,
    quality,
    verdict: verdict(quality),
    elapsedMs: result.elapsedMs,
  };

  if (!flags.json) printResult(summary, outPath, { promo: !batch });
  return summary;
}

function printBatch(results) {
  const done = results.filter((r) => r.output);
  const skipped = results.filter((r) => r.skipped);
  const errors = results.filter((r) => r.error);
  console.log("");
  if (done.length) {
    const before = done.reduce((sum, r) => sum + r.input.bytes, 0);
    const after = done.reduce((sum, r) => sum + r.output.bytes, 0);
    console.log(`  ${done.length} compressed   ${bytes(before)} -> ${bytes(after)}   ${ratio(before, after)} smaller`);
  }
  if (skipped.length) console.log(`  ${skipped.length} skipped (already under target)`);
  if (errors.length) console.log(`  ${errors.length} failed`);
  console.log("");
  if (done.length) printStarPrompt();
}

function defaultOutput(input, flags, plan) {
  const dir = path.dirname(input);
  const ext = path.extname(input);
  const base = path.basename(input, ext);
  const tag = flags.for
    ? String(flags.for).toLowerCase()
    : flags.to
      ? String(flags.to).replace(/\s+/g, "").toLowerCase()
      : `crf${flags.crf}`;
  return path.join(dir, `${base}.${tag}.mp4`);
}

function line(label, value) {
  console.log(`  ${label.padEnd(10)} ${value}`);
}

function printPlan(info, plan, flags, outPath, platform, showHeader = true) {
  console.log("");
  if (showHeader) {
    console.log(`  halfsize ${VERSION}`);
    console.log("");
  }
  console.log(`  ${path.basename(info.file)}`);
  console.log(
    `  ${bytes(info.sizeBytes)}  ${duration(info.duration)}  ${info.video.width}x${info.video.height}  ${info.video.fps.toFixed(2)} fps  ${info.video.codec}`,
  );
  console.log("");
  if (plan.mode === "size") line("target", platform ? `${bytes(plan.targetBytes)}  (${platform.label})` : bytes(plan.targetBytes));
  else line("mode", `CRF ${plan.crf}`);
  line(
    "plan",
    `${plan.label}  ${plan.width}x${plan.height}  ${plan.videoKbps ? bitrate(plan.videoKbps) : "auto"}  audio ${plan.audioKbps || 0} kbps  ${plan.twoPass ? "2-pass" : "1-pass"}`,
  );
  if (plan.downscaled) line("scale", `${info.video.width}x${info.video.height} -> ${plan.width}x${plan.height}`);
  if (plan.mode === "size") {
    const est = estimateBytes(info, plan);
    line("estimate", `${bytes(est)}  (${ratio(info.sizeBytes, est)} smaller)`);
  }
  line("output", path.basename(outPath));
  for (const warning of plan.warnings) console.log(`  ! ${warning}`);
  console.log("");
}

class Progress {
  constructor(enabled, total) {
    this.enabled = enabled;
    this.total = total;
    this.lastPrint = 0;
    this.start = Date.now();
  }

  update({ ratio, speed, pass, passes }) {
    if (!this.enabled) return;
    const now = Date.now();
    if (now - this.lastPrint < 120 && ratio < 1) return;
    this.lastPrint = now;
    const width = 28;
    const filled = Math.max(0, Math.min(width, Math.round(ratio * width)));
    const bar = "=".repeat(filled) + (filled < width ? ">" : "") + " ".repeat(Math.max(0, width - filled - 1));
    const elapsed = (now - this.start) / 1000;
    const eta = ratio > 0.02 ? (elapsed / ratio) * (1 - ratio) : 0;
    const speedText = String(speed || "").replace("x", "");
    const passText = passes > 1 ? `pass ${pass}/2  ` : "";
    process.stdout.write(
      `\r  [${bar}] ${String(Math.round(ratio * 100)).padStart(3)}%  ${passText}${speedText ? `${speedText}x` : ""}  eta ${clock(eta)}   `,
    );
  }

  finish() {
    if (!this.enabled) return;
    process.stdout.write(`\r${" ".repeat(72)}\r`);
  }
}

function printResult(summary, outPath, { promo = true } = {}) {
  const accuracy =
    summary.accuracy === null ? "" : `${Math.abs(summary.accuracy * 100).toFixed(1)}% ${summary.accuracy > 0 ? "over" : "under"} target`;
  console.log(`  done in ${duration(summary.elapsedMs / 1000)}`);
  console.log("");
  console.log(
    `  ${bytes(summary.input.bytes)}  ->  ${bytes(summary.output.bytes)}   ${ratio(summary.input.bytes, summary.output.bytes)} smaller   ${accuracy}`,
  );
  if (summary.quality.vmaf !== null || summary.quality.ssim !== null) {
    const parts = [];
    if (summary.quality.vmaf !== null) parts.push(`VMAF ${summary.quality.vmaf.toFixed(1)}`);
    if (summary.quality.ssim !== null) parts.push(`SSIM ${summary.quality.ssim.toFixed(3)}`);
    parts.push(summary.verdict.label);
    console.log(`  ${parts.join("   ")}`);
  }
  console.log("");
  console.log(`  -> ${outPath}`);
  if (promo) printStarPrompt();
  else console.log("");
}

const SOURCE_LABEL = {
  env: "HALFSIZE_FFMPEG",
  path: "system PATH",
  bundled: "bundled with halfsize",
};

async function doctor() {
  const { resolveBinaries } = await import("./ffmpeg.mjs");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);

  console.log("");
  console.log(`  halfsize ${VERSION} doctor`);
  console.log("");
  console.log(`  node       ${process.version}   ${process.platform} ${process.arch}`);
  console.log(`  npm        ${process.env.npm_config_user_agent || "not running under npm/npx"}`.slice(0, 120));

  let bins;
  try {
    bins = await resolveBinaries();
  } catch (err) {
    console.log("");
    console.log(err.message.replace(/^/gm, "  "));
    console.log("");
    process.exitCode = 1;
    return;
  }

  const { stdout } = await run(bins.ffmpeg, ["-version"]);
  console.log("");
  console.log(`  ffmpeg     ${bins.ffmpeg}`);
  console.log(`  ffprobe    ${bins.ffprobe}`);
  console.log(`  source     ${SOURCE_LABEL[bins.source] || bins.source}`);
  console.log(`  version    ${stdout.split("\n")[0].replace("ffmpeg version ", "")}`);

  let hasVmaf = null;
  try {
    const { stdout: encodersOut } = await run(bins.ffmpeg, ["-hide_banner", "-encoders"]);
    const encoders = ["libx264", "libx265", "h264_nvenc", "hevc_nvenc", "h264_qsv", "h264_amf"];
    console.log("");
    for (const name of encoders) {
      console.log(`  encoder   ${name.padEnd(12)} ${encodersOut.includes(name) ? "yes" : "no"}`);
    }
    const { stdout: filters } = await run(bins.ffmpeg, ["-hide_banner", "-filters"]);
    hasVmaf = /\blibvmaf\b/.test(filters);
    console.log(`  filter    ${"libvmaf".padEnd(12)} ${hasVmaf ? "yes" : "no"}`);
  } catch {
    // Encoder listing is a bonus; the version check above already proved FFmpeg runs.
  }

  console.log("");
  if (bins.source === "bundled") {
    console.log("  ready. No system FFmpeg install is needed.");
  } else {
    console.log(`  ready. Using ${SOURCE_LABEL[bins.source] || bins.source}.`);
  }
  if (hasVmaf === false) {
    console.log("  note: this build has no libvmaf, so quality checks fall back to SSIM.");
    console.log("        A full build enables VMAF: https://ffmpeg.org/download.html");
  }
  console.log("");
}

async function startWeb(port) {
  const { resolveBinaries } = await import("./ffmpeg.mjs");
  try {
    await resolveBinaries();
  } catch (err) {
    console.error(`\n  x ${err.message}`);
    console.error("\n  Fix FFmpeg first, then run `npx halfsize@latest --doctor` to confirm.\n");
    process.exitCode = 1;
    return;
  }
  const { startServer } = await import("./server.mjs");
  const url = await startServer(port ? { port } : {});
  console.log("");
  console.log(`  halfsize is running at ${url}`);
  console.log("  Drop a video in - nothing leaves this machine.");
  console.log("  Press Ctrl+C to stop.");
  console.log("");
  if (!process.env.HALFSIZE_NO_OPEN) openBrowser(url);
}

function openBrowser(url) {
  const [command, args] =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // The URL is already printed; opening a browser is a convenience.
  }
}
