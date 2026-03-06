/**
 * scrobbler.js
 *
 * Last.fm and ListenBrainz scrobbling for the Dynamic Island extension.
 *
 * Scrobble rules (Last.fm spec):
 *   • Track must be ≥ 30 seconds long.
 *   • Must have played for min(½ duration, 240 s) before the scrobble fires.
 *   • "Now Playing" is sent immediately when a new track starts.
 *   • Play time is accumulated correctly across pause/resume cycles.
 *
 * GSettings keys consumed (all in the extension schema):
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
    this._session = new Soup.Session({ timeout: 15 });

    // Current track state
    this._track = null; // { title, artist, album, durationSecs, startedAt }
    this._playedSecs = 0; // total play time accumulated for this track
    this._playStartMono = null; // monotonic µs when current play-session began (null if paused)
    this._scrobbled = false; // have we already scrobbled this track?
    this._pollSrc = null; // GLib timer id for threshold polling
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Call when a new track starts playing.
   * @param {string} title
   * @param {string} artist
   * @param {string} album
   * @param {number} durationSecs — track length in seconds (0 = unknown)
   */
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

    // Send "Now Playing" to each enabled service
    this._dispatch("nowPlaying", this._track);

    // Don't schedule polling for very short or unknown-length tracks
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

  /** Call when playback pauses or the player reports Paused/Stopped. */
  paused() {
    this._accumulate();
    this._checkThreshold(); // scrobble immediately if threshold was already passed
  }

  /** Call when the same track resumes after a pause. */
  resumed() {
    if (this._playStartMono === null)
      this._playStartMono = GLib.get_monotonic_time();
  }

  /** Call when all media stops (player gone). Flushes pending scrobble. */
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

  /** Accumulate elapsed play time from current play-session into _playedSecs. */
  _accumulate() {
    if (this._playStartMono === null) return;
    const elapsedµs = GLib.get_monotonic_time() - this._playStartMono;
    this._playedSecs += elapsedµs / 1_000_000;
    this._playStartMono = null;
  }

  /** Total seconds played so far (accumulated + ongoing session). */
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

  /**
   * @param {"nowPlaying"|"scrobble"} action
   * @param {object} track
   */
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
      if (err)
        console.warn(
          "DynamicIsland/Scrobbler: Last.fm now-playing failed:",
          err.message,
        );
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
      if (err)
        console.warn(
          "DynamicIsland/Scrobbler: Last.fm scrobble failed:",
          err.message,
        );
      else console.log(`DynamicIsland/Scrobbler: Last.fm scrobbled "${title}"`);
    });
  }

  /** Compute the HMAC-style MD5 signature required by the Last.fm API. */
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
    if (!this._session) return;
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

    this._session.send_and_read_async(
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
    this._lbPost("playing_now", { track_metadata: meta });
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
    this._lbPost("single", { listened_at: startedAt, track_metadata: meta });
    console.log(`DynamicIsland/Scrobbler: ListenBrainz scrobbled "${title}"`);
  }

  _lbPost(listenType, payload) {
    if (!this._session) return;
    const token = this._settings.get_string("listenbrainz-token");
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

    this._session.send_and_read_async(
      msg,
      GLib.PRIORITY_DEFAULT,
      null,
      (sess, res) => {
        try {
          sess.send_and_read_finish(res);
        } catch (e) {
          if (!e.message?.includes("cancel"))
            console.warn(
              "DynamicIsland/Scrobbler: ListenBrainz failed:",
              e.message,
            );
        }
      },
    );
  }
}
