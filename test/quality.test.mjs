import test from "node:test";
import assert from "node:assert/strict";
import { verdict } from "../src/quality.mjs";

test("VMAF is preferred when both metrics exist", () => {
  const v = verdict({ vmaf: 96, ssim: 0.9 });
  assert.equal(v.key, "indistinguishable");
  assert.equal(v.tone, "good");
});

test("VMAF thresholds map to human words", () => {
  assert.equal(verdict({ vmaf: 95, ssim: null }).key, "indistinguishable");
  assert.equal(verdict({ vmaf: 90, ssim: null }).key, "same");
  assert.equal(verdict({ vmaf: 80, ssim: null }).key, "slight");
  assert.equal(verdict({ vmaf: 70, ssim: null }).key, "visible");
  assert.equal(verdict({ vmaf: 42, ssim: null }).key, "degraded");
  assert.equal(verdict({ vmaf: 42, ssim: null }).tone, "bad");
});

test("SSIM is the fallback when VMAF is unavailable", () => {
  assert.equal(verdict({ vmaf: null, ssim: 0.99 }).key, "indistinguishable");
  assert.equal(verdict({ vmaf: null, ssim: 0.96 }).key, "same");
  assert.equal(verdict({ vmaf: null, ssim: 0.92 }).key, "slight");
  assert.equal(verdict({ vmaf: null, ssim: 0.7 }).key, "visible");
});

test("no metrics means no claim", () => {
  const v = verdict({ vmaf: null, ssim: null });
  assert.equal(v.key, "none");
  assert.equal(v.tone, "unknown");
});
