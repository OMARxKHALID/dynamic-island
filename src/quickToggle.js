/**
 * quickToggle.js
 *
 * Adds a Quick Settings tile that lets the user toggle the Dynamic Island.
 */

import GObject from "gi://GObject";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import { SystemIndicator, QuickToggle } from "resource:///org/gnome/shell/ui/quickSettings.js";

// ── GObject indicator class ───────────────────────────────────────────────────

const IslandIndicator = GObject.registerClass(
  class IslandIndicator extends SystemIndicator {
    _init(settings) {
      super._init();
      this._settings = settings;

      this._toggle = new QuickToggle({
        title: "Dynamic Island",
        icon_name: "audio-x-generic-symbolic",
        toggle_mode: true,
      });
      
      this._toggle.checked = true;
      this.quickSettingsItems.push(this._toggle);

      this._updateSubtitle();
      this._settingsId = this._settings.connect("changed::auto-hide", () =>
        this._updateSubtitle(),
      );
    }

    _updateSubtitle() {
      this._toggle.subtitle = this._settings.get_boolean("auto-hide")
        ? "Auto-hide on"
        : "Always visible";
    }

    get toggle() {
      return this._toggle;
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
  constructor(settings, onToggle) {
    this._settings    = settings;
    this._onToggle    = onToggle;
    this._indicator   = null;
    this._toggledId   = 0;
  }

  enable() {
    const qs = Main.panel?.statusArea?.quickSettings;
    if (!qs) return;

    this._indicator = new IslandIndicator(this._settings);

    this._toggledId = this._indicator.toggle.connect("notify::checked", () => {
      this._onToggle?.(this._indicator.toggle.checked);
    });

    try {
      qs.addExternalIndicator(this._indicator);
    } catch (e) {
      console.warn("DynamicIsland: could not add Quick Settings indicator:", e.message);
      this._indicator.destroy();
      this._indicator = null;
    }
  }

  disable() {
    const qs = Main.panel?.statusArea?.quickSettings;
    if (this._indicator) {
      if (this._toggledId) {
        this._indicator.toggle.disconnect(this._toggledId);
        this._toggledId = 0;
      }
      if (qs) {
        try {
          qs.removeExternalIndicator(this._indicator);
        } catch (e) {
          console.warn("DynamicIsland: could not remove Quick Settings indicator:", e.message);
        }
      }
      this._indicator.destroy();
      this._indicator = null;
    }
    this._settings = null;
    this._onToggle = null;
  }

  setEnabled(enabled) {
    if (this._indicator) this._indicator.toggle.checked = enabled;
  }
}
