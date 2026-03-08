/**
 * utils.js
 *
 * Shared utility functions.
 */

export function parseArtists(rawArtists) {
  if (Array.isArray(rawArtists)) {
    return rawArtists[0] ?? "";
  }
  return String(rawArtists ?? "");
}

export function formatSecs(totalSecs) {
  if (!isFinite(totalSecs) || totalSecs < 0) return "0:00";
  const s = Math.max(0, Math.floor(totalSecs));
  const m = Math.floor(s / 60);
  const ss = s % 60;
  return `${m}:${ss.toString().padStart(2, "0")}`;
}
