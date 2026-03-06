/**
 * prefs.js
 *
 * Preferences window for Dynamic Island.
 * Runs in the GTK/Adw preferences process — never import Clutter/St/Shell here.
 */

import Adw from "gi://Adw";
import Gtk from "gi://Gtk";
import Gio from "gi://Gio";
import { ExtensionPreferences } from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";

export default class DynamicIslandPrefs extends ExtensionPreferences {
  fillPreferencesWindow(window) {
    const settings = this.getSettings();
    window.set_default_size(700, 680);
    window.set_title("Dynamic Island");

    // ════════════════════════════════════════════════════════════════════════
    // PAGE 1: Look & Feel
    // ════════════════════════════════════════════════════════════════════════
    const appearancePage = new Adw.PreferencesPage({
      title: "Look & Feel",
      icon_name: "applications-graphics-symbolic",
    });
    window.add(appearancePage);

    // ── Group: Position & Visibility ────────────────────────────────────
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

    // ── Group: Colors & Transparency ────────────────────────────────────
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

    // ── Group: State Dimensions ──────────────────────────────────────────
    const sizesGroup = new Adw.PreferencesGroup({
      title: "State Dimensions",
      description: "Width and height for each island state (before scale)",
    });
    appearancePage.add(sizesGroup);

    sizesGroup.add(
      this._spinRow(settings, "pill-width", {
        title: "Idle Width",
        lower: 50,
        upper: 400,
        step: 1,
      }),
    );
    sizesGroup.add(
      this._spinRow(settings, "pill-height", {
        title: "Idle Height",
        lower: 20,
        upper: 80,
        step: 1,
      }),
    );
    sizesGroup.add(
      this._spinRow(settings, "compact-width", {
        title: "Compact Width",
        lower: 50,
        upper: 400,
        step: 1,
      }),
    );
    sizesGroup.add(
      this._spinRow(settings, "compact-height", {
        title: "Compact Height",
        lower: 20,
        upper: 80,
        step: 1,
      }),
    );
    sizesGroup.add(
      this._spinRow(settings, "expanded-width", {
        title: "Expanded Width",
        lower: 300,
        upper: 800,
        step: 5,
      }),
    );
    sizesGroup.add(
      this._spinRow(settings, "expanded-height", {
        title: "Expanded Height",
        lower: 100,
        upper: 300,
        step: 5,
      }),
    );
    sizesGroup.add(
      this._spinRow(settings, "osd-width", {
        title: "Alert Width",
        lower: 200,
        upper: 600,
        step: 5,
      }),
    );
    sizesGroup.add(
      this._spinRow(settings, "osd-height", {
        title: "Alert Height",
        lower: 60,
        upper: 200,
        step: 5,
      }),
    );

    // ── Group: Artwork Sizes ─────────────────────────────────────────────
    const artGroup = new Adw.PreferencesGroup({
      title: "Album Artwork Sizes",
      description: "Control artwork dimensions in each view (before scale)",
    });
    appearancePage.add(artGroup);

    artGroup.add(
      this._spinRow(settings, "art-expanded-size", {
        title: "Expanded Art Size",
        subtitle: "Album art dimensions in the hover-expanded view",
        icon: "image-x-generic-symbolic",
        lower: 40,
        upper: 200,
        step: 2,
      }),
    );
    artGroup.add(
      this._spinRow(settings, "art-compact-size", {
        title: "Compact Art Size",
        subtitle: "Album art thumbnail size in the compact playing view",
        icon: "image-x-generic-symbolic",
        lower: 16,
        upper: 60,
        step: 1,
      }),
    );

    // ════════════════════════════════════════════════════════════════════════
    // PAGE 2: Features
    // ════════════════════════════════════════════════════════════════════════
    const behaviorPage = new Adw.PreferencesPage({
      title: "Features",
      icon_name: "preferences-system-symbolic",
    });
    window.add(behaviorPage);

    // ── Group: Display Logic ─────────────────────────────────────────────
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

    // NEW: notification toast toggle
    generalGroup.add(
      this._switchRow(settings, "show-notifications", {
        title: "Notification Toasts",
        subtitle: "Show incoming system notifications inside the island",
        icon: "preferences-system-notifications-symbolic",
      }),
    );

    // ── Group: Smoothness ────────────────────────────────────────────────
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

    // ════════════════════════════════════════════════════════════════════════
    // PAGE 3: Player Filter  (NEW)
    // ════════════════════════════════════════════════════════════════════════
    const filterPage = new Adw.PreferencesPage({
      title: "Player Filter",
      icon_name: "edit-find-symbolic",
    });
    window.add(filterPage);

    // ── Explanation group ────────────────────────────────────────────────
    const howToGroup = new Adw.PreferencesGroup({
      title: "How It Works",
      description:
        "Block specific media players from appearing in the Dynamic Island " +
        "even when they are actively playing. Useful for hiding browser tabs " +
        "that play background audio, or any app you prefer to manage elsewhere.",
    });
    filterPage.add(howToGroup);

    const infoRow = new Adw.ActionRow({
      title: "Finding a player's identity",
      subtitle:
        'Run "dbus-send --print-reply --dest=org.freedesktop.DBus ' +
        '/org/freedesktop/DBus org.freedesktop.DBus.ListNames" in a terminal ' +
        'and look for entries beginning with "org.mpris.MediaPlayer2." — the ' +
        "part after that prefix (lowercased, without instance numbers) is what " +
        'you enter below. Example: "firefox", "spotify", "vlc", "chromium".',
    });
    infoRow.add_prefix(
      new Gtk.Image({
        icon_name: "dialog-information-symbolic",
        pixel_size: 32,
        valign: Gtk.Align.CENTER,
      }),
    );
    howToGroup.add(infoRow);

    // ── Blocklist management group ───────────────────────────────────────
    const blockGroup = new Adw.PreferencesGroup({
      title: "Blocked Players",
      description:
        "Players in this list will never appear in the Dynamic Island",
    });
    filterPage.add(blockGroup);

    // Entry row to add a new player to the list
    const addRow = new Adw.EntryRow({
      title: "Add player identity (e.g. firefox)",
    });
    const addBtn = new Gtk.Button({
      label: "Add",
      valign: Gtk.Align.CENTER,
      css_classes: ["suggested-action"],
    });
    addRow.add_suffix(addBtn);
    blockGroup.add(addRow);

    // Container where individual blocked-player rows are shown.
    // We keep our own array so we can remove exactly what we added —
    // Adw.PreferencesGroup's internal GTK child tree is not safe to walk.
    const listGroup = new Adw.PreferencesGroup();
    filterPage.add(listGroup);

    // Tracks every row currently inside listGroup so we can remove them precisely.
    const _trackedRows = [];

    const rebuildBlocklistRows = () => {
      // Step 1: remove every row we previously added, in reverse order
      // (reverse avoids index shifting issues even though we clear the array after)
      for (let i = _trackedRows.length - 1; i >= 0; i--) {
        try {
          listGroup.remove(_trackedRows[i]);
        } catch (_e) {}
      }
      _trackedRows.length = 0; // clear the tracking array

      // Step 2: read current blocklist and rebuild rows
      const current = settings.get_strv("player-blocklist");

      if (current.length === 0) {
        const emptyRow = new Adw.ActionRow({
          title: "No players blocked",
          subtitle: "Add a player identity above to block it",
        });
        emptyRow.set_sensitive(false);
        listGroup.add(emptyRow);
        _trackedRows.push(emptyRow);
        return;
      }

      for (const entry of current) {
        const row = new Adw.ActionRow({
          title: entry,
          subtitle: `org.mpris.MediaPlayer2.${entry}`,
        });

        const removeBtn = new Gtk.Button({
          icon_name: "user-trash-symbolic",
          valign: Gtk.Align.CENTER,
          css_classes: ["destructive-action", "flat"],
          tooltip_text: `Remove "${entry}" from blocklist`,
        });
        removeBtn.connect("clicked", () => {
          const updated = settings
            .get_strv("player-blocklist")
            .filter((e) => e !== entry);
          settings.set_strv("player-blocklist", updated);
          // settings-changed signal fires → rebuildBlocklistRows() is called below
        });

        row.add_suffix(removeBtn);
        listGroup.add(row);
        _trackedRows.push(row); // remember this row so we can remove it later
      }
    };

    // Build initial list
    rebuildBlocklistRows();

    // Rebuild whenever settings change (handles add, delete, clear-all, and
    // any external gsettings write)
    settings.connect("changed::player-blocklist", () => rebuildBlocklistRows());

    // Add button handler — validates input before saving
    const addEntry = () => {
      const raw = addRow.get_text().trim().toLowerCase();
      if (!raw) return;

      // Strip the full bus prefix if the user pasted it accidentally
      const identity = raw
        .replace(/^org\.mpris\.mediaplayer2\./i, "")
        .replace(/(\.[0-9]+)+$/, ""); // strip .instance12345

      if (!identity) return;

      const current = settings.get_strv("player-blocklist");
      if (current.includes(identity)) {
        // Already present — just clear the input
        addRow.set_text("");
        return;
      }

      settings.set_strv("player-blocklist", [...current, identity]);
      addRow.set_text("");
    };

    addBtn.connect("clicked", addEntry);
    // Allow pressing Enter in the entry row to add
    addRow.connect("apply", addEntry);

    // Clear-all button
    const clearAllRow = new Adw.ActionRow({
      title: "Clear All",
      subtitle: "Remove every entry from the blocklist",
    });
    const clearBtn = new Gtk.Button({
      label: "Clear All",
      valign: Gtk.Align.CENTER,
      css_classes: ["destructive-action"],
    });
    clearBtn.connect("clicked", () => {
      settings.set_strv("player-blocklist", []);
    });
    clearAllRow.add_suffix(clearBtn);

    const clearGroup = new Adw.PreferencesGroup();
    filterPage.add(clearGroup);
    clearGroup.add(clearAllRow);

    // ════════════════════════════════════════════════════════════════════════
    // PAGE 4: System
    // ════════════════════════════════════════════════════════════════════════
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

    // ════════════════════════════════════════════════════════════════════════
    // PAGE 5: About
    // ════════════════════════════════════════════════════════════════════════
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

  // ── Widget helpers ────────────────────────────────────────────────────────

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
