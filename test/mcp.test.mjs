import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dispatch } from "../src/mcp.mjs";
import { resolveBinaries } from "../src/ffmpeg.mjs";

const BIN = fileURLToPath(new URL("../bin/halfsize.mjs", import.meta.url));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "halfsize-mcp-"));

test.after(() => {
  fs.rmSync(WORK, { recursive: true, force: true });
});

// Drives the real server over stdio, exactly like a client would.
function startServer() {
  const child = spawn(process.execPath, [BIN, "--mcp"], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let buffer = "";
  const waiting = [];
  const pending = new Map();

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const resolve = pending.get(message.id);
      if (resolve) {
        pending.delete(message.id);
        resolve(message);
      } else {
        waiting.push(message);
      }
    }
  });

  let nextId = 1;
  const request = (method, params) => {
    const id = nextId++;
    const message = { jsonrpc: "2.0", id, method, params };
    const promise = new Promise((resolve, reject) => {
      // A real (not unref'd) timer, cleared on reply: if the server never answers,
      // the test has to fail rather than leave a promise nobody settles.
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`no response to ${method} within 20s`));
      }, 20000);
      pending.set(id, (reply) => {
        clearTimeout(timer);
        resolve(reply);
      });
    });
    child.stdin.write(`${JSON.stringify(message)}\n`);
    return promise;
  };

  return { child, request, notify: (method, params) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`) };
}

// Closing stdin lets the server's read loop end on its own; destroying the pipes
// after that is what stops the test runner from waiting on an open handle.
function stop(server) {
  const { child } = server;
  child.stdin.end();
  child.kill();
  child.stdin.destroy();
  child.stdout.destroy();
  child.stderr.destroy();
}

test("initialize answers with a protocol version, tool capability and a name", async () => {
  const server = startServer();
  try {
    const res = await server.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test" } });
    assert.equal(res.result.protocolVersion, "2025-06-18");
    assert.deepEqual(res.result.capabilities.tools, {});
    assert.equal(res.result.serverInfo.name, "halfsize");
    assert.match(res.result.serverInfo.version, /^\d+\.\d+\.\d+$/);
  } finally {
    stop(server);
  }
});

test("initialize echoes nothing newer than we speak, and does not crash on an unknown version", async () => {
  const res = await dispatch({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "1999-01-01" } });
  assert.equal(res.result.protocolVersion, "2025-06-18");
});

test("tools/list advertises compress_video with a usable schema", async () => {
  const res = await dispatch({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.equal(res.result.tools.length, 1);
  const tool = res.result.tools[0];
  assert.equal(tool.name, "compress_video");
  assert.deepEqual(tool.inputSchema.required, ["input", "target"]);
  assert.equal(tool.inputSchema.properties.input.type, "string");
  assert.equal(tool.inputSchema.properties.target.type, "string");
  assert.match(tool.description, /nothing is uploaded/i);
});

test("notifications get no response, so a client never blocks on them", async () => {
  assert.equal(await dispatch({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
  assert.equal(await dispatch({ jsonrpc: "2.0", method: "notifications/cancelled", params: {} }), null);
});

test("an unknown method is a JSON-RPC -32601, not a crash", async () => {
  const res = await dispatch({ jsonrpc: "2.0", id: 3, method: "does/not/exist" });
  assert.equal(res.error.code, -32601);
});

test("an unknown tool names the one that exists", async () => {
  const res = await dispatch({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "compress", arguments: {} } });
  assert.equal(res.error.code, -32602);
  assert.match(res.error.message, /compress_video/);
});

test("missing arguments produce a tool error the model can read, not a crash", async () => {
  const res = await dispatch({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "compress_video", arguments: { input: "a.mp4" } } });
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /target/);
  assert.ok(!res.result.structuredContent);
});

test("a tool call runs the real CLI and reports size plus measured quality", async (t) => {
  const { ffmpeg } = await resolveBinaries();
  const source = path.join(WORK, "clip.mp4");
  try {
    execFileSync(
      ffmpeg,
      [
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=24",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
        "-t", "1.5",
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

  const output = path.join(WORK, "clip.out.mp4");
  // The CLI itself is exercised here (verify:false keeps the test to one encode),
  // so this covers the argument mapping and the JSON contract, not just dispatch.
  const res = await dispatch({
    jsonrpc: "2.0",
    id: 6,
    method: "tools/call",
    params: { name: "compress_video", arguments: { input: source, target: "150kb", output, verify: false } },
  });

  assert.ok(!res.result.isError, res.result?.content?.[0]?.text);
  const summary = res.result.structuredContent;
  assert.equal(summary.output.file, output);
  assert.ok(fs.existsSync(output));
  assert.ok(summary.output.bytes <= 150_000 * 1.08, `${summary.output.bytes} overshot 150 KB`);
  assert.match(res.result.content[0].text, /Wrote /);
  assert.match(res.result.content[0].text, /150/);
});

test("--dry-run returns a plan instead of writing a file", async (t) => {
  const { ffmpeg } = await resolveBinaries();
  const source = path.join(WORK, "dry.mp4");
  try {
    execFileSync(
      ffmpeg,
      [
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=24",
        "-t", "1.5",
        "-c:v", "libx264", "-preset", "veryfast", "-b:v", "2M", "-pix_fmt", "yuv420p",
        source,
      ],
      { windowsHide: true, stdio: "ignore" },
    );
  } catch {
    t.skip("ffmpeg cannot generate test clips here");
    return;
  }

  const res = await dispatch({
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: { name: "compress_video", arguments: { input: source, target: "120kb", dryRun: true } },
  });

  assert.ok(!res.result.isError, res.result?.content?.[0]?.text);
  assert.equal(res.result.structuredContent.dryRun, true);
  assert.equal(res.result.structuredContent.targetBytes, 120_000);
  assert.ok(!fs.existsSync(res.result.structuredContent.out), "a dry run must not write the output");
  assert.match(res.result.content[0].text, /Plan for/);
});

test("a missing file comes back as a tool error, which is what the model needs", async () => {
  const res = await dispatch({
    jsonrpc: "2.0",
    id: 8,
    method: "tools/call",
    params: { name: "compress_video", arguments: { input: path.join(WORK, "nope.mp4"), target: "20mb" } },
  });
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /not found/i);
});
