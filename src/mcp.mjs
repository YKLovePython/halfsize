import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { VERSION, IS_SEA } from "./self.mjs";

// A one-tool MCP server over stdio. The point is not to wrap every flag: it is
// to give an agent a callable "make this video fit in 20 MB and tell me what it
// cost" that runs on the user's machine. Everything below mirrors the CLI's
// --json output, so the agent sees exactly what a human would.

// Inside the bundled executable there is no bin/halfsize.mjs to point at: the
// executable is the CLI, so it re-runs itself. Computed lazily because
// import.meta.url does not exist in the CommonJS bundle.
function binArgs() {
  if (IS_SEA) return [];
  return [fileURLToPath(new URL("../bin/halfsize.mjs", import.meta.url))];
}

const PROTOCOL_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18"];
const LATEST_PROTOCOL = PROTOCOL_VERSIONS[PROTOCOL_VERSIONS.length - 1];

const TOOL = {
  name: "compress_video",
  title: "Compress a video to an exact size",
  description:
    "Compress a local video file to a target size (for example 20mb for Discord or WeChat, " +
    "16mb for WhatsApp, 18mb for email) and return the measured quality loss (VMAF/SSIM). " +
    "Runs entirely on this machine: nothing is uploaded. Use it when a video will not fit " +
    "through an upload limit.",
  inputSchema: {
    type: "object",
    properties: {
      input: { type: "string", description: "Path to the local video file." },
      target: {
        type: "string",
        description: "Target size, e.g. 20mb, 16mb, 800k, 1.5gb. No unit means MB.",
      },
      output: {
        type: "string",
        description: "Output path. Defaults to <input>.<target>.mp4 next to the input.",
      },
      codec: { type: "string", enum: ["h264", "h265"], description: "h264 (default) or h265 (smaller)." },
      verify: {
        type: "boolean",
        description: "Measure VMAF/SSIM after encoding. Defaults to true; false is faster.",
      },
      dryRun: {
        type: "boolean",
        description: "Only return the plan (bitrate, resolution, warnings) without encoding.",
      },
    },
    required: ["input", "target"],
    additionalProperties: false,
  },
  annotations: { title: "Compress a video to an exact size", readOnlyHint: false, destructiveHint: false, openWorldHint: false },
};

function runCli(args) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, [...binArgs(), ...args], { windowsHide: true });
    } catch (err) {
      resolve({ code: -1, out: "", err: err?.message || String(err) });
      return;
    }
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => resolve({ code: -1, out, err: `${err}${e.message}` }));
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

const mb = (n) => `${(n / 1_000_000).toFixed(2)} MB`;

function describe(summary) {
  if (!summary || typeof summary !== "object") return "halfsize returned no result.";
  if (summary.error) return `halfsize failed: ${summary.error}`;
  if (summary.skipped) return `No encode needed: ${summary.input?.file} already fits (${mb(summary.input.bytes)}).`;

  const lines = [];
  const out = summary.output || {};
  const pct = typeof summary.accuracy === "number" ? `${Math.abs(summary.accuracy * 100).toFixed(1)}% ${summary.accuracy > 0 ? "over" : "under"} target` : "";
  if (summary.dryRun) {
    const plan = summary.plan || {};
    lines.push(`Plan for ${summary.info?.file ?? "the input"}: ${plan.codec?.toUpperCase?.() || "H.264"} ${plan.width}x${plan.height} at ${Math.round((plan.videoBitrate || 0) / 1000)} kbps${plan.passes > 1 ? ", two passes" : ""}.`);
    for (const warning of plan.warnings || []) lines.push(`Warning: ${warning.message}`);
    return lines.join("\n");
  }
  lines.push(`Wrote ${out.file} (${mb(out.bytes)})${summary.targetBytes ? ` from ${mb(summary.input.bytes)}, ${pct}` : ""}.`);
  const quality = summary.quality || {};
  const measured = [];
  if (typeof quality.vmaf === "number") measured.push(`VMAF ${quality.vmaf.toFixed(1)}`);
  if (typeof quality.ssim === "number") measured.push(`SSIM ${quality.ssim.toFixed(3)}`);
  if (measured.length && summary.verdict?.label) measured.push(summary.verdict.label);
  if (measured.length) lines.push(`Quality: ${measured.join(", ")}.`);
  if (summary.missedTarget) lines.push("Note: the encode still exceeded the target size.");
  return lines.join("\n");
}

