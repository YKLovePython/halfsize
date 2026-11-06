import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { probe } from "./probe.mjs";
import { planEncode } from "./plan.mjs";
import { encode } from "./encode.mjs";
import { measureQuality, verdict } from "./quality.mjs";
import { parseSize, bytes as fmt } from "./human.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(__dirname, "..", "web");

const jobs = new Map();
const clients = new Map();

let workDir = "";

function jobDir() {
  if (!workDir) {
    workDir = path.join(os.tmpdir(), `halfsize-${process.pid}-${Date.now().toString(36)}`);
    fs.mkdirSync(workDir, { recursive: true });
    const cleanup = () => {
      try {
        fs.rmSync(workDir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    };

    // Ctrl+C used to call process.exit() straight away, which left the running
    // FFmpeg child orphaned. Stop the jobs first, give them a moment to remove
    // their .part files, then clean the work directory and leave.
    let shuttingDown = false;
    const shutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      for (const job of jobs.values()) {
        if (job.status === "running" && job.controller) {
          job.cancelRequested = true;
          job.controller.abort();
        }
      }
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline && [...jobs.values()].some((job) => job.status === "running")) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      cleanup();
      process.exit(0);
    };

    process.once("exit", cleanup);
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  }
  return workDir;
}

function send(res, status, body, headers = {}) {
  const payload = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  res.end(payload);
}

function cancelledJob() {
  const err = new Error("Cancelled.");
  err.code = "HALFSIZE_CANCELLED";
  return err;
}

// The browser sends the file name; never trust it. Strip directories, control
// characters, and anything that would break a Content-Disposition header.
function safeName(raw) {
  const base = path.basename(String(raw || "").replace(/\\/g, "/"));
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f"\\/:*?<>|]/g, "_")
    .trim()
    .slice(0, 180);
  return cleaned || "video.mp4";
}

async function removeFile(file) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.rmSync(file, { force: true });
      return;
    } catch {
      // Windows keeps the handle for a moment after a destroyed stream.
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

function saveUpload(req, file, limit = 8 * 1024 ** 3) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(file);
    let size = 0;
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      req.unpipe(out);
      out.destroy();
      req.destroy();
      reject(err);
    };
    req.pipe(out);
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        const err = new Error("File is too large for the local app. Use the CLI for files over 8 GB.");
        err.code = "TOO_LARGE";
        fail(err);
      }
    });
    // A browser that closes mid-upload never sends "end". Without this the
    // promise would stay pending and the half-written file would stay open.
    req.on("close", () => {
      if (!settled && !req.readableEnded) fail(new Error("The upload was interrupted. Try again."));
    });
    out.on("finish", () => {
      if (settled) return;
      settled = true;
      resolve(size);
    });
    out.on("error", fail);
    req.on("error", fail);
  });
}

// A malformed body is a 400, not a 500 with a stack trace about JSON.
async function readJson(req, limit) {
  try {
    const text = (await readBody(req, limit)).toString();
    return text ? JSON.parse(text) : {};
  } catch (err) {
    const problem = new Error("Could not read this request. Reload the page and try again.");
    problem.status = 400;
    problem.cause = err;
    throw problem;
  }
}

function readBody(req, limit = 8 * 1024 ** 3) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("File is too large for the local app. Use the CLI for files over 8 GB."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
    req.on("close", () => {
      if (!req.readableEnded) reject(new Error("The request was interrupted."));
    });
  });
}

function emit(id, event, data) {
  const set = clients.get(id);
  if (!set) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of [...set]) {
    try {
      res.write(payload);
    } catch {
      set.delete(res);
    }
  }
}

