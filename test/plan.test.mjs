import test from "node:test";
import assert from "node:assert/strict";
import { planEncode, estimateBytes, tighterPlan } from "../src/plan.mjs";

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
  assert.ok(plan.warnings.some((w) => w.code === "low-bitrate"));
});

test("--no-downscale is respected and explains the cost", () => {
  const plan = planEncode(info(), { targetBytes: target(5), downscale: false });
  assert.equal(plan.width, 1920);
  assert.equal(plan.height, 1080);
  assert.ok(plan.warnings.some((w) => w.code === "no-downscale"));
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

test("fps is capped at 60 and never floored up", () => {
  const fast = planEncode(info({ video: { width: 1920, height: 1080, fps: 120 } }), { targetBytes: target(200) });
  assert.equal(fast.fps, 60);
  assert.ok(fast.warnings.some((w) => w.code === "fps-capped"));
  const slow = planEncode(info({ video: { width: 1920, height: 1080, fps: 5 } }), { targetBytes: target(200) });
  assert.equal(slow.fps, 5, "a 5 fps timelapse must not be duplicated up to 10 fps");
  assert.equal(slow.fpsFilter, null);
});

test("dropped audio, subtitle, and surround tracks are reported, not hidden", () => {
  const plan = planEncode(
    info({ audioTracks: 3, subtitleTracks: 2, audio: { bitrate: 384_000, channels: 6 } }),
    { targetBytes: target(25) },
  );
  const codes = plan.warnings.map((w) => w.code);
  assert.ok(codes.includes("audio-tracks"));
  assert.ok(codes.includes("subtitles"));
  assert.ok(codes.includes("downmix"));
  assert.equal(plan.warnings.find((w) => w.code === "audio-tracks").params.count, 3);
});

test("a plain stereo file with one audio track has no track warnings", () => {
  const plan = planEncode(info({ audioTracks: 1, subtitleTracks: 0 }), { targetBytes: target(25) });
  assert.equal(plan.warnings.some((w) => w.code === "audio-tracks"), false);
  assert.equal(plan.warnings.some((w) => w.code === "subtitles"), false);
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

test("HDR sources get a tone map and a reassuring warning, not a dead end", () => {
  const plan = planEncode(
    info({ video: { width: 1920, height: 1080, fps: 30, hdr: true, hdrTransfer: "hlg", colorTransfer: "arib-std-b67" } }),
    { targetBytes: target(25) },
  );
  assert.match(plan.toneMap, /tonemap=hable:desat=0/);
  assert.match(plan.toneMap, /tin=arib-std-b67/);
  assert.match(plan.toneMap, /npl=100/);
  const warning = plan.warnings.find((w) => w.code === "hdr");
  assert.ok(warning);
  assert.match(warning.message, /SDR/);
  assert.doesNotMatch(warning.message, /not implemented/);
});

test("PQ sources use the HDR10 nominal peak instead of the HLG one", () => {
  const plan = planEncode(
    info({ video: { width: 1920, height: 1080, fps: 30, hdr: true, hdrTransfer: "pq", colorTransfer: "smpte2084" } }),
    { targetBytes: target(25) },
  );
  assert.match(plan.toneMap, /npl=1000/);
});

test("a target below the bitrate floor is marked impossible before encoding", () => {
  const i = info({ duration: 60 });
  const plan = planEncode(i, { targetBytes: 100_000 });
  assert.equal(plan.infeasible, true);
  assert.ok(plan.minimumBytes >= 500_000, `floor was ${plan.minimumBytes}`);
  const warning = plan.warnings.find((w) => w.code === "infeasible");
  assert.ok(warning);
  assert.equal(warning.params.minimumBytes, plan.minimumBytes);

  const hour = planEncode(info({ duration: 3600 }), { targetBytes: target(20) });
  assert.equal(hour.infeasible, true);
  assert.ok(hour.minimumBytes > target(30), "a one-hour video cannot fit in 20 MB at the floor");
});

test("a normal target is not marked impossible", () => {
  const plan = planEncode(info(), { targetBytes: target(25) });
  assert.equal(plan.infeasible, false);
  assert.equal(plan.minimumBytes, null);
});

test("an overshoot produces a tighter bitrate, but never below the floor", () => {
  const i = info();
  const plan = planEncode(i, { targetBytes: target(25) });
  const tighter = tighterPlan(plan, i, target(26), target(25));
  assert.ok(tighter);
  assert.ok(tighter.videoKbps < plan.videoKbps);
  assert.ok(tighter.videoKbps >= 40);

  const floor = { ...plan, videoKbps: 40 };
  assert.equal(tighterPlan(floor, i, target(25.5), target(25)), null);
  assert.equal(tighterPlan(plan, i, target(24), target(25)), null);
});