function toolError(text) {
  return { content: [{ type: "text", text }], isError: true };
}

async function compressVideo(args) {
  if (!args || typeof args.input !== "string" || !args.input.trim()) {
    return toolError("compress_video needs an `input` path.");
  }
  if (typeof args.target !== "string" || !args.target.trim()) {
    return toolError("compress_video needs a `target` size, e.g. 20mb.");
  }

  const cmd = [args.input, "--to", args.target, "--json"];
  if (args.output) cmd.push("--out", args.output);
  if (args.codec) cmd.push("--codec", args.codec);
  if (args.verify === false) cmd.push("--no-verify");
  if (args.dryRun) cmd.push("--dry-run");

  const { code, out, err } = await runCli(cmd);
  let summary = null;
  try {
    summary = JSON.parse(out);
  } catch {
    // Old or broken output: fall through to the raw text below.
  }
  if (code !== 0 || !summary) {
    const text = (err || out || `halfsize exited with code ${code}`).trim();
    return toolError(text || "halfsize failed without a message.");
  }
  if (summary.error) return toolError(summary.error);

  return {
    content: [{ type: "text", text: `${describe(summary)}\n\n${JSON.stringify(summary, null, 2)}` }],
    structuredContent: summary,
  };
}

// Pure request dispatcher: takes one decoded JSON-RPC message and returns the
// response object, or null for notifications. Tests call this directly.
export async function dispatch(message, { run = compressVideo, version = VERSION } = {}) {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } };
  }
  const { id, method, params } = message;
  const isNotification = id === undefined || id === null;
  const reply = (result) => (isNotification ? null : { jsonrpc: "2.0", id, result });
  const fail = (code, text) => (isNotification ? null : { jsonrpc: "2.0", id, error: { code, message: text } });

  switch (method) {
    case "initialize": {
      const asked = params?.protocolVersion;
      const protocolVersion = PROTOCOL_VERSIONS.includes(asked) ? asked : LATEST_PROTOCOL;
      return reply({
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "halfsize", version },
        instructions:
          "Call compress_video to make a local video file fit an upload limit and get the measured quality loss back.",
      });
    }
    case "notifications/initialized":
    case "notifications/cancelled":
      return null;
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: [TOOL] });
    case "tools/call": {
      const name = params?.name;
      if (name !== TOOL.name) return fail(-32602, `Unknown tool "${name}". Available: ${TOOL.name}.`);
      const result = await run(params?.arguments ?? {});
      return reply(result);
    }
    case "resources/list":
      return reply({ resources: [] });
    case "prompts/list":
      return reply({ prompts: [] });
    default:
      return fail(-32601, `Method not found: ${method}`);
  }
}

// Newline-delimited JSON-RPC on stdin/stdout, per the MCP stdio transport.
export async function serve({ stdin = process.stdin, stdout = process.stdout } = {}) {
  stdin.setEncoding("utf8");
  let buffer = "";
  let chain = Promise.resolve();

  const handle = async (line) => {
    let response;
    try {
      response = await dispatch(JSON.parse(line));
    } catch (err) {
      response = { jsonrpc: "2.0", id: null, error: { code: -32700, message: `Parse error: ${err?.message || err}` } };
    }
    if (response) stdout.write(`${JSON.stringify(response)}\n`);
  };

  for await (const chunk of stdin) {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) chain = chain.then(() => handle(line));
    }
  }
  await chain;
}
