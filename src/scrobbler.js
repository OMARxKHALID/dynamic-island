/**
 * scrobbler.js
 *
 * Last.fm and ListenBrainz scrobbling for the Dynamic Island extension.
 *
 * Scrobble rules (Last.fm spec):
 *   - Track must be ≥ 30 seconds long.
 *   - Must have played for min(½ duration, 240 s) before the scrobble fires.
 *   - "Now Playing" is sent immediately when a new track starts.
 *   - Play time is accumulated correctly across pause/resume cycles.
 *
 * GSettings keys consumed:
 *   lastfm-enabled, lastfm-api-key, lastfm-api-secret, lastfm-session-key
 *   listenbrainz-enabled, listenbrainz-token
 */

import GLib from "gi://GLib";
import Soup from "gi://Soup";

const LASTFM_URL = "https://ws.audioscrobbler.com/2.0/";
const LB_URL = "https://api.listenbrainz.org/1/submit-listens";
const MIN_DURATION_S = 30; // tracks shorter than this are never scrobbled
const MAX_SCROBBLE_AT_S = 240; // scrobble at most 4 minutes into a track
const POLL_INTERVAL_S = 10; // how often to check whether threshold is reached

export class Scrobbler {
  constructor(settings) {
    this._settings = settings;
    // Session is created lazily in _getSession() so no GObject is constructed
    // during the constructor call (which runs during enable() setup).
    this._session = null;

    this._track = null; // { title, artist, album, durationSecs, startedAt }
    this._playedSecs = 0;
    this._playStartMono = null;
    this._scrobbled = false;
    this._pollSrc = null;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  nowPlaying(title, artist, album, durationSecs) {
    this._reset();

    this._track = {
      title,
      artist,
      album,
      durationSecs,
      startedAt: Math.floor(Date.now() / 1000),
    };
    this._playStartMono = GLib.get_monotonic_time();
    this._scrobbled = false;

    this._dispatch("nowPlaying", this._track);

    if (durationSecs < MIN_DURATION_S) return;

    this._pollSrc = GLib.timeout_add_seconds(
      GLib.PRIORITY_DEFAULT,
      POLL_INTERVAL_S,
      () => {
        if (!this._track || this._scrobbled) return GLib.SOURCE_REMOVE;
        this._checkThreshold();
        return this._scrobbled ? GLib.SOURCE_REMOVE : GLib.SOURCE_CONTINUE;
      },
    );
  }

  paused() {
    this._accumulate();
    this._checkThreshold();
  }

  resumed() {
    if (this._playStartMono === null)
      this._playStartMono = GLib.get_monotonic_time();
  }

  clearMedia() {
    this.paused();
    this._reset();
  }

  destroy() {
    this.clearMedia();
    try {
      this._session?.abort();
    } catch (_e) {}
    this._session = null;
    this._settings = null;
  }

  // ── Internal state management ─────────────────────────────────────────────

  _setStatus(msg) {
    if (!this._settings) return;
    try {
      this._settings.set_string("status-scrobbler", msg);
    } catch (_e) {}
  }

  _getSession() {
    if (!this._session) this._session = new Soup.Session({ timeout: 15 });
    return this._session;
  }

  _accumulate() {
    if (this._playStartMono === null) return;
    const elapsedµs = GLib.get_monotonic_time() - this._playStartMono;
    this._playedSecs += elapsedµs / 1_000_000;
    this._playStartMono = null;
  }

  _totalPlayedSecs() {
    let s = this._playedSecs;
    if (this._playStartMono !== null)
      s += (GLib.get_monotonic_time() - this._playStartMono) / 1_000_000;
    return s;
  }

  _checkThreshold() {
    if (!this._track || this._scrobbled) return;
    const threshold = Math.min(
      Math.floor(this._track.durationSecs / 2),
      MAX_SCROBBLE_AT_S,
    );
    if (this._totalPlayedSecs() >= threshold) {
      this._scrobbled = true;
      this._dispatch("scrobble", this._track);
    }
  }

  _reset() {
    if (this._pollSrc) {
      GLib.Source.remove(this._pollSrc);
      this._pollSrc = null;
    }
    this._track = null;
    this._playedSecs = 0;
    this._playStartMono = null;
    this._scrobbled = false;
  }

  // ── Dispatch to enabled services ──────────────────────────────────────────

  _dispatch(action, track) {
    if (
      this._settings?.get_boolean("lastfm-enabled") &&
      this._settings?.get_string("lastfm-session-key")
    ) {
      if (action === "nowPlaying") this._lastfmNowPlaying(track);
      else this._lastfmScrobble(track);
    }
    if (
      this._settings?.get_boolean("listenbrainz-enabled") &&
      this._settings?.get_string("listenbrainz-token")
    ) {
      if (action === "nowPlaying") this._lbNowPlaying(track);
      else this._lbScrobble(track);
    }
  }

  // ── Last.fm ───────────────────────────────────────────────────────────────

  _lastfmNowPlaying({ title, artist, album, durationSecs }) {
    const params = {
      method: "track.updateNowPlaying",
      track: title,
      artist,
      sk: this._settings.get_string("lastfm-session-key"),
    };
    if (album) params.album = album;
    if (durationSecs > 0) params.duration = String(Math.floor(durationSecs));
    this._lastfmPost(params, (err) => {
      if (err) {
        console.warn(
          "DynamicIsland/Scrobbler: Last.fm now-playing failed:",
          err.message,
        );
        this._setStatus("Last.fm now-playing failed: " + err.message);
      } else {
        this._setStatus(`Last.fm playing: "${title}"`);
      }
    });
  }

  _lastfmScrobble({ title, artist, album, durationSecs, startedAt }) {
    const params = {
      method: "track.scrobble",
      "track[0]": title,
      "artist[0]": artist,
      "timestamp[0]": String(startedAt),
      sk: this._settings.get_string("lastfm-session-key"),
    };
    if (album) params["album[0]"] = album;
    if (durationSecs > 0)
      params["duration[0]"] = String(Math.floor(durationSecs));
    this._lastfmPost(params, (err) => {
      if (err) {
        console.warn(
          "DynamicIsland/Scrobbler: Last.fm scrobble failed:",
          err.message,
        );
        this._setStatus("Last.fm scrobble failed: " + err.message);
      } else {
        console.debug(`DynamicIsland/Scrobbler: Last.fm scrobbled "${title}"`);
        this._setStatus(`Last.fm scrobbled: "${title}"`);
      }
    });
  }

  _lastfmSign(params) {
    const secret = this._settings.get_string("lastfm-api-secret");
    const str =
      Object.keys(params)
        .filter((k) => k !== "format")
        .sort()
        .map((k) => `${k}${params[k]}`)
        .join("") + secret;
    return GLib.compute_checksum_for_string(GLib.ChecksumType.MD5, str, -1);
  }

  _lastfmPost(params, callback) {
    params.api_key = this._settings.get_string("lastfm-api-key");
    params.format = "json";
    params.api_sig = this._lastfmSign(params);

    const body = Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&");

    let msg;
    try {
      msg = Soup.Message.new("POST", LASTFM_URL);
    } catch (e) {
      callback?.(e);
      return;
    }

    msg.set_request_body_from_bytes(
      "application/x-www-form-urlencoded",
      GLib.Bytes.new(new TextEncoder().encode(body)),
    );

    this._getSession().send_and_read_async(
      msg,
      GLib.PRIORITY_DEFAULT,
      null,
      (sess, res) => {
        try {
          sess.send_and_read_finish(res);
          callback?.(null);
        } catch (e) {
          if (!e.message?.includes("cancel")) callback?.(e);
        }
      },
    );
  }

  // ── ListenBrainz ──────────────────────────────────────────────────────────

  _lbNowPlaying({ title, artist, album, durationSecs }) {
    const meta = { artist_name: artist, track_name: title };
    if (album) meta.release_name = album;
    meta.additional_info = { listening_from: "dynamic-island-gnome" };
    if (durationSecs > 0)
      meta.additional_info.duration = Math.floor(durationSecs);
    this._lbPost("playing_now", { track_metadata: meta }, (err) => {
      if (err) {
        this._setStatus("ListenBrainz now-playing failed: " + err.message);
      } else {
        this._setStatus(`ListenBrainz playing: "${title}"`);
      }
    });
  }

  _lbScrobble({ title, artist, album, durationSecs, startedAt }) {
    const meta = {
      artist_name: artist,
      track_name: title,
      additional_info: { listening_from: "dynamic-island-gnome" },
    };
    if (album) meta.release_name = album;
    if (durationSecs > 0)
      meta.additional_info.duration = Math.floor(durationSecs);
    this._lbPost(
      "single",
      { listened_at: startedAt, track_metadata: meta },
      (err) => {
        if (err) {
          this._setStatus("ListenBrainz scrobble failed: " + err.message);
        } else {
          console.debug(
            `DynamicIsland/Scrobbler: ListenBrainz scrobbled "${title}"`,
          );
          this._setStatus(`ListenBrainz scrobbled: "${title}"`);
        }
      },
    );
  }

  _lbPost(listenType, payload, callback) {
    const token = this._settings?.get_string("listenbrainz-token");
    if (!token) return;

    const body = JSON.stringify({
      listen_type: listenType,
      payload: [payload],
    });

    let msg;
    try {
      msg = Soup.Message.new("POST", LB_URL);
    } catch (e) {
      console.warn("DynamicIsland/Scrobbler: LB message error:", e.message);
      return;
    }

    msg.get_request_headers().append("Authorization", `Token ${token}`);
    msg.set_request_body_from_bytes(
      "application/json",
      GLib.Bytes.new(new TextEncoder().encode(body)),
    );

    this._getSession().send_and_read_async(
      msg,
      GLib.PRIORITY_DEFAULT,
      null,
      (sess, res) => {
        try {
          sess.send_and_read_finish(res);
          if (callback) callback(null);
        } catch (e) {
          if (!e.message?.includes("cancel")) {
            console.warn(
              "DynamicIsland/Scrobbler: ListenBrainz failed:",
              e.message,
            );
            if (callback) callback(e);
          }
        }
      },
    );
  }
}
