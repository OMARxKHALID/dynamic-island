/**
 * mpris.js
 *
 * GObject wrapper around D-Bus MPRIS watching.
 *
 * Emits:
 *   "player-changed" (proxy) — active player metadata / status changed
 *   "player-closed"          — no MPRIS players remain
 *
 * FIX #3 — Media Player Visibility:
 *   The active player is only promoted (and "player-changed" emitted) when its
 *   PlaybackStatus is "Playing". A browser that registers MPRIS but has nothing
 *   playing will NOT trigger the island.
 *
 * NEW — Player Blocklist:
 *   Players whose bus-name identity appears in the "player-blocklist" GSettings
 *   key are silently ignored. The identity is the lowercase suffix of the D-Bus
 *   bus name after "org.mpris.MediaPlayer2." with trailing instance numbers
 *   stripped, e.g. "firefox", "chromium", "vlc".
 *   The blocklist is re-read on every check so preference changes take effect
 *   immediately without restarting the extension.
 */

import GLib from "gi://GLib";
import Gio from "gi://Gio";
import GObject from "gi://GObject";

const MPRIS_BUS_PREFIX = "org.mpris.MediaPlayer2.";
const MPRIS_OBJECT_PATH = "/org/mpris/MediaPlayer2";
const MPRIS_PLAYER_IFACE = "org.mpris.MediaPlayer2.Player";

const MPRIS_PLAYER_IFACE_XML = `
<node>
  <interface name="org.mpris.MediaPlayer2.Player">
    <method name="Next"/>
    <method name="Previous"/>
    <method name="Pause"/>
    <method name="PlayPause"/>
    <method name="Stop"/>
    <method name="Play"/>
    <property name="PlaybackStatus" type="s"     access="read"/>
    <property name="Metadata"       type="a{sv}" access="read"/>
    <property name="Volume"         type="d"     access="readwrite"/>
    <property name="Position"       type="x"     access="read"/>
    <property name="CanGoNext"      type="b"     access="read"/>
    <property name="CanGoPrevious"  type="b"     access="read"/>
    <property name="CanPlay"        type="b"     access="read"/>
    <property name="CanPause"       type="b"     access="read"/>
    <property name="CanSeek"        type="b"     access="read"/>
    <property name="CanControl"     type="b"     access="read"/>
  </interface>
</node>`;

