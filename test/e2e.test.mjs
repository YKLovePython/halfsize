import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { resolveBinaries } from "../src/ffmpeg.mjs";
import { probe } from "../src/probe.mjs";
import { planEncode } from "../src/plan.mjs";
import { encode } from "../src/encode.mjs";
import { measureQuality } from "../src/quality.mjs";

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "halfsize-test-"));

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
