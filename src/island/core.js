/**
 * island/core.js
 *
 * Core Dynamic Island orchestrator. Handles state machine and lifecycle.
 */

import GLib from "gi://GLib";
import Clutter from "gi://Clutter";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import { State } from "../constants.js";
import { SeekTracker } from "../seekTracker.js";
import { IslandView } from "./view.js";
import { IslandFeatures } from "./features.js";

export class IslandCore {
  constructor(settings) {
    this._settings = settings;

    this.view = new IslandView(this);
    this.features = new IslandFeatures(this);

    this._state = State.PILL;
    this._stateBeforeNotif = null;

    this._mediaProxy = null;
    this._playing = false;
    this._trackLength = 0;
    this._lastTrackId = null;

    this._lastWeatherData = null;
    this._lastBtDevices = [];

    this._stashFiles = [];
    this._stashFolderUri = null;
    this._stashActionCallback = null;

    this._osdState = null;
    this._pendingBrightnessFill = null;

    this._dominantColor = null;

    this._waveformSrc = null;
    this._osdHideSrc = null;
    this._notifHideSrc = null;
    this._clockSrc = null;
    this._collapseTimeoutId = null;
    this._autoHideSrc = null;
    this._renderIdleSrc = null;

    this._artCancellable = null;

    this._hoverId = 0;
    this._monitorsId = 0;
    this._fullscreenId = 0;
    this._settingsIds = [];

    this._scale = 1.0;
    this._fontSizeMultiplier = 1.0;
    this._animDur = 280;

    this._seekTracker = null;
  }

  // ── Public API ───────────────────────────────────────────────────────────

  init() {
    this._scale = this._settings.get_double("notch-scale") || 1.0;
    this._fontSizeMultiplier =
      this._settings.get_double("font-size-multiplier") || 1.0;
    this._animDur = this._settings.get_int("animation-duration") || 280;

    this._seekTracker = new SeekTracker(this._settings);

    this._actor = this.view.buildWidget();
    this._addToStage();
    this._connectSettings();
    this.features.startClock();

    if (this._settings.get_boolean("auto-hide") && !this._mediaProxy) {
      this._actor.hide();
      this._actor.opacity = 0;
    }
  }

  // ── Settings ─────────────────────────────────────────────────────────────

  _connectSettings() {
    const watch = (key, fn) =>
      this._settingsIds.push(this._settings.connect(`changed::${key}`, fn));

    watch("position-offset", () => this._repositionForSize(this._actor.width));

    watch("notch-scale", () => {
      this._scale = this._settings.get_double("notch-scale") || 1.0;
      this._refreshUI();
    });

    watch("font-size-multiplier", () => {
      this._fontSizeMultiplier =
        this._settings.get_double("font-size-multiplier") || 1.0;
      this._refreshUI();
    });

    watch("background-color", () =>
      this.view.updateNotchStyle(this._actor, this._actor.height, this._state),
    );
    watch("background-opacity", () =>
      this.view.updateNotchStyle(this._actor, this._actor.height, this._state),
    );
    watch("time-format", () => this.features.updateClock());
    watch("show-bluetooth", () => {
      this.features.updateBluetooth(this._lastBtDevices ?? []);
    });

    watch("dynamic-art-color", () => {
      if (!this._settings.get_boolean("dynamic-art-color"))
        this._dominantColor = null;
      this.view.updateNotchStyle(this._actor, this._actor.height, this._state);
    });

    const onSizeChange = () => this._transitionTo(this._state);
    for (const key of [
      "pill-width",
      "pill-height",
      "compact-width",
      "compact-height",
      "expanded-width",
      "expanded-height",
      "osd-width",
      "osd-height",
    ])
      watch(key, onSizeChange);

    const onArtSizeChange = () => this._refreshUI();
    watch("art-expanded-size", onArtSizeChange);
    watch("art-compact-size", onArtSizeChange);

    watch("animation-duration", () => {
      this._animDur = this._settings.get_int("animation-duration") || 280;
    });

    watch("show-seek-bar", () => {
      const show = this._settings.get_boolean("show-seek-bar");
      if (this._seekBg) this._seekBg.visible = show;
      if (this._timeRow) this._timeRow.visible = show;
    });

    watch("show-album-art", () => {
      if (!this._mediaProxy) return;
      const meta =
        this._mediaProxy.get_cached_property("Metadata")?.deepUnpack() ?? {};
      const artUrl = meta["mpris:artUrl"]?.unpack() ?? "";
      if (artUrl && this._settings.get_boolean("show-album-art"))
        this.features.loadAlbumArt(artUrl);
      else this.features.clearAlbumArt();
    });

    watch("auto-hide", () => {
      if (this._mediaProxy || this._state === State.OSD) return;
      if (this._settings.get_boolean("auto-hide")) {
        this._actor.ease({
          opacity: 0,
          duration: 250,
          mode: Clutter.AnimationMode.EASE_OUT_QUAD,
          onComplete: () => this._actor?.hide(),
        });
      } else {
        this._cancelAutoHide();
        if (!this._isFullscreen()) {
          this._actor.show();
          this._actor.opacity = 255;
        }
        this._transitionTo(State.PILL);
      }
    });

    watch("auto-hide-delay", () => this._resetAutoHideTimer());

    watch("show-notifications", () => {
      if (
        !this._settings.get_boolean("show-notifications") &&
        this._state === State.NOTIF
      ) {
        if (this._notifHideSrc) {
          GLib.Source.remove(this._notifHideSrc);
          this._notifHideSrc = null;
        }
        this.features.dismissNotification();
      }
    });

    watch("show-weather", () => {
      if (this._weatherWidget)
        this._weatherWidget.visible =
          this._settings.get_boolean("show-weather") &&
          !!this._lastWeatherData?.temp;
      this.features.updatePillSep();
    });
  }

