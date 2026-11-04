import test from "node:test";
import assert from "node:assert/strict";
import { planEncode, estimateBytes } from "../src/plan.mjs";

function info(overrides = {}) {
  return {
    duration: 60,
    sizeBytes: 100_000_000,
    audio: { bitrate: 128_000 },
    video: { width: 1920, height: 1080, fps: 30 },
    ...overrides,
  };
}

const target = (mb) => mb * 1_000_000;

test("a 25 MB target on a 100 MB clip downscales instead of over-compressing", () => {
  const plan = planEncode(info(), { targetBytes: target(25) });
  assert.equal(plan.mode, "size");
  assert.equal(plan.codec, "h264");
  assert.equal(plan.twoPass, true);
  assert.equal(plan.width, 1280);
  assert.equal(plan.height, 720);
  assert.equal(plan.downscaled, true);
  assert.equal(plan.scaleFilter, "scale=1280:720:flags=lanczos");
  assert.ok(plan.videoKbps > 3000);
  assert.equal(plan.audioKbps, 128);
});

test("H.265 keeps more resolution at the same target", () => {
  const h264 = planEncode(info(), { targetBytes: target(25), codec: "h264" });
  const h265 = planEncode(info(), { targetBytes: target(25), codec: "h265" });
  assert.equal(h265.label, "H.265");
  assert.ok(h265.width > h264.width, `${h265.width} should be wider than ${h264.width}`);
  assert.equal(h265.width, 1920);
  assert.equal(h265.height, 1080);
});

test("a generous target keeps the original resolution", () => {
  const plan = planEncode(info(), { targetBytes: target(200) });
  assert.equal(plan.width, 1920);
  assert.equal(plan.height, 1080);
  assert.equal(plan.downscaled, false);
  assert.equal(plan.scaleFilter, null);
  assert.deepEqual(plan.warnings, []);
});

test("a tiny target is allowed but warned about", () => {
  const plan = planEncode(info({ duration: 600 }), { targetBytes: target(5) });
  assert.ok(plan.width <= 640);
  assert.ok(plan.warnings.some((w) => /Very low bitrate/.test(w)));
});

test("--no-downscale is respected and explains the cost", () => {
  const plan = planEncode(info(), { targetBytes: target(5), downscale: false });
  assert.equal(plan.width, 1920);
  assert.equal(plan.height, 1080);
  assert.ok(plan.warnings.some((w) => /Downscaling is disabled/.test(w)));
});

test("CRF mode never invents a target or a second pass", () => {
  const plan = planEncode(info(), { crf: 23 });
  assert.equal(plan.mode, "quality");
  assert.equal(plan.crf, 23);
  assert.equal(plan.twoPass, false);
  assert.equal(plan.videoKbps, null);
  assert.equal(plan.width, 1920);
  assert.equal(plan.height, 1080);
});

test("portrait video is downscaled on the correct axis", () => {
  const plan = planEncode(info({ video: { width: 1080, height: 1920, fps: 30 } }), { targetBytes: target(25) });
  assert.ok(plan.height > plan.width, "portrait stays portrait");
  assert.equal(plan.width, 720);
  assert.equal(plan.height, 1280);
});

test("fps is capped at 60 and floored at 10", () => {
  const fast = planEncode(info({ video: { width: 1920, height: 1080, fps: 120 } }), { targetBytes: target(200) });
  assert.equal(fast.fps, 60);
  const slow = planEncode(info({ video: { width: 1920, height: 1080, fps: 1 } }), { targetBytes: target(200) });
  assert.equal(slow.fps, 10);
});

test("odd source sizes still produce even output", () => {
  const plan = planEncode(info({ video: { width: 1919, height: 1079, fps: 30 } }), { targetBytes: target(200) });
  assert.equal(plan.width % 2, 0);
  assert.equal(plan.height % 2, 0);
});

test("silent video spends the whole budget on pixels", () => {
  const plan = planEncode(info({ audio: null }), { targetBytes: target(25) });
  assert.equal(plan.audioKbps, 0);
  assert.ok(plan.videoKbps > 3000);
});

test("--no-audio drops the track and gives the bits to video", () => {
  const withAudio = planEncode(info(), { targetBytes: target(25) });
  const muted = planEncode(info(), { targetBytes: target(25), audio: false });
  assert.equal(muted.audioKbps, 0);
  assert.ok(muted.videoKbps > withAudio.videoKbps);
});

test("mono audio stays mono instead of being upmixed", () => {
  const plan = planEncode(info({ audio: { bitrate: 96_000, channels: 1 } }), { targetBytes: target(25) });
  assert.equal(plan.audioChannels, 1);
  const stereo = planEncode(info({ audio: { bitrate: 128_000, channels: 2 } }), { targetBytes: target(25) });
  assert.equal(stereo.audioChannels, 2);
});

test("invalid input fails loudly", () => {
  assert.throws(() => planEncode(info(), {}), /target size is required/);
  assert.throws(() => planEncode(info({ duration: 0 }), { targetBytes: target(25) }), /duration/);
  assert.throws(() => planEncode(info(), { targetBytes: target(25), codec: "av1" }), /Unknown codec/);
});

test("estimate lands just under the target", () => {
  const i = info();
  const plan = planEncode(i, { targetBytes: target(25) });
  const bytes = estimateBytes(i, plan);
  assert.ok(bytes < target(25));
  assert.ok(bytes > target(25) * 0.95);
});
