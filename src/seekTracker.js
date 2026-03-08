/**
 * seekTracker.js
 *
 * Orchestrator for the seek bar logic and UI.
 */

import GLib from "gi://GLib";
import { SEEK_TICK_S } from "./constants.js";
import { SeekCore } from "./seek/core.js";
import { SeekView } from "./seek/view.js";

export class SeekTracker {
  constructor(settings) {
    this._settings = settings;
    this.core = new SeekCore(settings);
    this.view = new SeekView(this.core, this);

    this._tickSrc = null;
    this._seekFetchSrc = null;
  }

  // ── Public API ───────────────────────────────────────────────────────────

  setWidgets(seekHit, seekBg, seekFill, posLabel, durLabel) {
    this.view.setWidgets(seekHit, seekBg, seekFill, posLabel, durLabel);
  }

  start(proxy, lengthMicros, skipFetch = false) {
    this.core.setProxy(proxy);
    this.core.setLength(lengthMicros);

    this.core.resetAnchor(this.core._anchorPosSecs);

    this._startTick();
    if (!skipFetch) {
      this.core.fetchPosition(this.core.getGen(), (pos) => this.view.updateUI(pos));
    } else {
      this.view.updateUI(this.core._anchorPosSecs);
    }
  }

  reset(proxy, lengthMicros) {
    this.stop();
    this.core.incrementGen();
    this._cancelSeekFetch();
    this.core.resetInhibit();

    this.core.resetAnchor(0);
    this.start(proxy, lengthMicros, true);
  }

  updateLength(lengthMicros) {
    this.core.setLength(lengthMicros);
  }

  stop() {
    if (this._tickSrc) {
      GLib.Source.remove(this._tickSrc);
      this._tickSrc = null;
    }
    const p = this.core.estimatePos();
    this.core.resetAnchor(p);
  }

  seekedTo(posMicros) {
    const posSecs = Number(posMicros) / 1_000_000;
    if (!isFinite(posSecs) || posSecs < 0 || this.core.isInhibited()) return;

    this.core.incrementGen();
    this._cancelSeekFetch();

    this.core.resetAnchor(posSecs);
    this.view.updateUI(posSecs);
  }

  renderNow() {
    this.view.updateUI(this.core.estimatePos());
  }

  fetchNow() {
    if (!this.core._proxy || this.core.isInhibited()) {
      this.renderNow();
      return;
    }
    this.core.fetchPosition(this.core.getGen(), (pos) => this.view.updateUI(pos));
  }

  destroy() {
    this.stop();
    this._cancelSeekFetch();
    this.view.destroy();
    this.core.setProxy(null);
  }

  // ── Tick Management ──────────────────────────────────────────────────────

  _startTick() {
    this.stop();
    this._tickSrc = GLib.timeout_add_seconds(
      GLib.PRIORITY_DEFAULT,
      SEEK_TICK_S,
      () => {
        if (!this.core._proxy) return GLib.SOURCE_REMOVE;
        if (this.view._dragging) return GLib.SOURCE_CONTINUE;
        this.view.updateUI(this.core.estimatePos());
        return GLib.SOURCE_CONTINUE;
      }
    );
  }

  // ── Seek Execution ───────────────────────────────────────────────────────

  _cancelSeekFetch() {
    if (this._seekFetchSrc) {
      GLib.Source.remove(this._seekFetchSrc);
      this._seekFetchSrc = null;
    }
  }

  commitSeek(targetSecs) {
    const gen = this.core.incrementGen();
    const preSeekMicros = Math.round(this.core.estimatePos() * 1_000_000);

    this.core.resetAnchor(targetSecs);
    this.view.updateUI(targetSecs);
    this._cancelSeekFetch();

    const owner = this.core._proxy?.g_name_owner;
    if (!owner) return;

    const targetMicros = Math.round(targetSecs * 1_000_000);
    const trackId = this.core.getTrackId();

    if (trackId) {
      this.core.doSetPosition(owner, trackId, targetMicros, (ok) => {
        if (!ok) this.core.doRelativeSeek(owner, preSeekMicros, targetMicros);
        this._schedulePostSeekFetch(gen);
      });
    } else {
      this.core.doRelativeSeek(owner, preSeekMicros, targetMicros);
      this._schedulePostSeekFetch(gen);
    }
  }

  _schedulePostSeekFetch(gen) {
    this._cancelSeekFetch();
    this._seekFetchSrc = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
      this._seekFetchSrc = null;
      if (this.core.getGen() === gen) {
        this.core.fetchPosition(gen, (pos) => this.view.updateUI(pos));
      }
      return GLib.SOURCE_REMOVE;
    });
  }
}