  // ── Stage ────────────────────────────────────────────────────────────────

  _addToStage() {
    Main.layoutManager.addChrome(this._actor, {
      affectsStruts: false,
      trackFullscreen: true,
    });
    this._repositionForSize(this._actor.width);
    this._monitorsId = Main.layoutManager.connect("monitors-changed", () =>
      this._repositionForSize(this._actor.width),
    );
    this._fullscreenId = global.display.connect("in-fullscreen-changed", () =>
      this._onFullscreenChanged(),
    );
  }

  _onFullscreenChanged() {
    if (!this._actor) return;
    if (this._isFullscreen()) {
      this._actor.hide();
    } else {
      const shouldBeVisible =
        this._playing ||
        this._state === State.OSD ||
        this._state === State.STASH ||
        !this._settings.get_boolean("auto-hide");
      if (shouldBeVisible) {
        this._actor.show();
        this._actor.opacity = 255;
      }
    }
  }

  _isFullscreen() {
    try {
      return global.display.get_monitor_in_fullscreen(
        Main.layoutManager.primaryIndex,
      );
    } catch (_e) {
      return false;
    }
  }

  _showActor(duration = 180) {
    if (!this._actor || this._isFullscreen()) return;
    if (!this._actor.visible) {
      this._actor.show();
      this._actor.opacity = 0;
    }
    if (duration > 0 && this._actor.opacity < 255) {
      this._actor.ease({
        opacity: 255,
        duration,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
      });
    } else {
      this._actor.opacity = 255;
    }
  }

  _repositionForSize(width) {
    const monitor = Main.layoutManager.primaryMonitor;
    if (!monitor) return;
    const offset = this._settings.get_int("position-offset");
    this._actor.set_position(
      monitor.x + Math.floor((monitor.width - width) / 2) + offset,
      monitor.y,
    );
  }

  // ── UI Rebuild ───────────────────────────────────────────────────────────