export const MprisWatcher = GObject.registerClass(
  {
    Signals: {
      "player-changed": { param_types: [GObject.TYPE_OBJECT] },
      "player-closed": {},
    },
  },
  class MprisWatcher extends GObject.Object {
    /**
     * @param {Gio.Settings} settings — extension settings, used to read
     *   "player-blocklist" dynamically on every player promotion check.
     */
    constructor(settings) {
      super();
      this._settings = settings;
      this._players = new Map(); // busName → { proxy, changedId }
      this._activeBusName = null;
      this._dbusSignalId = 0;
      this._playerIfaceInfo = null;
    }

    // ── Public ──────────────────────────────────────────────────────────

    start() {
      try {
        const nodeInfo = Gio.DBusNodeInfo.new_for_xml(MPRIS_PLAYER_IFACE_XML);
        this._playerIfaceInfo = nodeInfo.lookup_interface(MPRIS_PLAYER_IFACE);

        // Watch for players appearing / disappearing on D-Bus
        this._dbusSignalId = Gio.DBus.session.signal_subscribe(
          "org.freedesktop.DBus",
          "org.freedesktop.DBus",
          "NameOwnerChanged",
          "/org/freedesktop/DBus",
          null,
          Gio.DBusSignalFlags.NONE,
          (_conn, _sender, _path, _iface, _signal, params) => {
            const [name, oldOwner, newOwner] = params.deepUnpack();
            if (!name.startsWith(MPRIS_BUS_PREFIX)) return;
            if (newOwner && !oldOwner) this._addPlayer(name);
            else if (oldOwner && !newOwner) this._removePlayer(name);
          },
        );

        // Enumerate already-running players
        Gio.DBus.session.call(
          "org.freedesktop.DBus",
          "/org/freedesktop/DBus",
          "org.freedesktop.DBus",
          "ListNames",
          null,
          GLib.VariantType.new("(as)"),
          Gio.DBusCallFlags.NONE,
          -1,
          null,
          (conn, res) => {
            try {
              const [names] = conn.call_finish(res).deepUnpack();
              for (const name of names) {
                if (name.startsWith(MPRIS_BUS_PREFIX)) this._addPlayer(name);
              }
            } catch (e) {
              console.error("DynamicIsland: ListNames failed:", e.message);
            }
          },
        );
      } catch (e) {
        console.error(
          "DynamicIsland: MPRIS watcher failed to start:",
          e.message,
        );
      }
    }

    getActiveProxy() {
      if (!this._activeBusName) return null;
      return this._players.get(this._activeBusName)?.proxy ?? null;
    }

    destroy() {
      if (this._dbusSignalId) {
        Gio.DBus.session.signal_unsubscribe(this._dbusSignalId);
        this._dbusSignalId = 0;
      }
      if (this._players) {
        for (const { proxy, changedId } of this._players.values())
          proxy.disconnect(changedId);
        this._players.clear();
        this._players = null;
      }
      this._activeBusName = null;
      this._playerIfaceInfo = null;
      this._settings = null;
    }

    // ── Private ─────────────────────────────────────────────────────────

    /**
     * Extract the normalized identity from a full MPRIS bus name.
     *
     * "org.mpris.MediaPlayer2.firefox"            → "firefox"
     * "org.mpris.MediaPlayer2.firefox.instance12" → "firefox"
     * "org.mpris.MediaPlayer2.VLC"                → "vlc"
     *
     * The result is always lowercase.  Instance suffixes (a dot followed
     * by one or more digit-only segments) are stripped so that both
     * "spotify" and "spotify.instance1234" are matched by the single
     * blocklist entry "spotify".
     */
    _busNameToIdentity(busName) {
      // Strip the MPRIS prefix
      let id = busName.slice(MPRIS_BUS_PREFIX.length).toLowerCase();
      // Strip trailing .instance<digits> segments, e.g. ".instance12345"
      id = id.replace(/(\.[0-9]+)+$/, "");
      return id;
    }

    /**
     * Returns true if this bus name is on the user's blocklist.
     * The blocklist is read from settings on every call so changes in
     * the preferences window take effect without restarting the extension.
     */
    _isBlocked(busName) {
      if (!this._settings) return false;
      let list;
      try {
        list = this._settings.get_strv("player-blocklist");
      } catch (_e) {
        return false;
      }
      if (!list || list.length === 0) return false;
      const identity = this._busNameToIdentity(busName);
      return list.some((entry) => entry.trim().toLowerCase() === identity);
    }

    _addPlayer(busName) {
      if (this._players.has(busName)) return;

      // NEW: silently ignore blocked players — don't even create a proxy
      if (this._isBlocked(busName)) {
        console.debug(`DynamicIsland: ignoring blocked player ${busName}`);
        return;
      }

      Gio.DBusProxy.new_for_bus(
        Gio.BusType.SESSION,
        Gio.DBusProxyFlags.GET_INVALIDATED_PROPERTIES,
        this._playerIfaceInfo,
        busName,
        MPRIS_OBJECT_PATH,
        MPRIS_PLAYER_IFACE,
        null,
        (source, result) => {
          if (!this._players) return;

          let proxy;
          try {
            proxy = Gio.DBusProxy.new_for_bus_finish(result);
          } catch (e) {
            console.error(
              `DynamicIsland: failed to connect to ${busName}:`,
              e.message,
            );
            return;
          }

          const changedId = proxy.connect(
            "g-properties-changed",
            (_proxy, changed) => {
              if (!this._players) return;

              // Re-check blocklist on every property change — the user
              // may have added this player to the list since startup.
              if (this._isBlocked(busName)) {
                this._removePlayer(busName);
                return;
              }

              const dict = changed.deepUnpack();

              // FIX #3: When a non-active player starts Playing, promote it.
              if (busName !== this._activeBusName && "PlaybackStatus" in dict) {
                const newStatus = dict["PlaybackStatus"].unpack();
                if (newStatus === "Playing") {
                  this._setActive(busName);
                  return;
                }
              }

              // Emit for the active player on any property change so the
              // island can update play/pause, seek bar, title, etc.
              if (busName === this._activeBusName)
                this.emit("player-changed", proxy);
            },
          );

          this._players.set(busName, { proxy, changedId });

          // FIX #3: Only promote to active when actually Playing.
          const status = this._getStatus(proxy);
          if (status === "Playing") {
            this._setActive(busName);
          } else if (!this._activeBusName) {
            // Track silently — do NOT emit player-changed yet.
            this._activeBusName = busName;
          }
        },
      );
    }

    _removePlayer(busName) {
      const entry = this._players?.get(busName);
      if (!entry) return;

      entry.proxy.disconnect(entry.changedId);
      this._players.delete(busName);

      if (this._activeBusName !== busName) return;
      this._activeBusName = null;

      // Prefer another currently-playing player
      for (const [name, { proxy }] of this._players) {
        if (!this._isBlocked(name) && this._getStatus(proxy) === "Playing") {
          this._setActive(name);
          return;
        }
      }

      // Fall back to any non-blocked player, or signal that all are gone
      for (const [name] of this._players) {
        if (!this._isBlocked(name)) {
          this._setActive(name);
          return;
        }
      }

      this.emit("player-closed");
    }

    /**
     * Promote busName to active and emit "player-changed".
     * Only call this when you actually want the island to react.
     */
    _setActive(busName) {
      this._activeBusName = busName;
      const entry = this._players?.get(busName);
      if (entry) this.emit("player-changed", entry.proxy);
    }

    _getStatus(proxy) {
      try {
        return (
          proxy.get_cached_property("PlaybackStatus")?.unpack() ?? "Stopped"
        );
      } catch (_e) {
        return "Stopped";
      }
    }
  },
);
