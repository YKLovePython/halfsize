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
        "  Install it once and halfsize will use it:",
        "    Windows   winget install Gyan.FFmpeg",
        "    macOS     brew install ffmpeg",
        "    Linux     sudo apt install ffmpeg",
        "",
        "  Or point at your own build:",
        "    HALFSIZE_FFMPEG=/path/to/ffmpeg HALFSIZE_FFPROBE=/path/to/ffprobe",
      ].join("\n"),
    );
  }

  cache = { ffmpeg, ffprobe, source };
  return cache;
}
