/**
 * extension.js
 *
 * Entry point for the Dynamic Island extension.
 * Responsible only for lifecycle wiring — no UI code lives here.
 *
 * Follows the official review guidelines:
 *   • enable()  — creates all objects, connects signals
 *   • disable() — destroys all objects, disconnects signals, removes sources
 */

import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";

import { DynamicIsland } from "./src/island.js";
import { MprisWatcher } from "./src/mpris.js";
import { OsdInterceptor } from "./src/osd.js";

export default class DynamicIslandExtension extends Extension {
  enable() {
    this._settings = this.getSettings();

    // Core island UI
    this._island = new DynamicIsland(this._settings);
    this._island.init();

    // MPRIS media watcher
    this._mpris = new MprisWatcher();
    this._mprisChangedId = this._mpris.connect("player-changed", (_w, proxy) =>
      this._island.updateMedia(proxy),
    );
    this._mprisClosedId = this._mpris.connect("player-closed", () =>
      this._island.clearMedia(),
    );
    this._mpris.start();

    // OSD intercept (volume / brightness popups)
    this._osd = null;
    if (this._settings.get_boolean("intercept-osd")) this._enableOsd();

    this._interceptSettingId = this._settings.connect(
      "changed::intercept-osd",
      () => {
        if (this._settings.get_boolean("intercept-osd")) this._enableOsd();
        else this._disableOsd();
      },
    );
  }

  disable() {
    // Disconnect settings listener first
    if (this._interceptSettingId) {
      this._settings.disconnect(this._interceptSettingId);
      this._interceptSettingId = null;
    }

    // Tear down OSD intercept
    this._disableOsd();

    // Tear down MPRIS watcher
    if (this._mpris) {
      if (this._mprisChangedId) {
        this._mpris.disconnect(this._mprisChangedId);
        this._mprisChangedId = null;
      }
      if (this._mprisClosedId) {
        this._mpris.disconnect(this._mprisClosedId);
        this._mprisClosedId = null;
      }
      this._mpris.destroy();
      this._mpris = null;
    }

    // Tear down island (must come after MPRIS so no callbacks fire into it)
    if (this._island) {
      this._island.destroy();
      this._island = null;
    }

    this._settings = null;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  _enableOsd() {
    if (this._osd || !this._island) return;
    this._osd = new OsdInterceptor(this._island);
    this._osd.enable();
  }

  _disableOsd() {
    if (this._osd) {
      this._osd.disable();
      this._osd = null;
    }
  }
}
