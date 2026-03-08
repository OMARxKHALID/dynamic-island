/**
 * island/view.js
 *
 * View construction and styling logic for Dynamic Island.
 */

import Clutter from "gi://Clutter";
import St from "gi://St";
import Pango from "gi://Pango";
import Shell from "gi://Shell";
import GLib from "gi://GLib";
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
  STASH_W,
  STASH_H,
  OSD_SEG_COUNT,
  WAVEFORM_BARS,
  WAVEFORM_H,
  HOVER_DEBOUNCE,
  State,
  ART_COMPACT,
  ART_EXPANDED,
} from "../constants.js";

export class IslandView {
  constructor(core) {
    this.core = core;
  }

  // ── Main Shell ───────────────────────────────────────────────────────────

  buildWidget() {
    const scale = this.core._scale;
    const pillW = this.getPillW();
    const pillH = this.getPillH();

    const actor = new St.Widget({
      style_class: "dynamic-island",
      reactive: true,
      track_hover: true,
      clip_to_allocation: true,
      layout_manager: new Clutter.BinLayout(),
    });
    actor.set_size(pillW, pillH);
    this.updateNotchStyle(actor, pillH, State.PILL);

    try {
      this.core._blurEffect = new Shell.BlurEffect({
        brightness: 0.7,
        blur_radius: Math.floor(40 * scale),
        mode: Shell.BlurMode.BACKGROUND,
      });
      actor.add_effect(this.core._blurEffect);
    } catch (_e) {
      this.core._blurEffect = null;
    }

    this.core._pillView = this.buildPillView();
    this.core._compactView = this.buildCompactView();
    this.core._expandedView = this.buildExpandedView();
    this.core._osdView = this.buildOsdView();
    this.core._notifView = this.buildNotifView();
    this.core._stashView = this.buildStashView();

    for (const v of [
      this.core._pillView,
      this.core._compactView,
      this.core._expandedView,
      this.core._osdView,
      this.core._notifView,
      this.core._stashView,
    ])
      actor.add_child(v);

    this.core._pillView.show();
    this.core._compactView.hide();
    this.core._expandedView.hide();
    this.core._osdView.hide();
    this.core._notifView.hide();
    this.core._stashView.hide();

    this.core._hoverId = actor.connect("notify::hover", () => {
      if (this.core._state === State.OSD || this.core._state === State.NOTIF) return;

      if (actor.hover) {
        this.core._cancelAutoHide();
        if (this.core._collapseTimeoutId) {
          GLib.Source.remove(this.core._collapseTimeoutId);
          this.core._collapseTimeoutId = null;
        }
        this.core._onHoverEnter();
      } else {
        this.core._resetAutoHideTimer();
        if (this.core._collapseTimeoutId) return;
        this.core._collapseTimeoutId = GLib.timeout_add(
          GLib.PRIORITY_DEFAULT,
          HOVER_DEBOUNCE,
          () => {
            this.core._collapseTimeoutId = null;
            if (!this.core._actor || this.core._actor.hover) return GLib.SOURCE_REMOVE;
            this.core._onHoverLeave();
            return GLib.SOURCE_REMOVE;
          },
        );
      }
    });

    return actor;
  }

  // ── View Builders ────────────────────────────────────────────────────────

