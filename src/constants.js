/**
 * constants.js
 *
 * Centralized constants for the Dynamic Island extension.
 * All magic numbers live here — never scatter them in other files.
 */

// ── Default pill / state dimensions (px, before scale) ──────────────────────
export const PILL_W = 160;
export const PILL_H = 34;
export const COMPACT_W = 190;
export const COMPACT_H = 34;
export const EXPANDED_W = 450;
export const EXPANDED_H = 140;
export const OSD_W = 325;
export const OSD_H = 110;
export const NOTIF_W = 400;
export const NOTIF_H = 80;
export const NOTCH_RADIUS = 22;

// ── Component-specific sizes (px, before scale) ──────────────────────────────
export const ART_COMPACT = 28;
export const ART_EXPANDED = 110;
export const WAVEFORM_BARS = 8;
export const WAVEFORM_H = 26;
export const OSD_SEG_COUNT = 28;

// ── Timeouts / Durations ─────────────────────────────────────────────────────
export const OSD_HIDE_MS = 2500;
export const NOTIF_HIDE_MS = 4000;
export const WAVEFORM_MS = 140;
export const SEEK_TICK_S = 1;
export const HOVER_DEBOUNCE = 350;

// ── State enum ───────────────────────────────────────────────────────────────
export const State = Object.freeze({
  PILL: "pill",
  COMPACT: "compact",
  EXPANDED: "expanded",
  OSD: "osd",
  NOTIF: "notif",
});
