export function bytes(n) {
  if (n === null || n === undefined) return "-";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = n;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

export function duration(seconds) {
  if (!seconds || !Number.isFinite(seconds)) return "-";
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m) return `${m}m ${String(sec).padStart(2, "0")}s`;
  return `${sec}s`;
}

export function bitrate(kbps) {
  if (!kbps) return "-";
  return kbps >= 1000 ? `${(kbps / 1000).toFixed(2)} Mbps` : `${Math.round(kbps)} kbps`;
}

export function ratio(from, to) {
  if (!from || !to) return "-";
  const value = from / to;
  return value >= 10 ? `${Math.round(value)}x` : `${value.toFixed(1)}x`;
}

export function parseSize(input) {
  if (typeof input === "number") return input;
  const match = String(input)
    .trim()
    .toLowerCase()
    .match(/^([0-9]*\.?[0-9]+)\s*(b|kb|k|mb|m|gb|g)?$/);
  if (!match) throw new Error(`Cannot read size "${input}". Try 25mb, 700k or 1.5gb.`);
  const value = Number(match[1]);
  const unit = match[2] || "mb";
  const scale = { b: 1, k: 1000, kb: 1000, m: 1000 ** 2, mb: 1000 ** 2, g: 1000 ** 3, gb: 1000 ** 3 }[unit];
  return Math.round(value * scale);
}

export function clock(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