  _refreshUI() {
    const currentState = this._state;

    this.features.stopWaveform();
    this.features.stopClock();
    if (this._osdHideSrc) {
      GLib.Source.remove(this._osdHideSrc);
      this._osdHideSrc = null;
    }
    if (this._notifHideSrc) {
      GLib.Source.remove(this._notifHideSrc);
      this._notifHideSrc = null;
    }

    if (this._artCancellable) {
      this._artCancellable.cancel();
      this._artCancellable = null;
    }
    this._albumArtActor = null;
    this._compactArtActor = null;

    const scale = this._scale;
    let baseH;
    switch (currentState) {
      case State.PILL:
        baseH = this.view.getPillH();
        break;
      case State.COMPACT:
        baseH = this.view.getCompactH();
        break;
      case State.EXPANDED:
        baseH = this.view.getExpandedH();
        break;
      case State.OSD:
        baseH = this.view.getOsdH();
        break;
      case State.NOTIF:
        baseH = this.view.getNotifH();
        break;
      case State.STASH:
        baseH = this.view.getStashH();
        break;
      default:
        baseH = this.view.getPillH();
    }
    this.view.updateNotchStyle(this._actor, baseH, currentState);

    if (this._blurEffect) {
      try {
        this._blurEffect.blur_radius = Math.floor(40 * scale);
      } catch (_e) {}
    }

    this._actor.destroy_all_children();
    this._pillView = this.view.buildPillView();
    this._compactView = this.view.buildCompactView();
    this._expandedView = this.view.buildExpandedView();
    this._osdView = this.view.buildOsdView();
    this._notifView = this.view.buildNotifView();
    this._stashView = this.view.buildStashView();

    for (const v of [
      this._pillView,
      this._compactView,
      this._expandedView,
      this._osdView,
      this._notifView,
      this._stashView,
    ]) {
      this._actor.add_child(v);
      v.hide();
    }

    if (currentState === State.PILL) this._pillView.show();
    else if (currentState === State.COMPACT) this._compactView.show();
    else if (currentState === State.EXPANDED) this._expandedView.show();
    else if (currentState === State.OSD) this._osdView.show();
    else if (currentState === State.NOTIF) this._notifView.show();
    else if (currentState === State.STASH) this._stashView.show();

    this._transitionTo(currentState);
    this.features.startClock();

    if (this._playing) {
      this.features.startWaveform();
      this._seekTracker.renderNow();
    }

    if (this._lastWeatherData) this.features.updateWeather(this._lastWeatherData);
    if (this._lastBtDevices?.length) this.features.updateBluetooth(this._lastBtDevices);

    if (this._mediaProxy) this.features.updateMedia(this._mediaProxy);
    if (this._osdState)
      this.features.showOsd(
        this._osdState.icon,
        this._osdState.level,
        this._osdState.max,
      );

    if (this._stashFiles?.length)
      this.features.applyStashUI(this._stashFiles, this._stashFolderUri);

    this.features.updatePillSep();
  }

  // ── Transitions ──────────────────────────────────────────────────────────

  _transitionTo(state, onComplete) {
    this._state = state;
    if (!this._actor) return;

    const scale = this._scale;
    let targetW, targetH;

    switch (state) {
      case State.COMPACT:
        targetW = this.view.getCompactW();
        targetH = this.view.getCompactH();
        break;
      case State.EXPANDED:
        targetW = this.view.getExpandedW();
        targetH = this.view.getExpandedH();
        break;
      case State.OSD:
        targetW = this.view.getOsdW();
        targetH = this.view.getOsdH();
        break;
      case State.NOTIF:
        targetW = this.view.getNotifW();
        targetH = this.view.getNotifH();
        break;
      case State.STASH:
        targetW = this.view.getStashW();
        targetH = this.view.getStashH();
        break;
      default:
        targetW = this.view.getPillW();
        targetH = this.view.getPillH();
    }

    this.view.updateNotchStyle(this._actor, targetH, state);

    for (const v of [
      this._pillView,
      this._compactView,
      this._expandedView,
      this._osdView,
      this._notifView,
      this._stashView,
    ])
      v.hide();

    const monitor = Main.layoutManager.primaryMonitor;
    if (!monitor) return;
    const offset = this._settings.get_int("position-offset");
    const targetX =
      monitor.x + Math.floor((monitor.width - targetW) / 2) + offset;

    this._actor.ease({
      x: targetX,
      width: targetW,
      height: targetH,
      duration: this._animDur,
      mode: Clutter.AnimationMode.EASE_OUT_EXPO,
      onComplete: () => {
        if (!this._actor) return;
        this._actor.set_size(targetW, targetH);
        this._actor.set_x(targetX);

        if (state === State.PILL) this._pillView.show();
        else if (state === State.COMPACT) this._compactView.show();
        else if (state === State.EXPANDED) {
          this._expandedView.show();
          if (this._renderIdleSrc) {
            GLib.Source.remove(this._renderIdleSrc);
            this._renderIdleSrc = null;
          }
          this._renderIdleSrc = GLib.idle_add(
            GLib.PRIORITY_DEFAULT_IDLE,
            () => {
              this._renderIdleSrc = null;
              if (!this._seekTracker || !this._actor) return GLib.SOURCE_REMOVE;
              this._seekTracker.fetchNow();
              return GLib.SOURCE_REMOVE;
            },
          );
        } else if (state === State.OSD) this._osdView.show();
        else if (state === State.NOTIF) this._notifView.show();
        else if (state === State.STASH) this._stashView.show();

        if (state === State.PILL && !this._playing) this._resetAutoHideTimer();

        onComplete?.();
      },
    });
  }

