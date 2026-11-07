import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { startServer } from "../src/server.mjs";
import { resolveBinaries } from "../src/ffmpeg.mjs";

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "halfsize-server-"));
test.after(() => fs.rmSync(WORK, { recursive: true, force: true }));

async function withServer(fn) {
  const { url, close } = await startServer({ port: 0 });
  try {
    return await fn(url);
  } finally {
    await close();
  }
}

let clipPromise = null;
function clip() {
  clipPromise ??= (async () => {
    const { ffmpeg } = await resolveBinaries();
    const file = path.join(WORK, "clip.mp4");
    execFileSync(
      ffmpeg,
      [
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30",
        "-t", "2",
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "12", "-pix_fmt", "yuv420p",
        file,
      ],
      { windowsHide: true, stdio: "ignore" },
    );
    return file;
  })();
  return clipPromise;
}

function upload(base, name, body) {
  return fetch(`${base}/api/upload`, {
    method: "POST",
    headers: { "x-filename": encodeURIComponent(name) },
    body,
  });
}

async function waitForDone(base, id, timeout = 120000) {
  const res = await fetch(`${base}/api/events/${id}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeout;
  let seen = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    seen += decoder.decode(value, { stream: true });
    if (seen.includes("event: done")) {
      await reader.cancel();
      return "done";
    }
    if (seen.includes("event: failed")) {
      await reader.cancel();
      return "failed";
    }
    if (Date.now() > deadline) {
      await reader.cancel();
      return "timeout";
    }
  }
  return "closed";
}

test("a text file is refused instead of treated as a video", () =>
  withServer(async (base) => {
    const res = await upload(base, "notes.txt", "this is not a video\n");
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, "not_video");
    assert.doesNotMatch(body.error, /C:\\|ffprobe\.exe|Command failed/);
  }));

test("an empty upload is refused with a readable message", () =>
  withServer(async (base) => {
    const res = await upload(base, "empty.mp4", "");
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, "empty");
  }));

test("malformed JSON is a 400, not a 500", () =>
  withServer(async (base) => {
    for (const route of ["/api/compress", "/api/cancel"]) {
      const res = await fetch(`${base}${route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      });
      assert.equal(res.status, 400, route);
      assert.match((await res.json()).error, /reload the page/i);
    }
  }));

test("a target below the duration floor is refused before encoding", () =>
  withServer(async (base) => {
    const file = await clip();
    const res = await upload(base, "floor.mp4", fs.readFileSync(file));
    const job = await res.json();

    const start = await fetch(`${base}/api/compress`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: job.id, target: "1k" }),
    });
    assert.equal(start.status, 400);
    const body = await start.json();
    assert.equal(body.code, "infeasible");
    assert.ok(body.minimumBytes > 1000, `minimumBytes was ${body.minimumBytes}`);
    assert.match(body.error, /below|minimum|lowest/i);
  }));

test("a path in the uploaded name never reaches the download header", () =>
  withServer(async (base) => {
    const file = await clip();
    const res = await upload(base, "../../evil.mp4", fs.readFileSync(file));
    assert.equal(res.status, 200);
    const job = await res.json();
    assert.equal(job.name, "evil.mp4", "the stored name must be a bare file name");

    const start = await fetch(`${base}/api/compress`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: job.id, target: "50k", codec: "h264", preset: "ultrafast" }),
    });
    assert.equal(start.status, 202);
    assert.equal(await waitForDone(base, job.id), "done");

    const download = await fetch(`${base}/api/download/${job.id}`);
    assert.equal(download.status, 200);
    const disposition = download.headers.get("content-disposition") || "";
    assert.ok(!disposition.includes(".."), disposition);
    assert.ok(disposition.includes('filename="evil.halfsize.mp4"'), disposition);
    await download.body?.cancel();
  }));

test("old uploads are pruned instead of growing the temp directory forever", () =>
  withServer(async (base) => {
    const file = await clip();
    const body = fs.readFileSync(file);
    const ids = [];
    for (let i = 0; i < 12; i++) {
      const res = await upload(base, `prune-${i}.mp4`, body);
      assert.equal(res.status, 200, `upload ${i}`);
      ids.push((await res.json()).id);
    }

    const oldest = await fetch(`${base}/api/media/${ids[0]}/in`);
    assert.equal(oldest.status, 404, "the oldest upload should be gone");
    await oldest.body?.cancel();

    const newest = await fetch(`${base}/api/media/${ids.at(-1)}/in`, { headers: { Range: "bytes=0-0" } });
    assert.equal(newest.status, 206, "the newest upload must still play");
    await newest.body?.cancel();
  }));

test("impossible byte ranges return 416 instead of a broken stream", () =>
  withServer(async (base) => {
    const file = await clip();
    const res = await upload(base, "clip.mp4", fs.readFileSync(file));
    const job = await res.json();

    const partial = await fetch(`${base}/api/media/${job.id}/in`, { headers: { Range: "bytes=0-0" } });
    assert.equal(partial.status, 206);
    assert.equal(partial.headers.get("content-range"), `bytes 0-0/${job.size}`);
    await partial.body?.cancel();

    const open = await fetch(`${base}/api/media/${job.id}/in`, { headers: { Range: "bytes=0-" } });
    assert.equal(open.status, 206);
    assert.equal(open.headers.get("content-length"), String(job.size));
    await open.body?.cancel();

    for (const range of ["bytes=999999999-", "bytes=50-10", "bytes=abc", "bytes=-0"]) {
      const bad = await fetch(`${base}/api/media/${job.id}/in`, { headers: { Range: range } });
      assert.equal(bad.status, 416, range);
      await bad.body?.cancel();
    }
  }));