  buildPillView() {
    const scale = this.core._scale;
    const box = new St.BoxLayout({
      style_class: "di-pill-view",
      x_expand: true,
      y_expand: true,
      x_align: Clutter.ActorAlign.FILL,
      y_align: Clutter.ActorAlign.CENTER,
      style: `spacing: ${Math.floor(6 * scale)}px;`,
    });

    this.core._btIndicator = new St.BoxLayout({
      style_class: "di-bt-indicator",
      vertical: false,
      y_align: Clutter.ActorAlign.CENTER,
      visible: false,
      style: `spacing: ${Math.floor(3 * scale)}px;`,
    });
    this.core._btDeviceIcon = new St.Icon({
      style_class: "di-bt-icon",
      icon_name: "bluetooth-active-symbolic",
      icon_size: Math.floor(12 * scale),
      y_align: Clutter.ActorAlign.CENTER,
    });
    this.core._btBatteryLabel = new St.Label({
      style_class: "di-bt-label",
      text: "",
      y_align: Clutter.ActorAlign.CENTER,
      style: this.getFont(12),
    });
    this.core._btIndicator.add_child(this.core._btDeviceIcon);
    this.core._btIndicator.add_child(this.core._btBatteryLabel);

    this.core._weatherWidget = new St.BoxLayout({
      style_class: "di-weather",
      vertical: false,
      y_align: Clutter.ActorAlign.CENTER,
      visible:
        this.core._settings.get_boolean("show-weather") &&
        !!this.core._lastWeatherData?.temp,
      style: `spacing: ${Math.floor(3 * scale)}px;`,
    });
    this.core._weatherIconLabel = new St.Label({
      style_class: "di-weather-icon",
      text: "",
      y_align: Clutter.ActorAlign.CENTER,
      style: this.getFont(12),
    });
    this.core._weatherTempLabel = new St.Label({
      style_class: "di-weather-temp",
      text: "",
      y_align: Clutter.ActorAlign.CENTER,
      style: this.getFont(12),
    });
    this.core._weatherWidget.add_child(this.core._weatherIconLabel);
    this.core._weatherWidget.add_child(this.core._weatherTempLabel);

    this.core._pillPrefixSpacer = new St.Widget({
      x_expand: true,
      x_align: Clutter.ActorAlign.FILL,
      visible: false,
    });
    this.core._pillSuffixSpacer = new St.Widget({
      x_expand: true,
      x_align: Clutter.ActorAlign.FILL,
      visible: false,
    });
    this.core._pillMidSpacer = new St.Widget({
      x_expand: true,
      x_align: Clutter.ActorAlign.FILL,
      visible: true,
    });

    this.core._clockLabel = new St.Label({
      style_class: "di-clock-label",
      text: "--:--",
      y_align: Clutter.ActorAlign.CENTER,
      style: this.getFont(12),
    });
    this.core._clockLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;

    box.add_child(this.core._pillPrefixSpacer);
    box.add_child(this.core._btIndicator);
    box.add_child(this.core._weatherWidget);
    box.add_child(this.core._pillMidSpacer);
    box.add_child(this.core._clockLabel);
    box.add_child(this.core._pillSuffixSpacer);
    return box;
  }

  buildCompactView() {
    const scale = this.core._scale;
    const artSize = this.getArtCompactSize();

    const box = new St.BoxLayout({
      style_class: "di-compact-view",
      vertical: false,
      x_expand: true,
      y_expand: true,
      x_align: Clutter.ActorAlign.FILL,
      y_align: Clutter.ActorAlign.CENTER,
    });

    this.core._compactArtContainer = new St.Widget({
      style_class: "di-compact-art",
      width: artSize,
      height: artSize,
      layout_manager: new Clutter.BinLayout(),
      x_align: Clutter.ActorAlign.START,
      y_align: Clutter.ActorAlign.CENTER,
    });
    this.core._compactArtActor = new Clutter.Actor({
      width: artSize,
      height: artSize,
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
    });
    this.core._compactFallbackIcon = new St.Icon({
      style_class: "di-compact-icon",
      icon_name: "audio-x-generic-symbolic",
      icon_size: Math.floor(18 * scale),
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
      x_expand: true,
      y_expand: true,
    });
    this.core._compactArtContainer.add_child(this.core._compactArtActor);
    this.core._compactArtContainer.add_child(this.core._compactFallbackIcon);

    const waveformOuter = new St.Widget({
      layout_manager: new Clutter.BinLayout(),
      height: Math.floor(WAVEFORM_H * scale),
      clip_to_allocation: true,
      y_align: Clutter.ActorAlign.CENTER,
      x_align: Clutter.ActorAlign.END,
    });
    this.core._waveformBox = new St.BoxLayout({
      vertical: false,
      y_expand: true,
      y_align: Clutter.ActorAlign.END,
      style: `spacing: ${Math.floor(2 * scale)}px;`,
    });
    this.core._waveformBars = [];
    for (let i = 0; i < WAVEFORM_BARS; i++) {
      const bar = new St.Widget({
        style_class: "di-waveform-bar",
        width: Math.floor(3 * scale),
        height: Math.floor(2 * scale),
        y_align: Clutter.ActorAlign.END,
      });
      this.core._waveformBars.push(bar);
      this.core._waveformBox.add_child(bar);
    }
    waveformOuter.add_child(this.core._waveformBox);
    waveformOuter.add_child(
      new St.Widget({
        style_class: "di-waveform-fade",
        x_expand: true,
        y_expand: true,
        reactive: false,
      }),
    );

    box.add_child(this.core._compactArtContainer);
    box.add_child(new St.Widget({ x_expand: true }));
    box.add_child(waveformOuter);
    return box;
  }

