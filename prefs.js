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
      description: "Customize the position and visibility of the notch",
    });
    appearancePage.add(layoutGroup);

    const posRow = new Adw.SpinRow({
      title: "Horizontal Offset",
      subtitle: "Shift from center (px) for off-center camera setups",
      icon_name: "go-next-symbolic",
      adjustment: new Gtk.Adjustment({
        lower: -1200,
        upper: 1200,
        step_increment: 5,
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
      subtitle: "Display artwork in the expanded media view",
      icon_name: "image-x-generic-symbolic",
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
      subtitle: "Display playback progress and time indicators",
      icon_name: "media-seek-forward-symbolic",
    });
    settings.bind(
      "show-seek-bar",
      seekRow,
      "active",
      Gio.SettingsBindFlags.DEFAULT,
    );
    layoutGroup.add(seekRow);

    const scaleRow = new Adw.SpinRow({
      title: "Interface Scale",
      subtitle: "Adjust the overall size of the Dynamic Island",
      icon_name: "zoom-in-symbolic",
      adjustment: new Gtk.Adjustment({
        lower: 0.5,
        upper: 3.0,
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

    const generalGroup = new Adw.PreferencesGroup({
      title: "General",
      description: "Core extension logic and interactions",
    });
    behaviorPage.add(generalGroup);

    const autoHideRow = new Adw.SwitchRow({
      title: "Auto-hide Clock",
      subtitle: "Only show the island when media or OSD is active",
      icon_name: "eye-not-looking-symbolic",
    });
    settings.bind(
      "auto-hide",
      autoHideRow,
      "active",
      Gio.SettingsBindFlags.DEFAULT,
    );
    generalGroup.add(autoHideRow);

    const osdRow = new Adw.SwitchRow({
      title: "Replace System OSD",
      subtitle: "Render sound and brightness popups inside the notch",
      icon_name: "audio-volume-high-symbolic",
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
      subtitle: "Fluidity of expansion and collapse (ms)",
      icon_name: "preferences-desktop-animation-symbolic",
      adjustment: new Gtk.Adjustment({
        lower: 50,
        upper: 1000,
        step_increment: 10,
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
