import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../bin/halfsize.mjs", import.meta.url));

function run(args) {
  return execFileSync(process.execPath, [BIN, ...args], { encoding: "utf8" });
}

test("--version prints a version and nothing else", () => {
  const out = run(["--version"]).trim();
  assert.match(out, /^\d+\.\d+\.\d+$/);
});

test("-v is the same as --version", () => {
  assert.equal(run(["-v"]).trim(), run(["--version"]).trim());
});

test("no arguments prints help, which documents the main flags", () => {
  const out = run([]);
  assert.match(out, /Usage/);
  assert.match(out, /--to <size>/);
  assert.match(out, /--web/);
});

test("--help wins over a missing file", () => {
  const out = run(["--help"]);
  assert.match(out, /--doctor/);
});

test("an unknown flag fails with a readable message", () => {
  assert.throws(
    () => run(["--nope"]),
    (err) => err.status === 1 && /Unknown option --nope/.test(err.stderr),
  );
});

test("--for rejects an unknown platform and lists the choices", () => {
  assert.throws(
    () => run(["video.mp4", "--for", "myspace"]),
    (err) => err.status === 1 && /Unknown platform/.test(err.stderr) && /discord/.test(err.stderr),
  );
});

test("--to and --for cannot be combined", () => {
  assert.throws(
    () => run(["video.mp4", "--to", "10mb", "--for", "discord"]),
    (err) => err.status === 1 && /not both/.test(err.stderr),
  );
});

test("--out is rejected for a batch", () => {
  assert.throws(
    () => run(["a.mp4", "b.mp4", "--to", "10mb", "--out", "x.mp4"]),
    (err) => err.status === 1 && /only works with one input file/.test(err.stderr),
  );
});

test("help documents --for and --no-audio", () => {
  const out = run(["--help"]);
  assert.match(out, /--for <app>/);
  assert.match(out, /--no-audio/);
});
