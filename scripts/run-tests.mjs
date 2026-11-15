// Runs every test file in its own process, one at a time, with a hard timeout.
//
// `node --test test/a.mjs test/b.mjs …` runs the files in parallel. That is faster on
// a laptop, but on a two-core CI runner several encodes compete for the same CPU and a
// single stalled ffmpeg is invisible: the job just sits there until the workflow timeout,
// with no indication of which file did it. Serialising costs about ten seconds here and
// buys a name for every hang.
//
// It also means adding a test file is just adding a file — no list to keep in sync.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TIMEOUT_MS = Number(process.env.HALFSIZE_TEST_TIMEOUT_MS || 300_000);

const files = fs
  .readdirSync(path.join(ROOT, "test"))
  .filter((name) => name.endsWith(".test.mjs"))
  .sort();

if (!files.length) {
  console.error("No test files found in test/.");
  process.exit(1);
}

const failures = [];
const started = Date.now();

for (const name of files) {
  const file = path.join(ROOT, "test", name);
  const t0 = Date.now();
  const result = spawnSync(process.execPath, ["--test", file], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: TIMEOUT_MS,
    windowsHide: true,
  });
  const ms = Date.now() - t0;

  if (result.error?.code === "ETIMEDOUT") {
    console.log(`\n${name}  TIMED OUT after ${Math.round(TIMEOUT_MS / 1000)}s`);
    console.log("    This is the file to look at: a test in it never finished.");
    failures.push(name);
    continue;
  }

  const out = `${result.stdout || ""}${result.stderr || ""}`.replace(/\u001b\[[0-9;]*m/g, "");
  // Node prints `# pass 12` on some versions and `ℹ pass 12` on others.
  const pass = Number((out.match(/^(?:#|ℹ)\s*pass (\d+)$/m) || [])[1] || 0);
  const fail = Number((out.match(/^(?:#|ℹ)\s*fail (\d+)$/m) || [])[1] || 0);

  if (result.status === 0 && fail === 0) {
    console.log(`${name.padEnd(24)} ${String(pass).padStart(3)} tests  ${(ms / 1000).toFixed(1)}s`);
    continue;
  }

  console.log(`\n${name}  ${fail} failed  ${(ms / 1000).toFixed(1)}s`);
  console.log(out.trimEnd());
  failures.push(name);
}

const total = ((Date.now() - started) / 1000).toFixed(1);
if (failures.length) {
  console.log(`\n${failures.length} file(s) failed in ${total}s: ${failures.join(", ")}`);
  process.exit(1);
}
console.log(`\nall ${files.length} test files passed in ${total}s`);
