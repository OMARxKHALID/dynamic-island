/**
 * extension.js
 *
 * Entry-point for the Dynamic Island GNOME Extension.
 * Handles lifecycle wiring and service orchestration.
 */

import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";

import { IslandCore } from "./src/island/core.js";
import { MprisWatcher } from "./src/mpris.js";
import { OsdInterceptor } from "./src/osd.js";
import { Scrobbler } from "./src/scrobbler.js";
import { WeatherClient } from "./src/weather.js";
import { BluetoothWatcher } from "./src/bluetooth.js";
import { QuickSettingsTile } from "./src/quickToggle.js";
import { FileStash } from "./src/stash.js";
import { NotificationWatcher } from "./src/notification.js";
import { parseArtists } from "./src/utils.js";

export default class DynamicIslandExtension extends Extension {
  enable() {
    this._settings = this.getSettings();
    this._islandEnabled = true;

    this._startIsland();

    this._quickToggle = new QuickSettingsTile(this._settings, (enabled) => {
      this._islandEnabled = enabled;
      if (enabled) {
        this._startIsland();
      } else {
        this._stopIsland();
      }
    });
    this._quickToggle.enable();
  }

  disable() {
    this._quickToggle?.disable();
    this._quickToggle = null;
    this._stopIsland();
    this._settings = null;
    this._islandEnabled = true;
  }

  // ── Service Management ───────────────────────────────────────────────────

  _startIsland() {
    if (this._island) return;

    this._island = new IslandCore(this._settings);
    this._island.init();

    this._mpris = new MprisWatcher(this._settings);
    this._lastMprisStatus = null;
    this._lastMprisTrackId = null;

    this._mprisChangedId = this._mpris.connect(
      "player-changed",
      (_w, proxy) => {
        this._island.updateMedia(proxy);
        this._handleScrobbleState(proxy);
      },
    );
    this._mprisClosedId = this._mpris.connect("player-closed", () => {
      this._island.clearMedia();
      this._scrobbler?.clearMedia();
      this._lastMprisStatus = null;
      this._lastMprisTrackId = null;
    });
    this._mprisSeekId = this._mpris.connect("player-seeked", (_w, posMicros) =>
      this._island.onPlayerSeeked(posMicros),
    );
    this._mpris.start();

    this._osd = null;
    if (this._settings.get_boolean("intercept-osd")) this._enableOsd();
    this._interceptId = this._settings.connect("changed::intercept-osd", () => {
      if (this._settings.get_boolean("intercept-osd")) this._enableOsd();
      else this._disableOsd();
    });

    this._scrobbler = new Scrobbler(this._settings);

    this._weather = new WeatherClient(this._settings);
    this._weather.start((data) => this._island.updateWeather(data));
    this._weatherLocId = this._settings.connect(
      "changed::weather-location",
      () => this._weather.refresh(),
    );
    this._weatherUnitsId = this._settings.connect(
      "changed::weather-units",
      () => this._weather.refresh(),
    );

    this._notifications = new NotificationWatcher();
    this._notifications.connect("notification-added", (_w, notif) => {
      this._island.showNotification(notif);
    });
    this._notifications.start();

    this._bluetooth = new BluetoothWatcher(this._settings);
    this._bluetooth.start((devices) => this._island.updateBluetooth(devices));

    this._stash = new FileStash(this._settings, (files, folderUri) => {
      this._island.updateStash(files, folderUri);
    });
    this._stash.start();

    this._island.setStashActionCallback((action) => {
      if (!this._stash) return;
      if (action === "move") this._stash.executeMove();
      if (action === "copy") this._stash.executeCopy();
      if (action === "clear") this._stash.clear();
    });

    this._stashEnabledId = this._settings.connect(
      "changed::stash-enabled",
      () => {
        if (this._settings.get_boolean("stash-enabled")) {
          this._stash?.start();
        } else {
          this._stash?.stop();
        }
      },
    );
  }

  _stopIsland() {
    for (const id of [
      this._interceptId,
      this._weatherLocId,
      this._weatherUnitsId,
      this._stashEnabledId,
    ]) {
      if (id) this._settings?.disconnect(id);
    }
    this._interceptId =
      this._weatherLocId =
      this._weatherUnitsId =
      this._stashEnabledId =
        null;

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
      if (this._mprisSeekId) {
        this._mpris.disconnect(this._mprisSeekId);
        this._mprisSeekId = null;
      }
      this._mpris.destroy();
      this._mpris = null;
    }

    if (this._island) {
      this._island.destroy();
      this._island = null;
    }
    if (this._scrobbler) {
      this._scrobbler.destroy();
      this._scrobbler = null;
    }
    if (this._weather) {
      this._weather.destroy();
      this._weather = null;
    }

    this._notifications?.stop();
    this._notifications = null;

    if (this._bluetooth) {
      this._bluetooth.destroy();
      this._bluetooth = null;
    }
    if (this._stash) {
      this._stash.destroy();
      this._stash = null;
    }

    this._lastMprisStatus = null;
    this._lastMprisTrackId = null;
  }

  // ── OSD ──────────────────────────────────────────────────────────────────

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

  // ── Scrobbling ───────────────────────────────────────────────────────────

  _handleScrobbleState(proxy) {
    const status =
      proxy.get_cached_property("PlaybackStatus")?.unpack() ?? "Stopped";
    const meta = proxy.get_cached_property("Metadata")?.deepUnpack() ?? {};
    const trackId = meta["mpris:trackid"]?.unpack() ?? null;

    if (status === "Playing") {
      if (trackId !== this._lastMprisTrackId) {
        const title = meta["xesam:title"]?.unpack() ?? "";
        const rawArtists = meta["xesam:artist"]?.deepUnpack() ?? [];
        const artist = parseArtists(rawArtists);
        const album = meta["xesam:album"]?.unpack() ?? "";
        const durµs = Number(meta["mpris:length"]?.unpack() ?? 0);
        this._scrobbler?.nowPlaying(title, artist, album, durµs / 1_000_000);
        this._lastMprisTrackId = trackId;
      } else if (this._lastMprisStatus !== "Playing") {
        this._scrobbler?.resumed();
      }
    } else if (this._lastMprisStatus === "Playing") {
      this._scrobbler?.paused();
    }

    this._lastMprisStatus = status;
  }
}

