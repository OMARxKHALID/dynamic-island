import GLib from "gi://GLib";
import Gio from "gi://Gio";
import Clutter from "gi://Clutter";
import St from "gi://St";
import Pango from "gi://Pango";
import GdkPixbuf from "gi://GdkPixbuf";
import Cogl from "gi://Cogl";
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
  OSD_SEG_COUNT,
  OSD_HIDE_MS,
  WAVEFORM_MS,
  SEEK_TICK_S,
  CLOCK_TICK_MS,
  State,
  ART_COMPACT,
  ART_EXPANDED,
  WAVEFORM_BARS,
  WAVEFORM_H,
  HOVER_DEBOUNCE,
} from "./constants.js";

const MPRIS_PLAYER_IFACE = "org.mpris.MediaPlayer2.Player";

export class DynamicIsland {
  constructor(settings) {
    this._settings = settings;
    this._state = State.PILL;
    this._mediaProxy = null;
    this._playing = false;
    this._trackLength = 0;

    this._waveformSrc = null;
    this._seekSrc = null;
    this._osdHideSrc = null;
    this._clockSrc = null;
    this._artIdleId = null;
    this._collapseTimeoutId = null;

    this._hoverId = 0;
    this._monitorsId = 0;
    this._settingsIds = [];
    this._pendingBrightnessFill = undefined;
  }

  init() {
    this._buildWidget();
    this._addToStage();
    this._connectSettings();
    this._startClock();
  }

  _refreshUI() {
    // 1. Remember state
    const currentState = this._state;

    // 2. Clear children
    this._actor.destroy_all_children();

    // 3. Rebuild and add back
    this._pillView = this._buildPillView();
    this._compactView = this._buildCompactView();
    this._expandedView = this._buildExpandedView();
    this._osdView = this._buildOsdView();

    [
      this._pillView,
      this._compactView,
      this._expandedView,
      this._osdView,
    ].forEach((v) => this._actor.add_child(v));

    // 4. Restore visibility/sync state
    this._pillView.hide();
    this._compactView.hide();
    this._expandedView.hide();
    this._osdView.hide();

    if (currentState === State.PILL) this._pillView.show();
    else if (currentState === State.COMPACT) this._compactView.show();
    else if (currentState === State.EXPANDED) this._expandedView.show();
    else if (currentState === State.OSD) this._osdView.show();

    // 5. Trigger resize animation to new scale
    this._transitionTo(currentState);

    // 6. Reload artwork if needed
    if (this._mediaProxy) {
      const meta =
        this._mediaProxy.get_cached_property("Metadata")?.deepUnpack() ?? {};
      const artUrl = meta["mpris:artUrl"]?.unpack() ?? "";
      if (artUrl && this._settings.get_boolean("show-album-art")) {
        this._loadAlbumArt(artUrl);
      }
      this.updateMedia(this._mediaProxy);
    }
  }

