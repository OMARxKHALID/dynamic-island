/**
 * prefs.js
 *
 * Preferences window for Dynamic Island.
 */

import Adw from "gi://Adw";
import Gtk from "gi://Gtk";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import { ExtensionPreferences } from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";

import { WeatherClient } from "./src/weather.js";

export default class DynamicIslandPrefs extends ExtensionPreferences {
  fillPreferencesWindow(window) {
    const settings = this.getSettings();
    this._weatherClient = new WeatherClient(settings);

    window.set_default_size(720, 700);
    window.set_title("Dynamic Island");

    window.add(this._buildAppearancePage(settings));
    window.add(this._buildFeaturesPage(settings));
    window.add(this._buildScrobblingPage(settings));
    window.add(this._buildSystemPage(settings));

    window.connect("close-request", () => {
      this._weatherClient?.destroy();
      this._weatherClient = null;
    });
  }

  // ── Page 1: Look & Feel ───────────────────────────────────────────────────

  _buildAppearancePage(settings) {
    const page = new Adw.PreferencesPage({
      title: "Look & Feel",
      icon_name: "applications-graphics-symbolic",
    });

    const layoutGroup = new Adw.PreferencesGroup({
      title: "Position & Visibility",
      description: "Adjust where the island appears and what it shows",
    });
    page.add(layoutGroup);

    layoutGroup.add(
      this._spinRow(settings, "position-offset", {
        title: "Horizontal Shift",
        subtitle:
          "Move the island left (−) or right (+) for notch / camera alignment",
        icon: "preferences-desktop-display-symbolic",
        lower: -1200,
        upper: 1200,
        step: 5,
        page: 50,
      }),
    );
    layoutGroup.add(
      this._switchRow(settings, "show-album-art", {
        title: "Show Album Art",
        subtitle: "Display album covers in the expanded view",
        icon: "image-x-generic-symbolic",
      }),
    );
    layoutGroup.add(
      this._switchRow(settings, "dynamic-art-color", {
        title: "Dynamic Art Colour",
        subtitle:
          "Tint the island background with the dominant colour from album art",
        icon: "color-select-symbolic",
      }),
    );
    layoutGroup.add(
      this._switchRow(settings, "show-seek-bar", {
        title: "Show Progress Bar",
        subtitle: "Display the music timer and seek bar in the expanded view",
        icon: "media-playback-start-symbolic",
      }),
    );
    layoutGroup.add(
      this._spinRow(settings, "notch-scale", {
        title: "Global Scaling",
        subtitle: "Resize the entire island interface",
        icon: "zoom-in-symbolic",
        lower: 0.5,
        upper: 3.0,
        step: 0.05,
        page: 0.1,
        digits: 2,
      }),
    );
    layoutGroup.add(
      this._spinRow(settings, "font-size-multiplier", {
        title: "Font Size Multiplier",
        subtitle: "Scale text independently of the island size",
        icon: "format-text-size-symbolic",
        lower: 0.5,
        upper: 2.0,
        step: 0.05,
        page: 0.1,
        digits: 2,
      }),
    );

    const dimGroup = new Adw.PreferencesGroup({
      title: "Dimensions",
      description:
        "Customise the exact pixel sizes of each state (base size before scaling)",
    });
    page.add(dimGroup);

    for (const [key, title, lo, hi, step] of [
      ["pill-width", "Idle Width", 50, 800, 5],
      ["pill-height", "Idle Height", 20, 200, 2],
      ["compact-width", "Compact Width (Waveform)", 50, 800, 5],
      ["compact-height", "Compact Height", 20, 200, 2],
      ["expanded-width", "Expanded Width (Media Player)", 150, 800, 5],
      ["expanded-height", "Expanded Height", 50, 500, 5],
      ["osd-width", "OSD Width (Volume/Brightness)", 100, 800, 5],
      ["osd-height", "OSD Height", 50, 300, 2],
      ["art-expanded-size", "Expanded Cover Art Size", 20, 300, 2],
      ["art-compact-size", "Compact Cover Art Size", 10, 100, 2],
    ]) {
      dimGroup.add(
        this._spinRow(settings, key, { title, lower: lo, upper: hi, step }),
      );
    }

    const styleGroup = new Adw.PreferencesGroup({
      title: "Colors & Transparency",
      description: "Fine-tune the island appearance",
    });
    page.add(styleGroup);

    const colorRow = new Adw.EntryRow({
      title: "Island Color (HEX, e.g. #0a0a0a)",
      text: settings.get_string("background-color"),
    });
    colorRow.connect("changed", () => {
      const text = colorRow.get_text().trim();
      if (/^#[0-9A-Fa-f]{6}$/.test(text))
        settings.set_string("background-color", text);
    });
    styleGroup.add(colorRow);
    styleGroup.add(
      this._spinRow(settings, "background-opacity", {
        title: "Transparency",
        lower: 0.1,
        upper: 1.0,
        step: 0.05,
        digits: 2,
      }),
    );

    return page;
  }

  // ── Page 2: Features ──────────────────────────────────────────────────────

  _buildFeaturesPage(settings) {
    const page = new Adw.PreferencesPage({
      title: "Features",
      icon_name: "preferences-system-symbolic",
    });

    const generalGroup = new Adw.PreferencesGroup({
      title: "Display Logic",
      description: "Configure how and when the island shows up",
    });
    page.add(generalGroup);

    generalGroup.add(
      this._switchRow(settings, "auto-hide", {
        title: "Auto-Hide When Idle",
        subtitle: "Only show the island when music or alerts are active",
        icon: "eye-not-looking-symbolic",
      }),
    );

    const delayRow = this._spinRow(settings, "auto-hide-delay", {
      title: "Idle Timeout (seconds)",
      subtitle: "How long to wait before hiding (0 = wait until media stops)",
      lower: 0,
      upper: 120,
      step: 5,
      page: 15,
    });
    generalGroup.add(delayRow);

    const updateDelayRow = () =>
      delayRow.set_sensitive(settings.get_boolean("auto-hide"));
    updateDelayRow();
    const autoHideSigId = settings.connect(
      "changed::auto-hide",
      updateDelayRow,
    );
    page.connect("destroy", () => settings.disconnect(autoHideSigId));

    generalGroup.add(
      this._switchRow(settings, "intercept-osd", {
        title: "System Volume / Brightness OSD",
        subtitle: "Show volume and brightness changes inside the island",
        icon: "audio-volume-high-symbolic",
      }),
    );
    generalGroup.add(
      this._switchRow(settings, "persist-compact-media", {
        title: "Keep Media View While Paused",
        subtitle:
          "Show the media waveform and cover instead of the clock when paused",
        icon: "media-playback-pause-symbolic",
      }),
    );
    generalGroup.add(
      this._spinRow(settings, "osd-timeout", {
        title: "OSD Duration (ms)",
        subtitle: "How long volume and brightness popups stay visible",
        icon: "preferences-system-time-symbolic",
        lower: 500,
        upper: 10000,
        step: 250,
      }),
    );
    generalGroup.add(
      this._switchRow(settings, "show-notifications", {
        title: "Notification Toasts",
        subtitle: "Show incoming system notifications inside the island",
        icon: "preferences-system-notifications-symbolic",
      }),
    );

    const animGroup = new Adw.PreferencesGroup({ title: "Animation" });
    page.add(animGroup);
    animGroup.add(
      this._spinRow(settings, "animation-duration", {
        title: "Transition Speed (ms)",
        subtitle: "How fast the island expands and collapses",
        icon: "preferences-desktop-animation-symbolic",
        lower: 50,
        upper: 1000,
        step: 10,
        page: 100,
      }),
    );

    const clockGroup = new Adw.PreferencesGroup({
      title: "Clock & Time",
      description: "Customise the idle pill clock display",
    });
    page.add(clockGroup);
    clockGroup.add(
      this._comboRow(settings, "time-format", {
        title: "Clock Format",
        icon: "preferences-system-time-symbolic",
        choices: [
          { label: "Time Only (14:30)", value: "%H:%M" },
          { label: "Day & Time (Tue 14:30)", value: "%a %H:%M" },
          { label: "Date & Time (Mar 08, 14:30)", value: "%b %d, %H:%M" },
          {
            label: "Full Date & Time (Mar 08, 2026 14:30)",
            value: "%b %d, %Y %H:%M",
          },
        ],
      }),
    );

    // Redesigned weather section
    page.add(this._buildWeatherGroup(settings, page));

    const btGroup = new Adw.PreferencesGroup({ title: "Bluetooth" });
    page.add(btGroup);
    btGroup.add(
      this._switchRow(settings, "show-bluetooth", {
        title: "Show Bluetooth Indicator",
        subtitle: "Display connected device icon and battery level in the pill",
        icon: "bluetooth-active-symbolic",
      }),
    );

    // ── File Stash ────────────────────────────────────────────────────────
    const stashGroup = new Adw.PreferencesGroup({
      title: "File Stash",
      description:
        "Stash files from Nautilus and move or copy them to any folder — " +
        "right-click selected files → \"Stash in Island\", then navigate to destination.",
    });
    page.add(stashGroup);

    const stashEnabledRow = this._switchRow(settings, "stash-enabled", {
      title: "Enable File Stash",
      subtitle: "Register the D-Bus service so Nautilus can send files to the island",
      icon: "folder-drag-accept-symbolic",
    });
    stashGroup.add(stashEnabledRow);

    const autoClearRow = this._switchRow(settings, "stash-auto-clear", {
      title: "Clear After Move / Copy",
      subtitle: "Automatically empty the stash once the operation completes",
      icon: "edit-clear-all-symbolic",
    });
    stashGroup.add(autoClearRow);

    const notifyRow = this._switchRow(settings, "stash-notify-on-complete", {
      title: "Notify on Complete",
      subtitle: "Show a desktop notification confirming success or reporting an error",
      icon: "preferences-system-notifications-symbolic",
    });
    stashGroup.add(notifyRow);

    // Dim sub-options when stash is disabled
    const updateStashSensitive = () => {
      const on = settings.get_boolean("stash-enabled");
      autoClearRow.set_sensitive(on);
      notifyRow.set_sensitive(on);
    };
    updateStashSensitive();
    const stashSigId = settings.connect("changed::stash-enabled", updateStashSensitive);
    page.connect("destroy", () => settings.disconnect(stashSigId));

    page.add(this._buildPlayerFilterGroup(settings, page));

    return page;
  }

  // ── Player Filtering ──────────────────────────────────────────────────────

  _buildPlayerFilterGroup(settings, page) {
    const group = new Adw.PreferencesGroup({
      title: "Player Filter",
      description:
        "Ignore specific media players (e.g. 'firefox', 'chrome', 'spotify')",
    });

    const listbox = new Gtk.ListBox({
      selection_mode: Gtk.SelectionMode.NONE,
      css_classes: ["boxed-list"],
    });
    group.add(listbox);

    const updateList = () => {
      // Clear current rows
      let child = listbox.get_first_child();
      while (child) {
        const next = child.get_next_sibling();
        listbox.remove(child);
        child = next;
      }

      const blocklist = settings.get_strv("player-blocklist");
      if (blocklist.length === 0) {
        const emptyRow = new Adw.ActionRow({
          title: "No players blocked",
          subtitle: "All MPRIS players will be shown in the island",
        });
        listbox.append(emptyRow);
      } else {
        blocklist.forEach((id) => {
          const row = new Adw.ActionRow({ title: id });
          const delBtn = new Gtk.Button({
            icon_name: "user-trash-symbolic",
            valign: Gtk.Align.CENTER,
            has_frame: false,
            css_classes: ["flat"],
          });
          delBtn.connect("clicked", () => {
            const newList = blocklist.filter((x) => x !== id);
            settings.set_strv("player-blocklist", newList);
          });
          row.add_suffix(delBtn);
          listbox.append(row);
        });
      }
    };

    updateList();
    const listSigId = settings.connect(
      "changed::player-blocklist",
      updateList,
    );
    page.connect("destroy", () => settings.disconnect(listSigId));

    const addRow = new Adw.EntryRow({
      title: "Add Player Identity",
      show_apply_button: true,
      tooltip_text:
        "Type the base name (e.g. 'chromium') — instance numbers are ignored automatically",
    });
    addRow.connect("apply", () => {
      const val = addRow.get_text().trim().toLowerCase();
      if (val) {
        const list = settings.get_strv("player-blocklist");
        if (!list.includes(val)) {
          list.push(val);
          settings.set_strv("player-blocklist", list);
        }
        addRow.set_text("");
      }
    });
    group.add(addRow);

    return group;
  }

  // ── Weather group (fully redesigned) ──────────────────────────────────────

  _buildWeatherGroup(settings, page) {
    const group = new Adw.PreferencesGroup({
      title: "Weather",
      description: "Data from wttr.in — no API key needed.",
    });

    // ── Toggle ────────────────────────────────────────────────────────────
    group.add(
      this._switchRow(settings, "show-weather", {
        title: "Show Weather",
        subtitle: "Temperature and conditions in the idle pill",
        icon: "weather-clear-symbolic",
      }),
    );

    // ── Live status preview (Stack: loading ↔ data) ───────────────────────
    const loadingSpinner = new Gtk.Spinner({
      spinning: true,
      halign: Gtk.Align.CENTER,
      valign: Gtk.Align.CENTER,
      width_request: 24,
      height_request: 24,
    });

    const statusIcon = new Gtk.Label({
      label: "",
      css_classes: ["title-2"],
      valign: Gtk.Align.CENTER,
      margin_end: 4,
    });
    const statusTemp = new Gtk.Label({
      label: "—",
      css_classes: ["title-3"],
      valign: Gtk.Align.CENTER,
    });
    const statusLoc = new Gtk.Label({
      label: "",
      css_classes: ["caption", "dim-label"],
      valign: Gtk.Align.CENTER,
      halign: Gtk.Align.CENTER,
      ellipsize: 3,
    });

    const dataVBox = new Gtk.Box({
      orientation: Gtk.Orientation.VERTICAL,
      spacing: 2,
      valign: Gtk.Align.CENTER,
      halign: Gtk.Align.CENTER,
      hexpand: true,
    });
    const dataHBox = new Gtk.Box({
      orientation: Gtk.Orientation.HORIZONTAL,
      spacing: 4,
      halign: Gtk.Align.CENTER,
    });
    dataHBox.append(statusIcon);
    dataHBox.append(statusTemp);
    dataVBox.append(dataHBox);
    dataVBox.append(statusLoc);

    const statusStack = new Gtk.Stack({
      transition_type: Gtk.StackTransitionType.CROSSFADE,
      transition_duration: 200,
      hexpand: true,
      vexpand: false,
      valign: Gtk.Align.CENTER,
      margin_top: 10,
      margin_bottom: 10,
    });
    statusStack.add_named(loadingSpinner, "loading");
    statusStack.add_named(dataVBox, "data");
    statusStack.set_visible_child_name("loading");

    const statusRow = new Adw.PreferencesRow();
    statusRow.set_child(statusStack);
    group.add(statusRow);

    // ── Location: Adw.EntryRow ────────────────────────────────────────────
    const locationEntry = new Adw.EntryRow({
      title: "Location",
      text: settings.get_string("weather-location") ?? "",
      show_apply_button: false,
    });

    const spinner = new Gtk.Spinner({
      valign: Gtk.Align.CENTER,
      width_request: 16,
      height_request: 16,
    });
    locationEntry.add_suffix(spinner);

    const clearBtn = new Gtk.Button({
      icon_name: "edit-clear-symbolic",
      valign: Gtk.Align.CENTER,
      has_frame: false,
      tooltip_text: "Clear — use IP auto-detection",
      css_classes: ["flat"],
    });
    clearBtn.connect("clicked", () => {
      locationEntry.set_text("");
      settings.set_string("weather-location", "");
    });
    locationEntry.add_suffix(clearBtn);
    group.add(locationEntry);

    // ── Autocomplete results ──────────────────────────────────────────────
    const resultsBox = new Gtk.ListBox({
      selection_mode: Gtk.SelectionMode.NONE,
      visible: false,
      css_classes: ["boxed-list"],
      margin_top: 8,
      margin_bottom: 16,
    });
    group.add(resultsBox);

    const clearResults = () => {
      let child = resultsBox.get_first_child();
      while (child) {
        const next = child.get_next_sibling();
        resultsBox.remove(child);
        child = next;
      }
      resultsBox.set_visible(false);
    };

    const appendResult = (res) => {
      const parts = res.name.split(",");
      const city = parts[0].trim();
      const region = parts
        .slice(1)
        .map((p) => p.trim())
        .filter(Boolean)
        .join(", ");

      const row = new Adw.ActionRow({
        title: city,
        subtitle: region || res.name,
        activatable: true,
      });
      row.add_prefix(
        new Gtk.Image({ icon_name: "find-location-symbolic", pixel_size: 16 }),
      );
      row.add_suffix(
        new Gtk.Image({
          icon_name: "go-next-symbolic",
          css_classes: ["dim-label"],
        }),
      );

      row.connect("activated", () => {
        const saved = res.city?.length > 0 ? res.city : city;
        ignoreNextLocChange = true;
        locationEntry.set_text(saved);
        settings.set_string("weather-location", saved);
        clearResults();
        this._weatherClient?.refreshNow();
      });

      resultsBox.append(row);
    };

    // ── Debounced search ──────────────────────────────────────────────────
    let searchTimeoutId = 0;
    let ignoreNextLocChange = false;

    locationEntry.connect("changed", () => {
      if (ignoreNextLocChange) {
        ignoreNextLocChange = false;
        return;
      }
      const text = locationEntry.get_text().trim();
      if (searchTimeoutId) {
        GLib.Source.remove(searchTimeoutId);
        searchTimeoutId = 0;
      }
      clearResults();
      if (text.length < 2) {
        spinner.stop();
        return;
      }

      spinner.start();
      searchTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 600, () => {
        searchTimeoutId = 0;
        if (!this._weatherClient) {
          spinner.stop();
          return GLib.SOURCE_REMOVE;
        }

        this._weatherClient
          .search(text)
          .then((results) => {
            spinner.stop();
            clearResults();
            if (!results?.length) {
              const noRow = new Adw.ActionRow({
                title: "No locations found",
                subtitle: "Try a different search term",
              });
              noRow.add_prefix(
                new Gtk.Image({
                  icon_name: "dialog-information-symbolic",
                  pixel_size: 16,
                }),
              );
              resultsBox.append(noRow);
              resultsBox.set_visible(true);
              return;
            }
            for (const res of results) appendResult(res);
            resultsBox.set_visible(true);
          })
          .catch(() => spinner.stop());

        return GLib.SOURCE_REMOVE;
      });
    });

    locationEntry.connect("apply", () => {
      const text = locationEntry.get_text().trim();
      if (searchTimeoutId) {
        GLib.Source.remove(searchTimeoutId);
        searchTimeoutId = 0;
      }
      spinner.stop();
      settings.set_string("weather-location", text);
      clearResults();
      this._weatherClient?.refreshNow();
    });

    // ── Units ─────────────────────────────────────────────────────────────
    group.add(
      this._comboRow(settings, "weather-units", {
        title: "Units",
        icon: "applications-science-symbolic",
        choices: [
          { label: "Metric (°C)", value: "metric" },
          { label: "Imperial (°F)", value: "imperial" },
        ],
      }),
    );

    // ── Start client and connect signals ──────────────────────────────────
    this._weatherClient.start((data) => {
      const loc = settings.get_string("weather-location") || "your location";
      statusIcon.set_label(data.icon ?? "");
      statusTemp.set_label(data.temp ?? "—");
      statusLoc.set_label(`Conditions in ${loc}`);
      statusStack.set_visible_child_name("data");
    });

    const locSigId = settings.connect("changed::weather-location", () => {
      const saved = settings.get_string("weather-location");
      if (locationEntry.get_text() !== saved) {
        ignoreNextLocChange = true;
        locationEntry.set_text(saved);
      }
      // Flip back to loading spinner while new data fetches
      statusStack.set_visible_child_name("loading");
      this._weatherClient?.refresh();
    });
    const unitSigId = settings.connect("changed::weather-units", () => {
      statusStack.set_visible_child_name("loading");
      this._weatherClient?.refresh();
    });

    page.connect("destroy", () => {
      if (searchTimeoutId) {
        GLib.Source.remove(searchTimeoutId);
        searchTimeoutId = 0;
      }
      settings.disconnect(locSigId);
      settings.disconnect(unitSigId);
    });

    return group;
  }

