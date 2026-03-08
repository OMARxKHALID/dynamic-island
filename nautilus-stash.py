#!/usr/bin/env python3
"""
nautilus-stash.py — Dynamic Island File Stash, Nautilus companion extension.

Install:
    mkdir -p ~/.local/share/nautilus-python/extensions
    cp nautilus-stash.py ~/.local/share/nautilus-python/extensions/
    nautilus -q   # then re-open Nautilus

Requires:  python3-nautilus  (sudo apt install python3-nautilus)

Workflow
────────
1. Select files/folders in Nautilus → right-click → "📌 Stash N items in Island"
2. Navigate to the destination folder
3. Right-click folder background → "📂 Move N items Here"  or  "📋 Copy N items Here"
4. Done.  The island clears the stash automatically on success.

"🗑 Clear Island Stash" is also in the background menu to discard a stash.

Compatibility:
  nautilus-python 3.x — get_file_items(window, files)
  nautilus-python 4.x — get_file_items(files)          [no window arg]
  Using *args handles both without conditional version checks.
"""

import threading
import subprocess
from gi.repository import GObject, Nautilus, Gio, GLib


# ── D-Bus constants — must match src/stash.js exactly ────────────────────────
_BUS_NAME = "org.dynamicisland.FileStash"
_OBJ_PATH = "/org/dynamicisland/FileStash"
_IFACE    = "org.dynamicisland.FileStash"

_IFACE_XML = """
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
</node>"""


# ── Module-level stash mirror ─────────────────────────────────────────────────
# The StashChanged signal keeps this in sync so menu callbacks never need to
# make a blocking D-Bus call just to read the current file list.
_stash_uris: list = []


def _on_stash_changed(_conn, _sender, _path, _iface, _sig, params):
    global _stash_uris
    try:
        uris, _folder = params.unpack()
        _stash_uris = list(uris)
    except Exception:
        pass


# Subscribe once when the module loads
_conn = Gio.bus_get_sync(Gio.BusType.SESSION, None)
_conn.signal_subscribe(
    None,          # any sender (tolerates service restarts)
    _IFACE,
    "StashChanged",
    _OBJ_PATH,
    None,
    Gio.DBusSignalFlags.NONE,
    _on_stash_changed,
)


# ── Proxy helper ──────────────────────────────────────────────────────────────

def _make_proxy():
    """
    Return a D-Bus proxy to the island stash service, or None if not running.
    Always call this from an idle/thread — never directly from a menu callback.
    """
    try:
        iface_info = Gio.DBusNodeInfo.new_for_xml(_IFACE_XML).interfaces[0]
        p = Gio.DBusProxy.new_for_bus_sync(
            Gio.BusType.SESSION,
            Gio.DBusProxyFlags.DO_NOT_AUTO_START
            | Gio.DBusProxyFlags.DO_NOT_LOAD_PROPERTIES,
            iface_info,
            _BUS_NAME, _OBJ_PATH, _IFACE,
            None,
        )
        return p if p.get_name_owner() else None
    except Exception:
        return None


def _idle_call(method: str, params=None):
    """Schedule a fire-and-forget D-Bus call via GLib.idle_add."""
    def _do():
        p = _make_proxy()
        if p is None:
            _show_notification(
                "Dynamic Island not running",
                "Enable it from Quick Settings first.",
            )
            return False
        try:
            p.call_sync(method, params, Gio.DBusCallFlags.NONE, 2000, None)
        except Exception as exc:
            print(f"[DynamicIslandStash] {method} error: {exc}")
        return False   # run once
    GLib.idle_add(_do)


def _show_notification(summary: str, body: str = ""):
    subprocess.Popen(
        ["notify-send", "-a", "Dynamic Island", "-i", "dialog-information",
         summary, body],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )


# ── Nautilus extension class ──────────────────────────────────────────────────

