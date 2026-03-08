/**
 * mpris.js
 *
 * GObject wrapper around D-Bus MPRIS watching.
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
    <method name="Seek">
      <arg direction="in" type="x" name="Offset"/>
    </method>
    <method name="SetPosition">
      <arg direction="in" type="o" name="TrackId"/>
      <arg direction="in" type="x" name="Position"/>
    </method>
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
    <signal name="Seeked">
      <arg type="x" name="Position"/>
    </signal>
  </interface>
</node>`;

export const MprisWatcher = GObject.registerClass(
  {
    Signals: {
      "player-changed": { param_types: [GObject.TYPE_OBJECT] },
      "player-closed": {},
      "player-seeked": { param_types: [GObject.TYPE_DOUBLE] },
    },
  },
  class MprisWatcher extends GObject.Object {
    constructor(settings) {
      super();
      this._settings = settings;
      this._players = new Map();
      this._activeBusName = null;
      this._dbusSignalId = 0;
      this._playerIfaceInfo = null;
    }

    // ── Public API ───────────────────────────────────────────────────────────

    start() {
      try {
        const nodeInfo = Gio.DBusNodeInfo.new_for_xml(MPRIS_PLAYER_IFACE_XML);
        this._playerIfaceInfo = nodeInfo.lookup_interface(MPRIS_PLAYER_IFACE);

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
        console.error("DynamicIsland: MPRIS watcher failed:", e.message);
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
        for (const { proxy, changedId, seekedId } of this._players.values()) {
          proxy.disconnect(changedId);
          if (seekedId) proxy.disconnect(seekedId);
        }
        this._players.clear();
        this._players = null;
      }
      this._activeBusName = null;
      this._playerIfaceInfo = null;
      this._settings = null;
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    _busNameToIdentity(busName) {
      let id = busName.slice(MPRIS_BUS_PREFIX.length).toLowerCase();
      id = id.replace(/\.instance[0-9]+$/, "");
      id = id.replace(/(\.[0-9]+)+$/, "");
      return id;
    }

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
            console.error(`DynamicIsland: failed to connect to ${busName}:${e.message}`);
            return;
          }

          const changedId = proxy.connect(
            "g-properties-changed",
            (_proxy, changed) => {
              if (!this._players) return;

              if (this._isBlocked(busName)) {
                this._removePlayer(busName);
                return;
              }

              const dict = changed.deepUnpack();

              if (busName !== this._activeBusName && "PlaybackStatus" in dict) {
                if (dict["PlaybackStatus"].unpack() === "Playing") {
                  this._setActive(busName);
                  return;
                }
              }

              if (busName === this._activeBusName)
                this.emit("player-changed", proxy);
            },
          );

          const seekedId = proxy.connect(
            "g-signal",
            (_proxy, _senderName, signalName, params) => {
              if (!this._players) return;
              if (signalName !== "Seeked") return;
              if (busName !== this._activeBusName) return;
              try {
                const [posMicros] = params.deepUnpack();
                this.emit("player-seeked", Number(posMicros));
              } catch (_e) {}
            },
          );

          this._players.set(busName, { proxy, changedId, seekedId });

          if (this._getStatus(proxy) === "Playing") {
            this._setActive(busName);
          } else if (!this._activeBusName) {
            this._activeBusName = busName;
          }
        },
      );
    }

    _removePlayer(busName) {
      const entry = this._players?.get(busName);
      if (!entry) return;

      entry.proxy.disconnect(entry.changedId);
      if (entry.seekedId) entry.proxy.disconnect(entry.seekedId);
      this._players.delete(busName);

      if (this._activeBusName !== busName) return;
      this._activeBusName = null;

      for (const [name, { proxy }] of this._players) {
        if (!this._isBlocked(name) && this._getStatus(proxy) === "Playing") {
          this._setActive(name);
          return;
        }
      }

      for (const [name] of this._players) {
        if (!this._isBlocked(name)) {
          this._setActive(name);
          return;
        }
      }

      this.emit("player-closed");
    }

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
