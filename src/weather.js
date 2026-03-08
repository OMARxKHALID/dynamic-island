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
const REQUEST_TIMEOUT_S  = 30; // Increased to 30s for slower connections

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
    this._debounceSrc = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 800, () => {
      this._debounceSrc = null;
      this._fetch();
      return GLib.SOURCE_REMOVE;
    });
  }

  /**
   * Search for locations based on a query.
   * Returns a promise resolving to an array of { name, country, lat, lon }.
   */
  search(query) {
    if (!query || query.length < 1) return Promise.resolve([]);
    if (!this._session) return Promise.resolve([]);

    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=5&addressdetails=1`;
    const msg = Soup.Message.new("GET", url);
    msg.get_request_headers().append("User-Agent", "DynamicIsland-GNOME-Extension/1.1 (https://github.com/omarxkhalid/dynamic-island)");

    return new Promise((resolve) => {
      this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (session, res) => {
        try {
          const bytes = session.send_and_read_finish(res);
          if (!bytes) {
            resolve([]);
            return;
          }
          const raw = new TextDecoder().decode(bytes.get_data());
          const json = JSON.parse(raw);
          const mapped = json.map(item => ({
            name: item.display_name,
            lat: item.lat,
            lon: item.lon,
            city: item.address?.city || item.address?.town || item.address?.village || ""
          }));
          resolve(mapped);
        } catch (e) {
          resolve([]);
        }
      });
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

  _setStatus(msg) {
    if (!this._settings) return;
    try {
      this._settings.set_string("status-weather", msg);
    } catch (_e) {}
  }

  _fetch() {
    if (!this._session || !this._settings) return;

    const loc = (this._settings.get_string("weather-location") ?? "").trim();
    if (loc) {
      this._fetchWeather(loc);
    } else {
      this._autoDetectLocationThenFetch();
    }
  }

  _autoDetectLocationThenFetch() {
    this._setStatus("Auto-detecting location...");
    
    // Primary auto-detection via ipapi.co (reliable HTTPS)
    const msg = Soup.Message.new("GET", "https://ipapi.co/json/");
    
    this._session.send_and_read_async(
      msg,
      GLib.PRIORITY_DEFAULT,
      null,
      (sess, res) => {
        try {
          const bytes = sess.send_and_read_finish(res);
          if (bytes) {
            const json = JSON.parse(new TextDecoder().decode(bytes.get_data()));
            if (json.city) {
              this._fetchWeather(json.city);
              return;
            }
          }
        } catch (e) {}
        
        // Fallback: Second auto-detection via freeipapi.com
        try {
          const fMsg = Soup.Message.new("GET", "https://freeipapi.com/api/json");
          this._session.send_and_read_async(fMsg, GLib.PRIORITY_DEFAULT, null, (s, r) => {
            try {
              const b = s.send_and_read_finish(r);
              if (b) {
                const j = JSON.parse(new TextDecoder().decode(b.get_data()));
                if (j.cityName) {
                  this._fetchWeather(j.cityName);
                  return;
                }
              }
            } catch (ex) {}
            // Final fallback: Use wttr.in's own IP-based detection
            this._fetchWeather("");
          });
        } catch (err) {
          this._fetchWeather("");
        }
      },
    );
  }

  _fetchWeather(loc) {
    if (!this._session || !this._settings) return;
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
      this._setStatus("Invalid URL: " + e.message);
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
            this._setStatus("Unknown location");
            this._onUpdate?.({ temp: "?°C", icon: "🌡️" });
            return;
          }

          const sep  = raw.indexOf("|");
          const temp = (sep >= 0 ? raw.slice(0, sep) : raw)
            .trim()
            .replace(/^\+/, "");
          const icon = (sep >= 0 ? raw.slice(sep + 1) : "🌡️").trim();

          this._setStatus("OK (" + new Date().toLocaleTimeString() + ")");
          this._onUpdate?.({ temp, icon });
        } catch (e) {
          if (!e.message?.includes("cancel")) {
            console.warn("DynamicIsland/Weather: fetch failed:", e.message);
            this._setStatus("Failed to fetch: " + e.message);
          }
        }
      },
    );
  }
}
