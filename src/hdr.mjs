// iPhone 12 and later record HLG by default, and most Android flagships record
// HLG or PQ. If those code values are re-encoded as ordinary 8-bit yuv420p while
// the file keeps its HDR tags, players either show it grey or tone-map it
// differently: the classic "washed out after compression" result.
//
// The bundled FFmpeg ships zscale and tonemap, so converting to BT.709 SDR is
// just a filter chain. npl is the nominal peak luminance: HLG is relative and
// works with 100, while PQ (HDR10) is usually graded against 1000 nits.
export function toneMapFilter(transfer) {
  const kind = hdrKind(transfer);
  const input = kind === "pq"
    ? "tin=smpte2084:min=bt2020nc:pin=bt2020"
    : "tin=arib-std-b67:min=bt2020nc:pin=bt2020";
  const npl = kind === "pq" ? 1000 : 100;
  return [
    `zscale=${input}:t=linear:npl=${npl}`,
    "format=gbrpf32le",
    "zscale=p=bt709",
    "tonemap=tonemap=hable:desat=0",
    "zscale=t=bt709:m=bt709:r=tv",
    "format=yuv420p",
  ].join(",");
}

// ffprobe reports exact transfer names. Keep the few friendly aliases people
// and tests use, so the same helper works for both.
export function hdrKind(transfer) {
  const value = String(transfer || "").toLowerCase();
  if (value === "smpte2084" || value === "pq") return "pq";
  if (value === "arib-std-b67" || value === "hlg") return "hlg";
  return null;
}
