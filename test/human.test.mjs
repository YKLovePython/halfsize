import test from "node:test";
import assert from "node:assert/strict";
import { bytes, duration, bitrate, ratio, parseSize, clock } from "../src/human.mjs";

test("parseSize reads every unit people actually type", () => {
  assert.equal(parseSize("25mb"), 25_000_000);
  assert.equal(parseSize("25 MB"), 25_000_000);
  assert.equal(parseSize("700k"), 700_000);
  assert.equal(parseSize("1.5gb"), 1_500_000_000);
  assert.equal(parseSize("512b"), 512);
  assert.equal(parseSize("2"), 2_000_000);
  assert.equal(parseSize(1234), 1234);
});

test("parseSize rejects nonsense instead of guessing", () => {
  assert.throws(() => parseSize("abc"), /Cannot read size/);
  assert.throws(() => parseSize("12 tb"), /Cannot read size/);
});

test("bytes switches units and keeps useful precision", () => {
  assert.equal(bytes(999), "999 B");
  assert.equal(bytes(1_000), "1.00 KB");
  assert.equal(bytes(23_200_000), "23.2 MB");
  assert.equal(bytes(1_500_000_000), "1.50 GB");
  assert.equal(bytes(null), "-");
});

test("duration is human, not seconds", () => {
  assert.equal(duration(8), "8s");
  assert.equal(duration(75), "1m 15s");
  assert.equal(duration(3725), "1h 02m");
  assert.equal(duration(0), "-");
});

test("bitrate and ratio pick readable forms", () => {
  assert.equal(bitrate(900), "900 kbps");
  assert.equal(bitrate(1810), "1.81 Mbps");
  assert.equal(ratio(23.2, 1.99), "12x");
  assert.equal(ratio(10, 8), "1.3x");
});

test("clock pads minutes and seconds", () => {
  assert.equal(clock(0), "00:00");
  assert.equal(clock(65), "01:05");
  assert.equal(clock(-3), "00:00");
});
