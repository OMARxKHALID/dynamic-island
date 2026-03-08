/**
 * stash.js
 *
 * File Stash — D-Bus receiver + file-operation engine for Dynamic Island.
 *
 * Architecture:
 *   The companion Nautilus plugin (nautilus-stash.py) runs inside the
 *   Nautilus process and has direct access to the file selection.  It
 *   communicates with this module over D-Bus:
 *
 *     AddFiles(uris: as)         — add selected files/folders to the stash
 *     SetCurrentFolder(uri: s)   — update the folder Nautilus is showing
 *     ClearStash()               — empty the stash
 *
 *   The island UI calls:
 *     stash.executeMove()        — gio move stashed files → currentFolder
 *     stash.executeCopy()        — gio copy stashed files → currentFolder
 *     stash.clear()              — programmatic clear (e.g. user presses ✕)
 *     stash.getFiles()           — returns string[] of URIs
 *     stash.getCurrentFolder()   — returns destination URI string | null
 *
 *   The onChanged(files, folderUri) callback is invoked whenever the stash
 *   state changes so the island can update its UI.
 *
 * D-Bus identity:
 *   Name : org.dynamicisland.FileStash
 *   Path : /org/dynamicisland/FileStash
 *   Iface: org.dynamicisland.FileStash
 */

import GLib from "gi://GLib";
import Gio from "gi://Gio";

// ── D-Bus constants ───────────────────────────────────────────────────────────
const BUS_NAME = "org.dynamicisland.FileStash";
const OBJ_PATH = "/org/dynamicisland/FileStash";

const IFACE_XML = `
<node>
  <interface name="org.dynamicisland.FileStash">

    <!-- Called by the Nautilus plugin -->
    <method name="AddFiles">
      <arg direction="in" type="as" name="uris"/>
    </method>
    <method name="ClearStash"/>
    <method name="SetCurrentFolder">
      <arg direction="in" type="s" name="uri"/>
    </method>

    <!-- Queried by the Nautilus plugin to show context-menu actions -->
    <method name="GetStashCount">
      <arg direction="out" type="i" name="count"/>
    </method>

    <!-- Fired whenever the stash list or current folder changes -->
    <signal name="StashChanged">
      <arg type="as" name="uris"/>
      <arg type="s"  name="currentFolderUri"/>
    </signal>

  </interface>
</node>`;

export class FileStash {
  /**
   * @param {function(string[], string|null)} onChanged
   *   Callback invoked on every state change with (fileUris, folderUri).
   */
  constructor(onChanged) {
    this._onChanged = onChanged;
    this._files = []; // array of URI strings in the stash
    this._folder = null; // URI string of current Nautilus folder
    this._nameId = 0;
    this._dbusImpl = null;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  start() {
    // Export the interface on the session bus
    this._dbusImpl = Gio.DBusExportedObject.wrapJSObject(IFACE_XML, this);
    this._dbusImpl.export(Gio.DBus.session, OBJ_PATH);

    // Own the well-known name so Nautilus can discover us
    this._nameId = Gio.bus_own_name(
      Gio.BusType.SESSION,
      BUS_NAME,
      Gio.BusNameOwnerFlags.NONE,
      null, // onBusAcquired — not needed
      null, // onNameAcquired
      (_conn, name) => {
        // Name lost — another instance or session restart; not fatal
        console.warn(`DynamicIsland/Stash: lost D-Bus name "${name}"`);
      },
    );
  }

  destroy() {
    if (this._nameId) {
      Gio.bus_unown_name(this._nameId);
      this._nameId = 0;
    }
    if (this._dbusImpl) {
      this._dbusImpl.unexport();
      this._dbusImpl = null;
    }
    this._files = [];
    this._folder = null;
    this._onChanged = null;
  }

  // ── D-Bus method handlers (called by the Nautilus plugin) ────────────────────

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
    if (this._files.length === 0) return;
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

  // ── Public API (called by island.js) ─────────────────────────────────────────

  getFiles() {
    return [...this._files];
  }

  getCurrentFolder() {
    return this._folder;
  }

  hasFiles() {
    return this._files.length > 0;
  }

  /**
   * Remove a single URI from the stash (user clicks ✕ on a file chip).
   * @param {string} uri
   */
  removeFile(uri) {
    const before = this._files.length;
    this._files = this._files.filter((u) => u !== uri);
    if (this._files.length !== before) this._notify();
  }

  /** Clear the stash programmatically (user presses "Clear" in the island). */
  clear() {
    this.ClearStash();
  }

  /**
   * Move all stashed files to the current Nautilus folder.
   * Clears the stash on success.
   */
  executeMove() {
    this._execute("move");
  }

  /**
   * Copy all stashed files to the current Nautilus folder.
   * Clears the stash on success.
   */
  executeCopy() {
    this._execute("copy");
  }

  // ── Private ───────────────────────────────────────────────────────────────────

  _notify() {
    // Emit the D-Bus signal so the Nautilus plugin can update its menu
    try {
      this._dbusImpl?.emit_signal(
        "StashChanged",
        new GLib.Variant("(ass)", [this._files, this._folder ?? ""]),
      );
    } catch (_e) {}

    // Notify the island UI
    this._onChanged?.(this.getFiles(), this._folder);
  }

  /**
   * Run `gio move|copy <uris...> <dest>` asynchronously.
   * @param {"move"|"copy"} action
   */
  _execute(action) {
    if (!this._files.length) {
      console.warn(
        "DynamicIsland/Stash: executeMove/Copy called with empty stash",
      );
      return;
    }
    if (!this._folder) {
      console.warn("DynamicIsland/Stash: no destination folder known");
      return;
    }

    // gio move/copy accepts URI syntax directly (file:///…)
    const args = ["gio", action, ...this._files, this._folder];

    try {
      const proc = Gio.Subprocess.new(args, Gio.SubprocessFlags.STDERR_PIPE);

      proc.wait_async(null, (_p, res) => {
        try {
          proc.wait_finish(res);
          if (proc.get_successful()) {
            console.debug(`DynamicIsland/Stash: ${action} succeeded`);
            this._files = [];
            this._notify();
          } else {
            // Read stderr for a useful message
            const stderrStream = proc.get_stderr_pipe();
            if (stderrStream) {
              const dis = new Gio.DataInputStream({
                base_stream: stderrStream,
              });
              dis.read_line_async(GLib.PRIORITY_DEFAULT, null, (_s, r) => {
                try {
                  const [line] = dis.read_line_finish_utf8(r);
                  console.error(
                    `DynamicIsland/Stash: ${action} failed: ${line}`,
                  );
                } catch (_e2) {}
              });
            } else {
              console.error(
                `DynamicIsland/Stash: ${action} exited with non-zero status`,
              );
            }
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
}
