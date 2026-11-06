import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveBinaries } from "./ffmpeg.mjs";

const run = promisify(execFile);

// Demuxers that happily "read" things which are not videos. FFmpeg's tty
// demuxer turns a .txt file into an ANSI-art video stream, and image2 turns a
// single JPEG into a one-frame movie. Both used to sail through as valid input.
const NOT_VIDEO = new Set(["tty", "image2", "lavfi"]);

export async function probe(file) {
  const { ffprobe } = await resolveBinaries();
  let stdout;
  try {
    ({ stdout } = await run(
      ffprobe,
      ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file],
      { maxBuffer: 32 * 1024 * 1024, windowsHide: true },
    ));
  } catch (err) {
    // The raw execFile error is a full local path plus a command line. Nobody
    // needs that in a UI; keep it behind HALFSIZE_DEBUG.
    const detail = process.env.HALFSIZE_DEBUG ? `\n${err.stderr || err.message}` : "";
    throw new Error(`FFmpeg could not read this file as a video.${detail}`);
  }

  const json = JSON.parse(stdout);
  const format = json.format || {};
  const container = String(format.format_name || "").split(",")[0];
  if (NOT_VIDEO.has(container)) {
    throw new Error("This file is not a video. Pick an MP4, MOV, MKV, AVI, or WebM file.");
  }

  const video = json.streams.find((s) => s.codec_type === "video" && s.disposition?.attached_pic !== 1);
  if (!video) throw new Error("No video stream found in this file.");

  const audio = json.streams.find((s) => s.codec_type === "audio");
  const duration = Number(format.duration || video.duration || 0);
  const sizeBytes = Number(format.size || 0);

  const rotation = readRotation(video);
  const width = rotation % 180 === 0 ? video.width : video.height;
  const height = rotation % 180 === 0 ? video.height : video.width;

  return {
    file,
    duration,
    sizeBytes,
    container,
    bitrate: Number(format.bit_rate || 0),
    video: {
      codec: video.codec_name,
      profile: video.profile,
      width,
      height,
      fps: parseFps(video.avg_frame_rate) || parseFps(video.r_frame_rate) || 30,
      pixFmt: video.pix_fmt,
      bitrate: Number(video.bit_rate || 0),
      hdr: isHdr(video),
      rotation,
    },
    audio: audio
      ? {
          codec: audio.codec_name,
          channels: audio.channels,
          sampleRate: Number(audio.sample_rate),
          bitrate: Number(audio.bit_rate || 0),
        }
      : null,
    // Everything below the first video/audio stream is dropped at encode time.
    // The plan warns about it instead of losing it silently.
    audioTracks: json.streams.filter((s) => s.codec_type === "audio").length,
    subtitleTracks: json.streams.filter((s) => s.codec_type === "subtitle").length,
  };
}

function parseFps(value) {
  if (!value || value === "0/0") return 0;
  const [a, b] = value.split("/").map(Number);
  if (!b) return a || 0;
  return a / b;
}

function readRotation(stream) {
  const side = stream.side_data_list?.find((d) => d.rotation !== undefined);
  if (side) return Math.abs(Number(side.rotation)) % 360;
  const tag = stream.tags?.rotate;
  return tag ? Math.abs(Number(tag)) % 360 : 0;
}

function isHdr(stream) {
  const t = `${stream.color_transfer || ""} ${stream.color_primaries || ""}`;
  return /smpte2084|arib-std-b67|bt2020/i.test(t);
}