  _onHoverEnter() {
    if (this._mediaProxy && this._state === State.COMPACT)
      this._transitionTo(State.EXPANDED);
  }

  _onHoverLeave() {
    if (this._mediaProxy && this._state === State.EXPANDED)
      this._transitionTo(State.COMPACT);
  }

  // ── Auto-Hide ────────────────────────────────────────────────────────────

  _resetAutoHideTimer() {
    this._cancelAutoHide();
    if (!this._settings.get_boolean("auto-hide")) return;

    const delaySecs = this._settings.get_int("auto-hide-delay");
    if (delaySecs <= 0) return;

    this._autoHideSrc = GLib.timeout_add_seconds(
      GLib.PRIORITY_DEFAULT,
      delaySecs,
      () => {
        this._autoHideSrc = null;
        if (
          this._playing ||
          this._state === State.OSD ||
          this._state === State.STASH ||
          this._actor?.hover
        )
          return GLib.SOURCE_REMOVE;
        this._actor?.ease({
          opacity: 0,
          duration: 300,
          mode: Clutter.AnimationMode.EASE_OUT_QUAD,
          onComplete: () => this._actor?.hide(),
        });
        return GLib.SOURCE_REMOVE;
      },
    );
  }

  _cancelAutoHide() {
    if (this._autoHideSrc) {
      GLib.Source.remove(this._autoHideSrc);
      this._autoHideSrc = null;
    }
  }

  // ── Bridge ───────────────────────────────────────────────────────────────

  updateMedia(proxy) { this.features.updateMedia(proxy); }
  onPlayerSeeked(posMicros) { this.features.onPlayerSeeked(posMicros); }
  clearMedia() { this.features.clearMedia(); }
  updateWeather(data) { this.features.updateWeather(data); }
  updateBluetooth(devices) { this.features.updateBluetooth(devices); }
  updateStash(files, folderUri) { this.features.updateStash(files, folderUri); }
  setStashActionCallback(cb) { this.features.setStashActionCallback(cb); }
  showOsd(icon, level, max) { this.features.showOsd(icon, level, max); }
  showNotification(notif) { this.features.showNotification(notif); }

  _onPlayPause() { this.features.onPlayPause(); }
  _sendMprisCommand(method) { this.features.sendMprisCommand(method); }

  // ── Cleanup ──────────────────────────────────────────────────────────────

  destroy() {
    if (this._artCancellable) {
      this._artCancellable.cancel();
      this._artCancellable = null;
    }
    this._albumArtActor = null;
    this._compactArtActor = null;

    this.features.stopClock();
    this.features.stopWaveform();

    this._seekTracker?.destroy();
    this._seekTracker = null;

    for (const key of [
      "_osdHideSrc",
      "_notifHideSrc",
      "_collapseTimeoutId",
      "_autoHideSrc",
      "_renderIdleSrc",
    ]) {
      if (this[key]) {
        GLib.Source.remove(this[key]);
        this[key] = null;
      }
    }

    if (this._monitorsId) {
      Main.layoutManager.disconnect(this._monitorsId);
      this._monitorsId = 0;
    }

    if (this._fullscreenId) {
      global.display.disconnect(this._fullscreenId);
      this._fullscreenId = 0;
    }

    for (const id of this._settingsIds) this._settings.disconnect(id);
    this._settingsIds = [];

    if (this._hoverId && this._actor) {
      this._actor.disconnect(this._hoverId);
      this._hoverId = 0;
    }

    if (this._actor) {
      this._actor.destroy();
      this._actor = null;
    }

    this._settings = null;
    this._mediaProxy = null;
    this._osdState = null;
    this._dominantColor = null;
    this._stashActionCallback = null;
    this._stashFiles = [];
    this._stashFolderUri = null;
  }
}

