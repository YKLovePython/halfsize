import { spawn } from "node:child_process";
import { resolveBinaries } from "./ffmpeg.mjs";
import { toneMapFilter } from "./hdr.mjs";

const NULL_DEVICE = process.platform === "win32" ? "NUL" : "/dev/null";

// The output is SDR, but the source may still be HDR. Comparing them directly
// scores the transfer-curve difference as "bad quality", so the reference gets
// the same tone map the encoder used.
function metricGraph(options, metric) {
  if (!options.sourceHdr) return `[0:v][1:v]scale2ref[a][b];[a][b]${metric}`;
  return `[1:v]${toneMapFilter(options.sourceTransfer)}[ref];[0:v][ref]scale2ref[a][b];[a][b]${metric}`;
}

export async function measureQuality(source, output, duration, options = {}) {
  const { ffmpeg } = await resolveBinaries();
  const samples = options.samples || 3;
  const seconds = Math.min(options.seconds || 2, Math.max(1, duration / 4));
  const points = [];
  for (let i = 0; i < samples; i++) {
    const at = (duration * (i + 1)) / (samples + 1) - seconds / 2;
    points.push(Math.max(0, Math.min(duration - seconds, at)));
  }

  const ssims = [];
  for (const at of points) {
    const value = await runMetric(ffmpeg, [
      "-ss", String(at), "-t", String(seconds), "-i", output,
      "-ss", String(at), "-t", String(seconds), "-i", source,
      "-lavfi", metricGraph(options, "ssim"),
      "-f", "null", NULL_DEVICE,
    ], /All:\s*([0-9.]+)/);
    if (value !== null) ssims.push(value);
  }

  let vmaf = null;
  if (options.vmaf !== false && duration > 1) {
    const at = Math.max(0, duration / 2 - 1.5);
    vmaf = await runMetric(ffmpeg, [
      "-ss", String(at), "-t", "3", "-i", output,
      "-ss", String(at), "-t", "3", "-i", source,
      "-lavfi", metricGraph(options, "libvmaf=n_threads=2"),
      "-f", "null", NULL_DEVICE,
    ], /VMAF score:\s*([0-9.]+)/);
  }

  const ssim = ssims.length ? ssims.reduce((a, b) => a + b, 0) / ssims.length : null;
  return { ssim, vmaf, sampled: ssims.length, samples };
}

function runMetric(bin, args, regex) {
  return new Promise((resolve) => {
    const child = spawn(bin, ["-hide_banner", "-nostats", ...args], {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", () => resolve(null));
    child.on("close", () => {
      const match = stderr.match(regex);
      resolve(match ? Number(match[1]) : null);
    });
  });
}

export function verdict({ vmaf, ssim }) {
  if (vmaf !== null) {
    if (vmaf >= 95) return { key: "indistinguishable", label: "indistinguishable", tone: "good" };
    if (vmaf >= 90) return { key: "same", label: "looks the same", tone: "good" };
    if (vmaf >= 80) return { key: "slight", label: "slight softening", tone: "ok" };
    if (vmaf >= 70) return { key: "visible", label: "visible loss", tone: "warn" };
    return { key: "degraded", label: "clearly degraded", tone: "bad" };
  }
  if (ssim !== null) {
    if (ssim >= 0.98) return { key: "indistinguishable", label: "indistinguishable", tone: "good" };
    if (ssim >= 0.95) return { key: "same", label: "looks the same", tone: "good" };
    if (ssim >= 0.9) return { key: "slight", label: "slight softening", tone: "ok" };
    return { key: "visible", label: "visible loss", tone: "warn" };
  }
  return { key: "none", label: "not measured", tone: "unknown" };
}
