/**
 * island/features.js
 *
 * Feature modules for Dynamic Island: Media, Weather, Bluetooth, File Stash, OSD.
 */

import GLib from "gi://GLib";
import Gio from "gi://Gio";
import Clutter from "gi://Clutter";
import Cogl from "gi://Cogl";
import GdkPixbuf from "gi://GdkPixbuf";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import {
  State,
  PILL_H,
  WAVEFORM_BARS,
  WAVEFORM_MS,
  WAVEFORM_H,
  OSD_HIDE_MS,
  OSD_SEG_COUNT,
  NOTIF_HIDE_MS,
} from "../constants.js";
import { parseArtists } from "../utils.js";

const OVER_AMP_MAX = 1.5;

export class IslandFeatures {
  constructor(core) {
    this.core = core;
  }

  // ── Media (MPRIS) ────────────────────────────────────────────────────────

  updateMedia(proxy) {
    this.core._mediaProxy = proxy;

    const wasPlaying = this.core._playing;

    const meta = proxy.get_cached_property("Metadata")?.deepUnpack() ?? {};
    const status =
      proxy.get_cached_property("PlaybackStatus")?.unpack() ?? "Stopped";
    const title = meta["xesam:title"]?.unpack() ?? "";
    const rawArtists = meta["xesam:artist"]?.deepUnpack() ?? [];
    const artist = parseArtists(rawArtists);
    const artUrl = meta["mpris:artUrl"]?.unpack() ?? "";
    const newLength = Number(meta["mpris:length"]?.unpack() ?? 0);

    this.core._trackLength = newLength;
    this.core._playing = status === "Playing";

    const currentTrackId = meta["mpris:trackid"]?.unpack() ?? null;
    const trackChanged =
      currentTrackId !== this.core._lastTrackId ||
      title !== this.core._lastTitle ||
      artist !== this.core._lastArtist;

    if (trackChanged) {
      this.core._lastTrackId = currentTrackId;
      this.core._lastTitle = title;
      this.core._lastArtist = artist;
    }

    if (this.core._titleLabel) {
      this.core._titleLabel.set_text(title);
      this.core._titleLabel.visible = title.length > 0;
    }
    if (this.core._artistLabel) {
      this.core._artistLabel.set_text(artist);
      this.core._artistLabel.visible = artist.length > 0;
    }

    const playIcon = "media-playback-start-symbolic";
    const pauseIcon = "media-playback-pause-symbolic";
    if (this.core._playPauseBtn) {
      this.core._playPauseBtn
        .get_child()
        .set_icon_name(this.core._playing ? pauseIcon : playIcon);
      this.core._playPauseBtn.accessible_name = this.core._playing ? "Pause" : "Play";
    }

    const canPrev =
      proxy.get_cached_property("CanGoPrevious")?.unpack() ?? true;
    const canNext = proxy.get_cached_property("CanGoNext")?.unpack() ?? true;
    if (this.core._prevBtn) {
      this.core._prevBtn.reactive = canPrev;
      this.core._prevBtn.opacity = canPrev ? 255 : 80;
    }
    if (this.core._nextBtn) {
      this.core._nextBtn.reactive = canNext;
      this.core._nextBtn.opacity = canNext ? 255 : 80;
    }

    if (artUrl && this.core._settings.get_boolean("show-album-art"))
      this.loadAlbumArt(artUrl);
    else this.clearAlbumArt();

    if (this.core._playing) {
      if (trackChanged) {
        this.core._seekTracker.reset(proxy, newLength);
      } else if (!wasPlaying) {
        this.core._seekTracker.start(proxy, newLength);
      } else {
        this.core._seekTracker.updateLength(newLength);
      }
      this.startWaveform();
      this.core._cancelAutoHide();
    } else {
      if (trackChanged) {
        this.core._seekTracker.reset(proxy, newLength);
      }
      this.core._seekTracker.stop();
      this.stopWaveform();
      this.core._resetAutoHideTimer();
    }

    const persist = this.core._settings.get_boolean("persist-compact-media");
    const showMediaView = this.core._playing || (persist && title.length > 0);

    if (showMediaView) {
      if (this.core._collapseTimeoutId) {
        GLib.Source.remove(this.core._collapseTimeoutId);
        this.core._collapseTimeoutId = null;
      }
      this.core._showActor(180);
      if (this.core._state === State.PILL || this.core._state === State.OSD) {
        this.core._transitionTo(State.COMPACT);
      } else if (!this.core._playing && this.core._state === State.EXPANDED) {
        if (!this.core._actor?.hover) this.core._transitionTo(State.COMPACT);
      }
    } else {
      if (this.core._state === State.COMPACT || this.core._state === State.EXPANDED) {
        if (!this.core._collapseTimeoutId) {
          this.core._collapseTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            800,
            () => {
              this.core._collapseTimeoutId = null;
              if (
                this.core._state === State.COMPACT ||
                this.core._state === State.EXPANDED
              )
                this.core._transitionTo(State.PILL);
              return GLib.SOURCE_REMOVE;
            },
          );
        }
      }
    }
  }

  onPlayerSeeked(posMicros) {
    this.core._seekTracker?.seekedTo(posMicros);
  }

  clearMedia() {
    this.core._playing = false;
    this.core._dominantColor = null;
    this.core._lastTrackId = null;
    this.core._lastTitle = null;
    this.core._lastArtist = null;
    this.core._trackLength = 0;

    if (this.core._collapseTimeoutId) {
      GLib.Source.remove(this.core._collapseTimeoutId);
      this.core._collapseTimeoutId = null;
    }

    this.core._seekTracker.stop();
    this.stopWaveform();
    this.clearAlbumArt();

    this.core._titleLabel?.set_text("");
    if (this.core._titleLabel) this.core._titleLabel.visible = false;
    this.core._artistLabel?.set_text("");
    if (this.core._artistLabel) this.core._artistLabel.visible = false;
    if (this.core._prevBtn) {
      this.core._prevBtn.reactive = true;
      this.core._prevBtn.opacity = 255;
    }
    if (this.core._nextBtn) {
      this.core._nextBtn.reactive = true;
      this.core._nextBtn.opacity = 255;
    }

    this.core._actor?.show();
    if (this.core._actor) this.core._actor.opacity = 255;

    // Only go back to pill if we're not showing the stash
    if (this.core._state !== State.STASH) this.core._transitionTo(State.PILL);
  }

  // ── Weather ──────────────────────────────────────────────────────────────

  updateWeather(data) {
    this.core._lastWeatherData = data;
    if (!this.core._weatherWidget) return;
    if (data?.temp) {
      this.core._weatherTempLabel?.set_text(data.temp);
      this.core._weatherIconLabel?.set_text(data.icon ?? "");
    }
    this.core._weatherWidget.visible =
      this.core._settings.get_boolean("show-weather") && !!data?.temp;
    this.updatePillSep();
  }

  updatePillSep() {
    const btVis = this.core._btIndicator?.visible ?? false;
    const wxVis = this.core._weatherWidget?.visible ?? false;
    const hasSideInfo = btVis || wxVis;

    if (
      this.core._pillPrefixSpacer &&
      this.core._pillSuffixSpacer &&
      this.core._pillMidSpacer
    ) {
      this.core._pillPrefixSpacer.visible = !hasSideInfo;
      this.core._pillSuffixSpacer.visible = !hasSideInfo;
      this.core._pillMidSpacer.visible = hasSideInfo;
    }
  }

  // ── Bluetooth ────────────────────────────────────────────────────────────

  updateBluetooth(devices) {
    this.core._lastBtDevices = devices;

    const show = this.core._settings.get_boolean("show-bluetooth");
    const hasConn = devices.length > 0;

    if (this.core._btIndicator) this.core._btIndicator.visible = show && hasConn;

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
      this.core._btDeviceIcon?.set_icon_name(
        iconMap[primary.icon] ?? "bluetooth-active-symbolic",
      );

      let labelText = "";
      if (devices.length > 1) labelText = `${devices.length}×`;
      else if (primary.battery !== null && primary.battery !== undefined)
        labelText = `${primary.battery}%`;

      this.core._btBatteryLabel?.set_text(labelText);
    }

    this.updatePillSep();
  }

  // ── File Stash ───────────────────────────────────────────────────────────

  updateStash(files, folderUri) {
    this.core._stashFiles = files ?? [];
    this.core._stashFolderUri = folderUri;

    if (this.core._stashFiles.length === 0) {
      if (this.core._state === State.STASH) {
        if (this.core._mediaProxy && this.core._playing)
          this.core._transitionTo(State.COMPACT);
        else this.core._transitionTo(State.PILL);
      }
      return;
    }

    this.applyStashUI(this.core._stashFiles, folderUri);
    this.core._showActor(180);
    this.core._cancelAutoHide();

    if (this.core._state !== State.OSD && this.core._state !== State.NOTIF)
      this.core._transitionTo(State.STASH);
  }

  setStashActionCallback(cb) {
    this.core._stashActionCallback = cb;
  }

  applyStashUI(files, folderUri) {
    if (!this.core._stashCountLabel) return;

    const n = files.length;
    this.core._stashCountLabel.set_text(`${n} item${n !== 1 ? "s" : ""}`);

    const hasFolder = !!folderUri;

    if (hasFolder) {
      const parts = folderUri.replace(/\/$/, "").split("/");
      const folderName = decodeURIComponent(
        parts[parts.length - 1] || folderUri,
      );
      this.core._stashDestLabel?.set_text(`→ ${folderName}`);
    } else {
      this.core._stashDestLabel?.set_text("Open a folder in Nautilus");
    }

    for (const btn of [this.core._stashMoveBtn, this.core._stashCopyBtn]) {
      if (!btn) continue;
      btn.reactive = hasFolder;
      btn.opacity = hasFolder ? 255 : 80;
    }
  }

  // ── Playback Controls ────────────────────────────────────────────────────

  onPlayPause() {
    if (!this.core._mediaProxy) return;
    const status =
      this.core._mediaProxy.get_cached_property("PlaybackStatus")?.unpack() ??
      "Stopped";
    this.sendMprisCommand(status === "Stopped" ? "Play" : "PlayPause");
  }

  sendMprisCommand(method) {
    if (!this.core._mediaProxy) return;
    this.core._mediaProxy.call(
      method,
      new GLib.Variant("()", []),
      Gio.DBusCallFlags.NONE,
      -1,
      null,
      null,
      null,
    );
  }

  // ── OSD ──────────────────────────────────────────────────────────────────

  showOsd(iconName, level, maxLevel) {
    if (!this.core._actor) return;

    const scale = this.core._scale;
    const isVolume = iconName.startsWith("audio-volume");
    const isBright = iconName.includes("brightness");
    const isOverAmp = maxLevel != null && maxLevel > 1.0;
    const ceiling = isOverAmp ? OVER_AMP_MAX : 1.0;
    const clamped = Math.min(level ?? 0, ceiling);

    let pct;
    if (isVolume)
      pct = Math.min(Math.round(clamped * 100), isOverAmp ? 150 : 100);
    else pct = Math.round((clamped / (maxLevel || 1)) * 100);

    this.core._osdState = { icon: iconName, level: clamped, max: maxLevel };

    const safeIcon = `${iconName}-symbolic`.replace(
      /-symbolic-symbolic$/,
      "-symbolic",
    );
    this.core._osdIcon.set_icon_name(safeIcon);
    this.core._osdValueLabel.set_text(`${pct}%`);

    if (isVolume) {
      this.core._osdSegBox.show();
      this.core._osdSmoothBg.hide();
      const volOverAmp = clamped > 1.0;
      const filledCount = volOverAmp
        ? OSD_SEG_COUNT
        : Math.round(Math.min(clamped, 1.0) * OSD_SEG_COUNT);
      this.core._osdSegs.forEach((seg, i) => {
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
      this.core._osdSegBox.hide();
      this.core._osdSmoothBg.show();
      this.core._pendingBrightnessFill = clamped / (maxLevel || 1);
    }

    if (this.core._osdHideSrc) {
      GLib.Source.remove(this.core._osdHideSrc);
      this.core._osdHideSrc = null;
    }
    const timeout = this.core._settings.get_int("osd-timeout") || OSD_HIDE_MS;
    this.core._osdHideSrc = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeout, () => {
      this.core._osdHideSrc = null;
      this.core._osdState = null;
      if (this.core._stashFiles?.length) this.core._transitionTo(State.STASH);
      else if (this.core._playing) this.core._transitionTo(State.COMPACT);
      else this.core._transitionTo(State.PILL);
      return GLib.SOURCE_REMOVE;
    });

    if (this.core._state !== State.OSD) {
      if (this.core._isFullscreen()) return;
      this.core._showActor(100);
      this.core._transitionTo(State.OSD, () => {
        if (isBright && this.core._pendingBrightnessFill !== null) {
          const bgW =
            this.core._osdSmoothBg.get_width() ||
            Math.floor(this.core.view.getOsdW() - 40 * scale);
          this.core._osdSmoothFill.set_width(
            Math.floor(bgW * this.core._pendingBrightnessFill),
          );
          this.core._pendingBrightnessFill = null;
        }
      });
    } else if (isBright) {
      const bgW =
        this.core._osdSmoothBg.get_width() ||
        Math.floor(this.core.view.getOsdW() - 40 * scale);
      this.core._osdSmoothFill.set_width(
        Math.floor(bgW * (clamped / (maxLevel || 1))),
      );
    }

    this.core._cancelAutoHide();
  }

  // ── Notifications ────────────────────────────────────────────────────────

  showNotification(notif) {
    if (!this.core._actor || !this.core._notifView) return;
    if (!this.core._settings.get_boolean("show-notifications")) return;

    const appName = notif.source?.title ?? "";
    const title = notif.title ?? "";
    const body = (notif.body ?? "").replace(/\n/g, " ");

    const gicon = notif.source?.icon ?? null;
    if (gicon) {
      this.core._notifIcon.set_gicon(gicon);
    } else {
      const iconName = notif.source?.iconName ?? "dialog-information-symbolic";
      this.core._notifIcon.set_icon_name(iconName);
    }

    this.core._notifAppLabel.set_text(appName);
    this.core._notifTitleLabel.set_text(title);
    this.core._notifBodyLabel.set_text(body);
    this.core._notifBodyLabel.visible = body.length > 0;

    if (this.core._state !== State.NOTIF) this.core._stateBeforeNotif = this.core._state;

    if (this.core._notifHideSrc) {
      GLib.Source.remove(this.core._notifHideSrc);
      this.core._notifHideSrc = null;
    }

    this.core._showActor(180);
    this.core._transitionTo(State.NOTIF);
    this.core._cancelAutoHide();

    this.core._notifHideSrc = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      NOTIF_HIDE_MS,
      () => {
        this.core._notifHideSrc = null;
        this.dismissNotification();
        return GLib.SOURCE_REMOVE;
      },
    );
  }

  dismissNotification() {
    const restore = this.core._stateBeforeNotif ?? State.PILL;
    this.core._stateBeforeNotif = null;

    if (
      restore === State.PILL &&
      !this.core._mediaProxy &&
      !this.core._stashFiles?.length &&
      this.core._settings.get_boolean("auto-hide")
    ) {
      this.core._actor?.ease({
        opacity: 0,
        duration: 250,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        onComplete: () => this.core._actor?.hide(),
      });
      this.core._resetAutoHideTimer();
    } else {
      this.core._transitionTo(restore);
      if (!this.core._playing) this.core._resetAutoHideTimer();
    }
  }

  // ── Clock ────────────────────────────────────────────────────────────────

  updateClock() {
    const now = GLib.DateTime.new_now_local();
    const fmt = this.core._settings?.get_string("time-format") || "%H:%M";
    const text = now?.format(fmt);
    if (text && this.core._clockLabel) this.core._clockLabel.set_text(text);
  }

  startClock() {
    this.stopClock();
    this.updateClock();

    const now = GLib.DateTime.new_now_local();
    const secsLeft = now ? Math.max(1, 60 - now.get_second()) : 60;

    this.core._clockSrc = GLib.timeout_add_seconds(
      GLib.PRIORITY_DEFAULT,
      secsLeft,
      () => {
        this.core._clockSrc = null;
        this.updateClock();

        this.core._clockSrc = GLib.timeout_add_seconds(
          GLib.PRIORITY_DEFAULT,
          60,
          () => {
            this.updateClock();
            return GLib.SOURCE_CONTINUE;
          },
        );

        return GLib.SOURCE_REMOVE;
      },
    );
  }

  stopClock() {
    if (this.core._clockSrc) {
      GLib.Source.remove(this.core._clockSrc);
      this.core._clockSrc = null;
    }
  }

  // ── Waveform ─────────────────────────────────────────────────────────────

  startWaveform() {
    this.stopWaveform();
    let phase = 0,
      beatEnergy = 0,
      beatCooldown = 0,
      volumeSmooth = 0.5;

    const n = WAVEFORM_BARS;
    const maxBarH = Math.floor(WAVEFORM_H * this.core._scale);
    const BEAT_DECAY = 0.18;
    const BEAT_THRESH = 0.3;

    this.core._waveformSrc = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      WAVEFORM_MS,
      () => {
        if (!this.core._waveformBars?.length) return GLib.SOURCE_REMOVE;

        phase += 0.22;

        let rawVol = 0.5;
        try {
          const v = this.core._mediaProxy?.get_cached_property("Volume")?.unpack();
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

        this.core._waveformBars.forEach((bar, i) => {
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

  stopWaveform() {
    if (this.core._waveformSrc) {
      GLib.Source.remove(this.core._waveformSrc);
      this.core._waveformSrc = null;
    }
  }

  // ── Album Art ────────────────────────────────────────────────────────────

  loadAlbumArt(artUrl) {
    if (this.core._artCancellable) {
      this.core._artCancellable.cancel();
      this.core._artCancellable = null;
    }
    if (!artUrl?.startsWith("file://")) {
      this.clearAlbumArt();
      return;
    }

    const cancellable = new Gio.Cancellable();
    this.core._artCancellable = cancellable;

    const file = Gio.File.new_for_uri(artUrl);
    file.load_contents_async(cancellable, (_source, res) => {
      if (!this.core._albumArtActor || !this.core._compactArtActor) return;
      try {
        const [, contents] = file.load_contents_finish(res);

        const loader = GdkPixbuf.PixbufLoader.new();
        loader.write(contents);
        loader.close();
        const pixbuf = loader.get_pixbuf();
        if (!pixbuf) {
          this.clearAlbumArt();
          return;
        }

        const srcW = pixbuf.get_width();
        const srcH = pixbuf.get_height();

        const fitPixbuf = (maxSize) => {
          if (srcW <= 0 || srcH <= 0) return pixbuf;
          const ratio = Math.min(maxSize / srcW, maxSize / srcH);
          return pixbuf.scale_simple(
            Math.max(1, Math.round(srcW * ratio)),
            Math.max(1, Math.round(srcH * ratio)),
            GdkPixbuf.InterpType.BILINEAR,
          );
        };

        const expandedPx = this.core.view.getArtExpandedSize();
        const compactPx = this.core.view.getArtCompactSize();

        const bigPb = fitPixbuf(expandedPx);
        const smallPb = fitPixbuf(compactPx);
        const bigImg = this.pixbufToImage(bigPb);
        const smallImg = this.pixbufToImage(smallPb);

        if (!this.core._albumArtActor || !this.core._compactArtActor) return;

        if (bigImg) {
          this.core._albumArtActor.set_size(bigPb.get_width(), bigPb.get_height());
          this.core._albumArtActor.set_content(bigImg);
          this.core._albumFallbackIcon?.hide();
          this.core._albumArtActor.show();
        }
        if (smallImg) {
          this.core._compactArtActor.set_size(
            smallPb.get_width(),
            smallPb.get_height(),
          );
          this.core._compactArtActor.set_content(smallImg);
          this.core._compactFallbackIcon?.hide();
          this.core._compactArtActor.show();
        }

        if (this.core._settings.get_boolean("dynamic-art-color")) {
          const dc = this.extractDominantColor(pixbuf);
          if (dc) {
            this.core._dominantColor = dc;
            this.core.view.updateNotchStyle(this.core._actor, this.core._actor.height, this.core._state);
          }
        }
      } catch (e) {
        if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) return;
        console.error("DynamicIsland: art load failed:", e.message);
        this.clearAlbumArt();
      }
      if (this.core._artCancellable === cancellable) this.core._artCancellable = null;
    });
  }

  clearAlbumArt() {
    if (this.core._albumArtActor) {
      this.core._albumArtActor.set_content(null);
      this.core._albumArtActor.hide();
    }
    this.core._albumFallbackIcon?.show();
    if (this.core._compactArtActor) {
      this.core._compactArtActor.set_content(null);
      this.core._compactArtActor.hide();
    }
    this.core._compactFallbackIcon?.show();
    this.core._dominantColor = null;
    this.core.view.updateNotchStyle(this.core._actor, this.core._actor?.height ?? PILL_H, this.core._state);
  }

  pixbufToImage(pixbuf) {
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
      return null;
    }
  }

  extractDominantColor(pixbuf) {
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
}
