// Builds a self-contained halfsize.exe for Windows: the whole CLI, the web page
// and a Node runtime in one file, no installer and no npm.
//
// Why a single executable: winget rejects script-based installers and npm
// packages, and the audience that needs "compress this to 20 MB" is mostly on
// Windows without Node. A ZIP containing one .exe satisfies winget's
// NestedInstallerType: portable.
//
// Node's single-executable applications need a single CommonJS script, so
// esbuild bundles bin/... first and postject injects the blob into a copy of the
// running node.exe. The blob and the executable must come from the same Node
// build, which is why this must run on the platform it targets.

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BUILD = path.join(ROOT, "build");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const GITHUB_REPO = "YKLovePython/halfsize";

const SENTINEL = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

function step(message) {
  console.log(`\n== ${message}`);
}

function run(file, args, options = {}) {
  return execFileSync(file, args, { stdio: "inherit", cwd: ROOT, ...options });
}

// A package is more than the executable: winget installs a directory, and a
// first-time user who unzips one .exe has no idea whether they also need FFmpeg.
function readmeText() {
  return `halfsize ${pkg.version} - compress a video to an exact size, keep the quality
=========================================================================

No installer, no Node, no account. Unzip this folder and run halfsize.exe.

QUICK START
  halfsize video.mp4 --to 20mb          fit Discord / WeChat / email
  halfsize video.mp4 --for whatsapp     use a platform's upload limit
  halfsize --web                        open the local web app
  halfsize --doctor                     check FFmpeg and hardware encoders
  halfsize --help                       everything else

The "full" build in this folder already includes ffmpeg.exe and ffprobe.exe.
If you downloaded the small build, run this once:

  halfsize --fix

Windows will warn that the executable is unsigned. That is true: code signing
certificates cost money and this project is free. The source is public at
https://github.com/YKLovePython/halfsize

LICENSES
  halfsize is MIT (see LICENSE).
  The bundled ffmpeg.exe / ffprobe.exe are GPL builds from gyan.dev, invoked as
  separate programs. Source and build scripts: https://www.gyan.dev/ffmpeg/builds/
`;
}

// A ZIP is what winget wants; Windows has no zip command, PowerShell does.
function zip(dir, destination) {
  if (process.platform === "win32") {
    run("powershell", [
      "-NoProfile",
      "-Command",
      `Compress-Archive -Path '${path.join(dir, "*")}' -DestinationPath '${destination}' -Force`,
    ]);
    return;
  }
  run("zip", ["-j", "-q", "-r", destination, dir]);
}

