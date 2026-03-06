import Adw from "gi://Adw";
import Gtk from "gi://Gtk";
import Gio from "gi://Gio";
import { ExtensionPreferences } from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";

export default class DynamicIslandPrefs extends ExtensionPreferences {
  fillPreferencesWindow(window) {
    const settings = this.getSettings();
    window.set_default_size(660, 520);
    window.set_title("Dynamic Island");

    // ── Appearance ───────────────────────────────────────────────────────
    const appearancePage = new Adw.PreferencesPage({
      title: "Appearance",
      icon_name: "applications-graphics-symbolic",
    });
    window.add(appearancePage);

    const layoutGroup = new Adw.PreferencesGroup({
      title: "Layout",
      description: "Control the island's position and what it shows",
    });
    appearancePage.add(layoutGroup);

    const posRow = new Adw.SpinRow({
      title: "Horizontal Offset",
      subtitle: "Shift from center (px). Negative = left, positive = right",
      adjustment: new Gtk.Adjustment({
        lower: -600,
        upper: 600,
        step_increment: 10,
        page_increment: 50,
      }),
    });
    settings.bind(
      "position-offset",
      posRow,
      "value",
      Gio.SettingsBindFlags.DEFAULT,
    );
    layoutGroup.add(posRow);

    const albumArtRow = new Adw.SwitchRow({
      title: "Show Album Art",
      subtitle: "Display album artwork in the expanded view",
    });
    settings.bind(
      "show-album-art",
      albumArtRow,
      "active",
      Gio.SettingsBindFlags.DEFAULT,
    );
    layoutGroup.add(albumArtRow);

    const seekRow = new Adw.SwitchRow({
      title: "Show Seek Bar",
      subtitle: "Display playback progress in the expanded view",
    });
    settings.bind(
      "show-seek-bar",
      seekRow,
      "active",
      Gio.SettingsBindFlags.DEFAULT,
    );
    layoutGroup.add(seekRow);

    const scaleRow = new Adw.SpinRow({
      title: "Notch Scale",
      subtitle: "Overall size multiplier (e.g., 1.2 is 20% larger)",
      adjustment: new Gtk.Adjustment({
        lower: 0.5,
        upper: 2.5,
        step_increment: 0.05,
        page_increment: 0.1,
      }),
      digits: 2,
    });
    settings.bind(
      "notch-scale",
      scaleRow,
      "value",
      Gio.SettingsBindFlags.DEFAULT,
    );
    layoutGroup.add(scaleRow);

    // ── Behavior ─────────────────────────────────────────────────────────
    const behaviorPage = new Adw.PreferencesPage({
      title: "Behavior",
      icon_name: "preferences-system-symbolic",
    });
    window.add(behaviorPage);

    const generalGroup = new Adw.PreferencesGroup({ title: "General" });
    behaviorPage.add(generalGroup);

    const autoHideRow = new Adw.SwitchRow({
      title: "Auto-hide",
      subtitle: "Completely hide the island when no media player is running",
    });
    settings.bind(
      "auto-hide",
      autoHideRow,
      "active",
      Gio.SettingsBindFlags.DEFAULT,
    );
    generalGroup.add(autoHideRow);

    const osdRow = new Adw.SwitchRow({
      title: "Replace System Volume / Brightness OSD",
      subtitle:
        "Show volume and brightness inside the island instead of the default popup",
    });
    settings.bind(
      "intercept-osd",
      osdRow,
      "active",
      Gio.SettingsBindFlags.DEFAULT,
    );
    generalGroup.add(osdRow);

    const animGroup = new Adw.PreferencesGroup({ title: "Animation" });
    behaviorPage.add(animGroup);

    const animRow = new Adw.SpinRow({
      title: "Animation Duration",
      subtitle: "Expand / collapse duration in milliseconds (100–800)",
      adjustment: new Gtk.Adjustment({
        lower: 100,
        upper: 800,
        step_increment: 20,
        page_increment: 100,
      }),
    });
    settings.bind(
      "animation-duration",
      animRow,
      "value",
      Gio.SettingsBindFlags.DEFAULT,
    );
    animGroup.add(animRow);

    // ── About ────────────────────────────────────────────────────────────
    const aboutPage = new Adw.PreferencesPage({
      title: "About",
      icon_name: "help-about-symbolic",
    });
    window.add(aboutPage);

    const aboutGroup = new Adw.PreferencesGroup();
    aboutPage.add(aboutGroup);

    const titleRow = new Adw.ActionRow({
      title: "Dynamic Island",
      subtitle: "v1.0 · GNOME Shell 46+",
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
}
