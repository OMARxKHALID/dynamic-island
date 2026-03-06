/**
 * osd.js
 *
 * Intercepts GNOME Shell's OSD (volume / brightness popups) and redirects
 * them to the Dynamic Island instead.
 *
 * ⚠ This patches Main.osdWindowManager.show() at runtime. The patch is
 *   carefully designed to fall back to the original implementation for any
 *   icon type we do not handle, and to restore cleanly on disable().
 *
 * FIX #2 — Volume Percentage:
 *   GNOME Shell passes level in the range 0.0–1.0 for normal volume and
 *   0.0–1.5 (or slightly beyond) when "Allow Louder Than 100%" is enabled
 *   (over-amplification). The raw value is clamped here before being forwarded
 *   to the island so the displayed percentage never exceeds 100% on systems
 *   without over-amp and never exceeds 150% on Zorin OS 18 / systems that
 *   have it enabled.
 */

import Gio from "gi://Gio";
import * as Main from "resource:///org/gnome/shell/ui/main.js";

// Maximum level GNOME passes when over-amplification is active.
const OVER_AMP_MAX = 1.5;

export class OsdInterceptor {
  constructor(island) {
    this._island = island;
    this._originalShow = null;
    this._enabled = false;
  }

  enable() {
    const osdManager = Main.osdWindowManager;
    if (typeof osdManager?.show !== "function") {
      console.warn(
        "DynamicIsland: OsdWindowManager.show not found — OSD intercept skipped.",
      );
      return;
    }

    this._originalShow = osdManager.show.bind(osdManager);
    this._enabled = true;

    osdManager.show = (monitorIndex, icon, label, level, maxLevel) => {
      try {
        const iconName = this._resolveIconName(icon);
        const isVolume = iconName.startsWith("audio-volume");
        const isBrightness = iconName.includes("brightness");

        if ((isVolume || isBrightness) && this._island) {
          // FIX #2: Clamp level so the island never shows > 150% (over-amp)
          // or > 100% (normal). maxLevel > 1 signals over-amp is active.
          const effectiveMax =
            maxLevel != null && maxLevel > 1 ? OVER_AMP_MAX : 1.0;
          const clampedLevel = Math.min(level ?? 0, effectiveMax);
          this._island.showOsd(iconName, clampedLevel, effectiveMax);
          return; // consumed — don't call original
        }
      } catch (e) {
        console.error("DynamicIsland: OSD intercept error:", e.message);
      }

      // Fallthrough: let GNOME handle it normally
      this._originalShow?.(monitorIndex, icon, label, level, maxLevel);
    };
  }

  disable() {
    if (this._enabled && this._originalShow) {
      Main.osdWindowManager.show = this._originalShow;
    }
    this._originalShow = null;
    this._island = null;
    this._enabled = false;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  _resolveIconName(icon) {
    if (!icon) return "";
    if (icon instanceof Gio.ThemedIcon) return icon.get_names()[0] ?? "";
    if (typeof icon.to_string === "function") return icon.to_string();
    return "";
  }
}