async function main() {
  if (process.platform !== "win32") {
    throw new Error("This script produces a Windows executable; run it on Windows (or a Windows CI runner).");
  }
  const arch = process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : process.arch;
  if (arch !== "x64") {
    throw new Error(`Only win32-x64 is produced today, not ${arch}.`);
  }

  fs.rmSync(BUILD, { recursive: true, force: true });
  fs.mkdirSync(BUILD, { recursive: true });

  step(`bundle ${pkg.version} (node ${process.version})`);
  await esbuild.build({
    entryPoints: [path.join(ROOT, "scripts", "exe-entry.mjs")],
    outfile: path.join(BUILD, "halfsize.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    // package.json is not on disk inside the blob, so the version is baked in.
    define: { __HALFSIZE_VERSION__: JSON.stringify(pkg.version) },
    // web/index.html rides along as a string (see src/embedded.mjs).
    loader: { ".html": "text" },
    // These cannot exist inside an exe: leave them unresolved so the lookup fails
    // and falls through to --fix, instead of esbuild trying to embed 150 MB of
    // binaries that are not even installed here.
    external: ["ffmpeg-static", "ffprobe-static"],
    legalComments: "none",
    // Every import.meta.url in src/ sits behind an IS_SEA check or a try/catch
    // that falls back to process.execPath (see src/self.mjs). esbuild cannot see
    // that, so it warns about each one; the warning is expected here.
    logOverride: { "empty-import-meta": "silent" },
    logLevel: "warning",
  });
  console.log(`   halfsize.cjs  ${(fs.statSync(path.join(BUILD, "halfsize.cjs")).size / 1024).toFixed(0)} KB`);

  step("prepare the SEA blob");
  const seaConfig = {
    main: path.join(BUILD, "halfsize.cjs"),
    output: path.join(BUILD, "sea.blob"),
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    // import() does not work when useCodeCache is on, and server.mjs loads the page
    // through a dynamic import in executable mode.
    useCodeCache: false,
  };
  const configFile = path.join(BUILD, "sea-config.json");
  fs.writeFileSync(configFile, JSON.stringify(seaConfig, null, 2));
  run(process.execPath, ["--experimental-sea-config", configFile]);
  console.log(`   sea.blob      ${(fs.statSync(seaConfig.output).size / 1024).toFixed(0)} KB`);

  step("copy node.exe and inject");
  const exe = path.join(BUILD, "halfsize.exe");
  fs.copyFileSync(process.execPath, exe);
  const postject = path.join(ROOT, "node_modules", "postject", "dist", "cli.js");
  if (!fs.existsSync(postject)) throw new Error(`postject is not installed at ${postject}`);
  run(process.execPath, [postject, exe, "NODE_SEA_BLOB", seaConfig.output, "--sentinel-fuse", SENTINEL]);

  step("smoke test the executable");
  const version = execFileSync(exe, ["--version"], { encoding: "utf8" }).trim();
  if (version !== pkg.version) throw new Error(`the exe reports ${version}, package.json says ${pkg.version}`);
  console.log(`   --version -> ${version}`);
  const help = execFileSync(exe, ["--help"], { encoding: "utf8" });
  if (!help.includes("halfsize")) throw new Error("--help printed nothing useful");
  console.log("   --help    -> ok");

  step("stage a folder that unzips into a working install");
  const stage = path.join(BUILD, "halfsize");
  fs.mkdirSync(stage, { recursive: true });
  fs.copyFileSync(exe, path.join(stage, "halfsize.exe"));
  fs.copyFileSync(path.join(ROOT, "LICENSE"), path.join(stage, "LICENSE"));
  fs.writeFileSync(path.join(stage, "README.txt"), readmeText());

  const liteZip = path.join(BUILD, `halfsize-${pkg.version}-win-x64.zip`);
  zip(stage, liteZip);

  // The full build is what winget installs: a user who has never heard of FFmpeg
  // should not meet a download prompt on first run. ~150 MB unpacked, so it is a
  // separate artifact rather than the only option.
  const ffmpegSrc = path.join(ROOT, "node_modules", "ffmpeg-static", "ffmpeg.exe");
  const ffprobeSrc = path.join(ROOT, "node_modules", "ffprobe-static", "bin", "win32", "x64", "ffprobe.exe");
  let fullZip = "";
  if (fs.existsSync(ffmpegSrc) && fs.existsSync(ffprobeSrc)) {
    step("add FFmpeg to the full build");
    fs.copyFileSync(ffmpegSrc, path.join(stage, "ffmpeg.exe"));
    fs.copyFileSync(ffprobeSrc, path.join(stage, "ffprobe.exe"));
    fullZip = path.join(BUILD, `halfsize-${pkg.version}-win-x64-full.zip`);
    zip(stage, fullZip);
  } else {
    console.log("   ffmpeg-static / ffprobe-static are not installed: skipping the full build");
  }

  const sha = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const artifact = (file) => ({
    name: path.basename(file),
    sha256: sha(file),
    bytes: fs.statSync(file).size,
  });

  const artifacts = [artifact(liteZip)];
  if (fullZip) artifacts.push(artifact(fullZip));

  console.log("");
  for (const item of artifacts) {
    console.log(`   ${item.name}`);
    console.log(`     ${(item.bytes / 1024 / 1024).toFixed(1)} MB   sha256 ${item.sha256}`);
    console.log(`     https://github.com/${GITHUB_REPO}/releases/download/v${pkg.version}/${item.name}`);
  }
  console.log(`   exe ${(fs.statSync(exe).size / 1024 / 1024).toFixed(1)} MB (uncompressed)`);

  // Consumed by the winget manifest step and by the release workflow.
  fs.writeFileSync(
    path.join(BUILD, "artifact.json"),
    JSON.stringify({ version: pkg.version, arch, exeBytes: fs.statSync(exe).size, artifacts }, null, 2),
  );
}

main().catch((err) => {
  console.error(`\n  x ${err?.message || err}`);
  if (process.env.HALFSIZE_DEBUG) console.error(err?.stack);
  process.exitCode = 1;
});