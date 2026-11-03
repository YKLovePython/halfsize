import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { probe } from "./probe.mjs";
import { planEncode, estimateBytes } from "./plan.mjs";
import { encode } from "./encode.mjs";
import { measureQuality, verdict } from "./quality.mjs";
import { bytes, duration, bitrate, ratio, parseSize, clock } from "./human.mjs";

const VERSION = "0.1.1";

const HELP = `
  halfsize ${VERSION} - compress a video to an exact size, and prove it still looks the same.

  Usage
    halfsize <file> --to 25mb          Compress to a target size
    halfsize <file> --to 25mb --codec h265
    halfsize <file> --crf 23           Quality-first mode
    halfsize --web                     Open the local app
    halfsize --doctor                  Check FFmpeg and hardware encoders

  Options
    --to <size>       Target size: 25mb, 700k, 1.5gb
    --crf <n>         Quality mode (18 best / 23 balanced / 28 small)
    --codec <name>    h264 (default, compatible) or h265 (smaller)
    --preset <name>   ultrafast..veryslow (default: medium)
    --out <file>      Output path
    --no-verify       Skip the SSIM/VMAF check
    --no-downscale    Never reduce resolution
    --json            Machine-readable result
    --dry-run         Print the plan, do not encode
    -h, --help        Show this help
    -v, --version     Show version

  Why
    "Just make it smaller" is easy. "Make it fit in 25 MB and still look identical"
    is the part everyone gets wrong. halfsize computes the bitrate, picks the
    resolution, encodes twice, then measures the result with SSIM and VMAF.
`;

const DEFAULTS = { codec: "h264", preset: "medium", verify: true, downscale: true };

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
    else if (a === "--web") args.flags.web = true;
    else if (a === "--doctor") args.flags.doctor = true;
    else if (a === "--to") args.flags.to = argv[++i];
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
  if (flags.web) return startWeb();

  const input = path.resolve(args._[0]);
  if (!fs.existsSync(input)) throw new Error(`File not found: ${input}`);
  if (!flags.to && flags.crf === undefined) {
    throw new Error("Pick a target: --to 25mb, or use --crf 23 for quality mode.");
  }

  const targetBytes = flags.to ? parseSize(flags.to) : null;
  const info = await probe(input);

  if (targetBytes && targetBytes >= info.sizeBytes) {
    console.log(`\n  This file is already ${bytes(info.sizeBytes)}, smaller than the ${bytes(targetBytes)} target.\n`);
    return;
  }

  const plan = planEncode(info, {
    targetBytes,
    crf: flags.crf,
    codec: flags.codec,
    preset: flags.preset,
    downscale: flags.downscale,
  });

  const outPath = flags.out
    ? path.resolve(flags.out)
    : defaultOutput(input, flags, plan);

  if (!flags.json) printPlan(info, plan, flags, outPath);

  if (flags.dryRun) {
    if (flags.json) console.log(JSON.stringify({ info, plan, out: outPath }, null, 2));
    return;
  }

  const progress = new Progress(Boolean(process.stdout.isTTY) && !flags.json, info.duration);
  let result;
  try {
    result = await encode(input, outPath, plan, info, (p) => progress.update(p));
  } finally {
    progress.finish();
  }

  let quality = { ssim: null, vmaf: null };
  if (flags.verify && !flags.noVerify) {
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

  if (flags.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  printResult(summary, outPath);
}

function defaultOutput(input, flags, plan) {
  const dir = path.dirname(input);
  const ext = path.extname(input);
  const base = path.basename(input, ext);
  const tag = flags.to ? String(flags.to).replace(/\s+/g, "").toLowerCase() : `crf${flags.crf}`;
  return path.join(dir, `${base}.${tag}.mp4`);
}

function line(label, value) {
  console.log(`  ${label.padEnd(10)} ${value}`);
}

function printPlan(info, plan, flags, outPath) {
  console.log("");
  console.log(`  halfsize ${VERSION}`);
  console.log("");
  console.log(`  ${path.basename(info.file)}`);
  console.log(
    `  ${bytes(info.sizeBytes)}  ${duration(info.duration)}  ${info.video.width}x${info.video.height}  ${info.video.fps.toFixed(2)} fps  ${info.video.codec}`,
  );
  console.log("");
  if (plan.mode === "size") line("target", bytes(plan.targetBytes));
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

  update({ ratio, speed }) {
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
    process.stdout.write(
      `\r  [${bar}] ${String(Math.round(ratio * 100)).padStart(3)}%  ${speedText ? `${speedText}x` : ""}  eta ${clock(eta)}   `,
    );
  }

  finish() {
    if (!this.enabled) return;
    process.stdout.write(`\r${" ".repeat(72)}\r`);
  }
}

function printResult(summary, outPath) {
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
  console.log("");
}

async function doctor() {
  const { resolveBinaries } = await import("./ffmpeg.mjs");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);

  console.log("");
  console.log(`  halfsize ${VERSION} doctor`);
  console.log("");
  try {
    const bins = await resolveBinaries();
    const { stdout } = await run(bins.ffmpeg, ["-version"]);
    console.log(`  ffmpeg     ${bins.ffmpeg}`);
    console.log(`  source     ${bins.source}`);
    console.log(`  version    ${stdout.split("\n")[0].replace("ffmpeg version ", "")}`);
  } catch (err) {
    console.log(`  ffmpeg     missing`);
    console.log(`  ${err.message.split("\n")[0]}`);
    return;
  }

  try {
    const bins = await resolveBinaries();
    const { stdout } = await run(bins.ffmpeg, ["-hide_banner", "-encoders"]);
    const encoders = ["libx264", "libx265", "h264_nvenc", "hevc_nvenc", "h264_qsv", "h264_amf"];
    console.log("");
    for (const name of encoders) {
      console.log(`  encoder   ${name.padEnd(12)} ${stdout.includes(name) ? "yes" : "no"}`);
    }
    const { stdout: filters } = await run(bins.ffmpeg, ["-hide_banner", "-filters"]);
    console.log(`  filter    ${"libvmaf".padEnd(12)} ${/\blibvmaf\b/.test(filters) ? "yes" : "no"}`);
  } catch {
    // ignore
  }
  console.log("");
}

async function startWeb() {
  const { startServer } = await import("./server.mjs");
  const url = await startServer();
  console.log("");
  console.log(`  halfsize is running at ${url}`);
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