  // ── Page 3: Scrobbling ────────────────────────────────────────────────────

  _buildScrobblingPage(settings) {
    const page = new Adw.PreferencesPage({
      title: "Scrobbling",
      icon_name: "audio-headphones-symbolic",
    });

    const lfmGroup = new Adw.PreferencesGroup({
      title: "Last.fm",
      description: "Scrobble tracks to your Last.fm profile",
    });
    page.add(lfmGroup);
    lfmGroup.add(
      this._switchRow(settings, "lastfm-enabled", {
        title: "Enable Last.fm Scrobbling",
        icon: "audio-headphones-symbolic",
      }),
    );

    // Note: lastfm-username key has been removed from the schema.
    for (const [key, title] of [
      ["lastfm-api-key", "API Key"],
      ["lastfm-api-secret", "API Secret"],
      ["lastfm-session-key", "Session Key"],
    ]) {
      const row = new Adw.EntryRow({ title });
      settings.bind(key, row, "text", Gio.SettingsBindFlags.DEFAULT);
      lfmGroup.add(row);
    }

    lfmGroup.add(
      new Adw.ActionRow({
        title: "How to get a session key",
        subtitle:
          "Use auth.getMobileSession via the Last.fm API with your API key + secret",
        icon_name: "dialog-information-symbolic",
      }),
    );

    const lbGroup = new Adw.PreferencesGroup({
      title: "ListenBrainz",
      description: "Scrobble tracks to your ListenBrainz profile",
    });
    page.add(lbGroup);
    lbGroup.add(
      this._switchRow(settings, "listenbrainz-enabled", {
        title: "Enable ListenBrainz Scrobbling",
        icon: "network-server-symbolic",
      }),
    );
    const lbToken = new Adw.EntryRow({ title: "User Token" });
    settings.bind(
      "listenbrainz-token",
      lbToken,
      "text",
      Gio.SettingsBindFlags.DEFAULT,
    );
    lbGroup.add(lbToken);
    lbGroup.add(
      new Adw.ActionRow({
        title: "Get your token",
        subtitle: "Visit listenbrainz.org → Profile → API Keys",
        icon_name: "dialog-information-symbolic",
      }),
    );

    return page;
  }

