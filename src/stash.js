/**
 * stash.js
 *
 * File Stash — D-Bus receiver + file-operation engine for Dynamic Island.
 *
 * GSettings keys consumed:
 *   stash-enabled            — if false, start() is a no-op
 *   stash-auto-clear         — clear stash after successful move/copy
 *   stash-notify-on-complete — send a desktop notification on completion
 */

import GLib from "gi://GLib";
import Gio from "gi://Gio";

const BUS_NAME = "org.dynamicisland.FileStash";
const OBJ_PATH = "/org/dynamicisland/FileStash";

const IFACE_XML = `
<node>
  <interface name="org.dynamicisland.FileStash">
    <method name="AddFiles">
      <arg direction="in" type="as" name="uris"/>
    </method>
    <method name="ClearStash"/>
    <method name="SetCurrentFolder">
      <arg direction="in" type="s" name="uri"/>
    </method>
    <method name="GetStashCount">
      <arg direction="out" type="i" name="count"/>
    </method>
    <signal name="StashChanged">
      <arg type="as" name="uris"/>
      <arg type="s"  name="currentFolderUri"/>
    </signal>
  </interface>
</node>`;

export class FileStash {
  constructor(settings, onChanged) {
    this._settings = settings;
    this._onChanged = onChanged;
    this._files = [];
    this._folder = null;
    this._nameId = 0;
    this._dbusImpl = null;
    this._running = false;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  start() {
    if (!this._settings?.get_boolean("stash-enabled")) return;
    if (this._running) return;
    this._running = true;

    this._dbusImpl = Gio.DBusExportedObject.wrapJSObject(IFACE_XML, this);
    this._dbusImpl.export(Gio.DBus.session, OBJ_PATH);

    this._nameId = Gio.bus_own_name(
      Gio.BusType.SESSION,
      BUS_NAME,
      Gio.BusNameOwnerFlags.NONE,
      null,
      null,
      (_conn, name) =>
        console.warn(`DynamicIsland/Stash: lost D-Bus name "${name}"`),
    );
  }

  stop() {
    if (!this._running) return;
    this._running = false;
    if (this._nameId) {
      Gio.bus_unown_name(this._nameId);
      this._nameId = 0;
    }
    if (this._dbusImpl) {
      this._dbusImpl.unexport();
      this._dbusImpl = null;
    }
    if (this._files.length) {
      this._files = [];
      this._folder = null;
      this._onChanged?.([], null);
    }
  }

  destroy() {
    this.stop();
    this._onChanged = null;
    this._settings = null;
  }

  // ── D-Bus handlers ───────────────────────────────────────────────────────────

  AddFiles(uris) {
    if (!Array.isArray(uris)) return;
    let dirty = false;
    for (const uri of uris) {
      if (typeof uri === "string" && uri && !this._files.includes(uri)) {
        this._files.push(uri);
        dirty = true;
      }
    }
    if (dirty) this._notify();
  }

  ClearStash() {
    if (!this._files.length) return;
    this._files = [];
    this._notify();
  }

  SetCurrentFolder(uri) {
    const next = typeof uri === "string" && uri ? uri : null;
    if (next === this._folder) return;
    this._folder = next;
    this._notify();
  }

  GetStashCount() {
    return this._files.length;
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  getFiles() {
    return [...this._files];
  }
  getCurrentFolder() {
    return this._folder;
  }
  hasFiles() {
    return this._files.length > 0;
  }
  isRunning() {
    return this._running;
  }

  removeFile(uri) {
    const before = this._files.length;
    this._files = this._files.filter((u) => u !== uri);
    if (this._files.length !== before) this._notify();
  }

  clear() {
    this.ClearStash();
  }
  executeMove() {
    this._execute("move");
  }
  executeCopy() {
    this._execute("copy");
  }

  // ── Private ───────────────────────────────────────────────────────────────────

  _notify() {
    try {
      this._dbusImpl?.emit_signal(
        "StashChanged",
        new GLib.Variant("(ass)", [this._files, this._folder ?? ""]),
      );
    } catch (_e) {}
    this._onChanged?.(this.getFiles(), this._folder);
  }

  _execute(action) {
    if (!this._files.length) {
      console.warn("DynamicIsland/Stash: _execute called with empty stash");
      return;
    }
    if (!this._folder) {
      console.warn(
        "DynamicIsland/Stash: _execute called with no destination folder",
      );
      return;
    }

    const files = [...this._files];
    const dest = this._folder;
    const count = files.length;
    const label = action === "move" ? "Moved" : "Copied";
    const autoClear = this._settings?.get_boolean("stash-auto-clear") ?? true;
    const notify =
      this._settings?.get_boolean("stash-notify-on-complete") ?? true;

    try {
      const proc = Gio.Subprocess.new(
        ["gio", action, ...files, dest],
        Gio.SubprocessFlags.STDERR_PIPE,
      );

      proc.wait_async(null, (_p, res) => {
        try {
          proc.wait_finish(res);
          if (proc.get_successful()) {
            console.debug(
              `DynamicIsland/Stash: ${action} of ${count} file(s) succeeded`,
            );
            if (autoClear) {
              this._files = [];
              this._notify();
            }
            if (notify)
              this._notify_send(
                "File Stash",
                `${label} ${count} item${count !== 1 ? "s" : ""} to ${this._folderName(dest)}`,
                "emblem-ok-symbolic",
              );
          } else {
            this._readStderr(proc, (errLine) => {
              console.error(
                `DynamicIsland/Stash: ${action} failed: ${errLine}`,
              );
              if (notify)
                this._notify_send(
                  "File Stash — Error",
                  errLine || `${action} failed`,
                  "dialog-error-symbolic",
                );
            });
          }
        } catch (e) {
          console.error("DynamicIsland/Stash: wait_async error:", e.message);
        }
      });
    } catch (e) {
      console.error(
        "DynamicIsland/Stash: failed to launch subprocess:",
        e.message,
      );
    }
  }

  _readStderr(proc, cb) {
    const stream = proc.get_stderr_pipe();
    if (!stream) {
      cb("(no stderr)");
      return;
    }
    const dis = new Gio.DataInputStream({ base_stream: stream });
    dis.read_line_async(GLib.PRIORITY_DEFAULT, null, (_s, r) => {
      try {
        const [line] = dis.read_line_finish_utf8(r);
        cb(line ?? "");
      } catch (_e) {
        cb("");
      }
    });
  }

  _folderName(uri) {
    try {
      return (
        decodeURIComponent(uri).replace(/\/$/, "").split("/").at(-1) || uri
      );
    } catch (_e) {
      return uri;
    }
  }

  _notify_send(title, body, icon) {
    try {
      Gio.Subprocess.new(
        [
          "notify-send",
          "--app-name=Dynamic Island",
          `--icon=${icon}`,
          title,
          body,
        ],
        Gio.SubprocessFlags.NONE,
      );
    } catch (_e) {}
  }
}