  buildExpandedView() {
    const scale = this.core._scale;
    const artSize = this.getArtExpandedSize();

    const box = new St.BoxLayout({
      style_class: "di-expanded-view",
      vertical: false,
      x_expand: true,
      y_expand: true,
      style: `spacing: ${Math.floor(18 * scale)}px;`,
    });

    this.core._albumArtBox = new St.Widget({
      style_class: "di-album-art",
      width: artSize,
      height: artSize,
      clip_to_allocation: true,
      layout_manager: new Clutter.BinLayout(),
      x_align: Clutter.ActorAlign.START,
      y_align: Clutter.ActorAlign.CENTER,
    });
    this.core._albumArtActor = new Clutter.Actor({
      width: artSize,
      height: artSize,
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
    });
    this.core._albumFallbackIcon = new St.Icon({
      style_class: "di-album-fallback",
      icon_name: "audio-x-generic-symbolic",
      icon_size: Math.floor(52 * scale),
      x_expand: true,
      y_expand: true,
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
    });

    this.core._albumArtBox.add_child(this.core._albumArtActor);
    this.core._albumArtBox.add_child(this.core._albumFallbackIcon);

    const rightCol = new St.BoxLayout({
      vertical: true,
      x_expand: true,
      y_expand: true,
      y_align: Clutter.ActorAlign.FILL,
      style: `spacing: ${Math.floor(4 * scale)}px;`,
    });

    this.core._titleLabel = new St.Label({
      style_class: "di-title",
      text: "",
      style: this.getFont(14),
    });
    this.core._titleLabel.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
    this.core._titleLabel.visible = false;

    this.core._artistLabel = new St.Label({
      style_class: "di-artist",
      text: "",
      style: this.getFont(11),
    });
    this.core._artistLabel.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
    this.core._artistLabel.visible = false;

    const barH = Math.floor(6 * scale);
    const hitH = Math.floor(20 * scale);

    this.core._seekHit = new St.Widget({
      style_class: "di-seek-hit",
      height: hitH,
      x_expand: true,
      reactive: true,
      track_hover: true,
      layout_manager: new Clutter.BinLayout(),
    });
    this.core._seekBg = new St.Widget({
      style_class: "di-seek-bg",
      height: barH,
      x_expand: true,
      x_align: Clutter.ActorAlign.FILL,
      y_align: Clutter.ActorAlign.CENTER,
    });
    this.core._seekFill = new St.Widget({
      style_class: "di-seek-fill",
      height: barH,
      width: 0,
      y_align: Clutter.ActorAlign.CENTER,
    });
    this.core._seekBg.add_child(this.core._seekFill);
    this.core._seekHit.add_child(this.core._seekBg);

    this.core._timeRow = new St.BoxLayout({
      style_class: "di-time-row",
      vertical: false,
      x_expand: true,
    });
    this.core._posLabel = new St.Label({
      style_class: "di-time",
      text: "0:00",
      style: this.getFont(10),
    });
    this.core._durLabel = new St.Label({
      style_class: "di-time",
      text: "0:00",
      style: this.getFont(10),
    });
    this.core._timeRow.add_child(this.core._posLabel);
    this.core._timeRow.add_child(new St.Widget({ x_expand: true }));
    this.core._timeRow.add_child(this.core._durLabel);

    const showSeek = this.core._settings.get_boolean("show-seek-bar");
    this.core._seekHit.visible = showSeek;
    this.core._timeRow.visible = showSeek;

    this.core._seekTracker.setWidgets(
      this.core._seekHit,
      this.core._seekBg,
      this.core._seekFill,
      this.core._posLabel,
      this.core._durLabel,
    );

    const controls = new St.BoxLayout({
      style_class: "di-controls",
      vertical: false,
      x_expand: true,
      x_align: Clutter.ActorAlign.CENTER,
      style: `spacing: ${Math.floor(6 * scale)}px;`,
    });
    this.core._prevBtn = this.makeCtrlBtn(
      "media-skip-backward-symbolic",
      "Previous Track",
      () => this.core._sendMprisCommand("Previous"),
    );
    this.core._playPauseBtn = this.makeCtrlBtn(
      "media-playback-start-symbolic",
      "Play",
      () => this.core._onPlayPause(),
    );
    this.core._nextBtn = this.makeCtrlBtn(
      "media-skip-forward-symbolic",
      "Next Track",
      () => this.core._sendMprisCommand("Next"),
    );
    controls.add_child(this.core._prevBtn);
    controls.add_child(this.core._playPauseBtn);
    controls.add_child(this.core._nextBtn);

    rightCol.add_child(this.core._titleLabel);
    rightCol.add_child(this.core._artistLabel);
    rightCol.add_child(new St.Widget({ y_expand: true }));
    rightCol.add_child(this.core._seekHit);
    rightCol.add_child(this.core._timeRow);
    rightCol.add_child(controls);

    box.add_child(this.core._albumArtBox);
    box.add_child(rightCol);
    return box;
  }

