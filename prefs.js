/**
 * prefs.js
 *
 * Preferences window for Dynamic Island.
 * Runs in the GTK/Adw preferences process — never import Clutter/St/Shell here.
 */

import Adw from "gi://Adw";
import Gtk from "gi://Gtk";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Soup from "gi://Soup";
import { ExtensionPreferences } from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";

export default class DynamicIslandPrefs extends ExtensionPreferences {
  fillPreferencesWindow(window) {
    const settings = this.getSettings();
    window.set_default_size(700, 680);
    window.set_title("Dynamic Island");

    // PAGE 1: Look & Feel
    const appearancePage = new Adw.PreferencesPage({
      title: "Look & Feel",
      icon_name: "applications-graphics-symbolic",
    });
    window.add(appearancePage);

    const layoutGroup = new Adw.PreferencesGroup({
      title: "Position & Visibility",
      description: "Adjust where the island appears and what it shows",
    });
    appearancePage.add(layoutGroup);

    layoutGroup.add(
      this._spinRow(settings, "position-offset", {
        title: "Horizontal Shift",
        subtitle: "Move the island left (−) or right (+) for camera alignment",
        icon: "go-next-symbolic",
        lower: -1200,
        upper: 1200,
        step: 5,
        page: 50,
      }),
    );

    layoutGroup.add(
      this._switchRow(settings, "show-album-art", {
        title: "Show Music Art",
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
        subtitle: "Display the music timer and seek bar",
        icon: "media-seek-forward-symbolic",
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

    const styleGroup = new Adw.PreferencesGroup({
      title: "Colors & Transparency",
      description: "Fine-tune the island appearance",
    });
    appearancePage.add(styleGroup);

    const colorRow = new Adw.EntryRow({
      title: "Island Color (HEX)",
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

    // PAGE 2: Features
    const behaviorPage = new Adw.PreferencesPage({
      title: "Features",
      icon_name: "preferences-system-symbolic",
    });
    window.add(behaviorPage);

    const generalGroup = new Adw.PreferencesGroup({
      title: "Display Logic",
      description: "Configure how and when the island shows up",
    });
    behaviorPage.add(generalGroup);

    generalGroup.add(
      this._switchRow(settings, "auto-hide", {
        title: "Hide When Idle",
        subtitle: "Only show the island when music or alerts are active",
        icon: "eye-not-looking-symbolic",
      }),
    );

    generalGroup.add(
      this._switchRow(settings, "intercept-osd", {
        title: "System Notch Alerts",
        subtitle: "Show volume and brightness changes inside the notch",
        icon: "audio-volume-high-symbolic",
      }),
    );

    generalGroup.add(
      this._spinRow(settings, "osd-timeout", {
        title: "Alert Duration (ms)",
        subtitle: "How long volume and brightness popups stay visible",
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

    const animGroup = new Adw.PreferencesGroup({ title: "Smoothness" });
    behaviorPage.add(animGroup);

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

    // WEATHER
    const weatherGroup = new Adw.PreferencesGroup({
      title: "Weather",
      description:
        "Show current conditions alongside the clock in the idle pill",
    });
    behaviorPage.add(weatherGroup);

    weatherGroup.add(
      this._switchRow(settings, "show-weather", {
        title: "Show Weather",
        subtitle: "Display temperature and condition in the pill view",
        icon: "weather-clear-symbolic",
      }),
    );

    const locationRow = new Adw.EntryRow({
      title: "Location",
      show_apply_button: true,
    });

    settings.bind(
      "weather-location",
      locationRow,
      "text",
      Gio.SettingsBindFlags.DEFAULT,
    );

    const locationSubRow = new Adw.ActionRow({
      subtitle:
        'City name (e.g. "London") or leave blank for auto-detect by IP',
    });

    locationSubRow.set_sensitive(false);

    weatherGroup.add(locationRow);
    weatherGroup.add(locationSubRow);

    // SYSTEM PAGE
    const systemPage = new Adw.PreferencesPage({
      title: "System",
      icon_name: "preferences-system-symbolic",
    });
    window.add(systemPage);

    const maintenanceGroup = new Adw.PreferencesGroup({
      title: "Maintenance",
      description: "Manage extension settings",
    });

    systemPage.add(maintenanceGroup);

    const resetRow = new Adw.ActionRow({
      title: "Reset Everything",
      subtitle: "Restore all settings to factory defaults",
    });

    const resetBtn = new Gtk.Button({
      label: "Reset",
      valign: Gtk.Align.CENTER,
      css_classes: ["destructive-action"],
    });

    resetBtn.connect("clicked", () =>
      settings.settings_schema.list_keys().forEach((k) => settings.reset(k)),
    );

    resetRow.add_suffix(resetBtn);
    maintenanceGroup.add(resetRow);

    // ABOUT PAGE
    const aboutPage = new Adw.PreferencesPage({
      title: "About",
      icon_name: "help-about-symbolic",
    });

    window.add(aboutPage);

    const aboutGroup = new Adw.PreferencesGroup();
    aboutPage.add(aboutGroup);

    const titleRow = new Adw.ActionRow({
      title: "Dynamic Island",
      subtitle: "v1.2 · GNOME Shell 46+",
    });

    titleRow.add_prefix(
      new Gtk.Image({ icon_name: "audio-x-generic-symbolic", pixel_size: 48 }),
    );

    aboutGroup.add(titleRow);

    aboutGroup.add(
      new Adw.ActionRow({ title: "Author", subtitle: "omarxkhalid" }),
    );
    aboutGroup.add(
      new Adw.ActionRow({ title: "License", subtitle: "GPL-2.0-or-later" }),
    );

    const sourceRow = new Adw.ActionRow({
      title: "Source Code",
      subtitle: "github.com/omarxkhalid/dynamic-island",
      activatable: true,
    });

    sourceRow.add_suffix(
      new Gtk.Image({ icon_name: "external-link-symbolic" }),
    );

    sourceRow.connect("activated", () =>
      Gtk.show_uri(window, "https://github.com/omarxkhalid/dynamic-island", 0),
    );

    aboutGroup.add(sourceRow);
  }

  _spinRow(settings, key, opts = {}) {
    const row = new Adw.SpinRow({
      title: opts.title ?? key,
      subtitle: opts.subtitle ?? "",
      ...(opts.icon ? { icon_name: opts.icon } : {}),
      digits: opts.digits ?? 0,
      adjustment: new Gtk.Adjustment({
        lower: opts.lower ?? 0,
        upper: opts.upper ?? 100,
        step_increment: opts.step ?? 1,
        page_increment: opts.page ?? (opts.step ?? 1) * 10,
      }),
    });

    settings.bind(key, row, "value", Gio.SettingsBindFlags.DEFAULT);
    return row;
  }

  _switchRow(settings, key, opts = {}) {
    const row = new Adw.SwitchRow({
      title: opts.title ?? key,
      subtitle: opts.subtitle ?? "",
      ...(opts.icon ? { icon_name: opts.icon } : {}),
    });

    settings.bind(key, row, "active", Gio.SettingsBindFlags.DEFAULT);
    return row;
  }
}
