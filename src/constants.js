/**
 * constants.js
 *
 * Centralized constants for the Dynamic Island extension.
 */

// Sizing
export const PILL_W = 145;
export const PILL_H = 34;
export const COMPACT_W = 180;
export const COMPACT_H = 34;
export const EXPANDED_W = 450;
export const EXPANDED_H = 150;
export const OSD_W = 330;
export const OSD_H = 114;

// Component specific
export const ART_COMPACT = 26;
export const ART_EXPANDED = 110;
export const WAVEFORM_BARS = 14;
export const WAVEFORM_H = 26;
export const OSD_SEG_COUNT = 28;

// Timeouts / Durations
export const OSD_HIDE_MS = 2500;
export const WAVEFORM_MS = 140;
export const SEEK_TICK_S = 1;
export const CLOCK_TICK_MS = 60000;
export const HOVER_DEBOUNCE = 350;

export const State = Object.freeze({
  PILL: "pill",
  COMPACT: "compact",
  EXPANDED: "expanded",
  OSD: "osd",
});
