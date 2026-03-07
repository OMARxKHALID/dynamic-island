/**
 * bluetooth.js
 *
 * Watches the BlueZ D-Bus service for connected Bluetooth devices and emits
 * an onChanged callback whenever the set of connected devices changes.
 *
 * Gracefully does nothing on systems where BlueZ is not running.
 *
 * Calls onChanged([ { name, icon, battery } ]) — list of currently connected
 * devices; empty array means no devices are connected.
 *
 * GSettings keys consumed: show-bluetooth
 */

import GLib from "gi://GLib";
import Gio from "gi://Gio";

const BLUEZ_BUS    = "org.bluez";
const OBJ_MGR_IFACE  = "org.freedesktop.DBus.ObjectManager";
const PROPS_IFACE    = "org.freedesktop.DBus.Properties";
const DEVICE_IFACE   = "org.bluez.Device1";
const BATTERY_IFACE  = "org.bluez.Battery1";
const CALL_TIMEOUT   = 5000; // ms

export class BluetoothWatcher {
  constructor(settings) {
    this._settings = settings;
    this._devices = new Map(); // objectPath → { name, icon, connected, battery }
    this._sigIds = [];
    this._onChanged = null;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  start(onChanged) {
    this._onChanged = onChanged;

    // PropertiesChanged: Connected / Name toggled, or battery updated
    this._sigIds.push(
      Gio.DBus.system.signal_subscribe(
        BLUEZ_BUS,
        PROPS_IFACE,
        "PropertiesChanged",
        null,
        null,
        Gio.DBusSignalFlags.NONE,
        (_c, _s, path, _i, _sig, params) => {
          if (!this._devices) return;
          try {
            const [iface, changed] = params.deepUnpack();
            if (iface === DEVICE_IFACE) {
              this._applyDeviceProps(path, changed);
            } else if (iface === BATTERY_IFACE) {
              const pct = changed["Percentage"]?.unpack();
              if (pct !== undefined) this._applyBattery(path, pct);
            }
          } catch (_e) {}
        },
      ),
    );

    // InterfacesAdded: new device appeared
    this._sigIds.push(
      Gio.DBus.system.signal_subscribe(
        BLUEZ_BUS,
        OBJ_MGR_IFACE,
        "InterfacesAdded",
        "/",
        null,
        Gio.DBusSignalFlags.NONE,
        (_c, _s, _p, _i, _sig, params) => {
          if (!this._devices) return;
          try {
            const [path, ifaces] = params.deepUnpack();
            if (DEVICE_IFACE in ifaces)
              this._addDevice(path, ifaces[DEVICE_IFACE], ifaces[BATTERY_IFACE]);
          } catch (_e) {}
        },
      ),
    );

    // InterfacesRemoved: device unpaired / adapter removed
    this._sigIds.push(
      Gio.DBus.system.signal_subscribe(
        BLUEZ_BUS,
        OBJ_MGR_IFACE,
        "InterfacesRemoved",
        "/",
        null,
        Gio.DBusSignalFlags.NONE,
        (_c, _s, _p, _i, _sig, params) => {
          if (!this._devices) return;
          try {
            const [path, removedIfaces] = params.deepUnpack();
            if (
              Array.isArray(removedIfaces) &&
              removedIfaces.includes(DEVICE_IFACE)
            ) {
              this._devices.delete(path);
              this._emit();
            }
          } catch (_e) {}
        },
      ),
    );

    // Initial enumeration
    Gio.DBus.system.call(
      BLUEZ_BUS,
      "/",
      OBJ_MGR_IFACE,
      "GetManagedObjects",
      null,
      new GLib.VariantType("(a{oa{sa{sv}}})"),
      Gio.DBusCallFlags.NONE,
      CALL_TIMEOUT,
      null,
      (conn, res) => {
        if (!this._devices) return;
        try {
          // deepUnpack() on (a{oa{sa{sv}}}) returns a JS Array (the tuple).
          // The first element is the objects dict — destructure with [objects],
          // NOT [[objects]], which would try to iterate a plain JS Object.
          const [objects] = conn.call_finish(res).deepUnpack();
          for (const [path, ifaces] of Object.entries(objects)) {
            if (DEVICE_IFACE in ifaces)
              this._addDevice(path, ifaces[DEVICE_IFACE], ifaces[BATTERY_IFACE]);
          }
        } catch (e) {
          console.debug("DynamicIsland/Bluetooth: BlueZ unavailable:", e.message);
        }
      },
    );
  }

  getConnected() {
    if (!this._devices) return [];
    return [...this._devices.values()].filter((d) => d.connected);
  }

  destroy() {
    for (const id of this._sigIds) Gio.DBus.system.signal_unsubscribe(id);
    this._sigIds = [];
    this._devices = null;
    this._onChanged = null;
    this._settings = null;
  }

  // ── Private ───────────────────────────────────────────────────────────────

  _addDevice(path, deviceProps, batteryProps) {
    const connected = deviceProps["Connected"]?.unpack() ?? false;
    const name =
      deviceProps["Name"]?.unpack() ??
      deviceProps["Address"]?.unpack() ??
      "Device";
    const icon    = deviceProps["Icon"]?.unpack() ?? "";
    const battery = batteryProps?.["Percentage"]?.unpack() ?? null;

    this._devices.set(path, { connected, name, icon, battery });

    if (connected) {
      // Debounce by 250 ms — lets the battery PropertiesChanged event arrive
      // before we emit, preventing a "name-only → name+battery%" flicker.
      GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
        if (this._devices) this._emit();
        return GLib.SOURCE_REMOVE;
      });
    }
  }

  _applyDeviceProps(path, changed) {
    const dev = this._devices.get(path);
    if (!dev) return;

    let dirty = false;
    if ("Connected" in changed) { dev.connected = changed["Connected"].unpack(); dirty = true; }
    if ("Name"      in changed) { dev.name      = changed["Name"].unpack();      dirty = true; }

    if (dirty) this._emit();
  }

  _applyBattery(path, pct) {
    const dev = this._devices.get(path);
    if (!dev) return;
    dev.battery = pct;
    if (dev.connected) this._emit();
  }

  _emit() {
    this._onChanged?.(this.getConnected());
  }
}