  // ── Page 4: System ────────────────────────────────────────────────────────

  _buildSystemPage(settings) {
    const page = new Adw.PreferencesPage({
      title: "System",
      icon_name: "preferences-system-symbolic",
    });

    const diagGroup = new Adw.PreferencesGroup({
      title: "Diagnostics",
      description: "Check the status of background services",
    });
    page.add(diagGroup);

    const wxStatusRow = new Adw.ActionRow({
      title: "Weather Module",
      icon_name: "weather-few-clouds-symbolic",
    });
    settings.bind(
      "status-weather",
      wxStatusRow,
      "subtitle",
      Gio.SettingsBindFlags.GET,
    );
    diagGroup.add(wxStatusRow);

    const scrobStatusRow = new Adw.ActionRow({
      title: "Scrobbling",
      icon_name: "audio-headphones-symbolic",
    });
    settings.bind(
      "status-scrobbler",
      scrobStatusRow,
      "subtitle",
      Gio.SettingsBindFlags.GET,
    );
    diagGroup.add(scrobStatusRow);

    const maintenanceGroup = new Adw.PreferencesGroup({
      title: "Maintenance",
      description: "Manage extension settings",
    });
    page.add(maintenanceGroup);

    const resetRow = new Adw.ActionRow({
      title: "Reset Everything",
      subtitle: "Restore all settings to factory defaults",
      icon_name: "edit-clear-all-symbolic",
    });
    const resetBtn = new Gtk.Button({
      label: "Reset",
      valign: Gtk.Align.CENTER,
      css_classes: ["destructive-action"],
    });
    resetBtn.connect("clicked", () => {
      settings.settings_schema.list_keys().forEach((k) => settings.reset(k));
    });
    resetRow.add_suffix(resetBtn);
    maintenanceGroup.add(resetRow);

    const aboutGroup = new Adw.PreferencesGroup({ title: "About" });
    page.add(aboutGroup);

    const meta = this.metadata;
    const metaVersion = meta.version !== undefined ? String(meta.version) : "1";
    const shellVer = Array.isArray(meta["shell-version"])
      ? meta["shell-version"].join(", ")
      : "46+";

    const titleRow = new Adw.ActionRow({
      title: "Dynamic Island",
      subtitle: "v" + metaVersion + " · GNOME Shell " + shellVer,
    });
    titleRow.add_prefix(
      new Gtk.Image({ icon_name: "audio-x-generic-symbolic", pixel_size: 48 }),
    );
    aboutGroup.add(titleRow);
    aboutGroup.add(
      new Adw.ActionRow({
        title: "Author",
        subtitle: "omarxkhalid",
        icon_name: "user-symbolic",
      }),
    );
    aboutGroup.add(
      new Adw.ActionRow({
        title: "License",
        subtitle: "GPL-2.0-or-later",
        icon_name: "text-x-generic-symbolic",
      }),
    );

    const sourceRow = new Adw.ActionRow({
      title: "Source Code",
      subtitle: "github.com/omarxkhalid/dynamic-island",
      activatable: true,
    });
    sourceRow.add_suffix(new Gtk.Image({ icon_name: "go-next-symbolic" }));
    sourceRow.connect("activated", () =>
      Gtk.show_uri(
        sourceRow.get_root(),
        "https://github.com/omarxkhalid/dynamic-island",
        0,
      ),
    );
    aboutGroup.add(sourceRow);

    return page;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  _spinRow(settings, key, opts) {
    const o = opts || {};
    const title = o.title !== undefined ? o.title : key;
    const subtitle = o.subtitle !== undefined ? o.subtitle : "";
    const digits = o.digits !== undefined ? o.digits : 0;
    const lower = o.lower !== undefined ? o.lower : 0;
    const upper = o.upper !== undefined ? o.upper : 100;
    const step = o.step !== undefined ? o.step : 1;
    const page = o.page !== undefined ? o.page : step * 10;
    const icon = o.icon !== undefined ? o.icon : null;

    const adj = new Gtk.Adjustment({
      lower,
      upper,
      step_increment: step,
      page_increment: page,
    });
    const rowProps = { title, subtitle, digits, adjustment: adj };
    if (icon) rowProps.icon_name = icon;

    const row = new Adw.SpinRow(rowProps);
    settings.bind(key, row, "value", Gio.SettingsBindFlags.DEFAULT);
    return row;
  }

  _switchRow(settings, key, opts) {
    const o = opts || {};
    const title = o.title !== undefined ? o.title : key;
    const subtitle = o.subtitle !== undefined ? o.subtitle : "";
    const icon = o.icon !== undefined ? o.icon : null;

    const rowProps = { title, subtitle };
    if (icon) rowProps.icon_name = icon;

    const row = new Adw.SwitchRow(rowProps);
    settings.bind(key, row, "active", Gio.SettingsBindFlags.DEFAULT);
    return row;
  }

  _comboRow(settings, key, opts) {
    const o = opts || {};
    const title = o.title !== undefined ? o.title : key;
    const choices = o.choices !== undefined ? o.choices : [];
    const icon = o.icon !== undefined ? o.icon : null;

    const model = new Gtk.StringList();
    const values = choices.map((c) => c.value);
    for (const { label } of choices) model.append(label);

    const rowProps = { title, model };
    if (icon) rowProps.icon_name = icon;
    const row = new Adw.ComboRow(rowProps);
    const cur = settings.get_string(key);
    const idx = values.indexOf(cur);
    if (idx >= 0) row.set_selected(idx);

    row.connect("notify::selected", () => {
      const sel = row.get_selected();
      if (sel >= 0 && sel < values.length)
        settings.set_string(key, values[sel]);
    });

    const sigId = settings.connect("changed::" + key, () => {
      const newIdx = values.indexOf(settings.get_string(key));
      if (newIdx >= 0 && newIdx !== row.get_selected())
        row.set_selected(newIdx);
    });
    row.connect("destroy", () => settings.disconnect(sigId));

    return row;
  }
}
