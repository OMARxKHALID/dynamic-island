/**
 * seekTracker.js
 *
 * Manages the seek bar: position display, tick polling, click-to-seek,
 * and drag-to-seek.
 *
 * ── ROOT CAUSE ANALYSIS AND FIXES ───────────────────────────────────────────
 *
 * BUG 1 — Bar shows as full / wrong position at start
 *   recursiveUnpack() on a GLib.Variant of type "(v)" has a known issue in
 *   some GJS versions where it does not correctly penetrate the variant
 *   container for int64 types (GJS issue #206).  The result can be a stale or
 *   garbage value that, when divided by 1_000_000, gives a huge number of
 *   "seconds" — larger than the track duration — which is then clamped to the
 *   duration, making the bar appear 100% full.
 *
 *   Fix: use result.get_child_value(0).get_variant().unpack() which is the
 *   correct, version-proven approach for unwrapping (v) containing x (int64).
 *
 * BUG 2 — Hovering over the seek bar causes it to seek
 *   button-release-event was connected only on _seekHit (the widget).  When
 *   the user releases the mouse button while the pointer is OUTSIDE the widget,
 *   the release event is never delivered to the widget — so _dragging stays
 *   true forever.  Every subsequent mouse movement anywhere on screen then
 *   calls _seekToEvent(), causing constant phantom seeking.
 *
 *   Fix: connect button-release-event on global.stage so release is always
 *   caught regardless of pointer position.
 *
 * BUG 3 — Seek position reverts after click/drag
 *   _fetchPosition() was called from both the periodic tick and after each
 *   seek.  The tick-fired D-Bus call (carrying the old pre-seek position) can
 *   arrive AFTER the post-seek confirmation call, overwriting the correct
 *   anchor with stale data.
 *
 *   Fix: remove _fetchPosition() from the tick entirely (local-clock
 *   interpolation is accurate enough between track start and seek events).
 *   Use a _fetchGen counter: increment it on every seek; each async call
 *   captures its generation at dispatch time and discards the result if the
 *   generation has advanced since (i.e. a newer seek invalidated it).
 *   Also delay the post-seek confirmation by 400 ms so the player has time to
 *   process SetPosition/Seek before we query it back.
 *
 * BUG 4 — Bluetooth chip not appearing in expanded view (fixed in island.js)
 *   See island.js _transitionTo() onComplete for EXPANDED state.
 *
 * ── WHY get_cached_property("Position") DOES NOT WORK ───────────────────────
 *   MPRIS players never include Position in PropertiesChanged (it changes
 *   every millisecond — broadcasting it would flood the bus).  We fetch it
 *   once on track start/resume and once (delayed) after each seek, then
 *   interpolate with GLib.get_monotonic_time().
 *
 * Public API:
 *   setWidgets(seekHit, seekBg, seekFill, posLabel, durLabel)
 *   start(proxy, lengthMicros)   — begin / resume for current track
 *   reset(proxy, lengthMicros)   — new track (resets position to 0)
 *   stop()                       — pause: halt tick, keep last frame
 *   renderNow()                  — force one immediate UI frame
 *   destroy()
 */

import GLib from "gi://GLib";
import Gio from "gi://Gio";
import Clutter from "gi://Clutter";

import { SEEK_TICK_S } from "./constants.js";

/** Format seconds as "m:ss".  Returns "0:00" on any non-finite input. */
function formatSecs(totalSecs) {
  if (!isFinite(totalSecs) || totalSecs < 0) return "0:00";
  const s = Math.max(0, Math.floor(totalSecs));
  const m = Math.floor(s / 60);
  const ss = s % 60;
  return `${m}:${ss.toString().padStart(2, "0")}`;
}

