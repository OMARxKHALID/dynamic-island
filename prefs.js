/**
 * prefs.js
 *
 * Preferences window for Dynamic Island.
 * Runs in the GTK/Adw preferences process — NEVER import Clutter/St/Shell here.
 *
 * Pages:
 *  1. Look & Feel  — position, art, colours, scale
 *  2. Features     — auto-hide, OSD, notifications, weather, player filter
 *  3. Scrobbling   — Last.fm and ListenBrainz credentials
 *  4. System       — reset, about
 */

import Adw from "gi://Adw";
import Gtk from "gi://Gtk";
import Gio from "gi://Gio";
import { ExtensionPreferences } from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";

export default class DynamicIslandPrefs extends ExtensionPreferences {
  fillPreferencesWindow(window) {
    const settings = this.getSettings();
    window.set_default_size(720, 700);
    window.set_title("Dynamic Island");

    window.add(this._buildAppearancePage(settings));
    window.add(this._buildFeaturesPage(settings));
    window.add(this._buildScrobblingPage(settings));
    window.add(this._buildSystemPage(settings));
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

    layoutGroup.add(this._spinRow(settings, "position-offset", {
      title: "Horizontal Shift",
      subtitle: "Move the island left (−) or right (+) for notch / camera alignment",
      icon: "go-next-symbolic",
      lower: -1200, upper: 1200, step: 5, page: 50,
    }));

    layoutGroup.add(this._switchRow(settings, "show-album-art", {
      title: "Show Album Art",
      subtitle: "Display album covers in the expanded view",
      icon: "image-x-generic-symbolic",
    }));

    layoutGroup.add(this._switchRow(settings, "dynamic-art-color", {
      title: "Dynamic Art Colour",
      subtitle: "Tint the island background with the dominant colour from album art",
      icon: "color-select-symbolic",
    }));

    layoutGroup.add(this._switchRow(settings, "show-seek-bar", {
      title: "Show Progress Bar",
      subtitle: "Display the music timer and seek bar in the expanded view",
      icon: "media-seek-forward-symbolic",
    }));

    layoutGroup.add(this._spinRow(settings, "notch-scale", {
      title: "Global Scaling",
      subtitle: "Resize the entire island interface",
      icon: "zoom-in-symbolic",
      lower: 0.5, upper: 3.0, step: 0.05, page: 0.1, digits: 2,
    }));

    const dimensionsGroup = new Adw.PreferencesGroup({
      title: "Dimensions",
      description: "Customise the exact pixel sizes of each state (base size before scaling)",
    });
    page.add(dimensionsGroup);

    dimensionsGroup.add(this._spinRow(settings, "pill-width", { title: "Idle Width", lower: 50, upper: 800, step: 5 }));
    dimensionsGroup.add(this._spinRow(settings, "pill-height", { title: "Idle Height", lower: 20, upper: 200, step: 2 }));

    dimensionsGroup.add(this._spinRow(settings, "compact-width", { title: "Compact Width (Waveform)", lower: 50, upper: 800, step: 5 }));
    dimensionsGroup.add(this._spinRow(settings, "compact-height", { title: "Compact Height", lower: 20, upper: 200, step: 2 }));

    dimensionsGroup.add(this._spinRow(settings, "expanded-width", { title: "Expanded Width (Media Player)", lower: 150, upper: 800, step: 5 }));
    dimensionsGroup.add(this._spinRow(settings, "expanded-height", { title: "Expanded Height", lower: 50, upper: 500, step: 5 }));

    dimensionsGroup.add(this._spinRow(settings, "osd-width", { title: "OSD Width (Volume/Brightness)", lower: 100, upper: 800, step: 5 }));
    dimensionsGroup.add(this._spinRow(settings, "osd-height", { title: "OSD Height", lower: 50, upper: 300, step: 2 }));

    dimensionsGroup.add(this._spinRow(settings, "art-expanded-size", { title: "Expanded Cover Art Size", lower: 20, upper: 300, step: 2 }));
    dimensionsGroup.add(this._spinRow(settings, "art-compact-size", { title: "Compact Cover Art Size", lower: 10, upper: 100, step: 2 }));

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

    styleGroup.add(this._spinRow(settings, "background-opacity", {
      title: "Transparency",
      lower: 0.1, upper: 1.0, step: 0.05, digits: 2,
    }));

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

    generalGroup.add(this._switchRow(settings, "auto-hide", {
      title: "Auto-Hide When Idle",
      subtitle: "Only show the island when music or alerts are active",
      icon: "eye-not-looking-symbolic",
    }));

    const delayRow = this._spinRow(settings, "auto-hide-delay", {
      title: "Idle Timeout (seconds)",
      subtitle: "How long to wait before hiding (0 = wait until media stops)",
      lower: 0, upper: 120, step: 5, page: 15,
    });
    generalGroup.add(delayRow);

    const updateDelayRow = () => {
      delayRow.set_sensitive(settings.get_boolean("auto-hide"));
    };
    updateDelayRow();
    const autoHideSigId = settings.connect("changed::auto-hide", updateDelayRow);
    // Disconnect when the preferences window is closed
    page.connect("destroy", () => settings.disconnect(autoHideSigId));

    generalGroup.add(this._switchRow(settings, "intercept-osd", {
      title: "System Volume / Brightness OSD",
      subtitle: "Show volume and brightness changes inside the island",
      icon: "audio-volume-high-symbolic",
    }));

    generalGroup.add(this._spinRow(settings, "osd-timeout", {
      title: "OSD Duration (ms)",
      subtitle: "How long volume and brightness popups stay visible",
      lower: 500, upper: 10000, step: 250,
    }));

    generalGroup.add(this._switchRow(settings, "show-notifications", {
      title: "Notification Toasts",
      subtitle: "Show incoming system notifications inside the island",
      icon: "preferences-system-notifications-symbolic",
    }));

    const animGroup = new Adw.PreferencesGroup({ title: "Animation" });
    page.add(animGroup);

    animGroup.add(this._spinRow(settings, "animation-duration", {
      title: "Transition Speed (ms)",
      subtitle: "How fast the island expands and collapses",
      icon: "preferences-desktop-animation-symbolic",
      lower: 50, upper: 1000, step: 10, page: 100,
    }));

    const weatherGroup = new Adw.PreferencesGroup({
      title: "Weather",
      description: "Show current conditions alongside the clock in the idle pill",
    });
    page.add(weatherGroup);

    weatherGroup.add(this._switchRow(settings, "show-weather", {
      title: "Show Weather",
      subtitle: "Display temperature and condition in the pill view",
      icon: "weather-clear-symbolic",
    }));

    const locationRow = new Adw.EntryRow({
      title: "Search / Custom Location",
      show_apply_button: true,
    });
    locationRow.add_prefix(new Gtk.Image({
      icon_name: "system-search-symbolic",
      valign: Gtk.Align.CENTER,
      margin_end: 6,
    }));
    settings.bind("weather-location", locationRow, "text", Gio.SettingsBindFlags.DEFAULT);
    weatherGroup.add(locationRow);

    weatherGroup.add(this._comboRow(settings, "weather-units", {
      title: "Units",
      choices: [
        { label: "Metric (°C)",   value: "metric"   },
        { label: "Imperial (°F)", value: "imperial" },
      ],
    }));

    const btGroup = new Adw.PreferencesGroup({ title: "Bluetooth" });
    page.add(btGroup);

    btGroup.add(this._switchRow(settings, "show-bluetooth", {
      title: "Show Bluetooth Indicator",
      subtitle: "Display connected device icon and battery level in the pill",
      icon: "bluetooth-active-symbolic",
    }));

    const playerGroup = new Adw.PreferencesGroup({
      title: "Media Player Filter",
      description: "Block specific players from triggering the island",
    });
    page.add(playerGroup);

    const blocklistRow = new Adw.EntryRow({
      title: 'Blocked Players (comma-separated, e.g. "firefox, chromium")',
    });
    blocklistRow.set_text(settings.get_strv("player-blocklist").join(", "));
    blocklistRow.connect("changed", () => {
      const list = blocklistRow
        .get_text()
        .split(",")
        .map((x) => x.trim().toLowerCase())
        .filter(Boolean);
      settings.set_strv("player-blocklist", list);
    });
    playerGroup.add(blocklistRow);

    return page;
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

    lfmGroup.add(this._switchRow(settings, "lastfm-enabled", {
      title: "Enable Last.fm Scrobbling",
    }));

    for (const [key, title] of [
      ["lastfm-username",   "Username"   ],
      ["lastfm-api-key",    "API Key"    ],
      ["lastfm-api-secret", "API Secret" ],
      ["lastfm-session-key","Session Key"],
    ]) {
      const row = new Adw.EntryRow({ title });
      settings.bind(key, row, "text", Gio.SettingsBindFlags.DEFAULT);
      lfmGroup.add(row);
    }

    lfmGroup.add(new Adw.ActionRow({
      title: "How to get a session key",
      subtitle: "Use auth.getMobileSession via the Last.fm API with your API key + secret",
    }));

    const lbGroup = new Adw.PreferencesGroup({
      title: "ListenBrainz",
      description: "Scrobble tracks to your ListenBrainz profile",
    });
    page.add(lbGroup);

    lbGroup.add(this._switchRow(settings, "listenbrainz-enabled", {
      title: "Enable ListenBrainz Scrobbling",
    }));

    const lbToken = new Adw.EntryRow({ title: "User Token" });
    settings.bind("listenbrainz-token", lbToken, "text", Gio.SettingsBindFlags.DEFAULT);
    lbGroup.add(lbToken);

    lbGroup.add(new Adw.ActionRow({
      title: "Get your token",
      subtitle: "Visit listenbrainz.org → Profile → API Keys",
    }));

    return page;
  }