class DynamicIslandStash(GObject.GObject, Nautilus.MenuProvider):
    """Bridges Nautilus file selection to the Dynamic Island File Stash."""

    def __init__(self):
        GObject.GObject.__init__(self)

    # ── Selected-files context menu ───────────────────────────────────────────

    def get_file_items(self, *args):
        """
        nautilus-python 4.x:  get_file_items(files)
        nautilus-python 3.x:  get_file_items(window, files)
        Using *args handles both.
        """
        files = args[-1]
        if not files:
            return []

        # Only local files
        uris = [f.get_uri() for f in files if f.get_uri_scheme() == "file"]
        if not uris:
            return []

        n = len(uris)
        item = Nautilus.MenuItem(
            name="DynamicIslandStash::stash_files",
            label=f"Stash {n} item{'s' if n != 1 else ''} in Island",
            tip="Hold these in the Dynamic Island stash for later move/copy",
        )
        item.connect("activate", lambda _m: self._do_stash(uris))
        return [item]

    # ── Background (folder) context menu ─────────────────────────────────────

    def get_background_items(self, *args):
        """
        nautilus-python 4.x:  get_background_items(current_folder)
        nautilus-python 3.x:  get_background_items(window, current_folder)
        """
        folder_file = args[-1]
        if folder_file is None:
            return []

        folder_uri = folder_file.get_uri()
        if not folder_uri:
            return []

        # Keep the island aware of where Nautilus is browsing (non-blocking)
        _idle_call("SetCurrentFolder", GLib.Variant("(s)", (folder_uri,)))

        n = len(_stash_uris)
        if n == 0:
            return []

        s = "s" if n != 1 else ""

        move_item = Nautilus.MenuItem(
            name="DynamicIslandStash::move_here",
            label=f"📂  Move {n} stashed item{s} Here",
            tip="Move Island stash into this folder",
        )
        move_item.connect(
            "activate", lambda _m: self._do_file_op("move", folder_uri)
        )

        copy_item = Nautilus.MenuItem(
            name="DynamicIslandStash::copy_here",
            label=f"📋  Copy {n} stashed item{s} Here",
            tip="Copy Island stash into this folder",
        )
        copy_item.connect(
            "activate", lambda _m: self._do_file_op("copy", folder_uri)
        )

        clear_item = Nautilus.MenuItem(
            name="DynamicIslandStash::clear",
            label="🗑   Clear Island Stash",
            tip="Remove all items from the Island stash",
        )
        clear_item.connect("activate", lambda _m: _idle_call("ClearStash"))

        return [move_item, copy_item, clear_item]

    # ── Helpers ───────────────────────────────────────────────────────────────

    @staticmethod
    def _do_stash(uris: list):
        _idle_call("AddFiles", GLib.Variant("(as)", (uris,)))

    @staticmethod
    def _do_file_op(action: str, dest_uri: str):
        """
        Run  gio move|copy  <stash_uris…>  <dest>  in a daemon thread so
        Nautilus is never blocked.  Clears the stash on success.
        """
        uris = list(_stash_uris)   # snapshot before any async gap
        if not uris:
            return

        def _run():
            cmd = ["gio", action] + uris + [dest_uri]
            try:
                result = subprocess.run(
                    cmd,
                    capture_output=True,
                    text=True,
                    timeout=120,
                )
                if result.returncode == 0:
                    p = _make_proxy()
                    if p:
                        try:
                            p.call_sync(
                                "ClearStash", None,
                                0, 1000, None,
                            )
                        except Exception:
                            pass
                    GLib.idle_add(
                        lambda: _show_notification(
                            "Island Stash",
                            f"{action.title()}d {len(uris)} item"
                            f"{'s' if len(uris) != 1 else ''} successfully."
                        ) or False
                    )
                else:
                    err = (result.stderr or f"exit {result.returncode}").strip()
                    GLib.idle_add(
                        lambda: _show_notification(
                            f"Stash {action} failed", err
                        ) or False
                    )
            except subprocess.TimeoutExpired:
                GLib.idle_add(
                    lambda: _show_notification(
                        "Stash operation timed out",
                        "The file operation took too long.",
                    ) or False
                )
            except Exception as exc:
                GLib.idle_add(
                    lambda: _show_notification("Stash error", str(exc)) or False
                )

        threading.Thread(target=_run, daemon=True).start()
