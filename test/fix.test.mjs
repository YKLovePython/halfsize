import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import {
  RELEASE,
  OFFICIAL_BASE,
  MIRROR_BASE,
  resolveTarget,
  assetFile,
  sha256For,
  downloadUrls,
  binaryName,
  installBinary,
} from "../src/fix.mjs";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "halfsize-fix-"));
}

function gz(text) {
  return gzipSync(Buffer.from(text, "utf8"));
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

test("resolveTarget accepts the architectures ffmpeg-static publishes", () => {
  assert.deepEqual(resolveTarget({ platform: "darwin", arch: "arm64" }), { platform: "darwin", arch: "arm64", emulated: false });
  assert.deepEqual(resolveTarget({ platform: "darwin", arch: "x64" }), { platform: "darwin", arch: "x64", emulated: false });
  assert.deepEqual(resolveTarget({ platform: "linux", arch: "arm64" }), { platform: "linux", arch: "arm64", emulated: false });
  assert.deepEqual(resolveTarget({ platform: "linux", arch: "arm" }), { platform: "linux", arch: "arm", emulated: false });
  assert.deepEqual(resolveTarget({ platform: "win32", arch: "x64" }), { platform: "win32", arch: "x64", emulated: false });
});

test("Windows on ARM falls back to the x64 binary instead of having none", () => {
  assert.deepEqual(resolveTarget({ platform: "win32", arch: "arm64" }), { platform: "win32", arch: "x64", emulated: true });
});

test("resolveTarget refuses platforms it has no build for, and says what to do", () => {
  assert.throws(() => resolveTarget({ platform: "freebsd", arch: "x64" }), /HALFSIZE_FFMPEG/);
  assert.throws(() => resolveTarget({ platform: "linux", arch: "riscv64" }), /HALFSIZE_FFMPEG/);
});

test("every platform we accept has a published checksum for both binaries", () => {
  const combos = [
    ["darwin", "x64"],
    ["darwin", "arm64"],
    ["linux", "x64"],
    ["linux", "ia32"],
    ["linux", "arm64"],
    ["linux", "arm"],
    ["win32", "x64"],
  ];
  for (const [platform, arch] of combos) {
    const target = resolveTarget({ platform, arch });
    for (const name of ["ffmpeg", "ffprobe"]) {
      const digest = sha256For(name, target);
      assert.match(digest, /^[0-9a-f]{64}$/, `${name} ${platform} ${arch} has no checksum`);
    }
  }
});

test("asset names match the ffmpeg-static release layout", () => {
  const target = resolveTarget({ platform: "darwin", arch: "arm64" });
  assert.equal(assetFile("ffmpeg", target), "ffmpeg-darwin-arm64.gz");
  assert.equal(assetFile("ffprobe", target), "ffprobe-darwin-arm64.gz");
});

test("downloadUrls tries GitHub first, then the mainland mirror", () => {
  const target = resolveTarget({ platform: "linux", arch: "x64" });
  const urls = downloadUrls("ffmpeg", target, {});
  assert.deepEqual(urls, [
    `${OFFICIAL_BASE}/${RELEASE}/ffmpeg-linux-x64.gz`,
    `${MIRROR_BASE}/${RELEASE}/ffmpeg-linux-x64.gz`,
  ]);
});

test("an explicit mirror is tried before the defaults, without duplicates", () => {
  const target = resolveTarget({ platform: "win32", arch: "x64" });
  const mirror = "https://example.test/ffmpeg-static/";
  const urls = downloadUrls("ffmpeg", target, { FFMPEG_BINARIES_URL: mirror });
  assert.equal(urls[0], `https://example.test/ffmpeg-static/${RELEASE}/ffmpeg-win32-x64.gz`);
  assert.equal(urls.filter((u) => u.includes(OFFICIAL_BASE)).length, 1);
  assert.equal(urls.filter((u) => u.includes(MIRROR_BASE)).length, 1);
});

test("setting both env overrides the same URL does not download it twice", () => {
  const target = resolveTarget({ platform: "linux", arch: "x64" });
  const urls = downloadUrls("ffprobe", target, {
    HALFSIZE_BINARIES_URL: OFFICIAL_BASE,
    FFMPEG_BINARIES_URL: `${OFFICIAL_BASE}/`,
  });
  assert.equal(urls.length, 2);
  assert.equal(urls.filter((u) => u.startsWith(OFFICIAL_BASE)).length, 1);
});

test("binaryName keeps the .exe suffix on Windows only", () => {
  assert.equal(binaryName("ffmpeg", "win32"), "ffmpeg.exe");
  assert.equal(binaryName("ffprobe", "win32"), "ffprobe.exe");
  assert.equal(binaryName("ffmpeg", "darwin"), "ffmpeg");
  assert.equal(binaryName("ffmpeg", "linux"), "ffmpeg");
});

test("installBinary unpacks a verified download and leaves no temp files", async () => {
  const dir = tempDir();
  const archive = gz("#!/bin/sh\necho ffmpeg\n");
  const target = resolveTarget({ platform: process.platform, arch: process.arch });

  const result = await installBinary({
    name: "ffmpeg",
    target,
    dir,
    urls: ["https://example.test/ffmpeg.gz"],
    digest: sha256(archive),
    fetchImpl: async () => new Response(archive, { status: 200, headers: { "content-length": String(archive.length) } }),
    verify: () => true,
  });

  assert.equal(result.path, path.join(dir, binaryName("ffmpeg", process.platform)));
  assert.equal(fs.readFileSync(result.path, "utf8"), "#!/bin/sh\necho ffmpeg\n");
  assert.deepEqual(fs.readdirSync(dir), [path.basename(result.path)]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("installBinary rejects a body that does not match the published checksum", async () => {
  const dir = tempDir();
  const archive = gz("not the real thing");
  const target = resolveTarget({ platform: process.platform, arch: process.arch });

  await assert.rejects(
    () =>
      installBinary({
        name: "ffmpeg",
        target,
        dir,
        urls: ["https://example.test/ffmpeg.gz"],
        digest: sha256(gz("something else")),
        fetchImpl: async () => new Response(archive, { status: 200 }),
        verify: () => true,
      }),
    /checksum mismatch/,
  );
  // Nothing may be left behind, so a failed --fix cannot break a working install.
  assert.deepEqual(fs.readdirSync(dir), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("installBinary falls back to the next mirror after an HTTP error", async () => {
  const dir = tempDir();
  const archive = gz("mirror copy");
  const target = resolveTarget({ platform: process.platform, arch: process.arch });
  const seen = [];

  const result = await installBinary({
    name: "ffprobe",
    target,
    dir,
    urls: ["https://blocked.test/ffprobe.gz", "https://mirror.test/ffprobe.gz"],
    digest: sha256(archive),
    fetchImpl: async (url) => {
      seen.push(url);
      if (url.includes("blocked")) return new Response("nope", { status: 403 });
      return new Response(archive, { status: 200 });
    },
    verify: () => true,
  });

  assert.deepEqual(seen, ["https://blocked.test/ffprobe.gz", "https://mirror.test/ffprobe.gz"]);
  assert.equal(result.url, "https://mirror.test/ffprobe.gz");
  assert.equal(fs.readFileSync(result.path, "utf8"), "mirror copy");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("installBinary reports every URL it tried when all of them fail", async () => {
  const dir = tempDir();
  const target = resolveTarget({ platform: process.platform, arch: process.arch });

  await assert.rejects(
    () =>
      installBinary({
        name: "ffmpeg",
        target,
        dir,
        urls: ["https://a.test/ffmpeg.gz", "https://b.test/ffmpeg.gz"],
        digest: "0".repeat(64),
        fetchImpl: async () => new Response("", { status: 404 }),
        verify: () => true,
      }),
    (err) => /a\.test/.test(err.message) && /b\.test/.test(err.message) && /HTTP 404/.test(err.message),
  );
  assert.deepEqual(fs.readdirSync(dir), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("installBinary refuses to unpack anything it cannot verify", async () => {
  const dir = tempDir();
  const target = resolveTarget({ platform: process.platform, arch: process.arch });
  await assert.rejects(
    () =>
      installBinary({
        name: "ffmpeg",
        target,
        dir,
        urls: ["https://example.test/ffmpeg.gz"],
        digest: "",
        fetchImpl: async () => new Response("", { status: 200 }),
      }),
    /checksum/,
  );
  fs.rmSync(dir, { recursive: true, force: true });
});
