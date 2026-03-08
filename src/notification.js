/**
 * notification.js
 *
 * System service for watching GNOME Shell notifications.
 */

import GObject from "gi://GObject";
import * as Main from "resource:///org/gnome/shell/ui/main.js";

export const NotificationWatcher = GObject.registerClass(
  {
    Signals: {
      "notification-added": { param_types: [GObject.Object] },
    },
  },
  class NotificationWatcher extends GObject.Object {
    constructor() {
      super();
      this._sources = new Map();
      this._addedId = 0;
    }

    start() {
      this.stop();

      this._addedId = Main.messageTray.connect("source-added", (_tray, source) => {
        this._watchSource(source);
      });

      Main.messageTray.getSources().forEach((s) => this._watchSource(s));
    }

    stop() {
      if (this._addedId) {
        Main.messageTray.disconnect(this._addedId);
        this._addedId = 0;
      }
      for (const [source, id] of this._sources) {
        source.disconnect(id);
      }
      this._sources.clear();
    }

    _watchSource(source) {
      if (this._sources.has(source)) return;

      const id = source.connect("notification-added", (_src, notif) => {
        this.emit("notification-added", notif);
      });
      this._sources.set(source, id);

      source.connect("destroy", () => {
        this._sources.delete(source);
      });
    }
  },
);
