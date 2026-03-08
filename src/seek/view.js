/**
 * seek/view.js
 *
 * UI and interaction logic for the seek bar.
 */

import Clutter from "gi://Clutter";
import { formatSecs } from "../utils.js";

export class SeekView {
  constructor(core, tracker) {
    this._core = core;
    this._tracker = tracker;

    this._seekHit = null;
    this._seekBg = null;
    this._seekFill = null;
    this._posLabel = null;
    this._durLabel = null;

    this._pressId = 0;
    this._globalMotionId = 0;
    this._globalReleaseId = 0;

    this._dragging = false;
  }

  setWidgets(seekHit, seekBg, seekFill, posLabel, durLabel) {
    this.disconnectAllHandlers();

    this._seekHit = seekHit;
    this._seekBg = seekBg;
    this._seekFill = seekFill;
    this._posLabel = posLabel;
    this._durLabel = durLabel;

    if (!this._seekHit) return;

    this._pressId = this._seekHit.connect("button-press-event", (_a, ev) => {
      if (ev.get_button() !== 1) return Clutter.EVENT_PROPAGATE;
      this._dragging = true;
      this._seekToEvent(ev, false);
      this._connectGlobalDrag();
      return Clutter.EVENT_STOP;
    });
  }

  updateUI(posSecs) {
    if (!this._seekFill || !this._seekBg) return;

    const dur = this._core._lengthSecs;
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

  _seekToEvent(ev, commit = true) {
    if (!this._core._proxy || !this._seekBg || this._core._lengthSecs <= 0)
      return;

    const [evX] = ev.get_coords();
    const [bgX] = this._seekBg.get_transformed_position();
    const bgW = this._seekBg.get_width();
    if (bgW <= 0) return;

    const ratio = Math.max(0, Math.min((evX - bgX) / bgW, 1));
    const targetSecs = ratio * this._core._lengthSecs;

    if (!commit) {
      this.updateUI(targetSecs);
      return;
    }

    this._tracker.commitSeek(targetSecs);
  }

  _connectGlobalDrag() {
    if (this._globalMotionId) return;

    this._globalMotionId = global.stage.connect("motion-event", (_stage, ev) => {
      if (this._dragging) this._seekToEvent(ev, false);
      return Clutter.EVENT_PROPAGATE;
    });

    this._globalReleaseId = global.stage.connect(
      "button-release-event",
      (_stage, ev) => {
        if (this._dragging) {
          this._seekToEvent(ev, true);
          this._dragging = false;
        }
        this.disconnectGlobalDrag();
        return Clutter.EVENT_PROPAGATE;
      }
    );
  }

  disconnectGlobalDrag() {
    if (this._globalMotionId) {
      global.stage.disconnect(this._globalMotionId);
      this._globalMotionId = 0;
    }
    if (this._globalReleaseId) {
      global.stage.disconnect(this._globalReleaseId);
      this._globalReleaseId = 0;
    }
  }

  disconnectAllHandlers() {
    this.disconnectGlobalDrag();
    this._dragging = false;

    if (this._seekHit && this._pressId) {
      this._seekHit.disconnect(this._pressId);
      this._pressId = 0;
    }
  }

  destroy() {
    this.disconnectAllHandlers();
    this._seekHit = null;
    this._seekBg = null;
    this._seekFill = null;
    this._posLabel = null;
    this._durLabel = null;
  }
}