  // ── Page 5: System ────────────────────────────────────────────────────────

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

    const wxStatusRow = new Adw.ActionRow({ title: "Weather Module" });
    settings.bind("status-weather", wxStatusRow, "subtitle", Gio.SettingsBindFlags.GET);
    diagGroup.add(wxStatusRow);

    const scrobStatusRow = new Adw.ActionRow({ title: "Scrobbling" });
    settings.bind("status-scrobbler", scrobStatusRow, "subtitle", Gio.SettingsBindFlags.GET);
    diagGroup.add(scrobStatusRow);

    const maintenanceGroup = new Adw.PreferencesGroup({
      title: "Maintenance",
      description: "Manage extension settings",
    });
    page.add(maintenanceGroup);

    const resetRow = new Adw.ActionRow({
      title: "Reset Everything",
      subtitle: "Restore all settings to factory defaults",
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
    // Avoid optional-chain (?.) inside new constructors — compute strings first.
    const metaVersion = meta.version !== undefined ? String(meta.version) : "—";
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

    aboutGroup.add(new Adw.ActionRow({
      title: "Author",
      subtitle: "omarxkhalid",
    }));
    aboutGroup.add(new Adw.ActionRow({
      title: "License",
      subtitle: "GPL-2.0-or-later",
    }));

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

  /**
   * Build a SpinRow.
   * All opts are extracted into local variables before constructing any GObject
   * so that neither ?. nor ?? appear directly inside a `new` call — GJS does
   * not allow optional-chain expressions as constructor arguments.
   */
  _spinRow(settings, key, opts) {
    const o = opts || {};
    const title    = o.title    !== undefined ? o.title    : key;
    const subtitle = o.subtitle !== undefined ? o.subtitle : "";
    const digits   = o.digits   !== undefined ? o.digits   : 0;
    const lower    = o.lower    !== undefined ? o.lower    : 0;
    const upper    = o.upper    !== undefined ? o.upper    : 100;
    const step     = o.step     !== undefined ? o.step     : 1;
    const page     = o.page     !== undefined ? o.page     : step * 10;
    const icon     = o.icon     !== undefined ? o.icon     : null;

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
    const title    = o.title    !== undefined ? o.title    : key;
    const subtitle = o.subtitle !== undefined ? o.subtitle : "";
    const icon     = o.icon     !== undefined ? o.icon     : null;

    const rowProps = { title, subtitle };
    if (icon) rowProps.icon_name = icon;

    const row = new Adw.SwitchRow(rowProps);
    settings.bind(key, row, "active", Gio.SettingsBindFlags.DEFAULT);
    return row;
  }

  _comboRow(settings, key, opts) {
    const o = opts || {};
    const title   = o.title   !== undefined ? o.title   : key;
    const choices = o.choices !== undefined ? o.choices : [];

    const model = new Gtk.StringList();
    const values = choices.map((c) => c.value);
    for (const { label } of choices) model.append(label);

    const row = new Adw.ComboRow({ title, model });

    const cur = settings.get_string(key);
    const idx = values.indexOf(cur);
    if (idx >= 0) row.set_selected(idx);

    row.connect("notify::selected", () => {
      const sel = row.get_selected();
      if (sel >= 0 && sel < values.length)
        settings.set_string(key, values[sel]);
    });

    // Track the signal ID so it is freed when the row is destroy()ed
    const sigId = settings.connect("changed::" + key, () => {
      const newIdx = values.indexOf(settings.get_string(key));
      if (newIdx >= 0 && newIdx !== row.get_selected())
        row.set_selected(newIdx);
    });
    row.connect("destroy", () => settings.disconnect(sigId));

    return row;
  }
}
