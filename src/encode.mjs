import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { resolveBinaries } from "./ffmpeg.mjs";

const NULL_DEVICE = process.platform === "win32" ? "NUL" : "/dev/null";

function buildFilters(plan) {
  const filters = [];
  if (plan.scaleFilter) filters.push(plan.scaleFilter);
  if (plan.fps) filters.push(`fps=${plan.fps}`);
  return filters.length ? filters.join(",") : null;
}

function baseArgs(input, plan, passlog) {
  const args = ["-hide_banner", "-y", "-i", input];
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
  return ["-c:a", "aac", "-b:a", `${plan.audioKbps}k`, "-ac", "2"];
}

export async function encode(input, output, plan, info, onProgress = () => {}) {
  const { ffmpeg } = await resolveBinaries();
  const passlog = path.join(os.tmpdir(), `halfsize-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const started = Date.now();

  try {
    if (plan.mode === "size" && plan.twoPass) {
      const pass1 = [
        ...baseArgs(input, plan, passlog),
        "-b:v", `${plan.videoKbps}k`,
        "-pass", "1",
        "-an",
        "-f", "null",
        NULL_DEVICE,
      ];
      await runFfmpeg(ffmpeg, pass1, info.duration, (p) => onProgress({ ...p, ratio: p.ratio * 0.5, pass: 1, passes: 2 }));
      const pass2 = [
        ...baseArgs(input, plan, passlog),
        "-b:v", `${plan.videoKbps}k`,
        "-pass", "2",
        ...audioArgs(plan),
        "-movflags", "+faststart",
        output,
      ];
      await runFfmpeg(ffmpeg, pass2, info.duration, (p) => onProgress({ ...p, ratio: 0.5 + p.ratio * 0.5, pass: 2, passes: 2 }));
    } else {
      const args = [...baseArgs(input, plan, null)];
      if (plan.mode === "size") {
        args.push("-b:v", `${plan.videoKbps}k`, "-maxrate", `${Math.round(plan.videoKbps * 1.2)}k`, "-bufsize", `${plan.videoKbps * 2}k`);
      } else {
        args.push("-crf", String(plan.crf));
      }
      args.push(...audioArgs(plan), "-movflags", "+faststart", output);
      await runFfmpeg(ffmpeg, args, info.duration, (p) => onProgress({ ...p, pass: 1, passes: 1 }));
    }
  } finally {
    cleanup(passlog);
  }

  return {
    outputBytes: fs.statSync(output).size,
    elapsedMs: Date.now() - started,
  };
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

function runFfmpeg(bin, args, duration, onProgress) {
  if (process.env.HALFSIZE_DEBUG_FFMPEG) console.error(`\n[ffmpeg] ${bin} ${args.join(" ")}\n`);
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ["-progress", "pipe:1", "-nostats", ...args], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    let buffer = "";
    let last = {};

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
            ratio: duration ? Math.min(1, seconds / duration) : 0,
            speed: last.speed || "",
          });
        }
      }
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 20000) stderr = stderr.slice(-20000);
    });

    child.on("error", reject);
    child.on("close", (code) => {
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
  return h * 3600 + m * 60 + s + Number(`0.${frac}`);
}
