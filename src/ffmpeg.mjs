import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { IS_SEA, selfCommand } from "./self.mjs";

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

// Where `halfsize --fix` puts the binaries it downloads. It is a user-level
// cache rather than node_modules, because a global install, an npx run and a
// local install all have different (often read-only, often disposable)
// dependency trees, and one download should serve all three.
export function binaryCacheDir(env = process.env, platform = process.platform) {
  if (env.HALFSIZE_BIN_DIR) return env.HALFSIZE_BIN_DIR;
  if (platform === "win32") {
    const local = env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return path.join(local, "halfsize", "Cache", "bin");
  }
  if (platform === "darwin") {
    return path.join(os.homedir(), "Library", "Caches", "halfsize", "bin");
  }
  return path.join(env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "halfsize", "bin");
}

function cachedBinary(name) {
  const exe = name + (process.platform === "win32" ? ".exe" : "");
  const file = path.join(binaryCacheDir(), exe);
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return file;
  } catch {
    return "";
  }
}

// A ZIP distribution can drop ffmpeg.exe beside halfsize.exe. That is the
// closest thing to "bundled" a single executable can offer without doubling its
// size, and it beats a first-run download.
function nextToExecutable(name) {
  if (!IS_SEA) return "";
  const exe = name + (process.platform === "win32" ? ".exe" : "");
  const file = path.join(path.dirname(process.execPath), exe);
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return file;
  } catch {
    return "";
  }
}

// Same as resolveBinaries(), but reports what is missing instead of throwing.
// `--fix` uses this to download only the binary that is actually absent.
export async function findBinaries() {
  if (cache) return cache;

  const envFfmpeg = process.env.HALFSIZE_FFMPEG || "";
  const envFfprobe = process.env.HALFSIZE_FFPROBE || "";

  let ffmpeg = envFfmpeg && works(envFfmpeg) ? envFfmpeg : "";
  let ffprobe = envFfprobe && works(envFfprobe) ? envFfprobe : "";
  let source = ffmpeg ? "env" : "";

  if (!ffmpeg) {
    const bin = nextToExecutable("ffmpeg");
    if (bin && works(bin)) {
      ffmpeg = bin;
      source = "sibling";
    }
  }
  if (!ffprobe) {
    const bin = nextToExecutable("ffprobe");
    if (bin && works(bin)) ffprobe = bin;
  }

  if (!ffmpeg && works("ffmpeg")) {
    ffmpeg = "ffmpeg";
    source = "path";
  }
  if (!ffprobe && works("ffprobe")) ffprobe = "ffprobe";

  // ffmpeg-static only exists in an npm install. Inside the executable the
  // resolution would be against the build machine's path anyway, which is a
  // confusing way to find a random node_modules; skip it.
  if (!IS_SEA && !ffmpeg) {
    const bin = await bundled("ffmpeg-static");
    if (bin && works(bin)) {
      ffmpeg = bin;
      source = "bundled";
    }
  }
  if (!IS_SEA && !ffprobe) {
    const bin = await bundled("ffprobe-static");
    if (bin && works(bin)) ffprobe = bin;
  }

  if (!ffmpeg) {
    const bin = cachedBinary("ffmpeg");
    if (bin && works(bin)) {
      ffmpeg = bin;
      source = "cache";
    }
  }
  if (!ffprobe) {
    const bin = cachedBinary("ffprobe");
    if (bin && works(bin)) ffprobe = bin;
  }

  return { ffmpeg, ffprobe, source };
}

export async function resolveBinaries() {
  const found = await findBinaries();
  if (found.ffmpeg && found.ffprobe) {
    cache = found;
    return cache;
  }

  throw new Error(
    IS_SEA
      ? [
          "halfsize needs FFmpeg, and it is not next to this executable.",
          "",
          "  Download it once (about 140 MB, into your user cache):",
          "",
          `    ${selfCommand("--fix")}`,
          "",
          "  Already have FFmpeg? Point halfsize at it:",
          "    HALFSIZE_FFMPEG=C:\\path\\to\\ffmpeg.exe HALFSIZE_FFPROBE=C:\\path\\to\\ffprobe.exe",
          "",
          `  More options: ${selfCommand("--doctor")}`,
        ].join("\n")
      : [
          "FFmpeg was not found.",
          "",
          "  halfsize ships FFmpeg, but the download was skipped (proxy, mirror or",
          "  antivirus). One command fixes it without reinstalling:",
          "",
          `    ${selfCommand("--fix")}`,
          "",
          "  Already have FFmpeg? Point halfsize at it:",
          "    HALFSIZE_FFMPEG=/path/to/ffmpeg HALFSIZE_FFPROBE=/path/to/ffprobe",
          "",
          `  More options: ${selfCommand("--doctor")}`,
        ].join("\n"),
  );
}