export class SeekTracker {
  constructor(settings) {
    this._settings = settings;

    this._proxy = null;
    this._lengthSecs = 0;
    this._tickSrc = null;

    // Local-clock position anchor
    // Initialised to "now" (not 0) so that if renderNow() is ever called
    // before start(), elapsed time won't be measured from system boot.
    this._anchorPosSecs = 0;
    this._anchorMonoUs = GLib.get_monotonic_time();

    // Monotonically increasing fetch generation counter.
    // Every seek increments this.  A _fetchPosition() callback checks that
    // its captured generation still matches before applying the result.
    this._fetchGen = 0;

    // Timer that fires a post-seek position confirmation after 400 ms
    this._seekFetchSrc = null;

    // Widgets
    this._seekHit = null;
    this._seekBg = null;
    this._seekFill = null;
    this._posLabel = null;
    this._durLabel = null;

    // Per-widget press handler
    this._pressId = 0;

    // Global stage handlers — connected ONLY during an active drag, so that
    // both motion and release are caught even when the pointer leaves the widget
    this._globalMotionId = 0;
    this._globalReleaseId = 0;

    this._dragging = false;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Wire up the seek-bar widgets.  Safe to call multiple times — old handlers
   * are always disconnected first.
   */
  setWidgets(seekHit, seekBg, seekFill, posLabel, durLabel) {
    this._disconnectAllHandlers();

    this._seekHit = seekHit;
    this._seekBg = seekBg;
    this._seekFill = seekFill;
    this._posLabel = posLabel;
    this._durLabel = durLabel;

    if (!this._seekHit) return;

    // Only left-click starts a drag
    this._pressId = this._seekHit.connect("button-press-event", (_a, ev) => {
      if (ev.get_button() !== 1) return Clutter.EVENT_PROPAGATE;
      this._dragging = true;
      this._seekToEvent(ev, false); // visually update only, do not commit
      this._connectGlobalDrag(); // capture motion + release globally
      return Clutter.EVENT_STOP;
    });
  }

  /**
   * Begin or resume ticking.
   * Called only on a genuine play-from-pause resume (see island.js updateMedia).
   * Does NOT reset _anchorPosSecs so the bar stays at the last known position.
   */
  start(proxy, lengthMicros) {
    this._proxy = proxy;

    const rawLen = Number(lengthMicros);
    this._lengthSecs = isFinite(rawLen) && rawLen > 0 ? rawLen / 1_000_000 : 0;

    // Re-anchor local clock at current estimate (position preserved from pause)
    this._anchorMonoUs = GLib.get_monotonic_time();

    this._startTick();
    this._fetchPosition(this._fetchGen);
  }

  /** New track: hard-reset position to 0, then start fresh. */
  reset(proxy, lengthMicros) {
    // Invalidate any in-flight or pending position fetch from the old track
    this._fetchGen++;
    this._cancelSeekFetch();

    this._anchorPosSecs = 0;
    this._anchorMonoUs = GLib.get_monotonic_time();
    this.stop();
    this.start(proxy, lengthMicros);
  }

  /** Pause: stop the tick but keep the last UI frame visible. */
  stop() {
    if (this._tickSrc) {
      GLib.Source.remove(this._tickSrc);
      this._tickSrc = null;
    }
  }

  /**
   * Called when the MPRIS Seeked signal arrives — the player moved its
   * position externally (user scrubbed in Spotify/VLC, etc).
   * Re-anchors the local clock immediately so we stop interpolating from
   * the stale pre-seek position.
   *
   * @param {number} posMicros  New absolute position in microseconds.
   */
  seekedTo(posMicros) {
    const posSecs = Number(posMicros) / 1_000_000;
    if (!isFinite(posSecs) || posSecs < 0) return;

    // Invalidate any in-flight or pending position fetch so it can't
    // overwrite this fresh anchor with a stale value.
    this._fetchGen++;
    this._cancelSeekFetch();

    this._anchorPosSecs = posSecs;
    this._anchorMonoUs = GLib.get_monotonic_time();
    this._updateUI(posSecs);
  }

  /** Force one immediate UI render from the current estimated position. */
  renderNow() {
    this._updateUI(this._estimatePos());
  }

  /**
   * Fetch the real playback position from the player and render.
   * Called by island.js after the expanded view is laid out so get_width()
   * returns the correct allocated width (not 0 or a stale natural size).
   */
  fetchNow() {
    if (!this._proxy) {
      this._updateUI(this._estimatePos());
      return;
    }
    // Use the current generation so the result is not discarded
    this._fetchPosition(this._fetchGen);
  }

  destroy() {
    this.stop();
    this._cancelSeekFetch();
    this._disconnectAllHandlers();
    this._proxy = null;
    this._settings = null;
    this._seekHit = null;
    this._seekBg = null;
    this._seekFill = null;
    this._posLabel = null;
    this._durLabel = null;
  }

  // ── Private — tick ─────────────────────────────────────────────────────────

  _startTick() {
    this.stop();
    this._tickSrc = GLib.timeout_add_seconds(
      GLib.PRIORITY_DEFAULT,
      SEEK_TICK_S,
      () => {
        if (!this._proxy) return GLib.SOURCE_REMOVE;
        if (this._dragging) return GLib.SOURCE_CONTINUE; // do not fight user drag
        // Tick uses pure local-clock interpolation only.
        // _fetchPosition is NOT called here — that prevents stale D-Bus
        // responses from overwriting a freshly-set seek anchor.
        this._updateUI(this._estimatePos());
        return GLib.SOURCE_CONTINUE;
      },
    );
  }

  _estimatePos() {
    const elapsedSecs =
      (GLib.get_monotonic_time() - this._anchorMonoUs) / 1_000_000;
    const pos = this._anchorPosSecs + elapsedSecs;
    return Math.max(0, Math.min(pos, this._lengthSecs || pos));
  }

  // ── Private — D-Bus position fetch ─────────────────────────────────────────

  /**
   * Async Properties.Get("Position").
   *
   * BUG FIX: The D-Bus reply type is "(v)" — a 1-tuple containing a variant
   * which itself holds an int64 (type "x").
   *
   * recursiveUnpack() has a known GJS issue (#206) where it does not properly
   * unwrap variant containers for 64-bit integer types, potentially returning
   * garbage or a zero value.
   *
   * The correct approach (confirmed in GJS issue #206):
   *   result.get_child_value(0)   → the "v" variant wrapper
   *         .get_variant()        → the "x" int64 variant inside it
   *         .unpack()             → the JS Number value
   *
   * @param {number} generation - Must match this._fetchGen when the callback
   *   fires, otherwise the result is discarded as stale.
   */
  _fetchPosition(generation) {
    if (!this._proxy) return;
    const owner = this._proxy.g_name_owner;
    if (!owner) return;

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
        // Discard if proxy was destroyed or a newer seek invalidated us
        if (!this._proxy || generation !== this._fetchGen) return;
        try {
          const result = conn.call_finish(res);

          // ── Correct (v) → x unpack ──────────────────────────────────────
          // result type: (v)  — 1-tuple wrapping a variant
          // get_child_value(0): the variant wrapper "v"
          // .get_variant():     the int64 "x" inside it
          // .unpack():          the JS Number
          const posVariant = result.get_child_value(0).get_variant();
          const rawPos = posVariant.unpack();
          const posSecs = Number(rawPos) / 1_000_000;

          if (!isFinite(posSecs) || posSecs < 0) return;

          this._anchorPosSecs = posSecs;
          this._anchorMonoUs = GLib.get_monotonic_time();
          this._updateUI(posSecs);
        } catch (_e) {
          // Non-fatal — local-clock interpolation continues from last anchor
        }
      },
    );
  }

  // ── Private — UI update ────────────────────────────────────────────────────

  _updateUI(posSecs) {
    if (!this._seekFill || !this._seekBg) return;

    const dur = this._lengthSecs;
    const pos = dur > 0 ? Math.min(posSecs, dur) : posSecs;

    if (this._posLabel) this._posLabel.set_text(formatSecs(pos));
    if (this._durLabel)
      this._durLabel.set_text(dur > 0 ? formatSecs(dur) : "--:--");

    if (dur > 0) {
      const bgW = this._seekBg.get_width();
      if (bgW > 0)
        this._seekFill.set_width(Math.max(0, Math.floor((pos / dur) * bgW)));
    } else {
      this._seekFill.set_width(0);
    }
  }

  // ── Private — seek ─────────────────────────────────────────────────────────

  _seekToEvent(ev, commit = true) {
    if (!this._proxy || !this._seekBg || this._lengthSecs <= 0) return;

    // ev.get_coords() → [x, y] in GJS (no boolean ok flag)
    const [evX] = ev.get_coords();
    // get_transformed_position() → [x, y] stage-global coords
    const [bgX] = this._seekBg.get_transformed_position();
    const bgW = this._seekBg.get_width();
    if (bgW <= 0) return;

    const ratio = Math.max(0, Math.min((evX - bgX) / bgW, 1));
    const targetSecs = ratio * this._lengthSecs;

    if (!commit) {
      this._updateUI(targetSecs);
      return;
    }

    // Increment generation — any in-flight position fetch is now stale
    this._fetchGen++;
    const gen = this._fetchGen;

    // ── BUG FIX: save the PRE-seek position BEFORE updating the anchor ──────
    // The Seek fallback uses a relative delta.  If we calculate delta from
    // _estimatePos() AFTER setting _anchorPosSecs = targetSecs, the estimate
    // already returns ~targetSecs, so delta ≈ 0 and the Seek call does nothing.
    const preSeekMicros = Math.round(this._estimatePos() * 1_000_000);

    // Optimistic update — bar snaps immediately to clicked position
    this._anchorPosSecs = targetSecs;
    this._anchorMonoUs = GLib.get_monotonic_time();
    this._updateUI(targetSecs);

    // Cancel any previously scheduled post-seek confirmation
    this._cancelSeekFetch();

    const owner = this._proxy.g_name_owner;
    if (!owner) return;

    const targetMicros = Math.round(targetSecs * 1_000_000);

    // ── BUG FIX: trackId resolution ─────────────────────────────────────────
    // Per the MPRIS spec, SetPosition MUST be called with the object path of
    // the current track.  Players are required to silently ignore the call if
    // the trackId doesn't match.  "/org/mpris/MediaPlayer2/TrackList/NoTrack"
    // is explicitly NOT a valid value — it will always be ignored.
    //
    // Strategy:
    //   1. Try to read mpris:trackid from the cached Metadata property.
    //   2. If a valid (non-NoTrack) trackId is available → use SetPosition.
    //   3. If trackId is missing or NoTrack → skip SetPosition entirely and
    //      go straight to Seek (relative offset), which has no trackId guard.
    let trackId = null;
    try {
      const meta = this._proxy.get_cached_property("Metadata")?.deepUnpack();
      if (meta?.["mpris:trackid"]) {
        const id = meta["mpris:trackid"].unpack();
        if (
          id &&
          id !== "/org/mpris/MediaPlayer2/TrackList/NoTrack" &&
          id !== "/org/mpris/MediaPlayer2/TrackList/NoTrack/"
        )
          trackId = id;
      }
    } catch (_e) {}

    if (trackId) {
      // Absolute seek via SetPosition (preferred — most accurate)
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
          } catch (_e) {
            // SetPosition failed — fall through to Seek
          }

          if (!ok) {
            this._doRelativeSeek(owner, preSeekMicros, targetMicros);
          }

          if (!this._proxy) return;
          this._schedulePostSeekFetch(gen);
        },
      );
    } else {
      // No valid trackId — go straight to relative Seek
      this._doRelativeSeek(owner, preSeekMicros, targetMicros);
      this._schedulePostSeekFetch(gen);
    }
  }

  _cancelSeekFetch() {
    if (this._seekFetchSrc) {
      GLib.Source.remove(this._seekFetchSrc);
      this._seekFetchSrc = null;
    }
  }

  /**
   * Send a relative Seek command using the delta from the pre-seek position.
   * @param {string} owner        D-Bus name owner of the player.
   * @param {number} preMicros    Position (µs) BEFORE the seek started.
   * @param {number} targetMicros Desired absolute position (µs).
   */
  _doRelativeSeek(owner, preMicros, targetMicros) {
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
      null, // fire-and-forget
    );
  }

  /**
   * Schedule a position confirmation fetch 400 ms from now.
   * Discarded if a newer seek (higher _fetchGen) happens before it fires.
   * @param {number} gen  The fetch generation this seek belongs to.
   */
  _schedulePostSeekFetch(gen) {
    this._cancelSeekFetch();
    this._seekFetchSrc = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
      this._seekFetchSrc = null;
      if (this._proxy && this._fetchGen === gen) this._fetchPosition(gen);
      return GLib.SOURCE_REMOVE;
    });
  }

  // ── Private — drag capture ─────────────────────────────────────────────────

  /**
   * Connect global stage motion + release handlers for the duration of a drag.
   * This ensures button-release is always caught, even if the pointer leaves
   * the seek bar widget — preventing _dragging from getting stuck as true.
   */
  _connectGlobalDrag() {
    if (this._globalMotionId) return; // already connected

    this._globalMotionId = global.stage.connect(
      "motion-event",
      (_stage, ev) => {
        if (this._dragging) this._seekToEvent(ev, false); // visually update only
        return Clutter.EVENT_PROPAGATE;
      },
    );

    // Release must also be caught globally so the drag ends cleanly
    this._globalReleaseId = global.stage.connect(
      "button-release-event",
      (_stage, ev) => {
        if (this._dragging) {
          this._seekToEvent(ev, true); // commit seek on release!
          this._dragging = false;
        }
        this._disconnectGlobalDrag();
        return Clutter.EVENT_PROPAGATE;
      },
    );
  }

  _disconnectGlobalDrag() {
    if (this._globalMotionId) {
      global.stage.disconnect(this._globalMotionId);
      this._globalMotionId = 0;
    }
    if (this._globalReleaseId) {
      global.stage.disconnect(this._globalReleaseId);
      this._globalReleaseId = 0;
    }
  }

  // ── Private — full cleanup ─────────────────────────────────────────────────

  _disconnectAllHandlers() {
    // Always release global stage captures first (prevents phantom seeking)
    this._disconnectGlobalDrag();
    this._dragging = false;

    if (this._seekHit && this._pressId) {
      this._seekHit.disconnect(this._pressId);
      this._pressId = 0;
    }
  }
}