  _buildWidget() {
    this._actor = new St.Widget({
      style_class: "dynamic-island",
      reactive: true,
      track_hover: true,
      clip_to_allocation: true,
      layout_manager: new Clutter.BinLayout(),
    });
    const scale = this._settings.get_double("notch-scale") || 1.0;
    this._actor.set_size(
      Math.floor(PILL_W * scale),
      Math.floor(PILL_H * scale),
    );

    this._pillView = this._buildPillView();
    this._compactView = this._buildCompactView();
    this._expandedView = this._buildExpandedView();
    this._osdView = this._buildOsdView();

    [
      this._pillView,
      this._compactView,
      this._expandedView,
      this._osdView,
    ].forEach((v) => this._actor.add_child(v));

    this._pillView.show();
    this._compactView.hide();
    this._expandedView.hide();
    this._osdView.hide();

    this._hoverId = this._actor.connect("notify::hover", () => {
      if (this._state === State.OSD) return;

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

  _buildPillView() {
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
    });
    const scale = this._settings.get_double("notch-scale") || 1.0;
    this._clockLabel.set_style(`font-size: ${Math.floor(13 * scale)}px;`);
    this._clockLabel.clutter_text.ellipsize = 0;
    box.add_child(this._clockLabel);
    return box;
  }

  _buildCompactView() {
    const box = new St.BoxLayout({
      style_class: "di-compact-view",
      vertical: false,
      x_expand: true,
      y_expand: true,
      y_align: Clutter.ActorAlign.CENTER,
    });

    const scale = this._settings.get_double("notch-scale") || 1.0;
    this._compactArtContainer = new St.Widget({
      style_class: "di-compact-art",
      width: Math.floor(ART_COMPACT * scale),
      height: Math.floor(ART_COMPACT * scale),
      y_align: Clutter.ActorAlign.CENTER,
    });

    this._compactArtActor = new Clutter.Actor({
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
    });
    this._compactFallbackIcon = new St.Icon({
      style_class: "di-compact-icon",
      icon_name: "audio-x-generic-symbolic",
      icon_size: Math.floor(14 * scale),
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
    });

    this._compactArtContainer.add_child(this._compactArtActor);
    this._compactArtContainer.add_child(this._compactFallbackIcon);

    const waveformOuter = new St.Widget({
      layout_manager: new Clutter.BinLayout(),
      height: Math.floor(WAVEFORM_H * scale),
      clip_to_allocation: true,
      y_align: Clutter.ActorAlign.CENTER,
    });
    this._waveformBox = new St.BoxLayout({
      vertical: false,
      y_expand: true,
      y_align: Clutter.ActorAlign.END,
      style: "spacing: 2px;",
    });
    this._waveformBars = [];
    for (let i = 0; i < WAVEFORM_BARS; i++) {
      const bar = new St.Widget({
        style_class: `di-waveform-bar di-bar-${i}`,
        height: 2,
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
    const scale = this._settings.get_double("notch-scale") || 1.0;
    const box = new St.BoxLayout({
      style_class: "di-expanded-view",
      vertical: false,
      x_expand: true,
      y_expand: true,
      style: `spacing: ${Math.floor(18 * scale)}px;`,
    });

    this._albumArtBox = new St.Widget({
      style_class: "di-album-art",
      width: Math.floor(ART_EXPANDED * scale),
      height: Math.floor(ART_EXPANDED * scale),
      clip_to_allocation: true,
      layout_manager: new Clutter.BinLayout(),
      y_align: Clutter.ActorAlign.CENTER,
    });

    this._albumArtActor = new Clutter.Actor({
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

    const rightCol = new St.BoxLayout({
      vertical: true,
      x_expand: true,
      y_align: Clutter.ActorAlign.CENTER,
      style: "spacing: 5px;",
    });

    this._titleLabel = new St.Label({ style_class: "di-title", text: "" });
    this._titleLabel.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
    this._titleLabel.visible = false;

    this._artistLabel = new St.Label({ style_class: "di-artist", text: "" });
    this._artistLabel.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
    this._artistLabel.visible = false;

    this._seekBg = new St.Widget({
      style_class: "di-seek-bg",
      height: 4,
      x_expand: true,
    });
    this._seekFill = new St.Widget({
      style_class: "di-seek-fill",
      height: 4,
      width: 0,
    });
    this._seekBg.add_child(this._seekFill);

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
    this._seekBg.visible = showSeek;
    this._timeRow.visible = showSeek;

    const controls = new St.BoxLayout({
      style_class: "di-controls",
      vertical: false,
      x_expand: true,
      x_align: Clutter.ActorAlign.CENTER,
      style: "spacing: 4px;",
    });
    this._prevBtn = this._makeCtrlBtn("media-skip-backward-symbolic", () =>
      this._onPrevious(),
    );
    this._playPauseBtn = this._makeCtrlBtn(
      "media-playback-start-symbolic",
      () => this._onPlayPause(),
    );
    this._nextBtn = this._makeCtrlBtn("media-skip-forward-symbolic", () =>
      this._onNext(),
    );
    this._playPauseBtn.reactive = true;
    this._nextBtn.reactive = true;
    this._prevBtn.reactive = true;
    controls.add_child(this._prevBtn);
    controls.add_child(this._playPauseBtn);
    controls.add_child(this._nextBtn);
    controls.set_style(`spacing: ${Math.floor(6 * scale)}px;`);

    rightCol.add_child(this._titleLabel);
    rightCol.add_child(this._artistLabel);
    rightCol.add_child(this._seekBg);
    rightCol.add_child(this._timeRow);
    rightCol.add_child(controls);

    box.add_child(this._albumArtBox);
    box.add_child(rightCol);
    return box;
  }

  _buildOsdView() {
    const box = new St.BoxLayout({
      style_class: "di-osd-view",
      vertical: true,
      x_expand: true,
      y_expand: true,
      y_align: Clutter.ActorAlign.CENTER,
      style: "spacing: 12px;",
    });
    const topRow = new St.BoxLayout({
      vertical: false,
      x_expand: true,
      style: "spacing: 8px;",
    });
    this._osdIcon = new St.Icon({ style_class: "di-osd-icon", icon_size: 18 });
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
      style: "spacing: 3px;",
    });
    this._osdSegs = [];
    const scale = this._settings.get_double("notch-scale") || 1.0;
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

  _makeCtrlBtn(iconName, onClicked) {
    const btn = new St.Button({ style_class: "di-ctrl-btn", reactive: true });
    const scale = this._settings.get_double("notch-scale") || 1.0;
    btn.set_child(
      new St.Icon({
        style_class: "di-ctrl-icon",
        icon_name: iconName,
        icon_size: Math.floor(18 * scale),
        reactive: false,
      }),
    );
    btn.connect("button-press-event", () => {
      onClicked();
      return Clutter.EVENT_STOP;
    });
    return btn;
  }

  _addToStage() {
    Main.layoutManager.addChrome(this._actor, {
      affectsStruts: false,
      trackFullscreen: true,
    });
    const scale = this._settings.get_double("notch-scale") || 1.0;
    this._actor.set_size(
      Math.floor(PILL_W * scale),
      Math.floor(PILL_H * scale),
    );
    this._repositionForSize(this._actor.width);

    this._monitorsId = Main.layoutManager.connect("monitors-changed", () =>
      this._repositionForSize(this._actor.width),
    );
  }

  _connectSettings() {
    const watch = (key, fn) =>
      this._settingsIds.push(this._settings.connect(`changed::${key}`, fn));

    watch("position-offset", () => this._repositionForSize(this._actor.width));
    watch("notch-scale", () => this._refreshUI());
    watch("show-seek-bar", () => {
      const show = this._settings.get_boolean("show-seek-bar");
      this._seekBg.visible = show;
      this._timeRow.visible = show;
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

  updateMedia(proxy) {
    this._mediaProxy = proxy;
    const meta = proxy.get_cached_property("Metadata")?.deepUnpack() ?? {};
    const status =
      proxy.get_cached_property("PlaybackStatus")?.unpack() ?? "Stopped";

    const title = meta["xesam:title"]?.unpack() ?? "";
    const artists = meta["xesam:artist"]?.deepUnpack() ?? [];
    const artist = Array.isArray(artists)
      ? (artists[0] ?? "")
      : String(artists);
    const artUrl = meta["mpris:artUrl"]?.unpack() ?? "";

    this._trackLength = Number(meta["mpris:length"]?.unpack() ?? 0);
    this._playing = status === "Playing";

    this._titleLabel.set_text(title);
    this._titleLabel.visible = title.length > 0;
    this._artistLabel.set_text(artist);
    this._artistLabel.visible = artist.length > 0;

    this._playPauseBtn
      .get_child()
      .set_icon_name(
        this._playing
          ? "media-playback-pause-symbolic"
          : "media-playback-start-symbolic",
      );

    const canGoPrev =
      proxy.get_cached_property("CanGoPrevious")?.unpack() ?? true;
    const canGoNext = proxy.get_cached_property("CanGoNext")?.unpack() ?? true;

    this._prevBtn.reactive = canGoPrev;
    this._prevBtn.opacity = canGoPrev ? 255 : 80;
    this._nextBtn.reactive = canGoNext;
    this._nextBtn.opacity = canGoNext ? 255 : 80;

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

    if (!this._actor.visible) {
      this._actor.show();
      this._actor.opacity = 0;
      this._actor.ease({
        opacity: 255,
        duration: 180,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
      });
    } else if (this._actor.opacity < 255) {
      this._actor.ease({
        opacity: 255,
        duration: 180,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
      });
    }

    if (this._state === State.PILL || this._state === State.OSD)
      this._transitionTo(State.COMPACT);
  }

  clearMedia() {
    this._mediaProxy = null;
    this._playing = false;
    this._stopSeekTracking();
    this._stopWaveform();
    this._clearAlbumArt();
    this._titleLabel.set_text("");
    this._titleLabel.visible = false;
    this._artistLabel.set_text("");
    this._artistLabel.visible = false;
    this._seekFill.set_width(0);
    this._posLabel.set_text("0:00");
    this._durLabel.set_text("0:00");
    this._prevBtn.reactive = true;
    this._nextBtn.reactive = true;
    this._prevBtn.opacity = 255;
    this._nextBtn.opacity = 255;

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

  _onPlayPause() {
    if (!this._mediaProxy) return;
    const status =
      this._mediaProxy.get_cached_property("PlaybackStatus")?.unpack() ??
      "Stopped";
    const method = status === "Stopped" ? "Play" : "PlayPause";
    this._mediaProxy.call(
      method,
      new GLib.Variant("()", []),
      Gio.DBusCallFlags.NONE,
      -1,
      null,
      null,
    );
  }

  _onPrevious() {
    if (!this._mediaProxy) return;
    this._mediaProxy.call(
      "Previous",
      new GLib.Variant("()", []),
      Gio.DBusCallFlags.NONE,
      -1,
      null,
      null,
    );
  }

  _onNext() {
    if (!this._mediaProxy) return;
    this._mediaProxy.call(
      "Next",
      new GLib.Variant("()", []),
      Gio.DBusCallFlags.NONE,
      -1,
      null,
      null,
    );
  }

  _startClock() {
    this._stopClock();
    const tick = () => {
      this._clockLabel?.set_text(GLib.DateTime.new_now_local().format("%H:%M"));
      return GLib.SOURCE_CONTINUE;
    };
    tick();
    const secsLeft = 60 - GLib.DateTime.new_now_local().get_second();
    this._clockSrc = GLib.timeout_add_seconds(
      GLib.PRIORITY_DEFAULT,
      secsLeft,
      () => {
        tick();
        this._clockSrc = GLib.timeout_add_seconds(
          GLib.PRIORITY_DEFAULT,
          60,
          tick,
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

  _loadAlbumArt(artUrl) {
    if (this._artIdleId) {
      GLib.Source.remove(this._artIdleId);
      this._artIdleId = null;
    }
    this._artIdleId = GLib.idle_add(GLib.PRIORITY_LOW, () => {
      this._artIdleId = null;
      if (!this._actor) return GLib.SOURCE_REMOVE;
      try {
        if (!artUrl.startsWith("file://")) {
          this._clearAlbumArt();
          return GLib.SOURCE_REMOVE;
        }
        const scale = this._settings.get_double("notch-scale") || 1.0;
        const [path] = GLib.filename_from_uri(artUrl);
        const bigSize = Math.floor(ART_EXPANDED * scale);
        const smallSize = Math.floor(ART_COMPACT * scale);

        const big = GdkPixbuf.Pixbuf.new_from_file_at_scale(
          path,
          bigSize,
          bigSize,
          true,
        );
        const small = GdkPixbuf.Pixbuf.new_from_file_at_scale(
          path,
          smallSize,
          smallSize,
          true,
        );

        this._albumArtActor.set_size(big.get_width(), big.get_height());
        this._albumArtActor.set_content(this._pixbufToImage(big));
        this._albumFallbackIcon.hide();
        this._albumArtActor.show();

        this._compactArtActor.set_size(small.get_width(), small.get_height());
        this._compactArtActor.set_content(this._pixbufToImage(small));
        this._compactFallbackIcon.hide();
        this._compactArtActor.show();
      } catch (e) {
        console.error("DynamicIsland: art load failed:", e.message);
        this._clearAlbumArt();
      }
      return GLib.SOURCE_REMOVE;
    });
  }

  _clearAlbumArt() {
    this._albumArtActor.set_content(null);
    this._albumArtActor.hide();
    this._albumFallbackIcon.show();
    this._compactArtActor.set_content(null);
    this._compactArtActor.hide();
    this._compactFallbackIcon.show();
  }

  _pixbufToImage(pixbuf) {
    if (!pixbuf) return null;
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
  }

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

  _tickSeek() {
    if (!this._mediaProxy || this._state !== State.EXPANDED) return;
    const owner = this._mediaProxy.g_name_owner;
    const path = this._mediaProxy.g_object_path;
    if (!owner) return;

    Gio.DBus.session.call(
      owner,
      path,
      "org.freedesktop.DBus.Properties",
      "Get",
      new GLib.Variant("(ss)", [MPRIS_PLAYER_IFACE, "Position"]),
      new GLib.VariantType("(v)"),
      Gio.DBusCallFlags.NONE,
      500,
      null,
      (conn, res) => {
        try {
          const reply = conn.call_finish(res);
          const [posVar] = reply.deepUnpack();
          const pos = Number(posVar.unpack());
          if (this._trackLength > 0 && this._seekBg) {
            const progress = Math.max(0, Math.min(pos / this._trackLength, 1));
            this._seekFill.set_width(
              Math.floor(this._seekBg.get_width() * progress),
            );
            this._posLabel.set_text(this._µsToTime(pos));
            this._durLabel.set_text(this._µsToTime(this._trackLength));
          } else {
            this._seekFill.set_width(0);
            this._posLabel.set_text("0:00");
            this._durLabel.set_text(
              this._trackLength > 0
                ? this._µsToTime(this._trackLength)
                : "0:00",
            );
          }
        } catch (_) {
          this._seekFill.set_width(0);
          this._posLabel.set_text("0:00");
        }
      },
    );
  }

  _µsToTime(µs) {
    const s = Math.floor(µs / 1_000_000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }

  _startWaveform() {
    this._stopWaveform();
    let phase = 0;
    const n = WAVEFORM_BARS;
    this._waveformSrc = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      WAVEFORM_MS,
      () => {
        phase += 0.28;
        this._waveformBars.forEach((bar, i) => {
          const norm = i / (n - 1);
          const env =
            0.3 +
            0.55 * Math.exp(-norm * 2.8) +
            0.38 * Math.exp(-((norm - 0.3) ** 2) / 0.06);
          const h =
            2 +
            Math.abs(
              Math.sin(phase * 1.4 + i * 0.6) * 11 * env +
                Math.sin(phase * 0.75 + i * 1.2 + 1.1) * 5 * env,
            );
          bar.ease({
            height: Math.max(2, Math.round(h)),
            duration: WAVEFORM_MS - 15,
            mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
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

  showOsd(iconName, level, maxLevel) {
    const scale = this._settings.get_double("notch-scale") || 1.0;
    const pct = Math.round((level / (maxLevel || 1)) * 100);
    const isVolume = iconName.startsWith("audio-volume");
    const isBrightness = iconName.includes("brightness");

    this._osdIcon.set_icon_name(
      `${iconName}-symbolic`.replace("-symbolic-symbolic", "-symbolic"),
    );
    this._osdValueLabel.set_text(`${pct}%`);

    if (isVolume) {
      this._osdSegBox.show();
      this._osdSmoothBg.hide();
      const filled = Math.round((pct / 100) * OSD_SEG_COUNT);
      this._osdSegs.forEach((seg, i) => {
        if (i < filled) {
          seg.add_style_class_name("active");
          if (pct > 100) seg.add_style_class_name("over-amplified");
          else seg.remove_style_class_name("over-amplified");
        } else {
          seg.remove_style_class_name("active");
          seg.remove_style_class_name("over-amplified");
        }
      });
    } else if (isBrightness) {
      this._osdSegBox.hide();
      this._osdSmoothBg.show();
      this._pendingBrightnessFill = level / (maxLevel || 1);
    }

    if (this._osdHideSrc) GLib.Source.remove(this._osdHideSrc);
    this._osdHideSrc = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      OSD_HIDE_MS,
      () => {
        this._osdHideSrc = null;
        if (this._playing) this._transitionTo(State.COMPACT);
        else if (this._settings.get_boolean("auto-hide")) {
          this._actor.ease({
            opacity: 0,
            duration: 250,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => this._actor.hide(),
          });
        } else this._transitionTo(State.PILL);
        return GLib.SOURCE_REMOVE;
      },
    );

    if (this._state !== State.OSD) {
      this._transitionTo(State.OSD, () => {
        if (isBrightness && this._pendingBrightnessFill !== undefined) {
          // Explicitly ensure the fill is visible by using a calculated width if real width is 0
          const bgW = this._osdSmoothBg.get_width() || (OSD_W - 40) * scale;
          this._osdSmoothFill.set_width(
            Math.floor(bgW * this._pendingBrightnessFill),
          );
          this._pendingBrightnessFill = undefined;
        }
      });
    } else if (isBrightness) {
      const bgW = this._osdSmoothBg.get_width() || (OSD_W - 40) * scale;
      this._osdSmoothFill.set_width(
        Math.floor(bgW * (level / (maxLevel || 1))),
      );
    }
  }

  _onHoverEnter() {
    if (this._mediaProxy) this._transitionTo(State.EXPANDED);
  }

  _onHoverLeave() {
    if (this._mediaProxy) this._transitionTo(State.COMPACT);
  }

  _transitionTo(state, onComplete) {
    this._state = state;
    if (!this._actor) return;
    const scale = this._settings.get_double("notch-scale") || 1.0;

    let targetW = PILL_W;
    let targetH = PILL_H;

    if (state === State.COMPACT) {
      targetW = COMPACT_W;
      targetH = COMPACT_H;
    } else if (state === State.EXPANDED) {
      targetW = EXPANDED_W;
      targetH = EXPANDED_H;
    } else if (state === State.OSD) {
      targetW = OSD_W;
      targetH = OSD_H;
    }

    targetW = Math.floor(targetW * scale);
    targetH = Math.floor(targetH * scale);

    const dur = this._settings.get_int("animation-duration") || 340;

    [
      this._pillView,
      this._compactView,
      this._expandedView,
      this._osdView,
    ].forEach((v) => v.hide());

    const monitor = Main.layoutManager.primaryMonitor;
    if (!monitor) return;
    const offset = this._settings.get_int("position-offset");
    const targetX =
      monitor.x + Math.floor((monitor.width - targetW) / 2) + offset;

    this._actor.ease({
      x: targetX,
      width: targetW,
      height: targetH,
      duration: dur,
      mode: Clutter.AnimationMode.EASE_OUT_EXPO,
      onComplete: () => {
        if (state === State.PILL) this._pillView.show();
        else if (state === State.COMPACT) this._compactView.show();
        else if (state === State.EXPANDED) {
          this._expandedView.show();
          this._tickSeek();
        } else if (state === State.OSD) this._osdView.show();
        if (onComplete) onComplete();
      },
    });
  }

  destroy() {
    this._stopClock();
    this._stopSeekTracking();
    this._stopWaveform();
    if (this._osdHideSrc) GLib.Source.remove(this._osdHideSrc);
    if (this._artIdleId) GLib.Source.remove(this._artIdleId);
    if (this._collapseTimeoutId) GLib.Source.remove(this._collapseTimeoutId);
    if (this._monitorsId) Main.layoutManager.disconnect(this._monitorsId);
    this._settingsIds.forEach((id) => this._settings.disconnect(id));
    if (this._actor) {
      this._actor.destroy();
      this._actor = null;
    }
  }
}