export async function startServer(options = {}) {
  const envPort = Number(process.env.HALFSIZE_PORT);
  const port = options.port ?? (Number.isInteger(envPort) && envPort > 0 ? envPort : 4174);
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://local");
      const pathname = url.pathname;

      if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
        const html = fs.readFileSync(path.join(WEB_DIR, "index.html"));
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(html);
      }

      if (req.method === "GET" && pathname.startsWith("/assets/")) {
        const file = path.join(WEB_DIR, pathname.slice("/assets/".length));
        const inside = path.relative(WEB_DIR, file);
        if (!inside || inside.startsWith("..") || path.isAbsolute(inside)) return send(res, 404, { error: "not found" });
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, { error: "not found" });
        res.writeHead(200, { "content-type": contentType(file) });
        return fs.createReadStream(file).pipe(res);
      }

      if (req.method === "POST" && pathname === "/api/upload") {
        let name = "video.mp4";
        try {
          name = safeName(decodeURIComponent(req.headers["x-filename"] || "video.mp4"));
        } catch {
          // Malformed percent-encoding; the fallback name is enough.
        }
        const id = crypto.randomBytes(8).toString("hex");
        const ext = (path.extname(name) || ".mp4").slice(0, 12);
        const dir = jobDir();
        const file = path.join(dir, `${id}${ext}`);

        try {
          await saveUpload(req, file);
        } catch (err) {
          await removeFile(file);
          return send(res, err.code === "TOO_LARGE" ? 413 : 400, { error: err.message });
        }

        if (!fs.statSync(file).size) {
          await removeFile(file);
          return send(res, 400, { error: "That file is empty.", code: "empty" });
        }

        let info;
        try {
          info = await probe(file);
        } catch (err) {
          await removeFile(file);
          return send(res, 400, { error: err.message, code: "not_video" });
        }

        jobs.set(id, { id, input: file, originalName: name, info, status: "ready" });
        return send(res, 200, {
          id,
          name,
          size: info.sizeBytes,
          duration: info.duration,
          width: info.video.width,
          height: info.video.height,
          fps: info.video.fps,
          codec: info.video.codec,
          hasAudio: Boolean(info.audio),
        });
      }

      if (req.method === "GET" && pathname.startsWith("/api/events/")) {
        const id = pathname.split("/").pop();
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
          connection: "keep-alive",
        });
        res.write(": connected\n\n");
        if (!clients.has(id)) clients.set(id, new Set());
        clients.get(id).add(res);
        // Without this, a socket error after the tab closes becomes an
        // unhandled 'error' event on the response and can kill the server.
        res.on("error", () => clients.get(id)?.delete(res));
        const job = jobs.get(id);
        if (job?.status === "done") emit(id, "done", job.result);
        if (job?.status === "error") emit(id, "failed", { message: job.error });
        req.on("close", () => {
          clients.get(id)?.delete(res);
          // A closed tab used to leave ffmpeg running to completion. Give
          // EventSource a moment to reconnect first, then stop the job.
          const job = jobs.get(id);
          if (!job || job.status !== "running" || !job.controller) return;
          // Capture this run's controller. Without it, a timer left over from
          // a previous run would abort the *next* encode started in the tab.
          const controller = job.controller;
          const timer = setTimeout(() => {
            if ((clients.get(id)?.size ?? 0) > 0) return;
            if (job.controller !== controller || controller.signal.aborted) return;
            job.cancelRequested = true;
            controller.abort();
          }, 10000);
          timer.unref?.();
        });
        return;
      }

      if (req.method === "POST" && pathname === "/api/compress") {
        const body = await readJson(req, 1024 * 1024);
        const job = jobs.get(body.id);
        if (!job) return send(res, 404, { error: "Unknown upload" });
        if (job.status === "running") return send(res, 409, { error: "Already running" });

        const targetBytes = body.target ? parseSize(body.target) : null;
        if (targetBytes && targetBytes >= job.info.sizeBytes) {
          return send(res, 400, {
            error: `This file is already ${fmt(job.info.sizeBytes)}, smaller than the ${fmt(targetBytes)} target. Pick a smaller target.`,
            code: "already_small",
          });
        }
        const plan = planEncode(job.info, {
          targetBytes,
          crf: body.crf,
          codec: body.codec || "h264",
          preset: body.preset || "medium",
          downscale: true,
        });
        const out = job.input.replace(/(\.[^.]+)$/, `.halfsize.mp4`);
        job.status = "running";
        job.plan = plan;
        job.output = null;
        job.result = null;
        job.error = null;
        job.wroteOutput = false;
        job.controller = new AbortController();

        send(res, 202, { ok: true, plan });

        (async () => {
          const started = Date.now();
          try {
            const result = await encode(job.input, out, plan, job.info, (p) => {
              emit(job.id, "progress", { ...p, eta: p.ratio > 0.01 ? ((Date.now() - started) / 1000 / p.ratio) * (1 - p.ratio) : 0 });
            }, { signal: job.controller.signal });
            job.wroteOutput = true;
            if (job.controller.signal.aborted) throw cancelledJob();
            emit(job.id, "phase", { phase: "verify" });
            const quality = await measureQuality(job.input, out, job.info.duration);
            // Cancel can land while the metrics run; the file is complete by
            // then, but the user asked to stop, so remove it and say cancelled.
            if (job.controller.signal.aborted) throw cancelledJob();
            job.result = {
              id: job.id,
              inputBytes: job.info.sizeBytes,
              outputBytes: result.outputBytes,
              targetBytes,
              accuracy: targetBytes ? result.outputBytes / targetBytes - 1 : null,
              ratio: job.info.sizeBytes / result.outputBytes,
              elapsedMs: result.elapsedMs,
              quality,
              verdict: verdict(quality),
              plan,
              name: job.originalName,
              download: `/api/download/${job.id}`,
            };
            job.status = "done";
            job.output = out;
            emit(job.id, "done", job.result);
          } catch (err) {
            if (err.code === "HALFSIZE_CANCELLED" || err.code === "HALFSIZE_INTERRUPTED") {
              if (job.wroteOutput) {
                try {
                  fs.rmSync(out, { force: true });
                } catch {
                  // best effort
                }
              }
              job.status = "cancelled";
              emit(job.id, "cancelled", { message: "cancelled" });
            } else {
              job.status = "error";
              job.error = err.message;
              emit(job.id, "failed", { message: err.message });
            }
          } finally {
            job.controller = null;
          }
        })();
        return;
      }

      if (req.method === "POST" && pathname === "/api/cancel") {
        const body = await readJson(req, 1024 * 1024);
        const job = jobs.get(body.id);
        if (!job) return send(res, 404, { error: "Unknown upload" });
        if (job.status !== "running" || !job.controller) return send(res, 409, { error: "Not running" });
        job.cancelRequested = true;
        job.controller.abort();
        return send(res, 202, { ok: true });
      }

      if (req.method === "GET" && pathname.startsWith("/api/download/")) {
        const id = pathname.split("/").pop();
        const job = jobs.get(id);
        if (!job?.output || !fs.existsSync(job.output)) return send(res, 404, { error: "not ready" });
        const base = safeName(job.originalName).replace(/\.[^.]+$/, "") || "video";
        const name = `${base}.halfsize.mp4`;
        const ascii = name.replace(/[^\x20-\x7e]/g, "_");
        res.writeHead(200, {
          "content-type": "video/mp4",
          "content-disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
          "content-length": fs.statSync(job.output).size,
        });
        return fs.createReadStream(job.output).pipe(res);
      }

      if (req.method === "GET" && pathname.startsWith("/api/media/")) {
        const [, , , id, which] = pathname.split("/");
        const job = jobs.get(id);
        const file = which === "out" ? job?.output : job?.input;
        if (!file || !fs.existsSync(file)) return send(res, 404, { error: "not found" });
        return streamVideo(req, res, file);
      }

      return send(res, 404, { error: "not found" });
    } catch (err) {
      if (res.headersSent) {
        try {
          res.end();
        } catch {
          // The socket is already gone.
        }
        return;
      }
      return send(res, err.status || 500, { error: err.message });
    }
  });

  await new Promise((resolve, reject) => {
    const onError = (err) => {
      server.removeListener("listening", onListening);
      if (err.code === "EADDRINUSE") {
        reject(
          new Error(
            `Port ${port} is already in use. Close the other halfsize window, or run: npx halfsize --web --port ${port + 1}`,
          ),
        );
        return;
      }
      reject(err);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });

  const actualPort = server.address().port;
  return {
    url: `http://127.0.0.1:${actualPort}`,
    server,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

function streamVideo(req, res, file) {
  const stat = fs.statSync(file);
  const size = stat.size;
  const range = req.headers.range;
  if (!range) {
    res.writeHead(200, { "content-length": size, "content-type": "video/mp4", "accept-ranges": "bytes" });
    return fs.createReadStream(file).pipe(res);
  }

  // Only the single-range form browsers actually send. Anything else gets a
  // 416 instead of a negative content-length and a crashed stream.
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
  if (!match || (match[1] === "" && match[2] === "")) return unsatisfiable(res, size);

  let start;
  let end;
  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (!suffix) return unsatisfiable(res, size);
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Number(match[2]);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= size || start > end) {
    return unsatisfiable(res, size);
  }
  end = Math.min(end, size - 1);

  res.writeHead(206, {
    "content-range": `bytes ${start}-${end}/${size}`,
    "accept-ranges": "bytes",
    "content-length": end - start + 1,
    "content-type": "video/mp4",
  });
  return fs.createReadStream(file, { start, end }).pipe(res);
}

function unsatisfiable(res, size) {
  res.writeHead(416, { "content-range": `bytes */${size}`, "content-length": 0 });
  res.end();
}

function contentType(file) {
  const ext = path.extname(file).toLowerCase();
  return (
    {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".woff2": "font/woff2",
    }[ext] || "application/octet-stream"
  );
}
