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
    constructor() {
      super();
      this._players = new Map();
      this._activeBusName = null;
      this._dbusSignalId = 0;
      this._playerIfaceInfo = null;
    }

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
        console.error(
          "DynamicIsland: MPRIS watcher failed to start:",
          e.message,
        );
      }
    }

    _addPlayer(busName) {
      if (this._players.has(busName)) return;

      Gio.DBusProxy.new_for_bus(
        Gio.BusType.SESSION,
        Gio.DBusProxyFlags.GET_INVALIDATED_PROPERTIES,
        this._playerIfaceInfo,
        busName,
        MPRIS_OBJECT_PATH,
        MPRIS_PLAYER_IFACE,
        null,
        (source, result) => {
          // Watcher may have been destroyed before this callback fires
          if (this._players === null) return;

          let proxy;
          try {
            proxy = Gio.DBusProxy.new_for_bus_finish(result);
          } catch (e) {
            console.error(
              `DynamicIsland: Failed to connect to ${busName}:`,
              e.message,
            );
            return;
          }

          const changedId = proxy.connect(
            "g-properties-changed",
            (_proxy, changed) => {
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

          this._players.set(busName, { proxy, changedId });

          if (!this._activeBusName || this._getStatus(proxy) === "Playing")
            this._setActive(busName);
        },
      );
    }

    _removePlayer(busName) {
      const entry = this._players.get(busName);
      if (!entry) return;

      entry.proxy.disconnect(entry.changedId);
      this._players.delete(busName);

      if (this._activeBusName !== busName) return;
      this._activeBusName = null;

      for (const [name, { proxy }] of this._players) {
        if (this._getStatus(proxy) === "Playing") {
          this._setActive(name);
          return;
        }
      }
      const first = this._players.keys().next().value;
      if (first) this._setActive(first);
      else this.emit("player-closed");
    }

    _setActive(busName) {
      this._activeBusName = busName;
      const entry = this._players.get(busName);
      if (entry) this.emit("player-changed", entry.proxy);
    }

    _getStatus(proxy) {
      try {
        return (
          proxy.get_cached_property("PlaybackStatus")?.unpack() ?? "Stopped"
        );
      } catch (_) {
        return "Stopped";
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
      for (const { proxy, changedId } of this._players.values())
        proxy.disconnect(changedId);
      this._players.clear();
      this._players = null;
      this._activeBusName = null;
      this._playerIfaceInfo = null;
    }
  },
);
