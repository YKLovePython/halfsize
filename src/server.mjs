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
    process.once("exit", cleanup);
    process.once("SIGINT", () => {
      cleanup();
      process.exit(0);
    });
    process.once("SIGTERM", () => {
      cleanup();
      process.exit(0);
    });
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
  const port = options.port || Number(process.env.HALFSIZE_PORT) || 4174;
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
        const file = path.join(WEB_DIR, pathname.replace("/assets/", ""));
        if (!file.startsWith(WEB_DIR) || !fs.existsSync(file)) return send(res, 404, { error: "not found" });
        res.writeHead(200, { "content-type": contentType(file) });
        return fs.createReadStream(file).pipe(res);
      }

      if (req.method === "POST" && pathname === "/api/upload") {
        const name = decodeURIComponent(req.headers["x-filename"] || "video.mp4");
        const id = crypto.randomBytes(8).toString("hex");
        const ext = path.extname(name) || ".mp4";
        const dir = jobDir();
        const file = path.join(dir, `${id}${ext}`);
        await new Promise((resolve, reject) => {
          const out = fs.createWriteStream(file);
          let size = 0;
          req.on("data", (chunk) => {
            size += chunk.length;
            if (size > 8 * 1024 ** 3) {
              req.destroy();
              out.destroy();
              reject(new Error("File is too large for the local app. Use the CLI for files over 8 GB."));
            }
          });
          req.pipe(out);
          out.on("finish", resolve);
          out.on("error", reject);
          req.on("error", reject);
        });
        const info = await probe(file);
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
        const job = jobs.get(id);
        if (job?.status === "done") emit(id, "done", job.result);
        if (job?.status === "error") emit(id, "failed", { message: job.error });
        req.on("close", () => {
          clients.get(id)?.delete(res);
          // A closed tab used to leave ffmpeg running to completion. Give
          // EventSource a moment to reconnect first, then stop the job.
          const job = jobs.get(id);
          if (!job || job.status !== "running" || !job.controller) return;
          const timer = setTimeout(() => {
            if ((clients.get(id)?.size ?? 0) > 0) return;
            if (job.status !== "running" || !job.controller) return;
            job.cancelRequested = true;
            job.controller.abort();
          }, 10000);
          timer.unref?.();
        });
        return;
      }

      if (req.method === "POST" && pathname === "/api/compress") {
        const body = JSON.parse((await readBody(req, 1024 * 1024)).toString());
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
        job.output = out;
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
            emit(job.id, "done", job.result);
          } catch (err) {
            if (err.code === "HALFSIZE_CANCELLED" || err.code === "HALFSIZE_INTERRUPTED") {
              if (job.wroteOutput) {
                try {
                  fs.rmSync(job.output, { force: true });
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
        const body = JSON.parse((await readBody(req, 1024 * 1024)).toString());
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
        const name = job.originalName.replace(/(\.[^.]+)$/, "") + ".halfsize.mp4";
        res.writeHead(200, {
          "content-type": "video/mp4",
          "content-disposition": `attachment; filename="${name.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "")}"; filename*=UTF-8''${encodeURIComponent(name)}`,
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
      return send(res, 500, { error: err.message });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });

  return `http://127.0.0.1:${port}`;
}

function streamVideo(req, res, file) {
  const stat = fs.statSync(file);
  const range = req.headers.range;
  if (range) {
    const [startRaw, endRaw] = range.replace("bytes=", "").split("-");
    const start = Number(startRaw) || 0;
    const end = endRaw ? Number(endRaw) : stat.size - 1;
    res.writeHead(206, {
      "content-range": `bytes ${start}-${end}/${stat.size}`,
      "accept-ranges": "bytes",
      "content-length": end - start + 1,
      "content-type": "video/mp4",
    });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { "content-length": stat.size, "content-type": "video/mp4", "accept-ranges": "bytes" });
  return fs.createReadStream(file).pipe(res);
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
