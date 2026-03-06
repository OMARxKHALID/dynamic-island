/**
 * extension.js
 *
 * Entry point — lifecycle wiring only. No UI code lives here.
 *
 * Modules managed:
 *   DynamicIsland   — the island actor
 *   MprisWatcher    — D-Bus MPRIS media detection
 *   OsdInterceptor  — replaces GNOME's volume/brightness OSD
 *   Scrobbler       — Last.fm / ListenBrainz scrobbling
 *   WeatherClient   — wttr.in weather widget
 *   BluetoothWatcher— BlueZ connected-device indicator
 */

import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";

import { DynamicIsland } from "./src/island.js";
import { MprisWatcher } from "./src/mpris.js";
import { OsdInterceptor } from "./src/osd.js";
import { Scrobbler } from "./src/scrobbler.js";
import { WeatherClient } from "./src/weather.js";
import { BluetoothWatcher } from "./src/bluetooth.js";

export default class DynamicIslandExtension extends Extension {
  enable() {
    this._settings = this.getSettings();

    // ── Island UI ──────────────────────────────────────────────────────────
    this._island = new DynamicIsland(this._settings);
    this._island.init();

    // ── MPRIS watcher ──────────────────────────────────────────────────────
    this._mpris = new MprisWatcher(this._settings);

    // Track last known status/track-id so we can tell the scrobbler about
    // play / pause / resume / new-track transitions.
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
    this._mpris.start();

    // ── OSD intercept ──────────────────────────────────────────────────────
    this._osd = null;
    if (this._settings.get_boolean("intercept-osd")) this._enableOsd();

    this._interceptId = this._settings.connect("changed::intercept-osd", () => {
      if (this._settings.get_boolean("intercept-osd")) this._enableOsd();
      else this._disableOsd();
    });

    // ── Scrobbler ──────────────────────────────────────────────────────────
    this._scrobbler = new Scrobbler(this._settings);

    // ── Weather ────────────────────────────────────────────────────────────
    this._weather = new WeatherClient(this._settings);
    this._weather.start((data) => this._island.updateWeather(data));

    // Refresh when the user changes location or units in prefs
    this._weatherLocId = this._settings.connect(
      "changed::weather-location",
      () => this._weather.refresh(),
    );
    this._weatherUnitsId = this._settings.connect(
      "changed::weather-units",
      () => this._weather.refresh(),
    );

    // ── Bluetooth ──────────────────────────────────────────────────────────
    this._bluetooth = new BluetoothWatcher(this._settings);
    this._bluetooth.start((devices) => this._island.updateBluetooth(devices));
  }

  disable() {
    // Settings listeners
    for (const id of [
      this._interceptId,
      this._weatherLocId,
      this._weatherUnitsId,
    ]) {
      if (id) this._settings.disconnect(id);
    }
    this._interceptId = this._weatherLocId = this._weatherUnitsId = null;

    // OSD
    this._disableOsd();

    // MPRIS
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

    // Island (after MPRIS so no in-flight callbacks hit a dead actor)
    if (this._island) {
      this._island.destroy();
      this._island = null;
    }

    // Scrobbler
    if (this._scrobbler) {
      this._scrobbler.destroy();
      this._scrobbler = null;
    }

    // Weather
    if (this._weather) {
      this._weather.destroy();
      this._weather = null;
    }

    // Bluetooth
    if (this._bluetooth) {
      this._bluetooth.destroy();
      this._bluetooth = null;
    }

    this._lastMprisStatus = null;
    this._lastMprisTrackId = null;
    this._settings = null;
  }

  // ── Private ───────────────────────────────────────────────────────────────

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

  /**
   * Translates MPRIS property-change events into the Scrobbler's API:
   *   nowPlaying() — new track started
   *   paused()     — playback paused/stopped
   *   resumed()    — same track resumed
   */
  _handleScrobbleState(proxy) {
    const status =
      proxy.get_cached_property("PlaybackStatus")?.unpack() ?? "Stopped";
    const meta = proxy.get_cached_property("Metadata")?.deepUnpack() ?? {};
    const trackId = meta["mpris:trackid"]?.unpack() ?? null;

    if (status === "Playing") {
      const isNewTrack = trackId !== this._lastMprisTrackId;

      if (isNewTrack) {
        // Extract track metadata for the scrobbler
        const title = meta["xesam:title"]?.unpack() ?? "";
        const rawArtists = meta["xesam:artist"]?.deepUnpack() ?? [];
        const artist = Array.isArray(rawArtists)
          ? (rawArtists[0] ?? "")
          : String(rawArtists);
        const album = meta["xesam:album"]?.unpack() ?? "";
        const durationµs = Number(meta["mpris:length"]?.unpack() ?? 0);

        this._scrobbler?.nowPlaying(
          title,
          artist,
          album,
          durationµs / 1_000_000,
        );
        this._lastMprisTrackId = trackId;
      } else if (this._lastMprisStatus !== "Playing") {
        // Same track, resumed from pause
        this._scrobbler?.resumed();
      }
    } else if (this._lastMprisStatus === "Playing") {
      // Transitioned from Playing → Paused/Stopped
      this._scrobbler?.paused();
    }

    this._lastMprisStatus = status;
  }
}
