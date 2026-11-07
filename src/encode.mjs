import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { resolveBinaries } from "./ffmpeg.mjs";
import { tighterPlan } from "./plan.mjs";

const NULL_DEVICE = process.platform === "win32" ? "NUL" : "/dev/null";

// Set while a child ffmpeg is running, so Ctrl+C can stop it instead of
// orphaning the process and leaving a half-written file behind.
let activeChild = null;
let interrupted = false;
let handlersInstalled = false;

function installSignalHandlers() {
  if (handlersInstalled) return;
  handlersInstalled = true;
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      if (!activeChild) {
        // Nothing to clean up: behave like the default handler.
        process.exit(signal === "SIGINT" ? 130 : 143);
        return;
      }
      interrupted = true;
      activeChild.kill("SIGTERM");
    });
  }
}

function cancelled(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function buildFilters(plan) {
  const filters = [];
  // Tone mapping must happen before scaling: zscale expects the source
  // transfer curve, not a resampled approximation of it.
  if (plan.toneMap) filters.push(plan.toneMap);
  if (plan.scaleFilter) filters.push(plan.scaleFilter);
  if (plan.fps) filters.push(`fps=${plan.fps}`);
  return filters.length ? filters.join(",") : null;
}

function baseArgs(input, plan, passlog) {
  const args = ["-hide_banner", "-y", "-i", input];
  // Map exactly the streams we mean to encode. Without this, ffmpeg can pick a
  // cover art / thumbnail stream on files that carry one.
  args.push("-map", "0:v:0");
  if (plan.audioKbps) args.push("-map", "0:a:0?");
  const filters = buildFilters(plan);
  if (filters) args.push("-vf", filters);
  args.push("-fps_mode", "cfr");
  args.push("-c:v", plan.encoder, "-preset", plan.preset);
  if (plan.codec === "h265") args.push("-x265-params", "log-level=error");
  if (plan.codec === "h265") args.push("-tag:v", "hvc1");
  args.push("-pix_fmt", "yuv420p");
  if (passlog) args.push("-passlogfile", passlog);
  return args;
}

function audioArgs(plan) {
  if (!plan.audioKbps) return ["-an"];
  return ["-c:a", "aac", "-b:a", `${plan.audioKbps}k`, "-ac", String(plan.audioChannels === 1 ? 1 : 2)];
}

// Write next to the destination so the final rename stays on one filesystem,
// and keep the real extension so ffmpeg still infers the container.
function tempPathFor(output) {
  const dir = path.dirname(output);
  const ext = path.extname(output);
  const base = path.basename(output, ext);
  return path.join(dir, `.${base}.part-${crypto.randomBytes(4).toString("hex")}${ext}`);
}

async function removeQuietly(file) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.rmSync(file, { force: true });
      return;
    } catch {
      // Windows can keep a handle for a moment after ffmpeg exits.
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
  }
}

export async function encode(input, output, plan, info, onProgress = () => {}, options = {}) {
  const { ffmpeg } = await resolveBinaries();
  installSignalHandlers();
  interrupted = false;

  const dir = path.dirname(output);
  fs.mkdirSync(dir, { recursive: true });

  const temp = tempPathFor(output);
  const passlog = path.join(os.tmpdir(), `halfsize-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`);
  const signal = options.signal;
  const started = Date.now();

  try {
    if (signal?.aborted) throw cancelled("HALFSIZE_CANCELLED", "Cancelled.");

    if (plan.mode === "size" && plan.twoPass) {
      const pass1 = [
        ...baseArgs(input, plan, passlog),
        "-b:v", `${plan.videoKbps}k`,
        "-pass", "1",
        "-an",
        "-f", "null",
        NULL_DEVICE,
      ];
      await runFfmpeg(ffmpeg, pass1, info.duration, (p) => onProgress({ ...p, ratio: p.ratio * 0.5, pass: 1, passes: 2 }), signal);
      const pass2 = [
        ...baseArgs(input, plan, passlog),
        "-b:v", `${plan.videoKbps}k`,
        "-pass", "2",
        ...audioArgs(plan),
        "-movflags", "+faststart",
        temp,
      ];
      await runFfmpeg(ffmpeg, pass2, info.duration, (p) => onProgress({ ...p, ratio: 0.5 + p.ratio * 0.5, pass: 2, passes: 2 }), signal);
    } else {
      const args = [...baseArgs(input, plan, null)];
      if (plan.mode === "size") {
        args.push("-b:v", `${plan.videoKbps}k`, "-maxrate", `${Math.round(plan.videoKbps * 1.2)}k`, "-bufsize", `${plan.videoKbps * 2}k`);
      } else {
        args.push("-crf", String(plan.crf));
      }
      args.push(...audioArgs(plan), "-movflags", "+faststart", temp);
      await runFfmpeg(ffmpeg, args, info.duration, (p) => onProgress({ ...p, pass: 1, passes: 1 }), signal);
    }
  } catch (err) {
    await removeQuietly(temp);
    throw err;
  } finally {
    interrupted = false;
    cleanup(passlog);
  }

  // The encode is only real once the file has its final name. A crash, a
  // cancel, or a killed ffmpeg can never leave a plausible-looking .mp4 here.
  try {
    fs.renameSync(temp, output);
  } catch (err) {
    const reason = err.code === "EPERM" || err.code === "EBUSY" ? "it is open in another program" : err.message;
    const problem = new Error(
      `Compressed, but could not replace ${path.basename(output)} (${reason}). The result is saved as ${path.basename(temp)}.`,
    );
    problem.code = "HALFSIZE_RENAME_FAILED";
    throw problem;
  }

  return {
    outputBytes: fs.statSync(output).size,
    elapsedMs: Date.now() - started,
  };
}

