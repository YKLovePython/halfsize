import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveBinaries } from "./ffmpeg.mjs";

const run = promisify(execFile);

export async function probe(file) {
  const { ffprobe } = await resolveBinaries();
  const { stdout } = await run(
    ffprobe,
    ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file],
    { maxBuffer: 32 * 1024 * 1024, windowsHide: true },
  );
  const json = JSON.parse(stdout);

  const video = json.streams.find((s) => s.codec_type === "video" && s.disposition?.attached_pic !== 1);
  if (!video) throw new Error("No video stream found in this file.");

  const audio = json.streams.find((s) => s.codec_type === "audio");
  const duration = Number(json.format.duration || video.duration || 0);
  const sizeBytes = Number(json.format.size || 0);

  const rotation = readRotation(video);
  const width = rotation % 180 === 0 ? video.width : video.height;
  const height = rotation % 180 === 0 ? video.height : video.width;

  return {
    file,
    duration,
    sizeBytes,
    container: (json.format.format_name || "").split(",")[0],
    bitrate: Number(json.format.bit_rate || 0),
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
