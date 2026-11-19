// Runs every test file in its own process, one at a time, with a hard timeout.
//
// `node --test test/a.mjs test/b.mjs …` runs the files in parallel. That is faster on
// a laptop, but on a two-core CI runner several encodes compete for the same CPU and a
// single stalled ffmpeg is invisible: the job just sits there until the workflow timeout,
// with no indication of which file did it. Serialising costs about ten seconds here and
// buys a name for every hang.
//
// A timed-out file is retried once. On a shared runner an encode occasionally stalls for
// no reason that reproduces; without the retry that costs a red badge on a commit that did
// not change any code. A real hang fails both attempts, and the log says so ("after retry"),
// so the retry cannot hide one. Timeouts also kill the whole process tree: a spawned
// ffmpeg outlives its parent otherwise and starves the next file, turning one stall into two.
//
// It also means adding a test file is just adding a file — no list to keep in sync.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TIMEOUT_MS = Number(process.env.HALFSIZE_TEST_TIMEOUT_MS || 300_000);
const RETRIES = Number(process.env.HALFSIZE_TEST_RETRIES ?? 1);

const files = fs
  .readdirSync(path.join(ROOT, "test"))
  .filter((name) => name.endsWith(".test.mjs"))
  .sort();

if (!files.length) {
  console.error("No test files found in test/.");
  process.exit(1);
}

// Spawn rather than execFileSync so the pid is available: killing only the node process
// leaves the ffmpeg it started running, and that orphan then slows down every later file.
function runFile(file, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--test", file], {
      cwd: ROOT,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      // A new process group on POSIX is what makes kill(-pid) reach the grandchildren.
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const t0 = Date.now();

    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform === "win32") {
          spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
        } else {
          process.kill(-child.pid, "SIGKILL");
        }
      } catch {
        // Already gone, or the group is not ours; nothing left to do.
      }
    }, timeoutMs);

    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr, ms: Date.now() - t0, timedOut });
    });
  });
}

const failures = [];
const started = Date.now();

// The runner prints each finished test as it goes. A tail separates "one test is
// stuck" (partial list, no summary) from "everything passed but the process will
// not exit" (summary printed, event loop held open by some handle).
function printTail(result) {
  const tail = `${result.stdout}${result.stderr}`.replace(/\u001b\[[0-9;]*m/g, "").trimEnd();
  if (!tail) {
    console.log("    (the file produced no output at all)");
    return;
  }
  console.log("    --- last output before the kill ---");
  for (const line of tail.split("\n").slice(-25)) console.log(`    ${line}`);
}

for (const name of files) {
  const file = path.join(ROOT, "test", name);
  let result = await runFile(file, TIMEOUT_MS);
  let retried = false;

  if (result.timedOut && RETRIES > 0) {
    console.log(`\n${name}  TIMED OUT after ${Math.round(TIMEOUT_MS / 1000)}s, retrying once`);
    // Print the first attempt's output too: once it is retried, this is the only
    // record of where the stall happened, and the retry usually passes.
    printTail(result);
    for (let attempt = 0; attempt < RETRIES; attempt++) {
      result = await runFile(file, TIMEOUT_MS);
      retried = true;
      if (!result.timedOut) break;
    }
  }

  if (result.timedOut) {
    console.log(`\n${name}  TIMED OUT after ${Math.round(TIMEOUT_MS / 1000)}s${retried ? " (again, after retry)" : ""}`);
    console.log("    This is the file to look at: a test in it never finished.");
    printTail(result);
    failures.push(name);
    continue;
  }

  const out = `${result.stdout}${result.stderr}`.replace(/\u001b\[[0-9;]*m/g, "");
  // Node prints `# pass 12` on some versions and `ℹ pass 12` on others.
  const pass = Number((out.match(/^(?:#|ℹ)\s*pass (\d+)$/m) || [])[1] || 0);
  const fail = Number((out.match(/^(?:#|ℹ)\s*fail (\d+)$/m) || [])[1] || 0);

  if (result.status === 0 && fail === 0) {
    const note = retried ? "  (passed on retry)" : "";
    console.log(`${name.padEnd(24)} ${String(pass).padStart(3)} tests  ${(result.ms / 1000).toFixed(1)}s${note}`);
    continue;
  }

  console.log(`\n${name}  ${fail} failed  ${(result.ms / 1000).toFixed(1)}s`);
  console.log(out.trimEnd());
  failures.push(name);
}

const total = ((Date.now() - started) / 1000).toFixed(1);
if (failures.length) {
  console.log(`\n${failures.length} file(s) failed in ${total}s: ${failures.join(", ")}`);
  process.exit(1);
}
console.log(`\nall ${files.length} test files passed in ${total}s`);