/**
 * island.js
 *
 * Core Dynamic Island actor.
 *
 * States: Pill (clock) → Compact (waveform) → Expanded (player) → OSD → Notif
 *
 * Fixes applied:
 *  #1 — Art Size Setting:    art-compact-size / art-expanded-size from GSettings
 *  #2 — Volume Percentage:   capped at 100% (normal) or 150% (over-amp)
 *  #3 — Player Visibility:   island only appears when PlaybackStatus = "Playing"
 *  #4 — Seek bar:            track-ID reset, local interpolation, longer D-Bus timeout
 *
 * New in this revision:
 *  • show-notifications setting — when false, _showNotification() is a no-op
 *  • Settings watcher for show-notifications so toggling in prefs is instant
 */

import GLib from "gi://GLib";
import Gio from "gi://Gio";
import Clutter from "gi://Clutter";
import St from "gi://St";
import Pango from "gi://Pango";
import GdkPixbuf from "gi://GdkPixbuf";
import Cogl from "gi://Cogl";
import Shell from "gi://Shell";
import * as Main from "resource:///org/gnome/shell/ui/main.js";

import {
  PILL_W,
  PILL_H,
  COMPACT_W,
  COMPACT_H,
  EXPANDED_W,
  EXPANDED_H,
  OSD_W,
  OSD_H,
  NOTIF_W,
  NOTIF_H,
  OSD_SEG_COUNT,
  OSD_HIDE_MS,
  NOTIF_HIDE_MS,
  WAVEFORM_MS,
  SEEK_TICK_S,
  State,
  ART_COMPACT,
  ART_EXPANDED,
  WAVEFORM_BARS,
  WAVEFORM_H,
  HOVER_DEBOUNCE,
} from "./constants.js";

const MPRIS_PLAYER_IFACE = "org.mpris.MediaPlayer2.Player";
const OVER_AMP_MAX = 1.5;

export class DynamicIsland {
  // ── Constructor ──────────────────────────────────────────────────────────

  constructor(settings) {
    this._settings = settings;

    // State machine
    this._state = State.PILL;
    this._stateBeforeNotif = null;

    // Media
    this._mediaProxy = null;
    this._playing = false;
    this._trackLength = 0;

    // FIX #4: track-ID change detection and local seek interpolation
    this._lastTrackId = null;
    this._seekBasePosition = 0; // µs — last known authoritative position
    this._seekBaseMonoTime = 0; // GLib.get_monotonic_time() at that moment

    // OSD
    this._osdState = null; // { icon, level, max }

    // Dynamic art colour
    this._dominantColor = null;

    // GLib source IDs — every one must be removed in destroy()
    this._waveformSrc = null;
    this._seekSrc = null;
    this._osdHideSrc = null;
    this._notifHideSrc = null;
    this._clockSrc = null;
    this._collapseTimeoutId = null;

    // Async art loading
    this._artCancellable = null;

    // Signal IDs
    this._hoverId = 0;
    this._monitorsId = 0;
    this._fullscreenId = 0; // global.display in-fullscreen-changed
    this._settingsIds = [];

    // Notification watcher
    this._notifMsgTrayAddedId = 0;
    this._notifMsgTrayRemovedId = 0;
    this._notifSources = new Map();

    // Cached settings values
    this._scale = 1.0;
    this._animDur = 280;

    // Pending brightness fill applied after OSD transition completes
    this._pendingBrightnessFill = undefined;
  }

  // ── Public entry point ───────────────────────────────────────────────────

  init() {
    this._scale = this._settings.get_double("notch-scale") || 1.0;
    this._animDur = this._settings.get_int("animation-duration") || 280;

    this._buildWidget();
    this._addToStage();
    this._connectSettings();
    this._startClock();
    this._connectNotifications();

    if (this._settings.get_boolean("auto-hide") && !this._mediaProxy) {
      this._actor.hide();
      this._actor.opacity = 0;
    }
  }

  // ── Settings watchers ────────────────────────────────────────────────────

