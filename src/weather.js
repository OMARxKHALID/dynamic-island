/**
 * weather.js
 *
 * Lightweight weather client for the Dynamic Island pill view.
 * Uses wttr.in (no API key required).
 *
 * GSettings keys consumed:
 *   show-weather, weather-location (empty = auto-detect), weather-units
 *
 * Calls onUpdate({ temp: "22°C", icon: "☀️" }) after every successful fetch.
 */

import GLib from "gi://GLib";
import Soup from "gi://Soup";

const WTTR_BASE         = "https://wttr.in";
const REFRESH_INTERVAL_S = 30 * 60; // fetch every 30 minutes
const REQUEST_TIMEOUT_S  = 15;

export class WeatherClient {
  constructor(settings) {
    this._settings   = settings;
    this._session    = null;
    this._refreshSrc = null;
    this._debounceSrc = null; // always initialised to null
    this._onUpdate   = null;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  start(onUpdate) {
    this._onUpdate = onUpdate;
    this._session  = new Soup.Session({ timeout: REQUEST_TIMEOUT_S });

    this._fetch();

    this._refreshSrc = GLib.timeout_add_seconds(
      GLib.PRIORITY_DEFAULT,
      REFRESH_INTERVAL_S,
      () => {
        this._fetch();
        return GLib.SOURCE_CONTINUE;
      },
    );
  }

  /**
   * Trigger a re-fetch, debounced by 500 ms to avoid flooding the network
   * when the user types character-by-character in the location field.
   */
  refresh() {
    if (this._debounceSrc) {
      GLib.Source.remove(this._debounceSrc);
      this._debounceSrc = null;
    }
    this._debounceSrc = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
      this._debounceSrc = null;
      this._fetch();
      return GLib.SOURCE_REMOVE;
    });
  }

  destroy() {
    if (this._debounceSrc) {
      GLib.Source.remove(this._debounceSrc);
      this._debounceSrc = null;
    }
    if (this._refreshSrc) {
      GLib.Source.remove(this._refreshSrc);
      this._refreshSrc = null;
    }
    try {
      this._session?.abort();
    } catch (_e) {}
    this._session  = null;
    this._onUpdate = null;
    this._settings = null;
  }

  // ── Private ───────────────────────────────────────────────────────────────

  _fetch() {
    if (!this._session || !this._settings) return;

    const loc   = (this._settings.get_string("weather-location") ?? "").trim();
    const units = this._settings.get_string("weather-units") === "imperial" ? "u" : "m";

    // %t = temperature | %c = weather condition emoji
    const formatStr = "%t|%c";
    const url = loc
      ? `${WTTR_BASE}/${encodeURIComponent(loc)}?format=${encodeURIComponent(formatStr)}&${units}`
      : `${WTTR_BASE}/?format=${encodeURIComponent(formatStr)}&${units}`;

    let msg;
    try {
      msg = Soup.Message.new("GET", url);
    } catch (e) {
      console.warn("DynamicIsland/Weather: invalid URL:", e.message);
      return;
    }
    msg.get_request_headers().append(
      "User-Agent",
      "DynamicIsland-GNOME-Extension/1.0 (https://github.com/omarxkhalid/dynamic-island)",
    );

    this._session.send_and_read_async(
      msg,
      GLib.PRIORITY_DEFAULT,
      null,
      (sess, res) => {
        try {
          const bytes = sess.send_and_read_finish(res);
          if (!bytes) return;

          const raw = new TextDecoder()
            .decode(bytes.get_data() ?? new Uint8Array())
            .trim();

          if (!raw || raw.toLowerCase().startsWith("unknown")) {
            this._onUpdate?.({ temp: "?°C", icon: "🌡️" });
            return;
          }

          const sep  = raw.indexOf("|");
          const temp = (sep >= 0 ? raw.slice(0, sep) : raw)
            .trim()
            .replace(/^\+/, "");
          const icon = (sep >= 0 ? raw.slice(sep + 1) : "🌡️").trim();

          this._onUpdate?.({ temp, icon });
        } catch (e) {
          if (!e.message?.includes("cancel"))
            console.warn("DynamicIsland/Weather: fetch failed:", e.message);
        }
      },
    );
  }
}
