/**
 * Centralized sync-status derivation.
 *
 * Apps display "what's happening with the recordings on the device right now"
 * in multiple places — sync banners, pending-recordings rows, recording detail
 * pages, list-item subtitles. Without a shared rule set every screen tends to
 * compute its own label from raw inputs, leading to screens that disagree
 * (one shows "Bluetooth syncing", another shows "4G uploading").
 *
 * This module owns the *rules* (pure function over a typed input shape). Apps
 * own the *subscription* (a thin hook that reads from whatever stores/queries
 * they use and calls `deriveSyncStatus`). The label text returned here is the
 * canonical surface — every consumer should read `label` / `shortLabel`
 * verbatim rather than re-deriving from `kind`/`channel`.
 *
 * Precedence policy (when multiple signals are true simultaneously):
 *   1. Live recording — if the device is actively recording AND streaming is
 *      enabled, show "Streaming via <channel>" regardless of pending uploads.
 *   2. Actual device transport — if `device.syncActive` is set and a radio
 *      (WiFi / 4G) is up, the label reflects *that* transport, even if the
 *      app initiated the sync via BLE. This matches what bytes are actually
 *      moving and avoids the smart-sync handoff flicker where the app's
 *      "BLE pull" state lags the device's "4G upload" reality.
 *   3. App-driven BLE pull — `appDriving.active` (e.g. the consumer's
 *      `useSyncAllRecordings` global) shows as "Bluetooth syncing N/M".
 *   4. Device claims sync but no radio is up — `'waiting_channel'`, best-guess
 *      channel from `wifiAttempting` / `lteAttempting`.
 *   5. Otherwise — `'idle'`.
 */

export type SyncKind =
  | 'idle'
  | 'ble_pull'
  | 'wifi_upload'
  | 'lte_upload'
  | 'streaming'
  | 'waiting_channel';

export type SyncChannel = 'Bluetooth' | 'WiFi' | '4G';

/**
 * Inputs to `deriveSyncStatus`. Every field is what the *consumer app* already
 * has on hand — the SDK does not subscribe to any state itself.
 *
 * `appDriving` — populated from the consumer's app-level sync state (e.g. the
 *   global `isSyncing` + `syncAllProgress` exposed by their `useSyncAll*`
 *   hook). Set `active: false` if the app isn't currently pulling.
 *
 * `device` — flags reported by the device. For BLE-connected devices these
 *   come from `BotaClient.devices.on('statusUpdate', ...)`. For backend-only
 *   visibility (no BLE) they come from the heartbeat-derived state on the
 *   server, merged at the app layer.
 *
 * `bleConnected` — whether the app currently has a live BLE link to this
 *   device. Used to disambiguate `'ble_pull'` from `'4g/wifi_upload'`.
 */
export interface SyncStatusInputs {
  appDriving: {
    /** True while the consumer's sync flow is actively pulling via BLE. */
    active: boolean;
    /** 1-indexed current item. Undefined if not tracking per-item progress. */
    currentIndex?: number;
    /** Total items being synced. Undefined if unknown. */
    total?: number;
  };
  device: {
    /** Device's own sync-active flag (bit 5 of the firmware status flags). */
    syncActive: boolean;
    /** Device is currently recording. */
    isRecording: boolean;
    /** Device has a usable WiFi connection. */
    wifiConnected: boolean;
    /** Device has a usable LTE/4G connection. */
    lteConnected: boolean;
    /** Device's WiFi radio is powered up and trying (connecting / scanning). */
    wifiAttempting: boolean;
    /** Device's LTE radio is powered up and trying (registered / searching). */
    lteAttempting: boolean;
    /** Streaming upload mode is enabled on the device. */
    streamingEnabled: boolean;
    /**
     * Device's upload-channel preference order (highest priority first), e.g.
     * `['wifi', 'ble', 'cellular']`. When provided, the streaming channel is
     * resolved by walking this list and picking the first channel that is both
     * enabled (`enabledConnections`) and currently up — so a device whose LTE
     * radio is connected but whose preference ranks BLE higher (or has cellular
     * disabled) is correctly shown as streaming via Bluetooth, not 4G.
     * Omit to fall back to the legacy "first connected radio wins" heuristic.
     */
    uploadPreference?: Array<'wifi' | 'ble' | 'cellular'>;
    /** Which upload channels are enabled on the device. */
    enabledConnections?: { wifi: boolean; cellular: boolean };
  };
  /** BLE link to the device is currently up. */
  bleConnected: boolean;
}

/**
 * Resolve the channel a live stream is actually using. When the device's upload
 * preference + enabled-connection flags are known, walk the preference order and
 * pick the first channel that is enabled AND up (BLE is always available while
 * the link is live) — this matches the firmware/app channel-selection rule. When
 * those inputs are absent, fall back to "first connected radio wins".
 */