  _connectSettings() {
    const watch = (key, fn) =>
      this._settingsIds.push(this._settings.connect(`changed::${key}`, fn));

    watch("position-offset", () => this._repositionForSize(this._actor.width));

    watch("notch-scale", () => {
      this._scale = this._settings.get_double("notch-scale") || 1.0;
      this._refreshUI();
    });

    watch("background-color", () =>
      this._updateNotchStyle(this._actor.height, this._state),
    );
    watch("background-opacity", () =>
      this._updateNotchStyle(this._actor.height, this._state),
    );

    watch("dynamic-art-color", () => {
      if (!this._settings.get_boolean("dynamic-art-color"))
        this._dominantColor = null;
      this._updateNotchStyle(this._actor.height, this._state);
    });

    const onSizeChange = () => this._transitionTo(this._state);
    watch("pill-width", onSizeChange);
    watch("pill-height", onSizeChange);
    watch("compact-width", onSizeChange);
    watch("compact-height", onSizeChange);
    watch("expanded-width", onSizeChange);
    watch("expanded-height", onSizeChange);
    watch("osd-width", onSizeChange);
    watch("osd-height", onSizeChange);

    // FIX #1: art size changes require a full rebuild
    const onArtSizeChange = () => this._refreshUI();
    watch("art-expanded-size", onArtSizeChange);
    watch("art-compact-size", onArtSizeChange);

    watch("animation-duration", () => {
      this._animDur = this._settings.get_int("animation-duration") || 280;
    });

    watch("osd-timeout", () => {});

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
        this._loadAlbumArt(artUrl);
      else this._clearAlbumArt();
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
        if (!this._isFullscreen()) {
          this._actor.show();
          this._actor.opacity = 255;
        }
        this._transitionTo(State.PILL);
      }
    });

    // NEW: toggling show-notifications at runtime — if disabled while a toast
    // is active, dismiss it immediately and restore the previous state.
    watch("show-notifications", () => {
      if (!this._settings.get_boolean("show-notifications")) {
        if (this._state === State.NOTIF) {
          if (this._notifHideSrc) {
            GLib.Source.remove(this._notifHideSrc);
            this._notifHideSrc = null;
          }
          this._dismissNotification();
        }
      }
    });
  }

  // ── Widget construction ───────────────────────────────────────────────────

  _buildWidget() {
    const scale = this._scale;
    const pillW = Math.floor(
      (this._settings.get_int("pill-width") || PILL_W) * scale,
    );
    const pillH = Math.floor(
      (this._settings.get_int("pill-height") || PILL_H) * scale,
    );

    this._actor = new St.Widget({
      style_class: "dynamic-island",
      reactive: true,
      track_hover: true,
      clip_to_allocation: true,
      layout_manager: new Clutter.BinLayout(),
    });
    this._actor.set_size(pillW, pillH);
    this._updateNotchStyle(pillH, State.PILL);

    try {
      this._blurEffect = new Shell.BlurEffect({
        brightness: 0.7,
        blur_radius: Math.floor(40 * scale),
        mode: Shell.BlurMode.BACKGROUND,
      });
      this._actor.add_effect(this._blurEffect);
    } catch (_e) {
      this._blurEffect = null;
    }

    this._pillView = this._buildPillView();
    this._compactView = this._buildCompactView();
    this._expandedView = this._buildExpandedView();
    this._osdView = this._buildOsdView();
    this._notifView = this._buildNotifView();

    for (const v of [
      this._pillView,
      this._compactView,
      this._expandedView,
      this._osdView,
      this._notifView,
    ])
      this._actor.add_child(v);

    this._pillView.show();
    this._compactView.hide();
    this._expandedView.hide();
    this._osdView.hide();
    this._notifView.hide();

    this._hoverId = this._actor.connect("notify::hover", () => {
      if (this._state === State.OSD || this._state === State.NOTIF) return;

      if (this._actor.hover) {
        if (this._collapseTimeoutId) {
          GLib.Source.remove(this._collapseTimeoutId);
          this._collapseTimeoutId = null;
        }
        this._onHoverEnter();
      } else {
        if (this._collapseTimeoutId) return;
        this._collapseTimeoutId = GLib.timeout_add(
          GLib.PRIORITY_DEFAULT,
          HOVER_DEBOUNCE,
          () => {
            this._collapseTimeoutId = null;
            if (!this._actor || this._actor.hover) return GLib.SOURCE_REMOVE;
            this._onHoverLeave();
            return GLib.SOURCE_REMOVE;
          },
        );
      }
    });
  }

  // ── View builders ─────────────────────────────────────────────────────────

  _buildPillView() {
    const scale = this._scale;
    const box = new St.BoxLayout({
      style_class: "di-pill-view",
      x_expand: true,
      y_expand: true,
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
    });
    this._clockLabel = new St.Label({
      style_class: "di-clock-label",
      text: "--:--",
      y_align: Clutter.ActorAlign.CENTER,
      style: `font-size: ${Math.floor(13 * scale)}px;`,
    });
    this._clockLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    box.add_child(this._clockLabel);
    return box;
  }

  _buildCompactView() {
    const scale = this._scale;
    // FIX #1: art size from settings
    const artSize = Math.floor(
      (this._settings.get_int("art-compact-size") || ART_COMPACT) * scale,
    );

    const box = new St.BoxLayout({
      style_class: "di-compact-view",
      vertical: false,
      x_expand: true,
      y_expand: true,
      x_align: Clutter.ActorAlign.FILL,
      y_align: Clutter.ActorAlign.CENTER,
    });

    this._compactArtContainer = new St.Widget({
      style_class: "di-compact-art",
      width: artSize,
      height: artSize,
      layout_manager: new Clutter.BinLayout(),
      x_align: Clutter.ActorAlign.START,
      y_align: Clutter.ActorAlign.CENTER,
    });
    this._compactArtActor = new Clutter.Actor({
      width: artSize,
      height: artSize,
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
    });
    this._compactFallbackIcon = new St.Icon({
      style_class: "di-compact-icon",
      icon_name: "audio-x-generic-symbolic",
      icon_size: Math.floor(18 * scale),
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
      x_expand: true,
      y_expand: true,
    });
    this._compactArtContainer.add_child(this._compactArtActor);
    this._compactArtContainer.add_child(this._compactFallbackIcon);

    const waveformOuter = new St.Widget({
      layout_manager: new Clutter.BinLayout(),
      height: Math.floor(WAVEFORM_H * scale),
      clip_to_allocation: true,
      y_align: Clutter.ActorAlign.CENTER,
      x_align: Clutter.ActorAlign.END,
    });
    this._waveformBox = new St.BoxLayout({
      vertical: false,
      y_expand: true,
      y_align: Clutter.ActorAlign.END,
      style: `spacing: ${Math.floor(2 * scale)}px;`,
    });
    this._waveformBars = [];
    for (let i = 0; i < WAVEFORM_BARS; i++) {
      const bar = new St.Widget({
        style_class: `di-waveform-bar di-bar-${i}`,
        width: Math.floor(3 * scale),
        height: Math.floor(2 * scale),
        y_align: Clutter.ActorAlign.END,
      });
      this._waveformBars.push(bar);
      this._waveformBox.add_child(bar);
    }
    waveformOuter.add_child(this._waveformBox);
    waveformOuter.add_child(
      new St.Widget({
        style_class: "di-waveform-fade",
        x_expand: true,
        y_expand: true,
        reactive: false,
      }),
    );

    box.add_child(this._compactArtContainer);
    box.add_child(new St.Widget({ x_expand: true }));
    box.add_child(waveformOuter);
    return box;
  }

  _buildExpandedView() {
    const scale = this._scale;
    // FIX #1: art size from settings
    const artSize = Math.floor(
      (this._settings.get_int("art-expanded-size") || ART_EXPANDED) * scale,
    );

    const box = new St.BoxLayout({
      style_class: "di-expanded-view",
      vertical: false,
      x_expand: true,
      y_expand: true,
      style: `spacing: ${Math.floor(18 * scale)}px;`,
    });

    // Album art
    this._albumArtBox = new St.Widget({
      style_class: "di-album-art",
      width: artSize,
      height: artSize,
      clip_to_allocation: true,
      layout_manager: new Clutter.BinLayout(),
      x_align: Clutter.ActorAlign.START,
      y_align: Clutter.ActorAlign.CENTER,
    });
    this._albumArtActor = new Clutter.Actor({
      width: artSize,
      height: artSize,
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
    });
    this._albumFallbackIcon = new St.Icon({
      style_class: "di-album-fallback",
      icon_name: "audio-x-generic-symbolic",
      icon_size: Math.floor(52 * scale),
      x_expand: true,
      y_expand: true,
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
    });
    this._albumArtBox.add_child(this._albumArtActor);
    this._albumArtBox.add_child(this._albumFallbackIcon);

    // Right column
    const rightCol = new St.BoxLayout({
      vertical: true,
      x_expand: true,
      y_expand: true,
      y_align: Clutter.ActorAlign.FILL,
      style: `spacing: ${Math.floor(4 * scale)}px;`,
    });

    this._titleLabel = new St.Label({
      style_class: "di-title",
      text: "",
      style: `font-size: ${Math.floor(14 * scale)}px; font-weight: bold;`,
    });
    this._titleLabel.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
    this._titleLabel.visible = false;

    this._artistLabel = new St.Label({
      style_class: "di-artist",
      text: "",
      style: `font-size: ${Math.floor(10 * scale)}px;`,
    });
    this._artistLabel.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
    this._artistLabel.visible = false;

    // Seek bar — FIX #4: reactive with improved click handler
    this._seekBg = new St.Widget({
      style_class: "di-seek-bg",
      height: Math.floor(4 * scale),
      x_expand: true,
      reactive: true,
      track_hover: true,
    });
    this._seekFill = new St.Widget({
      style_class: "di-seek-fill",
      height: Math.floor(4 * scale),
      width: 0,
    });
    this._seekBg.add_child(this._seekFill);
    this._seekBg.connect("button-press-event", (actor, event) =>
      this._onSeekClick(actor, event),
    );

    this._timeRow = new St.BoxLayout({
      style_class: "di-time-row",
      vertical: false,
      x_expand: true,
    });
    this._posLabel = new St.Label({
      style_class: "di-time",
      text: "0:00",
      style: `font-size: ${Math.floor(11 * scale)}px;`,
    });
    this._durLabel = new St.Label({
      style_class: "di-time",
      text: "0:00",
      style: `font-size: ${Math.floor(11 * scale)}px;`,
    });
    this._timeRow.add_child(this._posLabel);
    this._timeRow.add_child(new St.Widget({ x_expand: true }));
    this._timeRow.add_child(this._durLabel);

    const showSeek = this._settings.get_boolean("show-seek-bar");
    this._seekBg.visible = showSeek;
    this._timeRow.visible = showSeek;

    // Playback controls
    const controls = new St.BoxLayout({
      style_class: "di-controls",
      vertical: false,
      x_expand: true,
      x_align: Clutter.ActorAlign.CENTER,
      style: `spacing: ${Math.floor(6 * scale)}px;`,
    });
    this._prevBtn = this._makeCtrlBtn(
      "media-skip-backward-symbolic",
      "Previous Track",
      () => this._sendMprisCommand("Previous"),
    );
    this._playPauseBtn = this._makeCtrlBtn(
      "media-playback-start-symbolic",
      "Play",
      () => this._onPlayPause(),
    );
    this._nextBtn = this._makeCtrlBtn(
      "media-skip-forward-symbolic",
      "Next Track",
      () => this._sendMprisCommand("Next"),
    );
    controls.add_child(this._prevBtn);
    controls.add_child(this._playPauseBtn);
    controls.add_child(this._nextBtn);

    rightCol.add_child(this._titleLabel);
    rightCol.add_child(this._artistLabel);
    rightCol.add_child(new St.Widget({ y_expand: true }));
    rightCol.add_child(this._seekBg);
    rightCol.add_child(this._timeRow);
    rightCol.add_child(controls);

    box.add_child(this._albumArtBox);
    box.add_child(rightCol);
    return box;
  }

  _buildOsdView() {
    const scale = this._scale;
    const box = new St.BoxLayout({
      style_class: "di-osd-view",
      vertical: true,
      x_expand: true,
      y_expand: true,
      y_align: Clutter.ActorAlign.CENTER,
      style: `spacing: ${Math.floor(12 * scale)}px;`,
    });

    const topRow = new St.BoxLayout({
      vertical: false,
      x_expand: true,
      style: `spacing: ${Math.floor(8 * scale)}px;`,
    });
    this._osdIcon = new St.Icon({
      style_class: "di-osd-icon",
      icon_size: Math.floor(18 * scale),
    });
    this._osdValueLabel = new St.Label({
      style_class: "di-osd-value",
      text: "",
      x_expand: true,
      x_align: Clutter.ActorAlign.END,
      style: `font-size: ${Math.floor(14 * scale)}px;`,
    });
    topRow.add_child(this._osdIcon);
    topRow.add_child(this._osdValueLabel);

    this._osdSegBox = new St.BoxLayout({
      vertical: false,
      x_expand: true,
      y_align: Clutter.ActorAlign.CENTER,
      style: `spacing: ${Math.floor(3 * scale)}px;`,
    });
    this._osdSegs = [];
    for (let i = 0; i < OSD_SEG_COUNT; i++) {
      const seg = new St.Widget({
        style_class: "di-osd-seg",
        width: Math.floor(7 * scale),
        height: Math.floor(24 * scale),
      });
      this._osdSegs.push(seg);
      this._osdSegBox.add_child(seg);
    }

    this._osdSmoothBg = new St.Widget({
      style_class: "di-osd-smooth-bg",
      height: Math.floor(6 * scale),
      x_expand: true,
    });
    this._osdSmoothFill = new St.Widget({
      style_class: "di-osd-smooth-fill",
      height: Math.floor(6 * scale),
      width: 0,
    });
    this._osdSmoothBg.add_child(this._osdSmoothFill);

    box.add_child(topRow);
    box.add_child(this._osdSegBox);
    box.add_child(this._osdSmoothBg);
    return box;
  }

  _buildNotifView() {
    const scale = this._scale;
    const box = new St.BoxLayout({
      style_class: "di-notif-view",
      vertical: false,
      x_expand: true,
      y_expand: true,
      y_align: Clutter.ActorAlign.CENTER,
      style: `spacing: ${Math.floor(12 * scale)}px; padding: 0 ${Math.floor(16 * scale)}px;`,
    });

    this._notifIcon = new St.Icon({
      style_class: "di-notif-icon",
      icon_size: Math.floor(26 * scale),
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
    });

    const textCol = new St.BoxLayout({
      vertical: true,
      x_expand: true,
      y_align: Clutter.ActorAlign.CENTER,
      style: `spacing: ${Math.floor(1 * scale)}px;`,
    });

    this._notifAppLabel = new St.Label({
      style_class: "di-notif-app",
      text: "",
      style: `font-size: ${Math.floor(9 * scale)}px; color: rgba(255,255,255,0.45);`,
    });
    this._notifAppLabel.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);

    this._notifTitleLabel = new St.Label({
      style_class: "di-notif-title",
      text: "",
      style: `font-size: ${Math.floor(13 * scale)}px; font-weight: bold; color: #ffffff;`,
    });
    this._notifTitleLabel.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);

    this._notifBodyLabel = new St.Label({
      style_class: "di-notif-body",
      text: "",
      style: `font-size: ${Math.floor(11 * scale)}px; color: rgba(255,255,255,0.55);`,
    });
    this._notifBodyLabel.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);

    textCol.add_child(this._notifAppLabel);
    textCol.add_child(this._notifTitleLabel);
    textCol.add_child(this._notifBodyLabel);

    box.add_child(this._notifIcon);
    box.add_child(textCol);
    return box;
  }

  _makeCtrlBtn(iconName, accessibleName, onClicked) {
    const btn = new St.Button({
      style_class: "di-ctrl-btn",
      reactive: true,
      accessible_name: accessibleName,
    });
    btn.set_child(
      new St.Icon({
        style_class: "di-ctrl-icon",
        icon_name: iconName,
        icon_size: Math.floor(18 * this._scale),
      }),
    );
    btn.connect("clicked", () => {
      onClicked();
      return Clutter.EVENT_STOP;
    });
    return btn;
  }

  // ── Stage integration ────────────────────────────────────────────────────

  _addToStage() {
    Main.layoutManager.addChrome(this._actor, {
      affectsStruts: false,
      trackFullscreen: true,
    });
    this._repositionForSize(this._actor.width);
    this._monitorsId = Main.layoutManager.connect("monitors-changed", () =>
      this._repositionForSize(this._actor.width),
    );

    // Hide when any window goes fullscreen on the primary monitor;
    // restore when it leaves fullscreen.
    this._fullscreenId = global.display.connect("in-fullscreen-changed", () =>
      this._onFullscreenChanged(),
    );
  }

  /**
   * Called whenever a window enters or exits fullscreen on any monitor.
   * We hide the island while the primary monitor is covered by a fullscreen
   * window and restore it when fullscreen ends.
   */
  _onFullscreenChanged() {
    if (!this._actor) return;

    if (this._isFullscreen()) {
      // Instantly hide — no animation so the user never sees a flash
      this._actor.hide();
    } else {
      // Leaving fullscreen: restore visibility only if there is something
      // to show (playing media, OSD, or not in auto-hide pill mode).
      const shouldBeVisible =
        this._playing ||
        this._state === State.OSD ||
        !this._settings.get_boolean("auto-hide");

      if (shouldBeVisible) {
        this._actor.show();
        this._actor.opacity = 255;
      }
    }
  }

  /**
   * Returns true when the primary monitor has an active fullscreen window.
   * Uses global.display.get_monitor_in_fullscreen() which is the canonical
   * GNOME Shell API for this check (available since GNOME 3.36).
   */
  _isFullscreen() {
    try {
      const primaryIdx = Main.layoutManager.primaryIndex;
      return global.display.get_monitor_in_fullscreen(primaryIdx);
    } catch (_e) {
      return false;
    }
  }

  /**
   * Show the actor and fade it in — but only when the primary monitor is
   * NOT in fullscreen.  Every place that previously called
   * this._actor.show() + ease({opacity:255}) now goes through here so
   * fullscreen suppression is enforced from a single point.
   *
   * @param {number} [duration=180] - fade-in duration in milliseconds.
   *   Pass 0 for an instant show (e.g. after leaving fullscreen).
   */
  _showActor(duration = 180) {
    if (!this._actor) return;
    if (this._isFullscreen()) return; // stay hidden while fullscreen

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

  // ── Full UI rebuild (scale / art size changes) ────────────────────────────

  _refreshUI() {
    const currentState = this._state;

    this._stopWaveform();
    this._stopSeekTracking();
    this._stopClock();
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

    const scale = this._scale;
    let baseH = this._settings.get_int("pill-height") || PILL_H;
    if (currentState === State.COMPACT)
      baseH = this._settings.get_int("compact-height") || COMPACT_H;
    else if (currentState === State.EXPANDED)
      baseH = this._settings.get_int("expanded-height") || EXPANDED_H;
    else if (currentState === State.OSD)
      baseH = this._settings.get_int("osd-height") || OSD_H;
    else if (currentState === State.NOTIF) baseH = NOTIF_H;
    this._updateNotchStyle(Math.floor(baseH * scale), currentState);

    if (this._blurEffect) {
      try {
        this._blurEffect.blur_radius = Math.floor(40 * scale);
      } catch (_e) {}
    }

    this._actor.destroy_all_children();
    this._pillView = this._buildPillView();
    this._compactView = this._buildCompactView();
    this._expandedView = this._buildExpandedView();
    this._osdView = this._buildOsdView();
    this._notifView = this._buildNotifView();

    for (const v of [
      this._pillView,
      this._compactView,
      this._expandedView,
      this._osdView,
      this._notifView,
    ]) {
      this._actor.add_child(v);
      v.hide();
    }

    if (currentState === State.PILL) this._pillView.show();
    else if (currentState === State.COMPACT) this._compactView.show();
    else if (currentState === State.EXPANDED) this._expandedView.show();
    else if (currentState === State.OSD) this._osdView.show();
    else if (currentState === State.NOTIF) this._notifView.show();

    this._transitionTo(currentState);

    this._startClock();
    if (this._playing) {
      this._startWaveform();
      this._startSeekTracking();
    }

    if (this._mediaProxy) {
      const meta =
        this._mediaProxy.get_cached_property("Metadata")?.deepUnpack() ?? {};
      const artUrl = meta["mpris:artUrl"]?.unpack() ?? "";
      if (artUrl && this._settings.get_boolean("show-album-art"))
        this._loadAlbumArt(artUrl);
      this.updateMedia(this._mediaProxy);
    }
    if (this._osdState)
      this.showOsd(
        this._osdState.icon,
        this._osdState.level,
        this._osdState.max,
      );
  }

  // ── Notch style ──────────────────────────────────────────────────────────

  _updateNotchStyle(height, state) {
    const scale = this._scale;
    const bgOpacity = this._settings.get_double("background-opacity") || 0.84;

    let r = 10,
      g = 10,
      b = 10;

    const useDynamic =
      this._settings.get_boolean("dynamic-art-color") && this._dominantColor;

    if (useDynamic) {
      r = this._dominantColor.r;
      g = this._dominantColor.g;
      b = this._dominantColor.b;
    } else {
      const bgColor =
        this._settings.get_string("background-color") || "#0a0a0a";
      try {
        if (bgColor.startsWith("#") && bgColor.length === 7) {
          const hex = bgColor.slice(1);
          r = parseInt(hex.substring(0, 2), 16);
          g = parseInt(hex.substring(2, 4), 16);
          b = parseInt(hex.substring(4, 6), 16);
        }
      } catch (_e) {
        console.warn("DynamicIsland: invalid background-color:", bgColor);
      }
    }

    let radius = Math.round(height / 2);
    if (state === State.EXPANDED || state === State.NOTIF)
      radius = Math.round(44 * scale);
    else if (state === State.OSD) radius = Math.round(38 * scale);

    this._actor.set_style(`
      background-color: rgba(${r}, ${g}, ${b}, ${bgOpacity});
      background-image: linear-gradient(to bottom, rgba(255,255,255,0.05), rgba(0,0,0,0.1));
      border-radius: 0 0 ${radius}px ${radius}px;
    `);
  }

  // ── State transitions ─────────────────────────────────────────────────────

  _transitionTo(state, onComplete) {
    this._state = state;
    if (!this._actor) return;

    const scale = this._scale;
    let targetW, targetH;

    switch (state) {
      case State.COMPACT:
        targetW = this._settings.get_int("compact-width") || COMPACT_W;
        targetH = this._settings.get_int("compact-height") || COMPACT_H;
        break;
      case State.EXPANDED:
        targetW = this._settings.get_int("expanded-width") || EXPANDED_W;
        targetH = this._settings.get_int("expanded-height") || EXPANDED_H;
        break;
      case State.OSD:
        targetW = this._settings.get_int("osd-width") || OSD_W;
        targetH = this._settings.get_int("osd-height") || OSD_H;
        break;
      case State.NOTIF:
        targetW = NOTIF_W;
        targetH = NOTIF_H;
        break;
      default: // PILL
        targetW = this._settings.get_int("pill-width") || PILL_W;
        targetH = this._settings.get_int("pill-height") || PILL_H;
    }

    targetW = Math.floor(targetW * scale);
    targetH = Math.floor(targetH * scale);
    this._updateNotchStyle(targetH, state);

    for (const v of [
      this._pillView,
      this._compactView,
      this._expandedView,
      this._osdView,
      this._notifView,
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
        if (state === State.PILL) this._pillView.show();
        else if (state === State.COMPACT) this._compactView.show();
        else if (state === State.EXPANDED) {
          this._expandedView.show();
          this._tickSeek();
        } else if (state === State.OSD) this._osdView.show();
        else if (state === State.NOTIF) this._notifView.show();
        onComplete?.();
      },
    });
  }

  _onHoverEnter() {
    // FIX #3: only expand when actually playing
    if (this._mediaProxy && this._playing) this._transitionTo(State.EXPANDED);
  }

  _onHoverLeave() {
    if (this._mediaProxy && this._playing) this._transitionTo(State.COMPACT);
  }

  // ── Media (MPRIS) ────────────────────────────────────────────────────────

  /**
   * FIX #3: Island only becomes visible / transitions to Compact when
   *   PlaybackStatus is "Playing". Paused/Stopped collapses back to Pill.
   *
   * FIX #4: Track-ID comparison resets seek bar immediately on new tracks.
   */
  updateMedia(proxy) {
    this._mediaProxy = proxy;

    const meta = proxy.get_cached_property("Metadata")?.deepUnpack() ?? {};
    const status =
      proxy.get_cached_property("PlaybackStatus")?.unpack() ?? "Stopped";
    const title = meta["xesam:title"]?.unpack() ?? "";
    const rawArtists = meta["xesam:artist"]?.deepUnpack() ?? [];
    const artist = Array.isArray(rawArtists)
      ? (rawArtists[0] ?? "")
      : String(rawArtists);
    const artUrl = meta["mpris:artUrl"]?.unpack() ?? "";

    this._trackLength = Number(meta["mpris:length"]?.unpack() ?? 0);
    this._playing = status === "Playing";

    // FIX #4: Detect track changes and reset seek bar immediately
    const currentTrackId = meta["mpris:trackid"]?.unpack() ?? null;
    if (currentTrackId !== this._lastTrackId) {
      this._lastTrackId = currentTrackId;
      this._seekBasePosition = 0;
      this._seekBaseMonoTime = GLib.get_monotonic_time();
      if (this._seekFill) this._seekFill.set_width(0);
      if (this._posLabel) this._posLabel.set_text("0:00");
      if (this._durLabel)
        this._durLabel.set_text(
          this._trackLength > 0 ? this._µsToTime(this._trackLength) : "0:00",
        );
    }

    this._titleLabel.set_text(title);
    this._titleLabel.visible = title.length > 0;
    this._artistLabel.set_text(artist);
    this._artistLabel.visible = artist.length > 0;

    const pauseIcon = "media-playback-pause-symbolic";
    const playIcon = "media-playback-start-symbolic";
    this._playPauseBtn
      .get_child()
      .set_icon_name(this._playing ? pauseIcon : playIcon);
    this._playPauseBtn.accessible_name = this._playing ? "Pause" : "Play";

    const canPrev =
      proxy.get_cached_property("CanGoPrevious")?.unpack() ?? true;
    const canNext = proxy.get_cached_property("CanGoNext")?.unpack() ?? true;
    this._prevBtn.reactive = canPrev;
    this._prevBtn.opacity = canPrev ? 255 : 80;
    this._nextBtn.reactive = canNext;
    this._nextBtn.opacity = canNext ? 255 : 80;

    if (artUrl && this._settings.get_boolean("show-album-art"))
      this._loadAlbumArt(artUrl);
    else this._clearAlbumArt();

    if (this._playing) {
      this._startSeekTracking();
      this._startWaveform();
    } else {
      this._stopSeekTracking();
      this._stopWaveform();
    }

    // FIX #3 + fullscreen guard: only show island when Playing and not fullscreen
    if (this._playing) {
      this._showActor(180);
      if (this._state === State.PILL || this._state === State.OSD)
        this._transitionTo(State.COMPACT);
    } else {
      if (this._state === State.COMPACT || this._state === State.EXPANDED) {
        if (this._settings.get_boolean("auto-hide")) {
          this._actor.ease({
            opacity: 0,
            duration: 250,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => this._actor?.hide(),
          });
        } else {
          this._transitionTo(State.PILL);
        }
      }
    }
  }

  clearMedia() {
    this._mediaProxy = null;
    this._playing = false;
    this._dominantColor = null;
    this._lastTrackId = null;
    this._seekBasePosition = 0;
    this._seekBaseMonoTime = 0;
    this._stopSeekTracking();
    this._stopWaveform();
    this._clearAlbumArt();

    this._titleLabel?.set_text("");
    if (this._titleLabel) this._titleLabel.visible = false;
    this._artistLabel?.set_text("");
    if (this._artistLabel) this._artistLabel.visible = false;
    this._seekFill?.set_width(0);
    this._posLabel?.set_text("0:00");
    this._durLabel?.set_text("0:00");
    if (this._prevBtn) {
      this._prevBtn.reactive = true;
      this._prevBtn.opacity = 255;
    }
    if (this._nextBtn) {
      this._nextBtn.reactive = true;
      this._nextBtn.opacity = 255;
    }

    if (this._settings.get_boolean("auto-hide")) {
      this._actor?.ease({
        opacity: 0,
        duration: 250,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        onComplete: () => this._actor?.hide(),
      });
    } else {
      this._actor?.show();
      this._transitionTo(State.PILL);
    }
  }

  // ── Playback controls ─────────────────────────────────────────────────────

  _onPlayPause() {
    if (!this._mediaProxy) return;
    const status =
      this._mediaProxy.get_cached_property("PlaybackStatus")?.unpack() ??
      "Stopped";
    this._sendMprisCommand(status === "Stopped" ? "Play" : "PlayPause");
  }

  _sendMprisCommand(method) {
    if (!this._mediaProxy) return;
    this._mediaProxy.call(
      method,
      new GLib.Variant("()", []),
      Gio.DBusCallFlags.NONE,
      -1,
      null,
      null,
    );
  }

  // ── Click-to-Seek — FIX #4 ───────────────────────────────────────────────

  _onSeekClick(actor, event) {
    if (!this._mediaProxy || this._trackLength <= 0)
      return Clutter.EVENT_PROPAGATE;

    const canSeek =
      this._mediaProxy.get_cached_property("CanSeek")?.unpack() ?? true;
    if (!canSeek) return Clutter.EVENT_PROPAGATE;

    const [clickX] = event.get_coords();
    const [actorX] = actor.get_transformed_position();
    const actorW = actor.get_width();
    if (actorW <= 0) return Clutter.EVENT_PROPAGATE;

    const fraction = Math.max(0, Math.min((clickX - actorX) / actorW, 1));
    const targetµs = Math.round(fraction * this._trackLength);

    const meta =
      this._mediaProxy.get_cached_property("Metadata")?.deepUnpack() ?? {};
    const trackId =
      meta["mpris:trackid"]?.unpack() ??
      "/org/mpris/MediaPlayer2/TrackList/NoTrack";

    try {
      this._mediaProxy.call(
        "SetPosition",
        new GLib.Variant("(ox)", [trackId, targetµs]),
        Gio.DBusCallFlags.NONE,
        -1,
        null,
        (proxy, res) => {
          try {
            proxy.call_finish(res);
          } catch (_e) {}
        },
      );
    } catch (e) {
      console.warn("DynamicIsland: SetPosition failed:", e.message);
    }

    // FIX #4: Update local baseline so interpolation continues from new pos
    this._seekBasePosition = targetµs;
    this._seekBaseMonoTime = GLib.get_monotonic_time();

    if (this._seekFill) this._seekFill.set_width(Math.floor(actorW * fraction));
    if (this._posLabel) this._posLabel.set_text(this._µsToTime(targetµs));

    return Clutter.EVENT_STOP;
  }

  // ── OSD — FIX #2 ────────────────────────────────────────────────────────

  showOsd(iconName, level, maxLevel) {
    if (!this._actor) return;

    const scale = this._scale;
    const isVolume = iconName.startsWith("audio-volume");
    const isBrightness = iconName.includes("brightness");

    const isOverAmp = maxLevel != null && maxLevel > 1.0;
    const ceiling = isOverAmp ? OVER_AMP_MAX : 1.0;
    const clampedLevel = Math.min(level ?? 0, ceiling);

    let pct;
    if (isVolume) {
      pct = Math.min(Math.round(clampedLevel * 100), isOverAmp ? 150 : 100);
    } else {
      pct = Math.round((clampedLevel / (maxLevel || 1)) * 100);
    }

    this._osdState = { icon: iconName, level: clampedLevel, max: maxLevel };

    const safeIcon = `${iconName}-symbolic`.replace(
      /-symbolic-symbolic$/,
      "-symbolic",
    );
    this._osdIcon.set_icon_name(safeIcon);
    this._osdValueLabel.set_text(`${pct}%`);

    if (isVolume) {
      this._osdSegBox.show();
      this._osdSmoothBg.hide();

      const volOverAmp = clampedLevel > 1.0;
      const filledCount = volOverAmp
        ? OSD_SEG_COUNT
        : Math.round(Math.min(clampedLevel, 1.0) * OSD_SEG_COUNT);

      this._osdSegs.forEach((seg, i) => {
        if (i < filledCount) {
          seg.add_style_class_name("active");
          if (volOverAmp) seg.add_style_class_name("over-amplified");
          else seg.remove_style_class_name("over-amplified");
        } else {
          seg.remove_style_class_name("active");
          seg.remove_style_class_name("over-amplified");
        }
      });
    } else if (isBrightness) {
      this._osdSegBox.hide();
      this._osdSmoothBg.show();
      this._pendingBrightnessFill = clampedLevel / (maxLevel || 1);
    }

    if (this._osdHideSrc) {
      GLib.Source.remove(this._osdHideSrc);
      this._osdHideSrc = null;
    }
    const timeout = this._settings.get_int("osd-timeout") || OSD_HIDE_MS;
    this._osdHideSrc = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeout, () => {
      this._osdHideSrc = null;
      this._osdState = null;
      if (this._playing) this._transitionTo(State.COMPACT);
      else if (this._settings.get_boolean("auto-hide"))
        this._actor?.ease({
          opacity: 0,
          duration: 250,
          mode: Clutter.AnimationMode.EASE_OUT_QUAD,
          onComplete: () => this._actor?.hide(),
        });
      else this._transitionTo(State.PILL);
      return GLib.SOURCE_REMOVE;
    });

    if (this._state !== State.OSD) {
      // Guard: don't show the OSD island if currently in fullscreen
      if (this._isFullscreen()) return;
      this._transitionTo(State.OSD, () => {
        if (isBrightness && this._pendingBrightnessFill !== undefined) {
          const bgW =
            this._osdSmoothBg.get_width() || Math.floor((OSD_W - 40) * scale);
          this._osdSmoothFill.set_width(
            Math.floor(bgW * this._pendingBrightnessFill),
          );
          this._pendingBrightnessFill = undefined;
        }
      });
    } else if (isBrightness) {
      const bgW =
        this._osdSmoothBg.get_width() || Math.floor((OSD_W - 40) * scale);
      this._osdSmoothFill.set_width(
        Math.floor(bgW * (clampedLevel / (maxLevel || 1))),
      );
    }
  }

  // ── Notification Toasts ───────────────────────────────────────────────────

  _connectNotifications() {
    const tray = Main.messageTray;
    if (!tray) return;

    this._notifMsgTrayAddedId = tray.connect("source-added", (_t, source) => {
      this._watchSource(source);
    });

    this._notifMsgTrayRemovedId = tray.connect(
      "source-removed",
      (_t, source) => {
        const id = this._notifSources.get(source);
        if (id !== undefined) {
          try {
            source.disconnect(id);
          } catch (_e) {}
          this._notifSources.delete(source);
        }
      },
    );

    try {
      const existing = tray.getSources?.() ?? [];
      for (const source of existing) this._watchSource(source);
    } catch (_e) {}
  }

  _watchSource(source) {
    if (this._notifSources.has(source)) return;
    try {
      const id = source.connect("notification-added", (_src, notif) => {
        this._showNotification(notif);
      });
      this._notifSources.set(source, id);
    } catch (_e) {}
  }

  _disconnectNotifications() {
    const tray = Main.messageTray;
    if (tray) {
      if (this._notifMsgTrayAddedId) {
        tray.disconnect(this._notifMsgTrayAddedId);
        this._notifMsgTrayAddedId = 0;
      }
      if (this._notifMsgTrayRemovedId) {
        tray.disconnect(this._notifMsgTrayRemovedId);
        this._notifMsgTrayRemovedId = 0;
      }
    }
    for (const [source, id] of this._notifSources) {
      try {
        source.disconnect(id);
      } catch (_e) {}
    }
    this._notifSources.clear();
  }

  /**
   * NEW — show-notifications guard:
   *   If the "show-notifications" setting is false this method returns
   *   immediately without touching the island state at all.
   */
  _showNotification(notif) {
    if (!this._actor || !this._notifView) return;

    // NEW: honour the show-notifications toggle
    if (!this._settings.get_boolean("show-notifications")) return;

    const appName = notif.source?.title ?? "";
    const title = notif.title ?? "";
    const body = (notif.body ?? "").replace(/\n/g, " ");
    const iconName = notif.source?.iconName ?? "dialog-information-symbolic";

    this._notifIcon.set_icon_name(iconName);
    this._notifAppLabel.set_text(appName);
    this._notifTitleLabel.set_text(title);
    this._notifBodyLabel.set_text(body);
    this._notifBodyLabel.visible = body.length > 0;

    if (this._state !== State.NOTIF) this._stateBeforeNotif = this._state;

    if (this._notifHideSrc) {
      GLib.Source.remove(this._notifHideSrc);
      this._notifHideSrc = null;
    }

    // Show the actor — _showActor() is a no-op when fullscreen is active,
    // so notifications are silently suppressed while a fullscreen window is open.
    this._showActor(180);

    this._transitionTo(State.NOTIF);

    this._notifHideSrc = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      NOTIF_HIDE_MS,
      () => {
        this._notifHideSrc = null;
        this._dismissNotification();
        return GLib.SOURCE_REMOVE;
      },
    );
  }

  _dismissNotification() {
    const restore = this._stateBeforeNotif ?? State.PILL;
    this._stateBeforeNotif = null;

    if (
      restore === State.PILL &&
      !this._mediaProxy &&
      this._settings.get_boolean("auto-hide")
    ) {
      this._actor?.ease({
        opacity: 0,
        duration: 250,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        onComplete: () => this._actor?.hide(),
      });
    } else {
      this._transitionTo(restore);
    }
  }

  // ── Clock ─────────────────────────────────────────────────────────────────

  _updateClock() {
    const now = GLib.DateTime.new_now_local();
    const text = now ? now.format("%H:%M") : null;
    if (text && this._clockLabel) this._clockLabel.set_text(text);
  }

  _startClock() {
    this._stopClock();
    this._updateClock();

    const now = GLib.DateTime.new_now_local();
    const secsLeft = now ? Math.max(1, 60 - now.get_second()) : 60;

    this._clockSrc = GLib.timeout_add_seconds(
      GLib.PRIORITY_DEFAULT,
      secsLeft,
      () => {
        this._updateClock();
        this._clockSrc = GLib.timeout_add_seconds(
          GLib.PRIORITY_DEFAULT,
          60,
          () => {
            this._updateClock();
            return GLib.SOURCE_CONTINUE;
          },
        );
        return GLib.SOURCE_REMOVE;
      },
    );
  }

  _stopClock() {
    if (this._clockSrc) {
      GLib.Source.remove(this._clockSrc);
      this._clockSrc = null;
    }
  }

  // ── Waveform ──────────────────────────────────────────────────────────────

  _startWaveform() {
    this._stopWaveform();

    let phase = 0;
    let beatEnergy = 0;
    let beatCooldown = 0;
    let volumeSmooth = 0.5;

    const n = WAVEFORM_BARS;
    const maxBarH = Math.floor(WAVEFORM_H * this._scale);
    const BEAT_DECAY = 0.18;
    const BEAT_THRESH = 0.3;

    this._waveformSrc = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      WAVEFORM_MS,
      () => {
        if (!this._waveformBars?.length) return GLib.SOURCE_REMOVE;

        phase += 0.22;

        let rawVol = 0.5;
        try {
          const v = this._mediaProxy?.get_cached_property("Volume")?.unpack();
          if (typeof v === "number" && isFinite(v)) rawVol = Math.min(v, 1.5);
        } catch (_e) {}

        volumeSmooth = volumeSmooth * 0.85 + rawVol * 0.15;
        const vol = Math.max(0.05, volumeSmooth);

        if (beatCooldown > 0) {
          beatCooldown--;
        } else if (vol > BEAT_THRESH) {
          const beatProb = 0.08 + (vol - BEAT_THRESH) * 0.35;
          if (Math.random() < beatProb) {
            beatEnergy = 0.5 + Math.random() * 0.5 * vol;
            beatCooldown = 3 + Math.floor(Math.random() * 5);
          }
        }
        beatEnergy = Math.max(0, beatEnergy - BEAT_DECAY);

        this._waveformBars.forEach((bar, i) => {
          const norm = i / (n - 1);
          const env = 0.25 + 0.75 * norm;
          const wave =
            Math.sin(phase * 1.6 + i * 0.55) * 0.5 +
            Math.sin(phase * 0.85 + i * 1.1 + 1.3) * 0.3 +
            Math.sin(phase * 2.4 + i * 0.3 + 2.1) * 0.2;
          const beatOff =
            beatEnergy * (0.6 + Math.sin(i * 0.9 + phase * 3) * 0.4);
          const amplitude = (maxBarH - 2) * vol * env;
          const h =
            2 + Math.abs(wave) * amplitude + beatOff * maxBarH * 0.55 * env;

          bar.ease({
            height: Math.max(2, Math.min(Math.round(h), maxBarH)),
            duration: WAVEFORM_MS - 20,
            mode: Clutter.AnimationMode.EASE_OUT_EXPO,
          });
        });

        return GLib.SOURCE_CONTINUE;
      },
    );
  }

  _stopWaveform() {
    if (this._waveformSrc) {
      GLib.Source.remove(this._waveformSrc);
      this._waveformSrc = null;
    }
  }

  // ── Seek tracking — FIX #4 ───────────────────────────────────────────────

  _startSeekTracking() {
    this._stopSeekTracking();
    this._seekSrc = GLib.timeout_add_seconds(
      GLib.PRIORITY_DEFAULT,
      SEEK_TICK_S,
      () => {
        this._tickSeek();
        return GLib.SOURCE_CONTINUE;
      },
    );
  }

  _stopSeekTracking() {
    if (this._seekSrc) {
      GLib.Source.remove(this._seekSrc);
      this._seekSrc = null;
    }
  }

  /**
   * FIX #4: Two-phase seek update:
   *   1. Immediately render an interpolated position using local monotonic time
   *      so the bar moves smoothly between D-Bus polls.
   *   2. Fire a D-Bus Property.Get("Position") call (2 s timeout) to resync
   *      the baseline from the authoritative player position.
   */
  _tickSeek() {
    if (!this._mediaProxy || !this._actor || !this._seekBg || !this._seekFill)
      return;

    // Phase 1: interpolated display (smooth, no network round-trip)
    if (
      this._state === State.EXPANDED &&
      this._playing &&
      this._trackLength > 0
    ) {
      const elapsedµs = GLib.get_monotonic_time() - this._seekBaseMonoTime;
      const interpolatedPos = Math.min(
        this._seekBasePosition + elapsedµs,
        this._trackLength,
      );
      const pct = Math.max(0, Math.min(interpolatedPos / this._trackLength, 1));
      this._seekFill.set_width(Math.floor(this._seekBg.get_width() * pct));
      if (this._posLabel)
        this._posLabel.set_text(this._µsToTime(interpolatedPos));
      if (this._durLabel)
        this._durLabel.set_text(this._µsToTime(this._trackLength));
    }

    // Phase 2: authoritative D-Bus poll — resync baseline (runs always)
    const owner = this._mediaProxy.g_name_owner;
    if (!owner) return;

    Gio.DBus.session.call(
      owner,
      this._mediaProxy.g_object_path,
      "org.freedesktop.DBus.Properties",
      "Get",
      new GLib.Variant("(ss)", [MPRIS_PLAYER_IFACE, "Position"]),
      new GLib.VariantType("(v)"),
      Gio.DBusCallFlags.NONE,
      2000, // FIX #4: 2 s timeout — Spotify / Firefox are slow to respond
      null,
      (_conn, res) => {
        if (!this._actor || !this._seekFill || !this._posLabel) return;
        try {
          const [posVar] = _conn.call_finish(res).deepUnpack();
          const pos = Number(posVar.unpack());

          // Resync local baseline with authoritative value
          this._seekBasePosition = pos;
          this._seekBaseMonoTime = GLib.get_monotonic_time();

          // Update UI only when expanded (avoid flickering in compact)
          if (this._state === State.EXPANDED && this._trackLength > 0) {
            const pct = Math.max(0, Math.min(pos / this._trackLength, 1));
            this._seekFill.set_width(
              Math.floor(this._seekBg.get_width() * pct),
            );
            if (this._posLabel) this._posLabel.set_text(this._µsToTime(pos));
            if (this._durLabel)
              this._durLabel.set_text(this._µsToTime(this._trackLength));
          } else if (this._state !== State.EXPANDED) {
            if (this._seekFill) this._seekFill.set_width(0);
            if (this._posLabel) this._posLabel.set_text("0:00");
          }
        } catch (_e) {
          // Poll failed — interpolated value stays on screen until next tick
        }
      },
    );
  }

  _µsToTime(µs) {
    const s = Math.floor(µs / 1_000_000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }

  // ── Album art (async, aspect-ratio-safe) ─────────────────────────────────

  _loadAlbumArt(artUrl) {
    if (this._artCancellable) {
      this._artCancellable.cancel();
      this._artCancellable = null;
    }
    if (!artUrl?.startsWith("file://")) {
      this._clearAlbumArt();
      return;
    }

    this._artCancellable = new Gio.Cancellable();
    const file = Gio.File.new_for_uri(artUrl);

    file.load_contents_async(this._artCancellable, (_source, res) => {
      try {
        const [, contents] = file.load_contents_finish(res);
        if (!this._actor) return;

        const loader = GdkPixbuf.PixbufLoader.new();
        loader.write(contents);
        loader.close();
        const pixbuf = loader.get_pixbuf();
        if (!pixbuf) {
          this._clearAlbumArt();
          return;
        }

        const srcW = pixbuf.get_width();
        const srcH = pixbuf.get_height();
        const scale = this._scale;

        const fitPixbuf = (maxSize) => {
          if (srcW <= 0 || srcH <= 0) return pixbuf;
          const ratio = Math.min(maxSize / srcW, maxSize / srcH);
          const dstW = Math.max(1, Math.round(srcW * ratio));
          const dstH = Math.max(1, Math.round(srcH * ratio));
          return pixbuf.scale_simple(dstW, dstH, GdkPixbuf.InterpType.BILINEAR);
        };

        // FIX #1: read art sizes from settings
        const expandedArtPx = Math.floor(
          (this._settings.get_int("art-expanded-size") || ART_EXPANDED) * scale,
        );
        const compactArtPx = Math.floor(
          (this._settings.get_int("art-compact-size") || ART_COMPACT) * scale,
        );

        const bigPb = fitPixbuf(expandedArtPx);
        const smallPb = fitPixbuf(compactArtPx);

        const bigImage = this._pixbufToImage(bigPb);
        const smallImage = this._pixbufToImage(smallPb);

        if (!this._albumArtActor || !this._compactArtActor) return;

        if (bigImage) {
          this._albumArtActor.set_size(bigPb.get_width(), bigPb.get_height());
          this._albumArtActor.set_content(bigImage);
          this._albumFallbackIcon.hide();
          this._albumArtActor.show();
        }
        if (smallImage) {
          this._compactArtActor.set_size(
            smallPb.get_width(),
            smallPb.get_height(),
          );
          this._compactArtActor.set_content(smallImage);
          this._compactFallbackIcon.hide();
          this._compactArtActor.show();
        }

        if (this._settings.get_boolean("dynamic-art-color")) {
          const dc = this._extractDominantColor(pixbuf);
          if (dc) {
            this._dominantColor = dc;
            this._updateNotchStyle(this._actor.height, this._state);
          }
        }
      } catch (e) {
        if (e.matches && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
          return;
        console.error("DynamicIsland: art load failed:", e.message);
        this._clearAlbumArt();
      }
      this._artCancellable = null;
    });
  }

  _clearAlbumArt() {
    if (this._albumArtActor) {
      this._albumArtActor.set_content(null);
      this._albumArtActor.hide();
    }
    this._albumFallbackIcon?.show();
    if (this._compactArtActor) {
      this._compactArtActor.set_content(null);
      this._compactArtActor.hide();
    }
    this._compactFallbackIcon?.show();
    this._dominantColor = null;
    this._updateNotchStyle(this._actor?.height ?? PILL_H, this._state);
  }

  _pixbufToImage(pixbuf) {
    if (!pixbuf) return null;
    try {
      const image = new Clutter.Image();
      const format = pixbuf.get_has_alpha()
        ? Cogl.PixelFormat.RGBA_8888
        : Cogl.PixelFormat.RGB_888;
      image.set_data(
        pixbuf.get_pixels(),
        format,
        pixbuf.get_width(),
        pixbuf.get_height(),
        pixbuf.get_rowstride(),
      );
      return image;
    } catch (e) {
      console.warn("DynamicIsland: pixbuf → Clutter.Image failed:", e.message);
      return null;
    }
  }

  _extractDominantColor(pixbuf) {
    try {
      const sample = pixbuf.scale_simple(8, 8, GdkPixbuf.InterpType.BILINEAR);
      const pixels = sample.get_pixels();
      const rowstride = sample.get_rowstride();
      const hasAlpha = sample.get_has_alpha();
      const channels = hasAlpha ? 4 : 3;
      const w = sample.get_width();
      const h = sample.get_height();

      let rSum = 0,
        gSum = 0,
        bSum = 0,
        count = 0;

      for (let row = 0; row < h; row++) {
        for (let col = 0; col < w; col++) {
          const off = row * rowstride + col * channels;
          const a = hasAlpha ? pixels[off + 3] : 255;
          if (a < 128) continue;
          rSum += pixels[off];
          gSum += pixels[off + 1];
          bSum += pixels[off + 2];
          count++;
        }
      }

      if (count === 0) return null;

      const darken = 0.35;
      return {
        r: Math.round((rSum / count) * darken),
        g: Math.round((gSum / count) * darken),
        b: Math.round((bSum / count) * darken),
      };
    } catch (e) {
      console.warn(
        "DynamicIsland: dominant colour extraction failed:",
        e.message,
      );
      return null;
    }
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────

  destroy() {
    if (this._artCancellable) {
      this._artCancellable.cancel();
      this._artCancellable = null;
    }

    this._disconnectNotifications();

    this._stopClock();
    this._stopSeekTracking();
    this._stopWaveform();

    if (this._osdHideSrc) {
      GLib.Source.remove(this._osdHideSrc);
      this._osdHideSrc = null;
    }
    if (this._notifHideSrc) {
      GLib.Source.remove(this._notifHideSrc);
      this._notifHideSrc = null;
    }
    if (this._collapseTimeoutId) {
      GLib.Source.remove(this._collapseTimeoutId);
      this._collapseTimeoutId = null;
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
  }
}
