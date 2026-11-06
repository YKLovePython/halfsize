export const CODECS = {
  h264: { label: "H.264", encoder: "libx264", bpp: 0.072, twoPass: true },
  h265: { label: "H.265", encoder: "libx265", bpp: 0.045, twoPass: true },
};

const TIERS = [
  [3840, 2160],
  [2560, 1440],
  [1920, 1080],
  [1600, 900],
  [1280, 720],
  [960, 540],
  [854, 480],
  [640, 360],
  [426, 240],
];

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

// Warnings carry a machine-readable code so the web UI can say the same thing
// in Chinese without re-parsing English sentences.
function warn(list, code, message, params = {}) {
  list.push({ code, message, params });
}

function fitTier(video, tier) {
  const portrait = video.height > video.width;
  const [tw, th] = portrait ? [tier[1], tier[0]] : tier;
  const scale = Math.min(1, tw / video.width, th / video.height);
  return { w: even(video.width * scale), h: even(video.height * scale) };
}

function candidateSizes(info) {
  const out = [];
  const seen = new Set();
  const push = (w, h) => {
    const key = `${w}x${h}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ w, h });
    }
  };
  push(even(info.video.width), even(info.video.height));
  for (const tier of TIERS) {
    const { w, h } = fitTier(info.video, tier);
    push(w, h);
  }
  return out;
}

function audioBitrate(info, totalKbps) {
  if (!info.audio) return 0;
  const preferred = totalKbps > 2500 ? 160 : totalKbps > 800 ? 128 : totalKbps > 300 ? 96 : 64;
  const source = info.audio.bitrate ? info.audio.bitrate / 1000 : preferred;
  const share = totalKbps * 0.18;
  const value = Math.min(preferred, source, share);
  return Math.max(32, Math.round(value / 8) * 8);
}

export function planEncode(info, options = {}) {
  const codecName = options.codec || "h264";
  const codec = CODECS[codecName];
  if (!codec) throw new Error(`Unknown codec "${codecName}". Use h264 or h265.`);

  const preset = options.preset || "medium";
  const allowDownscale = options.downscale !== false;
  const warnings = [];

  if (!info.duration) throw new Error("Could not read the duration of this file.");

  const fps = capFps(info.video.fps);

  // Everything past the first video/audio stream is dropped by -map. Say so.
  if (info.audioTracks > 1) {
    warn(
      warnings,
      "audio-tracks",
      `This file has ${info.audioTracks} audio tracks; only the first one is kept.`,
      { count: info.audioTracks },
    );
  }
  if (info.subtitleTracks > 0) {
    warn(
      warnings,
      "subtitles",
      info.subtitleTracks === 1
        ? "The subtitle track is not carried over to the MP4."
        : `${info.subtitleTracks} subtitle tracks are not carried over to the MP4.`,
      { count: info.subtitleTracks },
    );
  }
  if (info.audio?.channels > 2) {
    warn(
      warnings,
      "downmix",
      `Audio has ${info.audio.channels} channels and is downmixed to stereo.`,
      { channels: info.audio.channels },
    );
  }
  if (info.video.fps > 60.001) {
    warn(
      warnings,
      "fps-capped",
      `Frame rate is capped at 60 fps (the source is ${Math.round(info.video.fps)} fps).`,
      { from: info.video.fps, to: 60 },
    );
  }

  const audioChannels = info.audio?.channels === 1 ? 1 : 2;

  if (options.crf !== undefined) {
    return {
      mode: "quality",
      codec: codecName,
      label: codec.label,
      encoder: codec.encoder,
      preset,
      crf: Number(options.crf),
      width: info.video.width,
      height: info.video.height,
      fps,
      videoKbps: null,
      audioKbps: options.audio === false ? 0 : audioBitrate(info, 2000),
      audioChannels,
      targetBytes: null,
      twoPass: false,
      downscaled: false,
      scaleFilter: null,
      fpsFilter: null,
      warnings,
    };
  }

  if (!options.targetBytes) throw new Error("A target size is required.");

  const totalKbps = ((options.targetBytes * 8) / info.duration / 1000) * 0.97;
  const audioKbps = options.audio === false ? 0 : audioBitrate(info, totalKbps);
  const videoKbps = Math.max(40, Math.round(totalKbps - audioKbps));

  const sizes = candidateSizes(info);
  const original = sizes[0];
  let chosen = sizes[sizes.length - 1];
  for (const size of sizes) {
    const requiredKbps = (size.w * size.h * fps * codec.bpp) / 1000;
    if (requiredKbps <= videoKbps) {
      chosen = size;
      break;
    }
  }

  const requiredAtChosen = (chosen.w * chosen.h * fps * codec.bpp) / 1000;
  if (chosen.w === original.w && chosen.h === original.h && requiredAtChosen > videoKbps) {
    warn(
      warnings,
      "aggressive",
      "The target is aggressive for this resolution; keeping full size will look soft.",
    );
  }
  if (!allowDownscale && (chosen.w !== original.w || chosen.h !== original.h)) {
    chosen = { w: original.w, h: original.h };
    warn(
      warnings,
      "no-downscale",
      "Downscaling is disabled, so the target may be missed. Quality will suffer.",
    );
  }
  if (videoKbps < 120) {
    warn(warnings, "low-bitrate", "Very low bitrate. Consider a larger target or H.265.");
  }
  if (info.video.hdr) {
    warn(
      warnings,
      "hdr",
      "HDR source detected. HDR-to-SDR conversion is not implemented yet, so colors may look washed out.",
    );
  }

  const downscaled = chosen.w !== original.w || chosen.h !== original.h;

  return {
    mode: "size",
    codec: codecName,
    label: codec.label,
    encoder: codec.encoder,
    preset,
    crf: null,
    width: chosen.w,
    height: chosen.h,
    fps,
    videoKbps,
    audioKbps,
    audioChannels,
    targetBytes: options.targetBytes,
    twoPass: Boolean(codec.twoPass),
    downscaled,
    scaleFilter: downscaled ? `scale=${chosen.w}:${chosen.h}:flags=lanczos` : null,
    fpsFilter: fps < info.video.fps - 0.01 ? `fps=${fps}` : null,
    warnings,
  };
}

// Cap, never floor. A 5 fps timelapse used to be forced to 10 fps, which
// duplicated frames and inflated the bitrate the planner assumed it had.
function capFps(fps) {
  if (!fps || !Number.isFinite(fps)) return 30;
  return Math.min(60, Math.round(fps * 1000) / 1000);
}

export function estimateBytes(info, plan) {
  if (plan.mode !== "size") return null;
  const kbps = plan.videoKbps + plan.audioKbps;
  return Math.round((kbps * 1000 * info.duration) / 8);
}
