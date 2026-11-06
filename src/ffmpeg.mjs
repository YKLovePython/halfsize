import { execFileSync } from "node:child_process";

let cache = null;

function works(bin) {
  try {
    execFileSync(bin, ["-version"], { stdio: "ignore", timeout: 6000, windowsHide: true });
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
        "  halfsize normally ships its own FFmpeg. It is missing here, which usually",
        "  means npm skipped the binary download or a proxy blocked it.",
        "",
        "  Fix it one of these ways:",
        "",
        "    1. Install it once more, with the binary",
        "         npm install -g halfsize",
        "",
        "       On a slow or filtered network, use the mirror first:",
        "         PowerShell  $env:FFMPEG_BINARIES_URL=\"https://registry.npmmirror.com/-/binary/ffmpeg-static\"; npm install -g halfsize",
        "         macOS/Linux FFMPEG_BINARIES_URL=https://registry.npmmirror.com/-/binary/ffmpeg-static npm install -g halfsize",
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
