/**
 * quickToggle.js
 *
 * Adds a Quick Settings tile that lets the user toggle the Dynamic Island.
 * Uses addQuickSettingsItems() — the correct public API on GNOME 43+.
 */

import GObject from "gi://GObject";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import { QuickToggle } from "resource:///org/gnome/shell/ui/quickSettings.js";

// ── GObject tile class ────────────────────────────────────────────────────────

const IslandTile = GObject.registerClass(
  {
    Signals: {
      "island-toggled": { param_types: [GObject.TYPE_BOOLEAN] },
      "open-prefs":     {},
    },
  },
  class IslandTile extends QuickToggle {
    _init(settings) {
      super._init({
        title:       "Dynamic Island",
        icon_name:   "audio-x-generic-symbolic",
        toggle_mode: true,
      });

      this._settings  = settings;
      this.checked    = true; // island is running when tile is created

      this._updateSubtitle();
      this._settingsId = this._settings.connect("changed::auto-hide", () =>
        this._updateSubtitle(),
      );

      this.connect("clicked", () => {
        this.emit("island-toggled", this.checked);
      });
    }

    _updateSubtitle() {
      this.subtitle = this._settings.get_boolean("auto-hide")
        ? "Auto-hide on"
        : "Always visible";
    }

    destroy() {
      if (this._settingsId && this._settings) {
        this._settings.disconnect(this._settingsId);
        this._settingsId = 0;
      }
      this._settings = null;
      super.destroy();
    }
  },
);

// ── Public wrapper ────────────────────────────────────────────────────────────

export class QuickSettingsTile {
  constructor(settings, onToggle, onOpenPrefs) {
    this._settings    = settings;
    this._onToggle    = onToggle;
    this._onOpenPrefs = onOpenPrefs;
    this._tile        = null;
    this._toggledId   = 0;
    this._openPrefsId = 0;
  }

  enable() {
    const qs = Main.panel?.statusArea?.quickSettings;
    if (!qs) return; // GNOME < 43

    this._tile = new IslandTile(this._settings);

    this._toggledId = this._tile.connect("island-toggled", (_tile, enabled) => {
      this._onToggle?.(enabled);
    });
    this._openPrefsId = this._tile.connect("open-prefs", () => {
      this._onOpenPrefs?.();
    });

    try {
      qs.addQuickSettingsItems([this._tile]);
    } catch (e) {
      console.warn("DynamicIsland: could not add Quick Settings tile:", e.message);
      this._tile.destroy();
      this._tile = null;
    }
  }

  disable() {
    if (this._tile) {
      if (this._toggledId) {
        this._tile.disconnect(this._toggledId);
        this._toggledId = 0;
      }
      if (this._openPrefsId) {
        this._tile.disconnect(this._openPrefsId);
        this._openPrefsId = 0;
      }
      this._tile.destroy();
      this._tile = null;
    }
    this._settings    = null;
    this._onToggle    = null;
    this._onOpenPrefs = null;
  }

  setEnabled(enabled) {
    if (this._tile) this._tile.checked = enabled;
  }
}
