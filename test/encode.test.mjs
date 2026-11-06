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

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "halfsize-encode-"));
test.after(() => fs.rmSync(WORK, { recursive: true, force: true }));

async function source(name, seconds = 2, size = "320x240") {
  const { ffmpeg } = await resolveBinaries();
  const file = path.join(WORK, name);
  execFileSync(
    ffmpeg,
    [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", `testsrc2=size=${size}:rate=30`,
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
      "-t", String(seconds),
      "-c:v", "libx264", "-preset", "ultrafast", "-b:v", "4M", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "96k",
      file,
    ],
    { windowsHide: true, stdio: "ignore" },
  );
  return file;
}

function partFiles(dir) {
  return fs.readdirSync(dir).filter((name) => name.includes(".part-"));
}

test("a failed encode leaves neither the output nor a partial file", async (t) => {
  const dir = path.join(WORK, "fail");
  fs.mkdirSync(dir, { recursive: true });
  let input;
  try {
    input = await source("fail.mp4");
  } catch {
    t.skip("ffmpeg cannot generate test clips here");
    return;
  }

  const info = await probe(input);
  const plan = { ...planEncode(info, { targetBytes: 150_000 }), encoder: "libx264_does_not_exist" };
  const output = path.join(dir, "out.mp4");

  await assert.rejects(encode(input, output, plan, info));

  assert.equal(fs.existsSync(output), false, "a failed run must not leave a file at the destination");
  assert.deepEqual(partFiles(dir), [], "a failed run must not leave a .part file behind");
});

test("an aborted encode leaves nothing behind", async (t) => {
  const dir = path.join(WORK, "abort");
  fs.mkdirSync(dir, { recursive: true });
  let input;
  try {
    input = await source("abort.mp4", 8, "1280x720");
  } catch {
    t.skip("ffmpeg cannot generate test clips here");
    return;
  }

  const info = await probe(input);
  const plan = { ...planEncode(info, { targetBytes: 900_000 }), preset: "veryslow" };
  const output = path.join(dir, "out.mp4");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 250);

  try {
    await assert.rejects(
      encode(input, output, plan, info, () => {}, { signal: controller.signal }),
      (err) => err.code === "HALFSIZE_CANCELLED",
    );
  } finally {
    clearTimeout(timer);
  }

  assert.equal(fs.existsSync(output), false, "a cancelled run must not leave a file at the destination");
  assert.deepEqual(partFiles(dir), [], "a cancelled run must not leave a .part file behind");
});

test("an already-aborted encode never starts ffmpeg", async (t) => {
  let input;
  try {
    input = await source("pre-aborted.mp4");
  } catch {
    t.skip("ffmpeg cannot generate test clips here");
    return;
  }
  const info = await probe(input);
  const plan = planEncode(info, { targetBytes: 150_000 });
  const controller = new AbortController();
  controller.abort();

  const output = path.join(WORK, "pre-aborted-out.mp4");
  await assert.rejects(
    encode(input, output, plan, info, () => {}, { signal: controller.signal }),
    (err) => err.code === "HALFSIZE_CANCELLED",
  );
  assert.equal(fs.existsSync(output), false);
});
