/**
 * osd.js
 *
 * Intercepts GNOME Shell's OSD (volume / brightness popups).
 */

import Gio from "gi://Gio";
import * as Main from "resource:///org/gnome/shell/ui/main.js";

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
          const effectiveMax =
            maxLevel != null && maxLevel > 1 ? OVER_AMP_MAX : 1.0;
          const clampedLevel = Math.min(level ?? 0, effectiveMax);
          this._island.showOsd(iconName, clampedLevel, effectiveMax);
          return; // consumed — suppress the default popup
        }
      } catch (e) {
        console.error("DynamicIsland: OSD intercept error:", e.message);
      }

      // Fallthrough: let GNOME handle any icon type we don't recognise
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

  // ── Helpers ───────────────────────────────────────────────────────────────

  _resolveIconName(icon) {
    if (!icon) return "";
    if (icon instanceof Gio.ThemedIcon) return icon.get_names()[0] ?? "";
    if (typeof icon.to_string === "function") return icon.to_string();
    return "";
  }
}
