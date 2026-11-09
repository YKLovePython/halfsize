import { execFileSync } from "node:child_process";

let cache = null;

// The bundled ffprobe is a 76 MB binary. On macOS the first launch can spend
// more than ten seconds in the system's malware scan before printing its
// version, so a short timeout turns a healthy install into "FFmpeg was not
// found". Keep this generous: a missing binary fails instantly (ENOENT), and
// only a genuinely hung process pays the full timeout.
const PROBE_TIMEOUT_MS = 30000;

function works(bin) {
  try {
    execFileSync(bin, ["-version"], { stdio: "ignore", timeout: PROBE_TIMEOUT_MS, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

async function bundled(spec) {
  try {
    const mod = await import(spec);
    const value = mod.default ?? mod;
    return typeof value === "string" ? value : value?.path || "";
  } catch {
    return "";
  }
}

export async function resolveBinaries() {
  if (cache) return cache;

  const envFfmpeg = process.env.HALFSIZE_FFMPEG || "";
  const envFfprobe = process.env.HALFSIZE_FFPROBE || "";

  let ffmpeg = envFfmpeg && works(envFfmpeg) ? envFfmpeg : "";
  let ffprobe = envFfprobe && works(envFfprobe) ? envFfprobe : "";
  let source = ffmpeg ? "env" : "";

  if (!ffmpeg && works("ffmpeg")) {
    ffmpeg = "ffmpeg";
    source = "path";
  }
  if (!ffprobe && works("ffprobe")) ffprobe = "ffprobe";

  if (!ffmpeg) {
    const bin = await bundled("ffmpeg-static");
    if (bin && works(bin)) {
      ffmpeg = bin;
      source = "bundled";
    }
  }
  if (!ffprobe) {
    const bin = await bundled("ffprobe-static");
    if (bin && works(bin)) ffprobe = bin;
  }

  if (!ffmpeg || !ffprobe) {
    throw new Error(
      [
        "FFmpeg was not found.",
        "",
        "  halfsize ships its own FFmpeg, but npm could not download it. The package",
        "  still installs, so you can fix the binary without reinstalling the CLI.",
        "",
        "  Fix it one of these ways:",
        "",
        "    1. Download the binary from a mirror (fast in mainland China)",
        "         PowerShell  $env:FFMPEG_BINARIES_URL=\"https://registry.npmmirror.com/-/binary/ffmpeg-static\"; npm install -g halfsize",
        "         macOS/Linux FFMPEG_BINARIES_URL=https://registry.npmmirror.com/-/binary/ffmpeg-static npm install -g halfsize",
        "",
        "       TLS-inspecting proxy or antivirus (Node 22.15+)",
        "         PowerShell  $env:NODE_OPTIONS=\"--use-system-ca\"; npm install -g halfsize",
        "         macOS/Linux NODE_OPTIONS=--use-system-ca npm install -g halfsize",
        "",
        "    2. Use an FFmpeg you already have",
        "         Windows   winget install Gyan.FFmpeg",
        "         macOS     brew install ffmpeg",
        "         Linux     sudo apt install ffmpeg",
        "",
        "    3. Point at a specific build",
        "         HALFSIZE_FFMPEG=/path/to/ffmpeg HALFSIZE_FFPROBE=/path/to/ffprobe",
        "",
        "  Then check what halfsize found:",
        "    npx halfsize@latest --doctor",
      ].join("\n"),
    );
  }

  cache = { ffmpeg, ffprobe, source };
  return cache;
}
