/**
 * DeviceStateCache — last-known-good device state, keyed by serial number.
 *
 * Why this exists
 * ───────────────
 * Every consumer screen that displays a BLE-sourced field (the WiFi SSID, the
 * scanned network list, battery, storage, …) hit the same shape of bug: local
 * `useState` lost the value on unmount, the next mount kicked off a fresh BLE
 * read that took 200-800 ms, and the UI flashed empty in between. Each consumer
 * built its own per-screen cache with subtly different rules (clobber-on-
 * `undefined` was the recurring bug), so the SDK is the natural place to hold
 * one shared snapshot per device.
 *
 * Semantics
 * ─────────
 *   • In-memory only. Consumers persist what they care about themselves.
 *   • Keyed by serial number — the only stable identity across iOS UUID
 *     rotations and reconnects. (Peripheral IDs are not stable.)
 *   • Field-level partial updates with conservative merge rules:
 *       – `undefined` field on the patch → preserve the cached value
 *         (the BLE read came back without info on that field)
 *       – `null`      field on the patch → explicit clear
 *         (e.g. user forgot WiFi network → SSID is gone)
 *       – present     value             → overwrite
 *   • `clear(sn)` wipes one device (call on unpair/factory reset).
 *   • `clearAll()` wipes everything (call on logout / SDK destroy).
 *
 * What's NOT in scope
 * ───────────────────
 *   • Persistence — consumers serialize the snapshot to their preferred store
 *     (SecureStore, Keychain, AsyncStorage, in-memory). Hydrate on app launch
 *     by calling the regular update() with the persisted patch.
 *   • TTL — staleness is implicit in connection state. A disconnect doesn't
 *     auto-clear the cache; the cached value is the last-known-good. Consumers
 *     who want stricter freshness call `clear(sn)` on `deviceDisconnected`.
 *   • Authoritativeness — every fresh BLE read or subscribe-notify lands here
 *     and supersedes whatever was cached.
 */

import EventEmitter from 'eventemitter3';

import type { WiFiStatusInfo } from '../models/Device';

/**
 * Aggregated last-known-good state for a single device. Fields are optional
 * because they populate as the SDK observes BLE reads and notifications.
 */
export interface CachedDeviceState {
  wifiStatus?: WiFiStatusInfo;
  /** When this snapshot was last touched (ms since epoch). */
  updatedAt: number;
}

/**
 * Patch shape passed to `update()`. Each top-level field is itself a partial
 * (or `null` for explicit clear). Top-level `undefined` = "don't touch."
 */
export interface DeviceStatePatch {
  wifiStatus?: Partial<WiFiStatusInfo> | null;
}

/**
 * Events emitted by DeviceStateCache.
 *
 * `stateChanged` fires after any merge that actually changed the snapshot
 * (no-op patches don't emit). The `patch` is what the caller passed in, so
 * consumers can react to specific field changes without recomputing diffs.
 */
export interface DeviceStateCacheEvents {
  stateChanged: (serialNumber: string, patch: DeviceStatePatch, state: CachedDeviceState) => void;
  cleared: (serialNumber: string) => void;
  clearedAll: () => void;
}

export class DeviceStateCache extends EventEmitter<DeviceStateCacheEvents> {
  private snapshots: Map<string, CachedDeviceState> = new Map();

  /** Synchronous read. Returns `null` if nothing has been observed for this SN. */
  get(serialNumber: string): CachedDeviceState | null {
    return this.snapshots.get(serialNumber) ?? null;
  }

  /** Synchronous WiFi-only read — the most common consumer call. */
  getWifi(serialNumber: string): WiFiStatusInfo | null {
    return this.snapshots.get(serialNumber)?.wifiStatus ?? null;
  }

  /**
   * Merge a partial update into the cached snapshot for this SN. Emits
   * `stateChanged` if (and only if) the merge produced an observable change.
   */
  update(serialNumber: string, patch: DeviceStatePatch): void {
    const prev = this.snapshots.get(serialNumber);
    let next: CachedDeviceState = prev ?? { updatedAt: 0 };
    let changed = false;

    if ('wifiStatus' in patch) {
      const wifiPatch = patch.wifiStatus;
      if (wifiPatch === null) {
        if (next.wifiStatus !== undefined) {
          next = { ...next, wifiStatus: undefined };
          changed = true;
        }
      } else if (wifiPatch !== undefined) {
        const merged = mergeWifi(next.wifiStatus, wifiPatch);
        if (merged !== next.wifiStatus) {
          next = { ...next, wifiStatus: merged };
          changed = true;
        }
      }
    }

    if (!changed) return;

    next = { ...next, updatedAt: Date.now() };
    this.snapshots.set(serialNumber, next);
    this.emit('stateChanged', serialNumber, patch, next);
  }

  /** Forget one device — call on unpair, factory reset. */
  clear(serialNumber: string): void {
    if (this.snapshots.delete(serialNumber)) {
      this.emit('cleared', serialNumber);
    }
  }

  /** Forget everything — call on logout, SDK destroy. */
  clearAll(): void {
    if (this.snapshots.size === 0) return;
    this.snapshots.clear();
    this.emit('clearedAll');
  }

  /** Inspection helper (for tests / debug menus). */
  serialNumbers(): string[] {
    return Array.from(this.snapshots.keys());
  }
}

/**
 * Field-level merge for the WiFi sub-record. `undefined` in the patch means
 * "no information" → keep the prior value (this is the contract that bit
 * every consumer who naively did `{ ...prev, ...patch }`). Returns the same
 * reference when nothing changed so the caller can skip emitting.
 *
 * Per-field clear (e.g. "device forgot the network — drop the SSID alone")
 * happens at the outer `update()` level, not through a per-field `null`:
 * the WiFiStatusInfo type doesn't permit `null` on its fields, and a
 * status='disconnected' patch is the right shape to express that change.
 * To wipe the whole WiFi sub-record, pass `wifiStatus: null` at the
 * DeviceStatePatch level.
 */
function mergeWifi(
  prev: WiFiStatusInfo | undefined,
  patch: Partial<WiFiStatusInfo>
): WiFiStatusInfo | undefined {
  if (!prev) {
    return {
      status: patch.status ?? 'idle',
      ssid: patch.ssid,
      signalStrength: patch.signalStrength,
      lastError: patch.lastError,
    };
  }

  let changed = false;
  const next: WiFiStatusInfo = { ...prev };

  if (patch.status !== undefined && patch.status !== prev.status) {
    next.status = patch.status;
    changed = true;
  }
  if (patch.ssid !== undefined && patch.ssid !== prev.ssid) {
    next.ssid = patch.ssid;
    changed = true;
  }
  if (patch.signalStrength !== undefined && patch.signalStrength !== prev.signalStrength) {
    next.signalStrength = patch.signalStrength;
    changed = true;
  }
  if (patch.lastError !== undefined && patch.lastError !== prev.lastError) {
    next.lastError = patch.lastError;
    changed = true;
  }

  return changed ? next : prev;
}