  buildOsdView() {
    const scale = this.core._scale;
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
    this.core._osdIcon = new St.Icon({
      style_class: "di-osd-icon",
      icon_size: Math.floor(18 * scale),
    });
    this.core._osdValueLabel = new St.Label({
      style_class: "di-osd-value",
      text: "",
      x_expand: true,
      x_align: Clutter.ActorAlign.END,
      style: this.getFont(14),
    });
    topRow.add_child(this.core._osdIcon);
    topRow.add_child(this.core._osdValueLabel);

    this.core._osdSegBox = new St.BoxLayout({
      vertical: false,
      x_expand: true,
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
      style: `spacing: ${Math.floor(2 * scale)}px;`,
    });
    this.core._osdSegs = [];
    for (let i = 0; i < OSD_SEG_COUNT; i++) {
      const seg = new St.Widget({
        style_class: "di-osd-seg",
        width: Math.floor(6 * scale),
        height: Math.floor(22 * scale),
      });
      this.core._osdSegs.push(seg);
      this.core._osdSegBox.add_child(seg);
    }

    this.core._osdSmoothBg = new St.Widget({
      style_class: "di-osd-smooth-bg",
      height: Math.floor(6 * scale),
      x_expand: true,
    });
    this.core._osdSmoothFill = new St.Widget({
      style_class: "di-osd-smooth-fill",
      height: Math.floor(6 * scale),
      width: 0,
    });
    this.core._osdSmoothBg.add_child(this.core._osdSmoothFill);

    box.add_child(topRow);
    box.add_child(this.core._osdSegBox);
    box.add_child(this.core._osdSmoothBg);
    return box;
  }

