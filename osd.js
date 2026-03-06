import Gio from "gi://Gio";
import * as Main from "resource:///org/gnome/shell/ui/main.js";

export class OsdInterceptor {
  constructor(island) {
    this._island = island;
    this._originalShow = null;
  }

  enable() {
    const osdManager = Main.osdWindowManager;
    this._originalShow = osdManager.show.bind(osdManager);

    osdManager.show = (monitorIndex, icon, label, level, maxLevel) => {
      const iconName = this._resolveIconName(icon);
      const isVolume = iconName.startsWith("audio-volume");
      const isBright = iconName.includes("brightness");

      if (isVolume || isBright) {
        this._island.showOsd(iconName, level ?? 0, maxLevel ?? 1);
        return;
      }
      this._originalShow(monitorIndex, icon, label, level, maxLevel);
    };
  }

  disable() {
    if (this._originalShow) {
      Main.osdWindowManager.show = this._originalShow;
      this._originalShow = null;
    }
    this._island = null;
  }

  _resolveIconName(icon) {
    if (!icon) return "";
    if (icon instanceof Gio.ThemedIcon) return icon.get_names()[0] ?? "";
    if (typeof icon.to_string === "function") return icon.to_string();
    return "";
  }
}
