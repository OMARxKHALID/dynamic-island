import GLib from "gi://GLib";
import Gio from "gi://Gio";
import Clutter from "gi://Clutter";
import St from "gi://St";
import Pango from "gi://Pango";
import GdkPixbuf from "gi://GdkPixbuf";
import Cogl from "gi://Cogl";
import * as Main from "resource:///org/gnome/shell/ui/main.js";

const PILL_W = 160;
const PILL_H = 34;
const COMPACT_W = 145;
const COMPACT_H = 40;
const EXPANDED_W = 460;
const EXPANDED_H = 155;
const OSD_W = 330;
const OSD_H = 114;
const ART_COMPACT = 26;
const ART_EXPANDED = 110;

const OSD_SEG_COUNT = 28;
const OSD_HIDE_MS = 2500;
const WAVEFORM_MS = 135;
const WAVEFORM_BARS = 7;
const WAVEFORM_H = 26;
const SEEK_TICK_S = 1;
const HOVER_DEBOUNCE = 350;

const MPRIS_PLAYER_IFACE = "org.mpris.MediaPlayer2.Player";

const State = Object.freeze({
  PILL: "pill",
  COMPACT: "compact",
  EXPANDED: "expanded",
  OSD: "osd",
});

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

  // ── Widget construction ──────────────────────────────────────────────────

  _buildWidget() {
    this._actor = new St.Widget({
      style_class: "dynamic-island",
      reactive: true,
      track_hover: true,
      clip_to_allocation: true,
      layout_manager: new Clutter.BinLayout(),
    });
    this._actor.set_size(PILL_W, PILL_H);

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

    // Debounce collapse: notify::hover briefly fires false when the pointer
    // moves onto a reactive child (button) even though it is still inside the
    // island boundary. The timeout absorbs that transient false-leave before
    // deciding to actually collapse.
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
            if (!this._actor?.hover) this._onHoverLeave();
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

    this._compactArtContainer = new St.Widget({
      style_class: "di-compact-art",
      width: ART_COMPACT,
      height: ART_COMPACT,
      y_align: Clutter.ActorAlign.CENTER,
    });
    this._compactArtActor = new Clutter.Actor({
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
    });
    this._compactFallbackIcon = new St.Icon({
      style_class: "di-compact-icon",
      icon_name: "audio-x-generic-symbolic",
      icon_size: 14,
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
    });
    this._compactArtContainer.add_child(this._compactArtActor);
    this._compactArtContainer.add_child(this._compactFallbackIcon);

    const waveformOuter = new St.Widget({
      layout_manager: new Clutter.BinLayout(),
      height: WAVEFORM_H,
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
        style_class: "di-waveform-bar",
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
    const box = new St.BoxLayout({
      style_class: "di-expanded-view",
      vertical: false,
      x_expand: true,
      y_expand: true,
      style: "spacing: 18px;",
    });

    // Container clips to square. Actor is sized to actual pixbuf dimensions
    // after load so aspect ratio is preserved without stretching.
    this._albumArtBox = new St.Widget({
      style_class: "di-album-art",
      width: ART_EXPANDED,
      height: ART_EXPANDED,
      clip_to_allocation: true,
      y_align: Clutter.ActorAlign.CENTER,
    });
    this._albumArtActor = new Clutter.Actor({
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
    });
    this._albumFallbackIcon = new St.Icon({
      style_class: "di-album-fallback",
      icon_name: "audio-x-generic-symbolic",
      icon_size: 44,
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

    // Hidden by default; shown only when non-empty.
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
    controls.add_child(this._prevBtn);
    controls.add_child(this._playPauseBtn);
    controls.add_child(this._nextBtn);

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
    for (let i = 0; i < OSD_SEG_COUNT; i++) {
      const seg = new St.Widget({ style_class: "di-osd-seg" });
      this._osdSegs.push(seg);
      this._osdSegBox.add_child(seg);
    }

    this._osdSmoothBg = new St.Widget({
      style_class: "di-osd-smooth-bg",
      height: 6,
      x_expand: true,
    });
    this._osdSmoothFill = new St.Widget({
      style_class: "di-osd-smooth-fill",
      height: 6,
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
    btn.set_child(
      new St.Icon({
        style_class: "di-ctrl-icon",
        icon_name: iconName,
        icon_size: 18,
      }),
    );
    btn.connect("clicked", onClicked);
    return btn;
  }

  // ── Stage & settings ─────────────────────────────────────────────────────

  _addToStage() {
    Main.uiGroup.add_child(this._actor);
    Main.uiGroup.set_child_above_sibling(this._actor, null);
    this._repositionForSize(PILL_W);
    this._monitorsId = Main.layoutManager.connect("monitors-changed", () =>
      this._repositionForSize(this._actor.width),
    );
  }

  _connectSettings() {
    const watch = (key, fn) =>
      this._settingsIds.push(this._settings.connect(`changed::${key}`, fn));

    watch("position-offset", () => this._repositionForSize(this._actor.width));
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

  // ── Media API ────────────────────────────────────────────────────────────

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

    this._prevBtn.reactive = true;
    this._nextBtn.reactive = true;
    this._prevBtn.opacity = 255;
    this._nextBtn.opacity = 255;

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

  // ── Player actions ───────────────────────────────────────────────────────

  // Use the auto-generated *Remote() bindings produced by Gio.DBusProxy when
  // g-interface-info is set. These are the same methods GNOME Shell itself uses
  // in js/ui/mpris.js and are more reliable than proxy.call() with string names.
  _onPlayPause() {
    if (!this._mediaProxy) return;
    const status =
      this._mediaProxy.get_cached_property("PlaybackStatus")?.unpack() ??
      "Stopped";
    try {
      if (status === "Stopped") this._mediaProxy.PlayRemote();
      else this._mediaProxy.PlayPauseRemote();
    } catch (e) {
      console.error("DynamicIsland: PlayPause failed:", e.message);
    }
  }

  _onPrevious() {
    if (!this._mediaProxy) return;
    try {
      this._mediaProxy.PreviousRemote();
    } catch (e) {
      console.error("DynamicIsland: Previous failed:", e.message);
    }
  }

  _onNext() {
    if (!this._mediaProxy) return;
    try {
      this._mediaProxy.NextRemote();
    } catch (e) {
      console.error("DynamicIsland: Next failed:", e.message);
    }
  }

  // ── Clock ────────────────────────────────────────────────────────────────

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

  // ── Album art ────────────────────────────────────────────────────────────

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
        const [path] = GLib.filename_from_uri(artUrl);
        const big = GdkPixbuf.Pixbuf.new_from_file_at_scale(
          path,
          ART_EXPANDED,
          ART_EXPANDED,
          true,
        );
        const small = GdkPixbuf.Pixbuf.new_from_file_at_scale(
          path,
          ART_COMPACT,
          ART_COMPACT,
          true,
        );

        // Size actor to real pixbuf dimensions so clip_to_allocation
        // centers it without distorting the aspect ratio.
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

  // ── Seek tracking ────────────────────────────────────────────────────────

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

    // MPRIS Position is NOT sent via PropertiesChanged — the proxy cache is
    // always stale. Fetch it directly with an explicit Properties.Get call.
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
            const progress = Math.min(pos / this._trackLength, 1);
            this._seekFill.set_width(Math.floor(this._seekBg.width * progress));
            this._posLabel.set_text(this._µsToTime(pos));
            this._durLabel.set_text(this._µsToTime(this._trackLength));
          }
        } catch (_) {}
      },
    );
  }

  _µsToTime(µs) {
    const s = Math.floor(µs / 1_000_000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }

  // ── Waveform ─────────────────────────────────────────────────────────────

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
    this._waveformBars?.forEach((bar) =>
      bar.ease({
        height: 2,
        duration: 200,
        mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
      }),
    );
  }

  // ── OSD API ──────────────────────────────────────────────────────────────

  showOsd(iconName, level, maxLevel) {
    const pct = Math.round((level / (maxLevel || 1)) * 100);
    const isVolume = iconName.startsWith("audio-volume");
    const isBright = iconName.includes("brightness");
    const base = iconName.replace(/-symbolic$/, "");

    this._osdIcon.set_icon_name(`${base}-symbolic`);
    this._osdValueLabel.set_text(`${pct}%`);

    if (isVolume) {
      this._osdSegBox.show();
      this._osdSmoothBg.hide();
      const filled = Math.round((pct / 100) * OSD_SEG_COUNT);
      this._osdSegs.forEach((seg, i) => {
        const on = i < filled;
        if (on) seg.add_style_class_name("active");
        else seg.remove_style_class_name("active");
        if (on && pct > 100) seg.add_style_class_name("over-amplified");
        else seg.remove_style_class_name("over-amplified");
      });
    } else if (isBright) {
      this._osdSegBox.hide();
      this._osdSmoothBg.show();
      this._pendingBrightnessFill = level / (maxLevel || 1);
    }

    if (this._osdHideSrc) {
      GLib.Source.remove(this._osdHideSrc);
      this._osdHideSrc = null;
    }
    this._transitionTo(State.OSD);

    this._osdHideSrc = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      OSD_HIDE_MS,
      () => {
        this._osdHideSrc = null;
        this._transitionTo(this._mediaProxy ? State.COMPACT : State.PILL);
        return GLib.SOURCE_REMOVE;
      },
    );
  }

  // ── Transitions ──────────────────────────────────────────────────────────

  _onHoverEnter() {
    if (this._mediaProxy) this._transitionTo(State.EXPANDED);
  }

  _onHoverLeave() {
    if (this._state === State.EXPANDED)
      this._transitionTo(this._mediaProxy ? State.COMPACT : State.PILL);
  }

  _transitionTo(newState) {
    if (this._state === newState && newState !== State.OSD) return;

    newState === State.PILL ? this._startClock() : this._stopClock();
    this._state = newState;

    const dur = this._settings.get_int("animation-duration");
    const monitor = Main.layoutManager.primaryMonitor;
    if (!monitor) return;

    const dims = {
      [State.PILL]: [PILL_W, PILL_H],
      [State.COMPACT]: [COMPACT_W, COMPACT_H],
      [State.EXPANDED]: [EXPANDED_W, EXPANDED_H],
      [State.OSD]: [OSD_W, OSD_H],
    };
    const [targetW, targetH] = dims[newState];
    const offset = this._settings.get_int("position-offset");
    const targetX =
      monitor.x + Math.floor((monitor.width - targetW) / 2) + offset;

    // Hide all content views during the shape morph. Because clip_to_allocation
    // is true, any visible content would be clipped to the old size and flash
    // at the wrong dimensions during the animation. Showing after onComplete
    // gives a clean black-pill-morphing transition with no content glitch.
    this._showView(null);
    this._actor.remove_all_transitions();

    this._actor.ease({
      x: targetX,
      y: monitor.y,
      width: targetW,
      height: targetH,
      duration: dur,
      mode: Clutter.AnimationMode.EASE_OUT_EXPO,
      onComplete: () => {
        this._showView(newState);
        if (newState === State.EXPANDED) this._tickSeek();
        if (
          newState === State.OSD &&
          this._pendingBrightnessFill !== undefined
        ) {
          this._osdSmoothFill.set_width(
            Math.floor(this._osdSmoothBg.width * this._pendingBrightnessFill),
          );
          this._pendingBrightnessFill = undefined;
        }
      },
    });
  }

  // Passing null hides all views (used during morph animation).
  _showView(state) {
    this._pillView.visible = state === State.PILL;
    this._compactView.visible = state === State.COMPACT;
    this._expandedView.visible = state === State.EXPANDED;
    this._osdView.visible = state === State.OSD;
  }

  // ── Destroy ──────────────────────────────────────────────────────────────

  destroy() {
    this._stopClock();
    this._stopSeekTracking();

    if (this._waveformSrc) {
      GLib.Source.remove(this._waveformSrc);
      this._waveformSrc = null;
    }
    if (this._osdHideSrc) {
      GLib.Source.remove(this._osdHideSrc);
      this._osdHideSrc = null;
    }
    if (this._artIdleId) {
      GLib.Source.remove(this._artIdleId);
      this._artIdleId = null;
    }
    if (this._collapseTimeoutId) {
      GLib.Source.remove(this._collapseTimeoutId);
      this._collapseTimeoutId = null;
    }

    if (this._hoverId && this._actor) {
      this._actor.disconnect(this._hoverId);
      this._hoverId = 0;
    }
    if (this._monitorsId) {
      Main.layoutManager.disconnect(this._monitorsId);
      this._monitorsId = 0;
    }
    this._settingsIds.forEach((id) => this._settings?.disconnect(id));
    this._settingsIds = [];

    if (this._actor) {
      Main.uiGroup.remove_child(this._actor);
      this._actor.destroy();
      this._actor = null;
    }
    this._settings = this._mediaProxy = null;
  }
}