function resolveStreamingChannel(device: SyncStatusInputs['device']): SyncChannel {
  const { wifiConnected, lteConnected, uploadPreference, enabledConnections } = device;

  if (uploadPreference && enabledConnections) {
    for (const channel of uploadPreference) {
      if (channel === 'ble') return 'Bluetooth';
      if (channel === 'wifi' && enabledConnections.wifi && wifiConnected) return 'WiFi';
      if (channel === 'cellular' && enabledConnections.cellular && lteConnected) return '4G';
    }
    return 'Bluetooth';
  }

  return wifiConnected ? 'WiFi' : lteConnected ? '4G' : 'Bluetooth';
}

export interface SyncStatus {
  kind: SyncKind;
  /** Resolved channel ('Bluetooth' / 'WiFi' / '4G'), absent for idle. */
  channel?: SyncChannel;
  /** 1-indexed current item, if known. */
  currentIndex?: number;
  /** Total items, if known. */
  total?: number;
  /**
   * Full label suitable for banners. Examples:
   *   "Syncing 2/5 via Bluetooth..."
   *   "Uploading 1/3 via 4G..."
   *   "Streaming via WiFi"
   *   "Waiting for upload channel..."
   *   "" (when kind === 'idle')
   */
  label: string;
  /**
   * Compact label for tight UI (table rows, badges). Examples:
   *   "Bluetooth syncing 2/5"
   *   "4G uploading 1/3"
   *   "Streaming"
   *   "" (when kind === 'idle')
   */
  shortLabel: string;
}

const IDLE: SyncStatus = { kind: 'idle', label: '', shortLabel: '' };

function progressFraction(currentIndex?: number, total?: number): string {
  if (currentIndex == null || total == null || total <= 0) return '';
  return ` ${Math.min(currentIndex, total)}/${total}`;
}

/**
 * Pure derivation: given a snapshot of app + device + link state, return the
 * single canonical `SyncStatus`. Safe to call on every render (no I/O, no
 * allocations beyond the return value and label strings).
 */
export function deriveSyncStatus(inputs: SyncStatusInputs): SyncStatus {
  const { appDriving, device, bleConnected } = inputs;

  // 1. Live streaming wins — the user is recording right now and bytes are
  //    flowing as they're captured, not from queued files.
  if (device.isRecording && device.streamingEnabled) {
    const channel = resolveStreamingChannel(device);
    return {
      kind: 'streaming',
      channel,
      label: `Streaming via ${channel}`,
      shortLabel: `Streaming (${channel})`,
    };
  }

  // 2. Device says it's syncing AND a radio is up — trust the device's own
  //    transport. This wins over `appDriving` so smart-sync handoff (BLE
  //    trigger → device 4G upload) doesn't flicker on the label.
  if (device.syncActive && device.wifiConnected) {
    const frac = progressFraction(appDriving.currentIndex, appDriving.total);
    return {
      kind: 'wifi_upload',
      channel: 'WiFi',
      currentIndex: appDriving.currentIndex,
      total: appDriving.total,
      label: `Uploading${frac} via WiFi...`,
      shortLabel: `WiFi uploading${frac}`,
    };
  }
  if (device.syncActive && device.lteConnected && !bleConnected) {
    // When BLE is up the app is in control — see rule 3 — so we let
    // `appDriving` take over if it's active even though LTE is also flagged.
    const frac = progressFraction(appDriving.currentIndex, appDriving.total);
    return {
      kind: 'lte_upload',
      channel: '4G',
      currentIndex: appDriving.currentIndex,
      total: appDriving.total,
      label: `Uploading${frac} via 4G...`,
      shortLabel: `4G uploading${frac}`,
    };
  }

  // 3. App-driven BLE pull.
  if (appDriving.active) {
    const frac = progressFraction(appDriving.currentIndex, appDriving.total);
    return {
      kind: 'ble_pull',
      channel: 'Bluetooth',
      currentIndex: appDriving.currentIndex,
      total: appDriving.total,
      label: `Syncing${frac} via Bluetooth...`,
      shortLabel: `Bluetooth syncing${frac}`,
    };
  }

  // 4. Device says it's syncing but no radio is up yet — typically a 4G
  //    cold-start (PDP attach in progress) or WiFi reconnect.
  if (device.syncActive) {
    const guess: SyncChannel | undefined = device.wifiAttempting
      ? 'WiFi'
      : device.lteAttempting
      ? '4G'
      : undefined;
    if (guess) {
      const frac = progressFraction(appDriving.currentIndex, appDriving.total);
      return {
        kind: 'waiting_channel',
        channel: guess,
        currentIndex: appDriving.currentIndex,
        total: appDriving.total,
        label: `Uploading${frac} via ${guess}...`,
        shortLabel: `${guess} uploading${frac}`,
      };
    }
    return {
      kind: 'waiting_channel',
      label: 'Waiting for upload channel...',
      shortLabel: 'Waiting for channel',
    };
  }

  // 5. Idle.
  return IDLE;
}
