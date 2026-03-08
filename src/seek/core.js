/**
 * seek/core.js
 *
 * Core logic for track position estimation and MPRIS communication.
 */

import GLib from "gi://GLib";
import Gio from "gi://Gio";

export class SeekCore {
  constructor(settings) {
    this._settings = settings;
    this._proxy = null;
    this._lengthSecs = 0;

    this._anchorPosSecs = 0;
    this._anchorMonoUs = GLib.get_monotonic_time();

    this._fetchGen = 0;
    this._lastResetMonoUs = 0;
  }

  setProxy(proxy) {
    this._proxy = proxy;
  }

  setLength(lengthMicros) {
    const rawLen = Number(lengthMicros);
    this._lengthSecs = isFinite(rawLen) && rawLen > 0 ? rawLen / 1_000_000 : 0;
  }

  estimatePos() {
    const elapsedSecs =
      (GLib.get_monotonic_time() - this._anchorMonoUs) / 1_000_000;
    const pos = this._anchorPosSecs + elapsedSecs;
    return Math.max(0, Math.min(pos, this._lengthSecs || pos));
  }

  resetAnchor(posSecs) {
    this._anchorPosSecs = posSecs;
    this._anchorMonoUs = GLib.get_monotonic_time();
  }

  incrementGen() {
    return ++this._fetchGen;
  }

  getGen() {
    return this._fetchGen;
  }

  resetInhibit() {
    this._lastResetMonoUs = GLib.get_monotonic_time();
  }

  isInhibited() {
    const inhibitMs =
      (GLib.get_monotonic_time() - this._lastResetMonoUs) / 1000;
    return inhibitMs < 2500;
  }

  fetchPosition(generation, callback) {
    if (!this._proxy) return;
    const owner = this._proxy.g_name_owner;
    if (!owner || this.isInhibited()) return;

    Gio.DBus.session.call(
      owner,
      "/org/mpris/MediaPlayer2",
      "org.freedesktop.DBus.Properties",
      "Get",
      new GLib.Variant("(ss)", ["org.mpris.MediaPlayer2.Player", "Position"]),
      new GLib.VariantType("(v)"),
      Gio.DBusCallFlags.NONE,
      2000,
      null,
      (conn, res) => {
        if (!this._proxy || generation !== this._fetchGen || this.isInhibited())
          return;

        try {
          const result = conn.call_finish(res);
          const posVariant = result.get_child_value(0).get_variant();
          const rawPos = posVariant.unpack();
          const posSecs = Number(rawPos) / 1_000_000;

          if (!isFinite(posSecs) || posSecs < 0) return;

          this.resetAnchor(posSecs);
          callback?.(posSecs);
        } catch (_e) {}
      }
    );
  }

  doRelativeSeek(owner, preMicros, targetMicros) {
    const delta = targetMicros - preMicros;
    Gio.DBus.session.call(
      owner,
      "/org/mpris/MediaPlayer2",
      "org.mpris.MediaPlayer2.Player",
      "Seek",
      new GLib.Variant("(x)", [Math.round(delta)]),
      null,
      Gio.DBusCallFlags.NONE,
      3000,
      null,
      null
    );
  }

  doSetPosition(owner, trackId, targetMicros, callback) {
    Gio.DBus.session.call(
      owner,
      "/org/mpris/MediaPlayer2",
      "org.mpris.MediaPlayer2.Player",
      "SetPosition",
      new GLib.Variant("(ox)", [trackId, targetMicros]),
      null,
      Gio.DBusCallFlags.NONE,
      3000,
      null,
      (conn, res) => {
        let ok = false;
        try {
          conn.call_finish(res);
          ok = true;
        } catch (_e) {}
        callback?.(ok);
      }
    );
  }

  getTrackId() {
    try {
      const meta = this._proxy?.get_cached_property("Metadata")?.deepUnpack();
      if (meta?.["mpris:trackid"]) {
        const id = meta["mpris:trackid"].unpack();
        if (
          id &&
          id !== "/org/mpris/MediaPlayer2/TrackList/NoTrack" &&
          id !== "/org/mpris/MediaPlayer2/TrackList/NoTrack/"
        )
          return id;
      }
    } catch (_e) {}
    return null;
  }
}