  buildNotifView() {
    const scale = this.core._scale;
    const box = new St.BoxLayout({
      style_class: "di-notif-view",
      vertical: false,
      x_expand: true,
      y_expand: true,
      y_align: Clutter.ActorAlign.CENTER,
      style: `spacing: ${Math.floor(12 * scale)}px; padding: 0 ${Math.floor(16 * scale)}px;`,
    });

    this.core._notifIcon = new St.Icon({
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

    this.core._notifAppLabel = new St.Label({
      style_class: "di-notif-app",
      text: "",
      style: this.getFont(9),
    });
    this.core._notifAppLabel.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);

    this.core._notifTitleLabel = new St.Label({
      style_class: "di-notif-title",
      text: "",
      style: this.getFont(13),
    });
    this.core._notifTitleLabel.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);

    this.core._notifBodyLabel = new St.Label({
      style_class: "di-notif-body",
      text: "",
      style: this.getFont(11),
    });
    this.core._notifBodyLabel.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);

    textCol.add_child(this.core._notifAppLabel);
    textCol.add_child(this.core._notifTitleLabel);
    textCol.add_child(this.core._notifBodyLabel);

    box.add_child(this.core._notifIcon);
    box.add_child(textCol);
    return box;
  }

  buildStashView() {
    const scale = this.core._scale;

    const outer = new St.BoxLayout({
      style_class: "di-stash-view",
      vertical: false,
      x_expand: true,
      y_expand: true,
      y_align: Clutter.ActorAlign.CENTER,
      style: `spacing: ${Math.floor(12 * scale)}px; padding: 0 ${Math.floor(16 * scale)}px;`,
    });

    this.core._stashIcon = new St.Icon({
      style_class: "di-stash-icon",
      icon_name: "folder-drag-accept-symbolic",
      icon_size: Math.floor(26 * scale),
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
    });

    const col = new St.BoxLayout({
      vertical: true,
      x_expand: true,
      y_align: Clutter.ActorAlign.CENTER,
      style: `spacing: ${Math.floor(2 * scale)}px;`,
    });

    const headerRow = new St.BoxLayout({
      vertical: false,
      x_expand: true,
      y_align: Clutter.ActorAlign.CENTER,
    });

    const categoryLabel = new St.Label({
      style_class: "di-stash-category",
      text: "FILE STASH",
      x_expand: true,
      style: this.getFont(9),
    });

    this.core._stashClearBtn = new St.Button({
      style_class: "di-ctrl-btn",
      reactive: true,
      accessible_name: "Clear stash",
    });
    this.core._stashClearBtn.set_child(
      new St.Icon({
        style_class: "di-ctrl-icon",
        icon_name: "window-close-symbolic",
        icon_size: Math.floor(12 * scale),
      }),
    );
    this.core._stashClearBtn.connect("clicked", () => {
      this.core._stashActionCallback?.("clear");
      return Clutter.EVENT_STOP;
    });

    headerRow.add_child(categoryLabel);
    headerRow.add_child(this.core._stashClearBtn);

    this.core._stashCountLabel = new St.Label({
      style_class: "di-stash-count",
      text: "0 items",
      style: this.getFont(13),
    });
    this.core._stashCountLabel.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);

    this.core._stashDestLabel = new St.Label({
      style_class: "di-stash-dest",
      text: "Open a folder in Nautilus",
      style: this.getFont(11),
    });
    this.core._stashDestLabel.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);

    const actionRow = new St.BoxLayout({
      vertical: false,
      x_expand: true,
      style: `spacing: ${Math.floor(5 * scale)}px; margin-top: ${Math.floor(4 * scale)}px;`,
    });

    this.core._stashMoveBtn = new St.Button({
      label: "Move",
      style_class: "di-stash-action",
      can_focus: true,
      reactive: false,
    });
    this.core._stashMoveBtn.connect("clicked", () => {
      this.core._stashActionCallback?.("move");
      return Clutter.EVENT_STOP;
    });

    this.core._stashCopyBtn = new St.Button({
      label: "Copy",
      style_class: "di-stash-action",
      can_focus: true,
      reactive: false,
    });
    this.core._stashCopyBtn.connect("clicked", () => {
      this.core._stashActionCallback?.("copy");
      return Clutter.EVENT_STOP;
    });

    actionRow.add_child(this.core._stashMoveBtn);
    actionRow.add_child(this.core._stashCopyBtn);

    col.add_child(headerRow);
    col.add_child(this.core._stashCountLabel);
    col.add_child(this.core._stashDestLabel);
    col.add_child(actionRow);

    outer.add_child(this.core._stashIcon);
    outer.add_child(col);
    return outer;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  makeCtrlBtn(iconName, accessibleName, onClicked) {
    const btn = new St.Button({
      style_class: "di-ctrl-btn",
      reactive: true,
      accessible_name: accessibleName,
    });
    btn.set_child(
      new St.Icon({
        style_class: "di-ctrl-icon",
        icon_name: iconName,
        icon_size: Math.floor(18 * this.core._scale),
      }),
    );
    btn.connect("clicked", () => {
      onClicked();
      return Clutter.EVENT_STOP;
    });
    return btn;
  }

  updateNotchStyle(actor, height, state) {
    if (!actor) return;
    const bgOpacity = this.core._settings.get_double("background-opacity") || 0.84;
    let r = 10,
      g = 10,
      b = 10;

    if (
      this.core._settings.get_boolean("dynamic-art-color") &&
      this.core._dominantColor
    ) {
      ({ r, g, b } = this.core._dominantColor);
    } else {
      const bgColor =
        this.core._settings.get_string("background-color") || "#0a0a0a";
      if (bgColor.startsWith("#") && bgColor.length === 7) {
        const hex = bgColor.slice(1);
        r = parseInt(hex.substring(0, 2), 16);
        g = parseInt(hex.substring(2, 4), 16);
        b = parseInt(hex.substring(4, 6), 16);
      }
    }

    let radius = Math.round(height / 2);
    if (state === State.EXPANDED || state === State.NOTIF)
      radius = Math.round(44 * this.core._scale);
    else if (state === State.OSD || state === State.STASH)
      radius = Math.round(38 * this.core._scale);

    actor.set_style(
      `background-color: rgba(${r},${g},${b},${bgOpacity});` +
        `border-radius: 0 0 ${radius}px ${radius}px;`,
    );
  }

  // ── Geometry ─────────────────────────────────────────────────────────────

  getPillW() {
    return Math.floor(
      (this.core._settings.get_int("pill-width") || PILL_W) * this.core._scale,
    );
  }
  getPillH() {
    return Math.floor(
      (this.core._settings.get_int("pill-height") || PILL_H) * this.core._scale,
    );
  }
  getCompactW() {
    return Math.floor(
      (this.core._settings.get_int("compact-width") || COMPACT_W) * this.core._scale,
    );
  }
  getCompactH() {
    return Math.floor(
      (this.core._settings.get_int("compact-height") || COMPACT_H) * this.core._scale,
    );
  }
  getExpandedW() {
    return Math.floor(
      (this.core._settings.get_int("expanded-width") || EXPANDED_W) * this.core._scale,
    );
  }
  getExpandedH() {
    return Math.floor(
      (this.core._settings.get_int("expanded-height") || EXPANDED_H) * this.core._scale,
    );
  }
  getOsdW() {
    return Math.floor(
      (this.core._settings.get_int("osd-width") || OSD_W) * this.core._scale,
    );
  }
  getOsdH() {
    return Math.floor(
      (this.core._settings.get_int("osd-height") || OSD_H) * this.core._scale,
    );
  }
  getNotifW() {
    return Math.floor(NOTIF_W * this.core._scale);
  }
  getNotifH() {
    return Math.floor(NOTIF_H * this.core._scale);
  }
  getStashW() {
    return Math.floor(STASH_W * this.core._scale);
  }
  getStashH() {
    return Math.floor(STASH_H * this.core._scale);
  }
  getArtExpandedSize() {
    return Math.floor(
      (this.core._settings.get_int("art-expanded-size") || ART_EXPANDED) *
        this.core._scale,
    );
  }
  getArtCompactSize() {
    return Math.floor(
      (this.core._settings.get_int("art-compact-size") || ART_COMPACT) * this.core._scale,
    );
  }
  getFont(basePx) {
    return `font-size: ${Math.floor(basePx * this.core._scale * this.core._fontSizeMultiplier)}px;`;
  }
}

