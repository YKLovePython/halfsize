import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveBinaries } from "../src/ffmpeg.mjs";
import { probe } from "../src/probe.mjs";
import { planEncode } from "../src/plan.mjs";
import { encode } from "../src/encode.mjs";
import { measureQuality } from "../src/quality.mjs";

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "halfsize-test-"));
const BIN = fileURLToPath(new URL("../bin/halfsize.mjs", import.meta.url));

test.after(() => {
  fs.rmSync(WORK, { recursive: true, force: true });
});

test("end to end: generate, probe, compress to size, verify quality", async (t) => {
  const { ffmpeg } = await resolveBinaries();

  const source = path.join(WORK, "source.mp4");
  try {
    execFileSync(
      ffmpeg,
      [
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=24",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
        "-t", "2",
        "-c:v", "libx264", "-preset", "veryfast", "-b:v", "2M", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "96k",
        source,
      ],
      { windowsHide: true, stdio: "ignore" },
    );
  } catch {
    t.skip("ffmpeg cannot generate test clips here");
    return;
  }

  const info = await probe(source);
  assert.ok(Math.abs(info.duration - 2) < 0.2, `duration was ${info.duration}`);
  assert.equal(info.video.width, 320);
  assert.equal(info.video.height, 240);
  assert.ok(info.audio, "audio stream was detected");

  const targetBytes = 180_000;
  const plan = planEncode(info, { targetBytes });
  const output = path.join(WORK, "out.mp4");
  const result = await encode(source, output, plan, info);

  assert.ok(fs.existsSync(output));
  assert.ok(result.outputBytes > 0);
  assert.ok(
    result.outputBytes <= targetBytes * 1.08,
    `output ${result.outputBytes} overshot target ${targetBytes}`,
  );

  const quality = await measureQuality(source, output, info.duration, { samples: 1, seconds: 1 });
  assert.equal(typeof quality.ssim, "number");
  assert.ok(quality.ssim > 0.8, `SSIM was ${quality.ssim}`);

  const outInfo = await probe(output);
  assert.ok(outInfo.sizeBytes <= targetBytes * 1.08);
  assert.equal(outInfo.video.width, plan.width);
  assert.equal(outInfo.video.height, plan.height);
});

test("end to end: --no-audio produces a silent file and mono stays mono", async (t) => {
  const { ffmpeg } = await resolveBinaries();
  const source = path.join(WORK, "mono.mp4");
  try {
    execFileSync(
      ffmpeg,
      [
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=24",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
        "-t", "2",
        "-c:v", "libx264", "-preset", "veryfast", "-b:v", "2M", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "96k", "-ac", "1",
        source,
      ],
      { windowsHide: true, stdio: "ignore" },
    );
  } catch {
    t.skip("ffmpeg cannot generate test clips here");
    return;
  }

  const info = await probe(source);
  assert.equal(info.audio.channels, 1);

  const muted = path.join(WORK, "muted.mp4");
  const mutePlan = planEncode(info, { targetBytes: 180_000, audio: false });
  await encode(source, muted, mutePlan, info);
  const mutedInfo = await probe(muted).catch(() => null);
  assert.equal(mutedInfo?.audio, null, "no audio stream should be written");

  const mono = path.join(WORK, "mono-out.mp4");
  const monoPlan = planEncode(info, { targetBytes: 180_000 });
  await encode(source, mono, monoPlan, info);
  const monoInfo = await probe(mono);
  assert.equal(monoInfo.audio.channels, 1, "mono input must not be upmixed to stereo");
});

test("end to end: a Matroska source still lands on target", async (t) => {
  const { ffmpeg } = await resolveBinaries();
  const source = path.join(WORK, "source-mkv.mp4");
  try {
    execFileSync(
      ffmpeg,
      [
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=24",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
        "-t", "2.5",
        "-c:v", "libx264", "-preset", "veryfast", "-b:v", "2M", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "96k",
        source,
      ],
      { windowsHide: true, stdio: "ignore" },
    );
  } catch {
    t.skip("ffmpeg cannot generate test clips here");
    return;
  }

  const mkv = path.join(WORK, "source.mkv");
  execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-i", source, "-c", "copy", mkv], {
    windowsHide: true,
    stdio: "ignore",
  });

  const info = await probe(mkv);
  const targetBytes = 200_000;
  const plan = planEncode(info, { targetBytes });
  const output = path.join(WORK, "out-from-mkv.mp4");
  const result = await encode(mkv, output, plan, info);

  assert.ok(
    result.outputBytes <= targetBytes * 1.08,
    `Matroska input overshot: ${result.outputBytes} vs target ${targetBytes}`,
  );
});

test("batch: several files in one command, one JSON document", async (t) => {
  const { ffmpeg } = await resolveBinaries();
  const files = [];
  for (const name of ["batch-a", "batch-b"]) {
    const file = path.join(WORK, `${name}.mp4`);
    try {
      execFileSync(
        ffmpeg,
        [
          "-hide_banner", "-loglevel", "error", "-y",
          "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=24",
          "-t", "1.5",
          "-c:v", "libx264", "-preset", "veryfast", "-b:v", "2M", "-pix_fmt", "yuv420p",
          file,
        ],
        { windowsHide: true, stdio: "ignore" },
      );
    } catch {
      t.skip("ffmpeg cannot generate test clips here");
      return;
    }
    files.push(file);
  }

  const targetBytes = 150_000;
  const stdout = execFileSync(
    process.execPath,
    [BIN, ...files, "--to", "150kb", "--json", "--no-verify"],
    { encoding: "utf8", windowsHide: true },
  );
  const parsed = JSON.parse(stdout);
  assert.ok(Array.isArray(parsed.files), "batch JSON should wrap results in files[]");
  assert.equal(parsed.files.length, 2);
  for (const result of parsed.files) {
    assert.ok(result.output, "every file should produce an output");
    assert.ok(fs.existsSync(result.output.file));
    assert.ok(result.output.bytes <= targetBytes * 1.08, `${result.output.bytes} overshot`);
  }
});
