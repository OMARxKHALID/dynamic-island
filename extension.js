import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";

import { DynamicIsland } from "./island.js";
import { MprisWatcher } from "./mpris.js";
import { OsdInterceptor } from "./osd.js";

export default class DynamicIslandExtension extends Extension {
  enable() {
    this._settings = this.getSettings();

    this._island = new DynamicIsland(this._settings);
    this._island.init();

    this._mpris = new MprisWatcher();
    this._mprisChangedId = this._mpris.connect("player-changed", (_w, proxy) =>
      this._island.updateMedia(proxy),
    );
    this._mprisClosedId = this._mpris.connect("player-closed", () =>
      this._island.clearMedia(),
    );
    this._mpris.start();

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
    if (this._interceptSettingId) {
      this._settings.disconnect(this._interceptSettingId);
      this._interceptSettingId = null;
    }

    this._disableOsd();

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

    if (this._island) {
      this._island.destroy();
      this._island = null;
    }
    this._settings = null;
  }

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
