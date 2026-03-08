/**
 * island.js
 *
 * Core Dynamic Island actor.
 * States: Pill (clock) → Compact (waveform) → Expanded (player) → OSD → Notif
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
  State,
  ART_COMPACT,
  ART_EXPANDED,
  WAVEFORM_BARS,
  WAVEFORM_H,
  HOVER_DEBOUNCE,
} from "./constants.js";

import { SeekTracker } from "./seekTracker.js";

const OVER_AMP_MAX = 1.5;

export class IslandCore {
  constructor(settings) {
    this._settings = settings;

    // State machine
    this._state = State.PILL;
    this._stateBeforeNotif = null;

    // Media
    this._mediaProxy = null;
    this._playing = false;
    this._trackLength = 0;
    this._lastTrackId = null;

    // Cached data — reapplied after _refreshUI() rebuilds views
    this._lastWeatherData = null;
    this._lastBtDevices = [];

    // Pill-view separator (null until first _buildPillView)
    this._pillSep = null;

    // OSD
    this._osdState = null;
    this._pendingBrightnessFill = null;

    // Dynamic art colour
    this._dominantColor = null;

    // GLib source IDs
    this._waveformSrc = null;
    this._osdHideSrc = null;
    this._notifHideSrc = null;
    this._clockSrc = null;
    this._collapseTimeoutId = null;
    this._autoHideSrc = null;
    // Idle source for deferred seek-bar render after expand (layout must settle first)
    this._renderIdleSrc = null;

    // Async art loading
    this._artCancellable = null;

    // Signal IDs
    this._hoverId = 0;
    this._monitorsId = 0;
    this._fullscreenId = 0;
    this._settingsIds = [];

    // Notification watcher
    this._notifMsgTrayAddedId = 0;
    this._notifMsgTrayRemovedId = 0;
    this._notifSources = new Map();

    // Cached settings values
    this._scale = 1.0;
    this._animDur = 280;

    // Seek tracker (created in init())
    this._seekTracker = null;
  }

  // ── Public entry point ────────────────────────────────────────────────────

  init() {
    this._scale = this._settings.get_double("notch-scale") || 1.0;
    this._animDur = this._settings.get_int("animation-duration") || 280;

    this._seekTracker = new SeekTracker(this._settings);

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

  // ── Settings watchers ─────────────────────────────────────────────────────

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
        this._dismissNotification();
      }
    });

    watch("show-weather", () => {
      if (this._weatherWidget)
        this._weatherWidget.visible =
          this._settings.get_boolean("show-weather") &&
          !!this._lastWeatherData?.temp;
    });

    watch("show-bluetooth", () => {
      this.updateBluetooth(this._lastBtDevices ?? []);
    });
  }

  // ── Widget construction ───────────────────────────────────────────────────

  _buildWidget() {
    const scale = this._scale;
    const pillW = this._getPillW();
    const pillH = this._getPillH();

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

    // Hover
    this._hoverId = this._actor.connect("notify::hover", () => {
      if (this._state === State.OSD || this._state === State.NOTIF) return;

      if (this._actor.hover) {
        this._cancelAutoHide();
        if (this._collapseTimeoutId) {
          GLib.Source.remove(this._collapseTimeoutId);
          this._collapseTimeoutId = null;
        }
        this._onHoverEnter();
      } else {
        this._resetAutoHideTimer();
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
      x_align: Clutter.ActorAlign.FILL,
      y_align: Clutter.ActorAlign.CENTER,
      style: `spacing: ${Math.floor(6 * scale)}px;`,
    });

    // Bluetooth indicator
    this._btIndicator = new St.BoxLayout({
      style_class: "di-bt-indicator",
      vertical: false,
      y_align: Clutter.ActorAlign.CENTER,
      visible: false,
      style: `spacing: ${Math.floor(3 * scale)}px;`,
    });
    this._btDeviceIcon = new St.Icon({
      style_class: "di-bt-icon",
      icon_name: "bluetooth-active-symbolic",
      icon_size: Math.floor(12 * scale),
      y_align: Clutter.ActorAlign.CENTER,
    });
    this._btBatteryLabel = new St.Label({
      style_class: "di-bt-label",
      text: "",
      y_align: Clutter.ActorAlign.CENTER,
    });
    this._btIndicator.add_child(this._btDeviceIcon);
    this._btIndicator.add_child(this._btBatteryLabel);

    // Weather widget
    this._weatherWidget = new St.BoxLayout({
      style_class: "di-weather",
      vertical: false,
      y_align: Clutter.ActorAlign.CENTER,
      visible:
        this._settings.get_boolean("show-weather") &&
        !!this._lastWeatherData?.temp,
      style: `spacing: ${Math.floor(3 * scale)}px;`,
    });
    this._weatherIconLabel = new St.Label({
      style_class: "di-weather-icon",
      text: "",
      y_align: Clutter.ActorAlign.CENTER,
    });
    this._weatherTempLabel = new St.Label({
      style_class: "di-weather-temp",
      text: "",
      y_align: Clutter.ActorAlign.CENTER,
    });
    this._weatherWidget.add_child(this._weatherIconLabel);
    this._weatherWidget.add_child(this._weatherTempLabel);

    const spacer = new St.Widget({ x_expand: true });

    // Subtle 1 px vertical separator between the info group and the clock.
    // Visible only when at least one info widget (BT / weather) is shown.
    this._pillSep = new St.Widget({
      style_class: "di-pill-sep",
      width: 1,
      height: Math.floor(14 * scale),
      y_align: Clutter.ActorAlign.CENTER,
      visible: false,
    });

    this._clockLabel = new St.Label({
      style_class: "di-clock-label",
      text: "--:--",
      y_align: Clutter.ActorAlign.CENTER,
    });
    this._clockLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;

    box.add_child(this._btIndicator);
    box.add_child(this._weatherWidget);
    box.add_child(spacer);
    box.add_child(this._pillSep);
    box.add_child(this._clockLabel);
    return box;
  }

  _buildCompactView() {
    const scale = this._scale;
    const artSize = this._getArtCompactSize();

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
        style_class: "di-waveform-bar",
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
    const artSize = this._getArtExpandedSize();

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

    this._titleLabel = new St.Label({ style_class: "di-title", text: "" });
    this._titleLabel.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
    this._titleLabel.visible = false;

    this._artistLabel = new St.Label({ style_class: "di-artist", text: "" });
    this._artistLabel.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
    this._artistLabel.visible = false;

    // Seek bar — 20 px transparent hit-area around a 6 px visual track
    const barH = Math.floor(6 * scale);
    const hitH = Math.floor(20 * scale);

    this._seekHit = new St.Widget({
      style_class: "di-seek-hit",
      height: hitH,
      x_expand: true,
      reactive: true,
      track_hover: true,
      layout_manager: new Clutter.BinLayout(),
    });
    this._seekBg = new St.Widget({
      style_class: "di-seek-bg",
      height: barH,
      x_expand: true,
      x_align: Clutter.ActorAlign.FILL,
      y_align: Clutter.ActorAlign.CENTER,
    });
    this._seekFill = new St.Widget({
      style_class: "di-seek-fill",
      height: barH,
      width: 0,
      y_align: Clutter.ActorAlign.CENTER,
    });
    this._seekBg.add_child(this._seekFill);
    this._seekHit.add_child(this._seekBg);

    this._timeRow = new St.BoxLayout({
      style_class: "di-time-row",
      vertical: false,
      x_expand: true,
    });
    this._posLabel = new St.Label({ style_class: "di-time", text: "0:00" });
    this._durLabel = new St.Label({ style_class: "di-time", text: "0:00" });
    this._timeRow.add_child(this._posLabel);
    this._timeRow.add_child(new St.Widget({ x_expand: true }));
    this._timeRow.add_child(this._durLabel);

    const showSeek = this._settings.get_boolean("show-seek-bar");
    this._seekHit.visible = showSeek;
    this._timeRow.visible = showSeek;

    // Wire seek widgets into the tracker
    this._seekTracker.setWidgets(
      this._seekHit,
      this._seekBg,
      this._seekFill,
      this._posLabel,
      this._durLabel,
    );

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
    rightCol.add_child(this._seekHit);
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
    });
    this._notifAppLabel.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);

    this._notifTitleLabel = new St.Label({
      style_class: "di-notif-title",
      text: "",
    });
    this._notifTitleLabel.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);

    this._notifBodyLabel = new St.Label({
      style_class: "di-notif-body",
      text: "",
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

  // ── Stage integration ─────────────────────────────────────────────────────

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

  // ── Size Calculation Helpers ────────────────────────────────────────────────

  _getPillW() { return Math.floor((this._settings.get_int("pill-width") || PILL_W) * this._scale); }
  _getPillH() { return Math.floor((this._settings.get_int("pill-height") || PILL_H) * this._scale); }
  _getCompactW() { return Math.floor((this._settings.get_int("compact-width") || COMPACT_W) * this._scale); }
  _getCompactH() { return Math.floor((this._settings.get_int("compact-height") || COMPACT_H) * this._scale); }
  _getExpandedW() { return Math.floor((this._settings.get_int("expanded-width") || EXPANDED_W) * this._scale); }
  _getExpandedH() { return Math.floor((this._settings.get_int("expanded-height") || EXPANDED_H) * this._scale); }
  _getOsdW() { return Math.floor((this._settings.get_int("osd-width") || OSD_W) * this._scale); }
  _getOsdH() { return Math.floor((this._settings.get_int("osd-height") || OSD_H) * this._scale); }

  _getArtExpandedSize() { return Math.floor((this._settings.get_int("art-expanded-size") || ART_EXPANDED) * this._scale); }
  _getArtCompactSize() { return Math.floor((this._settings.get_int("art-compact-size") || ART_COMPACT) * this._scale); }

  _repositionForSize(width) {
    const monitor = Main.layoutManager.primaryMonitor;
    if (!monitor) return;
    const offset = this._settings.get_int("position-offset");
    this._actor.set_position(
      monitor.x + Math.floor((monitor.width - width) / 2) + offset,
      monitor.y,
    );
  }

  // ── Full UI rebuild ───────────────────────────────────────────────────────

  _refreshUI() {
    const currentState = this._state;

    this._stopWaveform();
    this._stopClock();
    if (this._osdHideSrc) {
      GLib.Source.remove(this._osdHideSrc);
      this._osdHideSrc = null;
    }
    if (this._notifHideSrc) {
      GLib.Source.remove(this._notifHideSrc);
      this._notifHideSrc = null;
    }

    // Cancel in-flight art load and null actors BEFORE destroy_all_children()
    // so stale async callbacks see nulls and bail out safely.
    if (this._artCancellable) {
      this._artCancellable.cancel();
      this._artCancellable = null;
    }
    this._albumArtActor = null;
    this._compactArtActor = null;

    const scale = this._scale;
    let baseH;
    switch (currentState) {
      case State.PILL: baseH = this._getPillH(); break;
      case State.COMPACT: baseH = this._getCompactH(); break;
      case State.EXPANDED: baseH = this._getExpandedH(); break;
      case State.OSD: baseH = this._getOsdH(); break;
      case State.NOTIF: baseH = Math.floor(NOTIF_H * scale); break;
      default: baseH = this._getPillH();
    }
    this._updateNotchStyle(baseH, currentState);

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
      this._seekTracker.renderNow();
    }

    if (this._lastWeatherData) this.updateWeather(this._lastWeatherData);
    if (this._lastBtDevices?.length) this.updateBluetooth(this._lastBtDevices);

    if (this._mediaProxy) this.updateMedia(this._mediaProxy);
    if (this._osdState)
      this.showOsd(
        this._osdState.icon,
        this._osdState.level,
        this._osdState.max,
      );
  }

  // ── Notch style ───────────────────────────────────────────────────────────

  _updateNotchStyle(height, state) {
    const bgOpacity = this._settings.get_double("background-opacity") || 0.84;
    let r = 10,
      g = 10,
      b = 10;

    if (
      this._settings.get_boolean("dynamic-art-color") &&
      this._dominantColor
    ) {
      ({ r, g, b } = this._dominantColor);
    } else {
      const bgColor =
        this._settings.get_string("background-color") || "#0a0a0a";
      if (bgColor.startsWith("#") && bgColor.length === 7) {
        const hex = bgColor.slice(1);
        r = parseInt(hex.substring(0, 2), 16);
        g = parseInt(hex.substring(2, 4), 16);
        b = parseInt(hex.substring(4, 6), 16);
      }
    }

    let radius = Math.round(height / 2);
    if (state === State.EXPANDED || state === State.NOTIF)
      radius = Math.round(44 * this._scale);
    else if (state === State.OSD) radius = Math.round(38 * this._scale);

    this._actor.set_style(
      `background-color: rgba(${r},${g},${b},${bgOpacity});` +
        `border-radius: 0 0 ${radius}px ${radius}px;`,
    );
  }

  // ── State transitions ─────────────────────────────────────────────────────

  _transitionTo(state, onComplete) {
    this._state = state;
    if (!this._actor) return;

    const scale = this._scale;
    let targetW, targetH;

    switch (state) {
      case State.COMPACT:
        targetW = this._getCompactW();
        targetH = this._getCompactH();
        break;
      case State.EXPANDED:
        targetW = this._getExpandedW();
        targetH = this._getExpandedH();
        break;
      case State.OSD:
        targetW = this._getOsdW();
        targetH = this._getOsdH();
        break;
      case State.NOTIF:
        targetW = Math.floor(NOTIF_W * scale);
        targetH = Math.floor(NOTIF_H * scale);
        break;
      default:
        targetW = this._getPillW();
        targetH = this._getPillH();
    }

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
        this._actor.set_size(targetW, targetH);
        this._actor.set_x(targetX);

        if (state === State.PILL) this._pillView.show();
        else if (state === State.COMPACT) this._compactView.show();
        else if (state === State.EXPANDED) {
          this._expandedView.show();
          // Defer renderNow() to the NEXT idle frame so that Clutter has had
          // time to do a layout pass and _seekBg.get_width() returns the actual
          // allocated width rather than 0 or a stale preferred-size value.
          // Without this, the fill is drawn at the wrong proportion the first
          // time the expanded view opens on each track.
          if (this._renderIdleSrc) {
            GLib.Source.remove(this._renderIdleSrc);
            this._renderIdleSrc = null;
          }
          this._renderIdleSrc = GLib.idle_add(
            GLib.PRIORITY_DEFAULT_IDLE,
            () => {
              this._renderIdleSrc = null;
              if (!this._seekTracker || !this._actor) return GLib.SOURCE_REMOVE;
              // Re-fetch actual playback position from player, then render
              this._seekTracker.fetchNow();
              return GLib.SOURCE_REMOVE;
            },
          );
        } else if (state === State.OSD) this._osdView.show();
        else if (state === State.NOTIF) this._notifView.show();

        if (state === State.PILL && !this._playing) this._resetAutoHideTimer();

        onComplete?.();
      },
    });
  }

  _onHoverEnter() {
    if (this._mediaProxy && this._playing) this._transitionTo(State.EXPANDED);
  }

  _onHoverLeave() {
    if (this._mediaProxy && this._playing) this._transitionTo(State.COMPACT);
  }

  // ── Smart auto-hide ───────────────────────────────────────────────────────

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
        if (this._playing || this._state === State.OSD || this._actor?.hover)
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

  // ── Media (MPRIS) ─────────────────────────────────────────────────────────

  updateMedia(proxy) {
    this._mediaProxy = proxy;

    // FIX: capture playing state BEFORE updating it — used below to decide
    // whether to call start() (resume) vs doing nothing (still playing).
    const wasPlaying = this._playing;

    const meta = proxy.get_cached_property("Metadata")?.deepUnpack() ?? {};
    const status =
      proxy.get_cached_property("PlaybackStatus")?.unpack() ?? "Stopped";
    const title = meta["xesam:title"]?.unpack() ?? "";
    const rawArtists = meta["xesam:artist"]?.deepUnpack() ?? [];
    const artist = Array.isArray(rawArtists)
      ? (rawArtists[0] ?? "")
      : String(rawArtists);
    const artUrl = meta["mpris:artUrl"]?.unpack() ?? "";
    const newLength = Number(meta["mpris:length"]?.unpack() ?? 0);

    this._trackLength = newLength;
    this._playing = status === "Playing";

    const currentTrackId = meta["mpris:trackid"]?.unpack() ?? null;
    const trackChanged = currentTrackId !== this._lastTrackId;
    if (trackChanged) this._lastTrackId = currentTrackId;

    this._titleLabel.set_text(title);
    this._titleLabel.visible = title.length > 0;
    this._artistLabel.set_text(artist);
    this._artistLabel.visible = artist.length > 0;

    const playIcon = "media-playback-start-symbolic";
    const pauseIcon = "media-playback-pause-symbolic";
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
      if (trackChanged) {
        // New track — full position reset
        this._seekTracker.reset(proxy, newLength);
      } else if (!wasPlaying) {
        // Resumed from pause — re-anchor without resetting position to 0
        this._seekTracker.start(proxy, newLength);
      }
      // else: still playing same track — leave tracker alone so the progress
      // bar does NOT snap back to 0 on every property-changed event (volume,
      // art updates, CanGoNext flips, etc.)
      this._startWaveform();
      this._cancelAutoHide();
    } else {
      this._seekTracker.stop();
      this._stopWaveform();
      this._resetAutoHideTimer();
    }

    if (this._playing) {
      if (this._collapseTimeoutId) {
        GLib.Source.remove(this._collapseTimeoutId);
        this._collapseTimeoutId = null;
      }
      this._showActor(180);
      if (this._state === State.PILL || this._state === State.OSD)
        this._transitionTo(State.COMPACT);
    } else {
      if (this._state === State.COMPACT || this._state === State.EXPANDED) {
        if (!this._collapseTimeoutId) {
          this._collapseTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 800, () => {
            this._collapseTimeoutId = null;
            if (this._state === State.COMPACT || this._state === State.EXPANDED) {
              this._transitionTo(State.PILL);
            }
            return GLib.SOURCE_REMOVE;
          });
        }
      }
    }
  }

  /**
   * Called when the MPRIS player fires the Seeked signal — e.g. the user
   * scrubs in Spotify/VLC, or another app seeks programmatically.
   * Re-anchors the seek tracker immediately so the island bar matches.
   * @param {number} posMicros  New absolute position in microseconds.
   */
  onPlayerSeeked(posMicros) {
    this._seekTracker?.seekedTo(posMicros);
  }

  clearMedia() {
    this._playing = false;
    this._dominantColor = null;
    this._lastTrackId = null;
    this._trackLength = 0;

    if (this._collapseTimeoutId) {
      GLib.Source.remove(this._collapseTimeoutId);
      this._collapseTimeoutId = null;
    }

    this._seekTracker.stop();
    this._stopWaveform();
    this._clearAlbumArt();

    this._titleLabel?.set_text("");
    if (this._titleLabel) this._titleLabel.visible = false;
    this._artistLabel?.set_text("");
    if (this._artistLabel) this._artistLabel.visible = false;
    if (this._prevBtn) {
      this._prevBtn.reactive = true;
      this._prevBtn.opacity = 255;
    }
    if (this._nextBtn) {
      this._nextBtn.reactive = true;
      this._nextBtn.opacity = 255;
    }

    this._actor?.show();
    if (this._actor) this._actor.opacity = 255;
    this._transitionTo(State.PILL);
  }

  // ── Weather ───────────────────────────────────────────────────────────────

  updateWeather(data) {
    this._lastWeatherData = data;
    if (!this._weatherWidget) return;
    if (data?.temp) {
      this._weatherTempLabel?.set_text(data.temp);
      this._weatherIconLabel?.set_text(data.icon ?? "");
    }
    this._weatherWidget.visible =
      this._settings.get_boolean("show-weather") && !!data?.temp;
    this._updatePillSep();
  }

  /** Toggle the pill separator based on whether any left-side widget is visible. */
  _updatePillSep() {
    if (!this._pillSep) return;
    const btVis = this._btIndicator?.visible ?? false;
    const wxVis = this._weatherWidget?.visible ?? false;
    this._pillSep.visible = btVis || wxVis;
  }

  // ── Bluetooth ─────────────────────────────────────────────────────────────

  updateBluetooth(devices) {
    this._lastBtDevices = devices;

    const show = this._settings.get_boolean("show-bluetooth");
    const hasConn = devices.length > 0;

    if (this._btIndicator) this._btIndicator.visible = show && hasConn;

    // Update pill label
    if (hasConn) {
      const primary = devices[0];
      const iconMap = {
        "audio-headset": "audio-headset-symbolic",
        "audio-headphones": "audio-headphones-symbolic",
        phone: "phone-symbolic",
        computer: "computer-symbolic",
        "input-gaming": "input-gaming-symbolic",
        "input-keyboard": "input-keyboard-symbolic",
        "input-mouse": "input-mouse-symbolic",
      };
      this._btDeviceIcon?.set_icon_name(
        iconMap[primary.icon] ?? "bluetooth-active-symbolic",
      );

      let labelText = "";
      if (devices.length > 1) labelText = `${devices.length}×`;
      else if (primary.battery !== null && primary.battery !== undefined)
        labelText = `${primary.battery}%`;

      this._btBatteryLabel?.set_text(labelText);
    }

    // Update pill separator visibility
    this._updatePillSep();
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

  // ── OSD ───────────────────────────────────────────────────────────────────

  showOsd(iconName, level, maxLevel) {
    if (!this._actor) return;

    const scale = this._scale;
    const isVolume = iconName.startsWith("audio-volume");
    const isBright = iconName.includes("brightness");
    const isOverAmp = maxLevel != null && maxLevel > 1.0;
    const ceiling = isOverAmp ? OVER_AMP_MAX : 1.0;
    const clamped = Math.min(level ?? 0, ceiling);

    let pct;
    if (isVolume)
      pct = Math.min(Math.round(clamped * 100), isOverAmp ? 150 : 100);
    else pct = Math.round((clamped / (maxLevel || 1)) * 100);

    this._osdState = { icon: iconName, level: clamped, max: maxLevel };

    const safeIcon = `${iconName}-symbolic`.replace(
      /-symbolic-symbolic$/,
      "-symbolic",
    );
    this._osdIcon.set_icon_name(safeIcon);
    this._osdValueLabel.set_text(`${pct}%`);

    if (isVolume) {
      this._osdSegBox.show();
      this._osdSmoothBg.hide();
      const volOverAmp = clamped > 1.0;
      const filledCount = volOverAmp
        ? OSD_SEG_COUNT
        : Math.round(Math.min(clamped, 1.0) * OSD_SEG_COUNT);
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
    } else if (isBright) {
      this._osdSegBox.hide();
      this._osdSmoothBg.show();
      this._pendingBrightnessFill = clamped / (maxLevel || 1);
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
      else this._transitionTo(State.PILL);
      return GLib.SOURCE_REMOVE;
    });

    if (this._state !== State.OSD) {
      if (this._isFullscreen()) return;
      this._showActor(100);
      this._transitionTo(State.OSD, () => {
        if (isBright && this._pendingBrightnessFill !== null) {
          const bgW = this._osdSmoothBg.get_width() || Math.floor(this._getOsdW() - (40 * scale));
          this._osdSmoothFill.set_width(
            Math.floor(bgW * this._pendingBrightnessFill),
          );
          this._pendingBrightnessFill = null;
        }
      });
    } else if (isBright) {
      const bgW = this._osdSmoothBg.get_width() || Math.floor(this._getOsdW() - (40 * scale));
      this._osdSmoothFill.set_width(
        Math.floor(bgW * (clamped / (maxLevel || 1))),
      );
    }

    this._cancelAutoHide();
  }

  // ── Notifications ─────────────────────────────────────────────────────────

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
      for (const source of tray.getSources?.() ?? []) this._watchSource(source);
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

  _showNotification(notif) {
    if (!this._actor || !this._notifView) return;
    if (!this._settings.get_boolean("show-notifications")) return;

    const appName = notif.source?.title ?? "";
    const title = notif.title ?? "";
    const body = (notif.body ?? "").replace(/\n/g, " ");

    // GNOME 45+: source.icon is a Gio.Icon; older: source.iconName is a string
    const gicon = notif.source?.icon ?? null;
    if (gicon) {
      this._notifIcon.set_gicon(gicon);
    } else {
      const iconName = notif.source?.iconName ?? "dialog-information-symbolic";
      this._notifIcon.set_icon_name(iconName);
    }

    this._notifAppLabel.set_text(appName);
    this._notifTitleLabel.set_text(title);
    this._notifBodyLabel.set_text(body);
    this._notifBodyLabel.visible = body.length > 0;

    if (this._state !== State.NOTIF) this._stateBeforeNotif = this._state;

    if (this._notifHideSrc) {
      GLib.Source.remove(this._notifHideSrc);
      this._notifHideSrc = null;
    }

    this._showActor(180);
    this._transitionTo(State.NOTIF);
    this._cancelAutoHide();

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
      this._resetAutoHideTimer();
    } else {
      this._transitionTo(restore);
      if (!this._playing) this._resetAutoHideTimer();
    }
  }

  // ── Clock ─────────────────────────────────────────────────────────────────

  _updateClock() {
    const now = GLib.DateTime.new_now_local();
    const text = now?.format("%H:%M");
    if (text && this._clockLabel) this._clockLabel.set_text(text);
  }

  /**
   * Starts a two-phase clock: first fires at the next full minute boundary,
   * then ticks every 60 s.  Uses a single GLib source ID at a time — the
   * phase-2 source is scheduled only after phase-1 has fully completed.
   */
  _startClock() {
    this._stopClock();
    this._updateClock();

    const now = GLib.DateTime.new_now_local();
    const secsLeft = now ? Math.max(1, 60 - now.get_second()) : 60;

    // Phase 1: wait until the next minute boundary
    this._clockSrc = GLib.timeout_add_seconds(
      GLib.PRIORITY_DEFAULT,
      secsLeft,
      () => {
        // Null out phase-1 ID before scheduling phase-2 to avoid any window
        // where _clockSrc could refer to an already-removed source.
        this._clockSrc = null;
        this._updateClock();

        // Phase 2: tick every 60 s
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
    let phase = 0,
      beatEnergy = 0,
      beatCooldown = 0,
      volumeSmooth = 0.5;

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

  // ── Album art ─────────────────────────────────────────────────────────────

  _loadAlbumArt(artUrl) {
    if (this._artCancellable) {
      this._artCancellable.cancel();
      this._artCancellable = null;
    }
    if (!artUrl?.startsWith("file://")) {
      this._clearAlbumArt();
      return;
    }

    const cancellable = new Gio.Cancellable();
    this._artCancellable = cancellable;

    const file = Gio.File.new_for_uri(artUrl);
    file.load_contents_async(cancellable, (_source, res) => {
      if (!this._albumArtActor || !this._compactArtActor) return;
      try {
        const [, contents] = file.load_contents_finish(res);

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
          return pixbuf.scale_simple(
            Math.max(1, Math.round(srcW * ratio)),
            Math.max(1, Math.round(srcH * ratio)),
            GdkPixbuf.InterpType.BILINEAR,
          );
        };

        const expandedPx = this._getArtExpandedSize();
        const compactPx = this._getArtCompactSize();

        const bigPb = fitPixbuf(expandedPx);
        const smallPb = fitPixbuf(compactPx);
        const bigImg = this._pixbufToImage(bigPb);
        const smallImg = this._pixbufToImage(smallPb);

        if (!this._albumArtActor || !this._compactArtActor) return;

        if (bigImg) {
          this._albumArtActor.set_size(bigPb.get_width(), bigPb.get_height());
          this._albumArtActor.set_content(bigImg);
          this._albumFallbackIcon?.hide();
          this._albumArtActor.show();
        }
        if (smallImg) {
          this._compactArtActor.set_size(
            smallPb.get_width(),
            smallPb.get_height(),
          );
          this._compactArtActor.set_content(smallImg);
          this._compactFallbackIcon?.hide();
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
        if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) return;
        console.error("DynamicIsland: art load failed:", e.message);
        this._clearAlbumArt();
      }
      if (this._artCancellable === cancellable) this._artCancellable = null;
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
      console.warn("DynamicIsland: pixbuf→Image failed:", e.message);
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
      const d = 0.35;
      return {
        r: Math.round((rSum / count) * d),
        g: Math.round((gSum / count) * d),
        b: Math.round((bSum / count) * d),
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
    this._albumArtActor = null;
    this._compactArtActor = null;

    this._disconnectNotifications();
    this._stopClock();
    this._stopWaveform();

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
  }
}
