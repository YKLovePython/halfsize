import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { Transform } from "node:stream";
import { createReadStream, createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { binaryCacheDir, findBinaries } from "./ffmpeg.mjs";

// `halfsize --fix` exists because the npm install can succeed while the binary
// download behind it silently fails: proxies, TLS-inspecting antivirus and
// mainland mirrors all produce a CLI that runs and then cannot encode. The
// install scripts belong to ffmpeg-static, so this re-implements only the one
// thing we need — fetch the same published asset, check it, unpack it.

export const RELEASE = "b6.1.1";
export const OFFICIAL_BASE = "https://github.com/eugeneware/ffmpeg-static/releases/download";
export const MIRROR_BASE = "https://registry.npmmirror.com/-/binary/ffmpeg-static";

// sha256 of every .gz in the b6.1.1 release, copied from the GitHub API's
// per-asset `digest` field. Without a baked-in table, "verify the download"
// would only check the mirror against itself; this checks it against the
// bytes the ffmpeg-static release actually published.
const DIGESTS = {
  "ffmpeg-darwin-arm64.gz": "8923876afa8db5585022d7860ec7e589af192f441c56793971276d450ed3bbfa",
  "ffmpeg-darwin-x64.gz": "929b375c1182d956c51f7ac25e0b2b0411fb01f6f407aa15c9758efeb4242106",
  "ffmpeg-linux-arm.gz": "64b115a12f0ab77c277e3c418aae8b40ef881e75e746a0e2d066a206b9bc5172",
  "ffmpeg-linux-arm64.gz": "754a678672298bc68156adff58aa7385a592c2b30b1d0ae8750c45c915c4bac0",
  "ffmpeg-linux-ia32.gz": "169b27c078a8ecedb814cac67afccf15a9868d63e9d74ef86088adefaa500d00",
  "ffmpeg-linux-x64.gz": "bfe8a8fc511530457b528c48d77b5737527b504a3797a9bc4866aeca69c2dffa",
  "ffmpeg-win32-x64.gz": "8883a3dffbd0a16cf4ef95206ea05283f78908dbfb118f73c83f4951dcc06d77",
  "ffprobe-darwin-arm64.gz": "d986a8ec7b030899fe66a8a288ed809a3543338705a3ce178cfb85869c5d80be",
  "ffprobe-darwin-x64.gz": "d4da574d6e2e197bd259b47d69cf262df9e312af24ad960444f6d806d3d4c186",
  "ffprobe-linux-arm.gz": "2471169c19fea00018413eebf188703c19ae5ab614477465146d4cdc7458b55d",
  "ffprobe-linux-arm64.gz": "2ab6aba60ee84412dff9188720703376cb4e7aaf7e0b5e43aa8249f2acae5bf8",
  "ffprobe-linux-ia32.gz": "a75c55bcaad1b0e79f2201d82b9cc43903d950857615f91baaea5ce92d756e63",
  "ffprobe-linux-x64.gz": "25d9b6ccb05e3d9de9e04e31e2506d8dd7f9f0418981965ac6df12e8d3afd067",
  "ffprobe-win32-x64.gz": "f309e6223ad89d2fe54bccd420a7709b66fd27540674e92309578ed491a43c8d",
};

const SUPPORTED = {
  darwin: ["x64", "arm64"],
  linux: ["x64", "ia32", "arm64", "arm"],
  win32: ["x64", "ia32"],
};

export function resolveTarget({ platform = process.platform, arch = process.arch } = {}) {
  const arches = SUPPORTED[platform];
  if (!arches) {
    throw new Error(`halfsize --fix has no FFmpeg build for ${platform}. Install FFmpeg yourself and set HALFSIZE_FFMPEG.`);
  }
  if (arches.includes(arch)) return { platform, arch, emulated: false };
  // Windows on ARM has no ffmpeg-static build, but the x64 binary runs there
  // under the OS emulation layer, which beats "no binary at all".
  if (platform === "win32" && arch === "arm64") return { platform, arch: "x64", emulated: true };
  throw new Error(`halfsize --fix has no FFmpeg build for ${platform} ${arch}. Install FFmpeg yourself and set HALFSIZE_FFMPEG.`);
}

export function assetFile(name, target) {
  return `${name}-${target.platform}-${target.arch}.gz`;
}

export function sha256For(name, target) {
  return DIGESTS[assetFile(name, target)] || "";
}

export function downloadUrls(name, target, env = process.env, release = RELEASE) {
  const file = assetFile(name, target);
  const bases = [env.HALFSIZE_BINARIES_URL, env.FFMPEG_BINARIES_URL, OFFICIAL_BASE, MIRROR_BASE]
    .filter(Boolean)
    .map((base) => `${String(base).replace(/\/+$/, "")}/${release}/${file}`);
  return [...new Set(bases)];
}

export function binaryName(name, platform = process.platform) {
  return name + (platform === "win32" ? ".exe" : "");
}

export function works(file) {
  try {
    execFileSync(file, ["-version"], { stdio: "ignore", timeout: 60000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

function humanBytes(n) {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

// Download one asset, verify it, and only then unpack it next to the caller's
// directory. A mismatch or a truncated body leaves nothing behind, so a failed
// --fix cannot break a working install.
export async function installBinary({
  name,
  target,
  dir,
  urls,
  digest,
  fetchImpl = fetch,
  log = () => {},
  verify = works,
  idleTimeoutMs = 60000,
}) {
  if (!digest) throw new Error(`No published checksum for ${name} on ${target.platform} ${target.arch}.`);

  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, binaryName(name, target.platform));
  // Windows only executes files ending in .exe, so the temporary name has to
  // keep that suffix or the "does it run" check below would always fail.
  const partPath = `${dest}.part${target.platform === "win32" ? ".exe" : ""}`;
  const gzPath = `${dest}.download`;
  const failures = [];

  for (const url of urls) {
    const controller = new AbortController();
    let idle = setTimeout(() => controller.abort(), idleTimeoutMs);
    const reset = () => {
      clearTimeout(idle);
      idle = setTimeout(() => controller.abort(), idleTimeoutMs);
    };

    try {
      const res = await fetchImpl(url, {
        signal: controller.signal,
        redirect: "follow",
        headers: { "user-agent": "halfsize-fix" },
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

      const total = Number(res.headers.get("content-length") || 0);
      const hash = createHash("sha256");
      let received = 0;
      let lastReport = 0;
      const meter = new Transform({
        transform(chunk, _enc, cb) {
          hash.update(chunk);
          received += chunk.length;
          reset();
          const now = Date.now();
          if (now - lastReport > 400) {
            lastReport = now;
            log("progress", { name, received, total });
          }
          cb(null, chunk);
        },
      });

      await pipeline(Readable.fromWeb(res.body), meter, createWriteStream(gzPath));

      const actual = hash.digest("hex");
      if (actual !== digest) {
        fs.rmSync(gzPath, { force: true });
        throw new Error(`checksum mismatch (got ${actual.slice(0, 12)}…, expected ${digest.slice(0, 12)}…)`);
      }

      await pipeline(createReadStream(gzPath), createGunzip(), createWriteStream(partPath));
      fs.chmodSync(partPath, 0o755);
      if (!verify(partPath)) throw new Error("the unpacked binary did not run");
      fs.renameSync(partPath, dest);
      fs.rmSync(gzPath, { force: true });
      log("installed", { name, url, bytes: received, path: dest });
      return { path: dest, url, bytes: received };
    } catch (err) {
      fs.rmSync(gzPath, { force: true });
      fs.rmSync(partPath, { force: true });
      failures.push(`${url} -> ${err?.message || err}`);
    } finally {
      clearTimeout(idle);
    }
  }

  throw new Error(`Could not download ${name}:\n  ${failures.join("\n  ")}`);
}

export async function fixBinaries({ log = () => {}, fetchImpl = fetch, idleTimeoutMs = 60000 } = {}) {
  const found = await findBinaries();
  const missing = ["ffmpeg", "ffprobe"].filter((name) => !found[name]);
  const target = resolveTarget();
  const dir = binaryCacheDir();

  if (!missing.length) return { ok: true, target, dir, found, installed: [] };

  const installed = [];
  for (const name of missing) {
    const result = await installBinary({
      name,
      target,
      dir,
      urls: downloadUrls(name, target),
      digest: sha256For(name, target),
      fetchImpl,
      idleTimeoutMs,
      log,
    });
    installed.push({ name, ...result });
  }

  const after = await findBinaries();
  if (!after.ffmpeg || !after.ffprobe) {
    throw new Error(`The binaries were downloaded to ${dir} but halfsize still cannot run them.`);
  }
  return { ok: true, target, dir, found: after, installed };
}

export { humanBytes };