// Encode once, and if the result missed the target, tighten the video bitrate
// and try again. two-pass is normally accurate, but short clips, audio, and
// container overhead can still overshoot; retrying is cheaper than making the
// user guess another number.
export async function encodeToSize(input, output, plan, info, onProgress = () => {}, options = {}) {
  let current = plan;
  let elapsedMs = 0;

  for (let attempt = 1; ; attempt++) {
    const result = await encode(input, output, current, info, onProgress, options);
    elapsedMs += result.elapsedMs;

    if (plan.mode !== "size" || !plan.targetBytes) {
      return { ...result, elapsedMs, attempts: attempt };
    }
    if (result.outputBytes <= plan.targetBytes * 1.005) {
      return { ...result, elapsedMs, attempts: attempt, missedTarget: false };
    }

    const next = attempt < 3 ? tighterPlan(current, info, result.outputBytes, plan.targetBytes) : null;
    if (!next) {
      return {
        ...result,
        elapsedMs,
        attempts: attempt,
        missedTarget: result.outputBytes > plan.targetBytes * 1.005,
      };
    }

    options.onRetry?.(attempt + 1, next, result.outputBytes);
    current = { ...current, videoKbps: next.videoKbps };
  }
}

function cleanup(passlog) {
  try {
    const dir = path.dirname(passlog);
    const base = path.basename(passlog);
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith(base)) fs.unlinkSync(path.join(dir, name));
    }
  } catch {
    // best effort
  }
}

function runFfmpeg(bin, args, duration, onProgress, signal) {
  if (process.env.HALFSIZE_DEBUG_FFMPEG) console.error(`\n[ffmpeg] ${bin} ${args.join(" ")}\n`);
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(cancelled("HALFSIZE_CANCELLED", "Cancelled."));

    const child = spawn(bin, ["-progress", "pipe:1", "-nostats", ...args], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    activeChild = child;

    let stderr = "";
    let buffer = "";
    let last = {};

    const onAbort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", onAbort, { once: true });

    const release = () => {
      activeChild = null;
      signal?.removeEventListener("abort", onAbort);
    };

    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        const index = line.indexOf("=");
        if (index === -1) continue;
        last[line.slice(0, index)] = line.slice(index + 1);
        if (line.startsWith("out_time=")) {
          const seconds = parseTime(last.out_time);
          onProgress({
            seconds,
            total: duration,
            ratio: duration && Number.isFinite(seconds) ? Math.min(1, seconds / duration) : 0,
            speed: last.speed || "",
          });
        }
      }
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 20000) stderr = stderr.slice(-20000);
    });

    child.on("error", (err) => {
      release();
      reject(err);
    });
    child.on("close", (code) => {
      release();
      if (interrupted) return reject(cancelled("HALFSIZE_INTERRUPTED", "Cancelled."));
      if (signal?.aborted) return reject(cancelled("HALFSIZE_CANCELLED", "Cancelled."));
      if (code === 0) return resolve();
      const tail = stderr.split(/\r?\n/).filter(Boolean).slice(-12).join("\n");
      reject(new Error(`FFmpeg exited with code ${code}\n${tail}`));
    });
  });
}

function parseTime(value) {
  if (!value) return 0;
  const [hms, frac = "0"] = value.split(".");
  const [h, m, s] = hms.split(":").map(Number);
  if (![h, m, s].every(Number.isFinite)) return 0;
  return h * 3600 + m * 60 + s + Number(`0.${frac}`);
}
