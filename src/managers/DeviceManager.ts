/**
 * Device Manager - Handles device discovery, connection, and provisioning
 */

import { Buffer } from 'buffer';
import { State, Subscription } from 'react-native-ble-plx';
import EventEmitter from 'eventemitter3';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { getBleManager, BleManager, type RadioPriority } from '../ble/BleManager';
import {
  SERVICE_DEVICE_INFO,
  SERVICE_BOTA_PROVISIONING,
  SERVICE_BOTA_CONTROL,
  SERVICE_BOTA_AUTH,
  SERVICE_BOTA_WIFI_CONFIG,
  CHAR_SERIAL_NUMBER,
  CHAR_FIRMWARE_REVISION,
  CHAR_HARDWARE_REVISION,
  CHAR_PAIRING_STATE,
  CHAR_DEVICE_TOKEN,
  CHAR_API_ENDPOINT,
  CHAR_BACKEND_PUBKEY,
  CHAR_DEVICE_CERT,
  CHAR_PROVISIONING_RESULT,
  CHAR_DEVICE_STATUS,
  CHAR_RECORDING_CONTROL,
  CHAR_RECORDING_STATUS,
  CHAR_TIME_SYNC,
  CHAR_WIFI_GRANT,
  CHAR_WIFI_CREDENTIAL,
  CHAR_WIFI_STATUS,
  API_ENDPOINT_DEV,
  API_ENDPOINT_PROD,
  API_ENDPOINT_GAMMA,
  PROVISIONING_SUCCESS,
  PROVISIONING_INVALID_TOKEN,
  PROVISIONING_STORAGE_ERROR,
  PROVISIONING_CHUNK_ERROR,
  PROVISIONING_ALREADY_PAIRED,
  OPERATION_TIMEOUT,
  RECORDING_CMD_GRANT_START,
  RECORDING_CMD_GRANT_STOP,
  RECORDING_RESULT_SUCCESS,
  RECORDING_RESULT_ALREADY_RECORDING,
  RECORDING_RESULT_NOT_RECORDING,
  RECORDING_RESULT_INVALID_GRANT,
  RECORDING_RESULT_GRANT_EXPIRED,
  RECORDING_RESULT_INVALID_STATE,
  CHAR_DEVICE_COMMAND,
  DEVICE_CMD_FACTORY_RESET,
  CHAR_WIFI_SCAN,
  CHAR_DEVICE_SETTINGS,
  CHAR_PK_D,
  CHAR_AUTH_NONCE,
  CHAR_DEVICE_LOG_CONTROL,
  CHAR_DEVICE_LOG_DATA,
  SERVICE_BOTA_DIAGNOSTICS,
  DEVICE_LOG_CMD_START,
  DEVICE_LOG_CMD_STOP,
  WIFI_SCAN_TIMEOUT,
  DEVICE_CMD_BLE_DEPROVISION,
  DEVICE_CMD_BLE_FACTORY_RESET,
  DEVICE_CMD_BLE_FACTORY_RESET_RESULT_ACK,
} from '../ble/constants';
import {
  parsePairingState,
  parseDeviceStatus,
  createTimeSyncData,
  parseWiFiStatusInfo,
  parseWiFiConfigResult,
  createWiFiGrantPacket,
  createWiFiScanCommand,
  parseWiFiScanResult,
  serializeConnectionSettings,
  parseConnectionSettings,
} from '../ble/parsers';
import type {
  DiscoveredDevice,
  ConnectedDevice,
  DeviceType,
  DeviceStatus,
  ScanOptions,
  ReconnectOptions,
  Environment,
  ProvisioningResult,
  BleFactoryResetResult,
  BleFactoryResetResultPersister,
  RecordingState,
  // RecordingCommand, // TODO: Re-enable when used
  StartRecordingOptions,
  StopRecordingOptions,
  WiFiConfigGrant,
  WiFiCredentials,
  WiFiConfigResult,
  WiFiStatusInfo,
  DeviceWiFiScanResult,
  DeviceConnectionSettings,
  DeviceLogEvent,
} from '../models/Device';
import type { DeviceManagerEvents } from '../models/Status';
import { DeviceStateCache, type CachedDeviceState } from '../cache/DeviceStateCache';
import { DeviceLogDecoder } from '../ble/deviceLogs';
import {
  DeviceError,
  ProvisioningError,
} from '../utils/errors';
import { logger } from '../utils/logger';
// TODO: Re-enable crypto imports once firmware mbedtls boot crash is resolved
// import { deriveSessionKey, encryptWiFiCredentials, formatWiFiCredentialPacket } from '../utils/crypto';

const log = logger.tag('DeviceManager');

const RECONNECT_REGISTRY_KEY = '@bota_sdk:reconnect_registry';
const DEFAULT_RECONNECT_SCAN_TIMEOUT = 10000; // 10 seconds

/** Stored info for reconnecting to a previously paired device */
interface ReconnectInfo {
  bleId: string;
  bleName: string;
  /** Device BLE MAC from advertisement manufacturer data — the stable, unique,
   *  scan-visible key. Used to identify the exact target during reconnect without
   *  connecting to read its serial (the peripheral UUID rotates on iOS; the SN is
   *  not advertised). Undefined for entries paired before this was stored, or on
   *  firmware that doesn't advertise the MAC. */
  mac?: string;
  deviceType: DeviceType;
  /** Cached from the previous successful connect — used to skip GATT info reads on reconnect. */
  serialNumber?: string;
  firmwareVersion?: string;
  hardwareRevision?: string;
  isProvisioned?: boolean;
  wifiUploadCapable?: boolean;
}

/** Normalize a BLE MAC for stable comparison: lowercase, strip ':'/'-' separators.
 *  Returns undefined for null/empty input so callers can treat "no MAC" uniformly. */
function normalizeMac(mac: string | null | undefined): string | undefined {
  if (!mac) return undefined;
  const norm = mac.toLowerCase().replace(/[:-]/g, '');
  return norm.length > 0 ? norm : undefined;
}

/** Reject if `p` doesn't settle within `ms`. Used to bound the post-connect GATT
 *  reads: right after a firmware-OTA reboot the device's link comes up but its
 *  GATT server can still stall a characteristic read indefinitely (react-native-ble-plx
 *  reads have no built-in timeout). Without this the whole connect() hangs and the
 *  auto-reconnect loop never completes — the device shows connected at the link
 *  layer but the SDK never emits `deviceConnected`. On timeout we throw so the
 *  attempt fails fast and the loop retries when the GATT is ready. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

/** Timeout for the post-connect device-info GATT reads (see {@link withTimeout}). */
const POST_CONNECT_READ_TIMEOUT_MS = 8000;

/**
 * Async fetcher invoked by {@link DeviceManager.requestStartRecording} and
 * {@link DeviceManager.requestStopRecording} when called with the fetcher
 * shape (instead of a pre-fetched grant blob). The SDK reads the device's
 * P6 session nonce, then calls this with the nonce so the caller can bind
 * the backend-issued grant to the current BLE session.
 *
 * @param nonce_d 16-byte hex session nonce, or null on pre-P6 firmware.
 * @returns Base64-encoded 171-byte HPKE grant blob.
 */
export type RecordingGrantFetcher = (nonce_d: string | null) => Promise<string>;

/** Options for {@link DeviceManager.provision}. */
export interface ProvisionOptions {
  /**
   * Optional fetcher invoked when the device rejects the token write with
   * ALREADY_PAIRED — the device is still paired with a stale token from a
   * previous owner. The fetcher should call the backend's deprovision-grant
   * endpoint (e.g. POST /devices/{id}/grant with scope=deprovision) and
   * return the base64 grant blob. The SDK then performs an opcode-0x05 BLE
   * deprovision (no reboot) and retries the token write on the same connection.
   *
   * @param nonce_d Hex-encoded P6 session nonce read from the device, or null
   *   on pre-P6 firmware. Pass through to the backend so it can bind the grant
   *   to the current BLE session.
   */
  fetchDeprovisionGrant?: (nonce_d: string | null) => Promise<string>;
}

/**
 * Device Manager class
 */
export class DeviceManager extends EventEmitter<DeviceManagerEvents> {
  private bleManager: BleManager;
  private connectedDevices: Map<string, ConnectedDevice> = new Map();
  private statusSubscriptions: Map<string, Subscription> = new Map();
  private nonceSubscriptions: Map<string, Subscription> = new Map();
  private deviceLogSubscriptions: Map<string, Subscription> = new Map();
  private deviceLogDecoders: Map<string, DeviceLogDecoder> = new Map();
  // Cache of P6 session nonce per device (received via notify on connect, cleared on disconnect)
  private nonceCache: Map<string, string> = new Map();
  private reconnectRegistry: Record<string, ReconnectInfo> = {};
  // Serializes reconnect attempts. Multiple SNs can be reconnecting at once
  // (auto-reconnect loop + app-driven calls); without this they all scan and
  // probe the single shared BLE adapter concurrently and race each other's
  // results.
  private reconnectChain: Promise<unknown> = Promise.resolve();
  // Dedup concurrent reconnect() calls for the same SN (e.g. the 3s auto-reconnect
  // loop firing again before the previous attempt settles) so they don't stack
  // up behind the serialize lock.
  private reconnectInFlight: Map<string, Promise<ConnectedDevice>> = new Map();
  // Cache of last known recording state per device (populated from status notifications)
  private recordingStateCache: Map<string, RecordingState> = new Map();

  /**
   * Last-known-good device state keyed by serial number. Fed by every
   * BLE-sourced read or subscribe-notify in this class. Consumers query it
   * synchronously to render UI without waiting on a fresh BLE round-trip.
   *
   * See `cache/DeviceStateCache.ts` for the merge semantics. The SDK does
   * NOT persist this — consumers serialize what they need themselves and
   * rehydrate by calling `update()` on launch.
   */
  private stateCache: DeviceStateCache = new DeviceStateCache();
  // Pending promise set while a recording command is in-flight — bridges the race where
  // the Bluetooth heartbeat arrives before the recording status notification.
  private recordingStatePending: Map<string, Promise<RecordingState>> = new Map();
  private isInitialized = false;

  // Auto-reconnect state
  private autoReconnectEnabled = false;
  private autoReconnectSerial: string | null = null;
  private autoReconnectTimer: ReturnType<typeof setInterval> | null = null;
  private autoReconnectAttempting = false;
  private userDisconnected = false;

  constructor() {
    super();
    this.bleManager = getBleManager();
    this.setupBleListeners();
  }

  /**
   * Initialize the device manager
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }
    await this.loadReconnectRegistry();
    this.isInitialized = true;
    log.info('DeviceManager initialized');
  }

  /**
   * Set up Bluetooth event listeners
   */
  private setupBleListeners(): void {
    this.bleManager.on('deviceDiscovered', (device) => {
      this.emit('deviceDiscovered', device);
    });

    this.bleManager.on('deviceConnected', (deviceId) => {
      const device = this.connectedDevices.get(deviceId);
      if (device) {
        this.emit('deviceConnected', device);
      }
    });

    this.bleManager.on('deviceDisconnected', (deviceId, error) => {
      const device = this.connectedDevices.get(deviceId);
      if (device) {
        // Update connection state
        device.connectionState = 'disconnected';
      }
      this.connectedDevices.delete(deviceId);
      this.recordingStateCache.delete(deviceId);
      this.nonceCache.delete(deviceId);

      // Clean up status and nonce subscriptions
      this.statusSubscriptions.get(deviceId)?.remove();
      this.statusSubscriptions.delete(deviceId);
      this.nonceSubscriptions.get(deviceId)?.remove();
      this.nonceSubscriptions.delete(deviceId);
      this.removeDeviceLogSubscription(deviceId);

      this.emit('deviceDisconnected', deviceId, error);

      // Start auto-reconnect if enabled and not user-initiated
      if (this.autoReconnectEnabled && !this.userDisconnected) {
        this.startAutoReconnectLoop();
      }
    });

    // Auto-reconnect when Bluetooth powers back on
    let prevState: State = State.Unknown;
    this.bleManager.on('stateChange', (state) => {
      if (state === State.PoweredOn && prevState !== State.PoweredOn) {
        log.info('Bluetooth powered on — emitting bluetoothReady');
        this.emit('bluetoothReady');
        // Trigger auto-reconnect
        if (this.autoReconnectEnabled && this.autoReconnectSerial && !this.userDisconnected) {
          this.startAutoReconnectLoop();
        }
      }
      prevState = state;
    });
  }

  /**
   * Start scanning for Bota devices
   */
  async startScan(options: ScanOptions = {}): Promise<void> {
    log.info('Starting device scan', options as Record<string, unknown>);
    this.emit('scanStarted');

    try {
      await this.bleManager.startScan(options);
    } catch (error) {
      this.emit('scanError', error as Error);
      throw error;
    }
  }

  /**
   * Stop scanning for devices
   */
  stopScan(): void {
    log.info('Stopping device scan');
    this.bleManager.stopScan();
    this.emit('scanStopped');
  }

  /**
   * Get list of discovered devices
   */
  getDiscoveredDevices(): DiscoveredDevice[] {
    return this.bleManager.getDiscoveredDevices();
  }

  /**
   * Get list of connected devices
   */
  getConnectedDevices(): ConnectedDevice[] {
    return Array.from(this.connectedDevices.values());
  }

  /**
   * Map of `serialNumber → last-known BLE peripheral id` from the reconnect
   * registry (populated whenever a device connects). Lets callers classify a
   * scanned device as already-known without reading its serial over GATT — the
   * serial is never advertised, but the peripheral id is in every scan result.
   *
   * Caveat: iOS peripheral ids rotate occasionally and reset on app reinstall,
   * so a stale/missing entry just means a known device is briefly seen as new.
   * Pair this with a MAC-address match (stable across installs) for best
   * coverage.
   */
  getKnownBleIds(): Record<string, string> {
    const map: Record<string, string> = {};
    for (const [serialNumber, info] of Object.entries(this.reconnectRegistry)) {
      if (info?.bleId) map[serialNumber] = info.bleId;
    }
    return map;
  }

  /**
   * Reverse-lookup the reconnect-registry serial number for a peripheral id.
   * Used by {@link connect} to detect the "we've seen this device before"
   * case and skip the device-info GATT reads.
   */
  private findReconnectEntryByBleId(bleId: string): string | undefined {
    for (const [sn, info] of Object.entries(this.reconnectRegistry)) {
      if (info?.bleId === bleId) return sn;
    }
    return undefined;
  }

  /**
   * Connect to a discovered device.
   *
   * @param priority `user` (default) for pairing/manual connect; `background`
   *   when called from the reconnect path so it yields to user operations.
   */
  async connect(
    device: DiscoveredDevice,
    priority: RadioPriority = 'user'
  ): Promise<ConnectedDevice> {
    log.info('Connecting to device', { deviceId: device.id, name: device.name });

    // Background reconnect may reuse an existing connected entry. User
    // pairing/manual connect must re-read identity from GATT even when the BLE
    // link is already up, because the cached entry may belong to a stale iOS
    // peripheral-id mapping.
    const existing = this.connectedDevices.get(device.id);
    if (priority === 'background' && existing && existing.connectionState === 'connected') {
      log.debug('Device already connected', { deviceId: device.id });
      return existing;
    }

    // Emit connecting state
    this.emit('connectionStateChanged', device.id, 'connecting');

    // For a user-initiated pair/manual connect, hold the "user op in flight"
    // state across the WHOLE transaction (connect + the device-info reads
    // below), not just the connect op. Otherwise the background auto-reconnect
    // loop slips in between the connect and the first read, probes this very
    // peripheral, and — on an SN mismatch against a stale reconnect target —
    // disconnects the link mid-pair (observed as a 2A26/2A27-read disconnect).
    // Background reconnect calls (priority 'background') must NOT take the span:
    // they are the work that should yield.
    const endUserTxn =
      priority === 'user' ? this.bleManager.beginUserTransaction() : undefined;

    try {
      // Connect via Bluetooth manager
      await this.bleManager.connect(device.id, priority);

      // Background reconnects may use cached info for speed. User-initiated
      // pairing/manual connects must refresh identity from GATT: iOS can
      // surface system-connected peripherals without MAC/manufacturer data,
      // and a stale BLE-id registry entry must not pair one device's serial
      // with another device's public key.
      const cachedSN = priority === 'background' ? this.findReconnectEntryByBleId(device.id) : undefined;
      const cached = cachedSN ? this.reconnectRegistry[cachedSN] : undefined;

      let serialNumber: string;
      let firmwareVersion: string;
      let hardwareRevision: string | undefined;
      let isProvisioned: boolean;
      let hasWifiService: boolean;
      let mtu: number;

      if (cached?.serialNumber) {
        // Reconnect fast-path: skip the GATT reads for fields that don't
        // change between connects (serial, hardware revision, WiFi
        // capability — all firmware-build-dependent or physical). Still
        // read firmware version fresh: after an OTA, the device reboots
        // with a new version and the cached value would be stale.
        // pairingState comes from the advertisement (scan-time), already
        // fresh, no GATT read needed. MTU is per-connection — fresh.
        const [fv, m] = await withTimeout(
          Promise.all([
            this.readFirmwareVersion(device.id),
            this.bleManager.getMtu(device.id),
          ]),
          POST_CONNECT_READ_TIMEOUT_MS,
          'reconnect device-info reads',
        );
        serialNumber = cached.serialNumber;
        firmwareVersion = fv;
        hardwareRevision = cached.hardwareRevision;
        isProvisioned = device.pairingState === 'paired';
        hasWifiService = cached.wifiUploadCapable ?? false;
        mtu = m;
        log.info('Reconnect fast-path: using cached device info', {
          deviceId: device.id,
          serialNumber,
          firmwareVersion,
        });
      } else {
        // First-ever connect (or pre-cache-schema entry): do the full 6 reads.
        // Sequential rather than parallel — we want the radio free for the
        // user's first action; the parallel block was a critical-path
        // optimisation that no longer applies once we're off the critical
        // path. We still keep this path on first connect because we need a
        // serial number as the registry key.
        const [
          sn,
          fv,
          hr,
          ps,
          m,
          hw,
        ] = await withTimeout(
          Promise.all([
            this.readSerialNumber(device.id),
            this.readFirmwareVersion(device.id),
            this.readHardwareRevision(device.id),
            this.readPairingState(device.id),
            this.bleManager.getMtu(device.id),
            this.bleManager.hasService(device.id, SERVICE_BOTA_WIFI_CONFIG),
          ]),
          POST_CONNECT_READ_TIMEOUT_MS,
          'reconnect device-info reads (full)',
        );
        serialNumber = sn;
        firmwareVersion = fv;
        hardwareRevision = hr;
        isProvisioned = ps === 'paired';
        mtu = m;
        hasWifiService = hw;
      }

      const connectedDevice: ConnectedDevice = {
        id: device.id,
        serialNumber,
        deviceType: device.deviceType,
        firmwareVersion,
        hardwareRevision,
        isProvisioned,
        connectionState: 'connected',
        mtu,
        capabilities: {
          bleSync: true,
          wifiUpload: hasWifiService,
          lteUpload: device.deviceType === 'bota_pin_4g',
          remoteRecord: true,
        },
      };

      this.connectedDevices.set(device.id, connectedDevice);
      this.emit('deviceConnected', connectedDevice);

      // Persist reconnect info for future reconnect() calls. Include the
      // cached fields so future reconnects can skip the device-info reads.
      for (const [sn, info] of Object.entries(this.reconnectRegistry)) {
        if (sn !== serialNumber && info?.bleId === device.id) {
          delete this.reconnectRegistry[sn];
        }
      }

      this.reconnectRegistry[serialNumber] = {
        bleId: device.id,
        bleName: device.name,
        mac: normalizeMac(device.macAddress),
        deviceType: device.deviceType,
        serialNumber,
        firmwareVersion,
        hardwareRevision,
        isProvisioned,
        wifiUploadCapable: hasWifiService,
      };
      this.saveReconnectRegistry().catch(() => {});

      log.info('Device connected successfully', {
        deviceId: device.id,
        serialNumber,
        isProvisioned: connectedDevice.isProvisioned,
      });

      // Subscribe to P6 session nonce notifications (CHAR_AUTH_NONCE may be NOTIFY-only).
      // Firmware sends the nonce when the CCC is written (subscription enabled).
      this.subscribeToNonce(device.id);

      this.emit('connectionStateChanged', device.id, 'connected');

      return connectedDevice;
    } catch (error) {
      // The link may be up at the BLE layer but the post-connect GATT reads
      // failed/timed out (common right after an OTA reboot). Tear the half-open
      // link down so the next reconnect attempt does a fresh connect instead of
      // reusing a stalled GATT session and hanging on the same read again.
      try { await this.bleManager.disconnect(device.id, priority); } catch { /* ignore */ }
      this.emit('connectionStateChanged', device.id, 'disconnected');
      throw error;
    } finally {
      endUserTxn?.();
    }
  }

  /**
   * Disconnect from a device (user-initiated)
   */
  async disconnect(device: ConnectedDevice): Promise<void> {
    log.info('Disconnecting from device', { deviceId: device.id });

    this.userDisconnected = true;
    this.stopAutoReconnectLoop();

    this.emit('connectionStateChanged', device.id, 'disconnecting');

    // Clean up status and nonce subscriptions
    this.statusSubscriptions.get(device.id)?.remove();
    this.statusSubscriptions.delete(device.id);
    this.nonceSubscriptions.get(device.id)?.remove();
    this.nonceSubscriptions.delete(device.id);
    this.nonceCache.delete(device.id);
    this.removeDeviceLogSubscription(device.id);

    await this.bleManager.disconnect(device.id);
    this.connectedDevices.delete(device.id);

    this.emit('connectionStateChanged', device.id, 'disconnected');
  }

  // ============================================================================
  // Auto-Reconnect
  // ============================================================================

  /**
   * Enable auto-reconnect for a device by serial number.
   * When enabled, the SDK will automatically attempt to reconnect when:
   * - The device disconnects unexpectedly (out of range, power loss)
   * - Bluetooth is toggled off and back on
   *
   * Auto-reconnect is paused when disconnect() is called (user-initiated).
   * Call enableAutoReconnect() again or reconnect() to resume.
   */
  enableAutoReconnect(serialNumber: string): void {
    this.autoReconnectSerial = serialNumber;
    this.autoReconnectEnabled = true;
    this.userDisconnected = false;
    log.info('Auto-reconnect enabled', { serialNumber });
  }

  /**
   * Disable auto-reconnect
   */
  disableAutoReconnect(): void {
    this.autoReconnectEnabled = false;
    this.autoReconnectSerial = null;
    this.userDisconnected = false;
    this.stopAutoReconnectLoop();
    log.info('Auto-reconnect disabled');
  }

  private startAutoReconnectLoop(): void {
    if (this.autoReconnectTimer || !this.autoReconnectSerial) return;

    log.info('Starting auto-reconnect loop', { serialNumber: this.autoReconnectSerial });
    this.emit('bluetoothReady'); // Signal apps that reconnection is starting

    const attempt = async () => {
      if (!this.autoReconnectEnabled || !this.autoReconnectSerial || this.userDisconnected) {
        this.stopAutoReconnectLoop();
        return;
      }

      // Already connected?
      for (const device of this.connectedDevices.values()) {
        if (device.serialNumber === this.autoReconnectSerial && device.connectionState === 'connected') {
          log.debug('Auto-reconnect: already connected');
          this.stopAutoReconnectLoop();
          return;
        }
      }

      // Bluetooth available?
      if (this.bleManager.getCachedState() !== State.PoweredOn) {
        return; // Wait for next tick
      }

      // Yield to user-initiated radio work (pairing / manual connect). A
      // background reconnect scan+probe here would race the user op on the
      // single adapter and tear down the user's connection mid-handshake.
      if (this.bleManager.isUserOpInFlight()) {
        log.debug('Auto-reconnect: yielding to user-initiated radio op');
        return; // Retry next tick once the user op settles
      }

      if (this.autoReconnectAttempting) return;
      this.autoReconnectAttempting = true;

      const attemptStartedAt = Date.now();
      try {
        log.debug('Auto-reconnect: attempting', { serialNumber: this.autoReconnectSerial });
        await this.reconnect(this.autoReconnectSerial, { scanTimeout: 5000 });
        log.info('Auto-reconnect: success', { totalMs: Date.now() - attemptStartedAt });
        this.stopAutoReconnectLoop();
      } catch {
        log.debug('Auto-reconnect: failed, will retry', { attemptMs: Date.now() - attemptStartedAt });
      } finally {
        this.autoReconnectAttempting = false;
      }
    };

    // Attempt immediately, then retry every 3 seconds
    attempt();
    this.autoReconnectTimer = setInterval(attempt, 3000);
  }

  private stopAutoReconnectLoop(): void {
    if (this.autoReconnectTimer) {
      clearInterval(this.autoReconnectTimer);
      this.autoReconnectTimer = null;
    }
  }

  /**
   * Reconnect to a previously paired device by serial number.
   *
   * The SDK stores the peripheral ID and advertised MAC from the initial pairing
   * when available. This method first matches those scan-visible identities. If
   * they no longer match because the peripheral identity changed, reconnect uses
   * a guarded Bota-candidate serial-number probe.
   *
   * @param serialNumber - Serial number of the device to reconnect to
   * @param options - Optional reconnection options
   * @returns The connected device
   * @throws DeviceError.notFound if no matching device is found during scan
   */
  async reconnect(
    serialNumber: string,
    options?: ReconnectOptions
  ): Promise<ConnectedDevice> {
    // Fast path: already connected — return immediately without taking the lock.
    for (const device of this.connectedDevices.values()) {
      if (device.serialNumber === serialNumber && device.connectionState === 'connected') {
        log.debug('Device already connected', { serialNumber });
        return device;
      }
    }

    // Dedup: an attempt for this SN is already queued/running — share it.
    const existing = this.reconnectInFlight.get(serialNumber);
    if (existing) {
      log.debug('Reconnect already in flight, sharing', { serialNumber });
      return existing;
    }

    // Serialize: chain after any in-flight reconnect so concurrent calls for
    // different SNs don't scan/probe/disconnect over each other on the single
    // shared BLE connection slot.
    const run = this.reconnectChain
      .catch(() => undefined)
      .then(() => this.doReconnect(serialNumber, options));
    this.reconnectChain = run.catch(() => undefined);
    this.reconnectInFlight.set(serialNumber, run);
    run.finally(() => {
      if (this.reconnectInFlight.get(serialNumber) === run) {
        this.reconnectInFlight.delete(serialNumber);
      }
    }).catch(() => undefined);
    return run;
  }

  private async doReconnect(
    serialNumber: string,
    options?: ReconnectOptions
  ): Promise<ConnectedDevice> {
    const scanTimeout = options?.scanTimeout ?? DEFAULT_RECONNECT_SCAN_TIMEOUT;

    log.info('Reconnecting to device', { serialNumber });

    // Re-check after acquiring the lock — a prior queued reconnect may have
    // already connected this SN.
    for (const device of this.connectedDevices.values()) {
      if (device.serialNumber === serialNumber && device.connectionState === 'connected') {
        log.debug('Device already connected', { serialNumber });
        return device;
      }
    }

    // Look up stored reconnect info
    const info = this.reconnectRegistry[serialNumber];
    const storedName = info?.bleName;
    const storedId = info?.bleId;
    const storedMac = info?.mac;

    log.debug('Reconnect info', {
      serialNumber,
      storedName: storedName ?? '(none)',
      storedId: storedId ?? '(none)',
      storedMac: storedMac ?? '(none)',
    });

    // Scan for devices. The scan runs up to `scanTimeout`, but we poll
    // `getDiscoveredDevices()` while it runs and return the moment the target
    // peripheral appears — typical healthy reconnect lands in <1s, no need to
    // wait the full 5s window.
    await this.startScan({ timeout: scanTimeout, allowDuplicates: true });

    const POLL_INTERVAL_MS = 200;
    // Exit the scan poll as soon as the target's scan-visible identity appears:
    // either the stored peripheral UUID or the advertised MAC. We deliberately do
    // not match by BLE name here because all units of the same model advertise the
    // same name.
    const matchesTarget = (d: DiscoveredDevice): boolean => {
      if (storedId && d.id === storedId) return true;
      if (storedMac && normalizeMac(d.macAddress) === storedMac) return true;
      return false;
    };

    const startedAt = Date.now();
    let discovered = this.getDiscoveredDevices();
    while (!discovered.some(matchesTarget) && Date.now() - startedAt < scanTimeout) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      discovered = this.getDiscoveredDevices();
    }

    log.debug('Reconnect scan done', {
      count: discovered.length,
      elapsedMs: Date.now() - startedAt,
      devices: discovered.map((d) => `${d.name}(${d.id})`).join(', '),
    });

    // Stop scan before connecting — on iOS a running scan can cancel the connection
    try { this.stopScan(); } catch { /* ignore */ }

    // Match priority:
    //   1) stored peripheral UUID — fast path, valid until iOS/macOS rotates it.
    //   2) advertised MAC — the stable, unique, scan-visible identity. Lets us pick
    //      the exact target out of several same-model devices and connect to ONLY it,
    //      without connecting to anyone to read a serial number.
    const byId = storedId ? discovered.find((d) => d.id === storedId) : undefined;
    if (byId) {
      log.info('Matched device by stored peripheral ID', { serialNumber, id: byId.id });
      return this.connect(byId, 'background');
    }

    if (storedMac) {
      const byMac = discovered.find((d) => normalizeMac(d.macAddress) === storedMac);
      if (byMac) {
        log.info('Matched device by advertised MAC', { serialNumber, id: byMac.id });
        return this.connect(byMac, 'background');
      }
      log.info('No advertised MAC match; falling back to guarded serial-number probe', {
        serialNumber,
      });
    }

    // If the iOS peripheral id rotates or the local registry is lost after an app
    // reinstall, or its advertised MAC changes after a firmware reset, the serial
    // number is the only remaining stable key, but it is only available through
    // GATT. Keep this fallback guarded so it cannot steal the adapter during user
    // pairing or another foreground radio operation.
    if (this.bleManager.isUserOpInFlight()) {
      log.debug('Reconnect: skipping serial-number probe because user radio work is in flight', {
        serialNumber,
      });
    } else {
      const seen = new Set<string>();
      const candidates = discovered
        .filter((d) => (storedName ? d.name === storedName : d.name?.startsWith('Bota')))
        .filter((d) => {
          if (seen.has(d.id)) return false;
          seen.add(d.id);
          return true;
        })
        .sort((a, b) => b.rssi - a.rssi);

      log.debug('Reconnect: probing Bota candidates by serial number', {
        serialNumber,
        count: candidates.length,
      });

      for (const cand of candidates) {
        if (this.bleManager.isUserOpInFlight()) {
          log.debug('Reconnect: aborting serial-number probe because user radio work started', {
            serialNumber,
          });
          break;
        }

        const sn = await this.probeSerialNumber(cand.id);
        if (sn === serialNumber) {
          log.info('Matched device by serial number', { serialNumber, id: cand.id });
          return this.connect(cand, 'background');
        }
        if (sn !== null && !this.connectedDevices.has(cand.id)) {
          log.debug('Reconnect: candidate SN mismatch, releasing', {
            wanted: serialNumber,
            got: sn,
            id: cand.id,
          });
          try { await this.bleManager.disconnect(cand.id, 'background'); } catch { /* ignore */ }
        }
      }
    }

    // Target wasn't found this round. If we have its stored peripheral id, iOS may
    // be holding a lingering half-connected state for it after a reset (OTA reboot)
    // and suppressing its advertisements to this central — which is exactly why a
    // running app can't reconnect but a fresh app (new central) can. Flush that
    // state so the NEXT scan tick surfaces the peripheral again.
    if (storedId) {
      await this.bleManager.flushPeripheralConnection(storedId);
    }

    log.warn('No matching device found for reconnection', { serialNumber });
    throw DeviceError.notFound(serialNumber);
  }

  /**
   * @deprecated Firmware ≥ P5 rejects the unauthenticated BLE factory-reset opcode (0x01).
   * Use the backend unbind/delete flow instead: `DELETE /v1/projects/{projectId}/devices/{id}`
   * or `POST /v1/projects/{projectId}/devices/{id}/unbind`. The backend emits a `factory_reset`
   * heartbeat command that the device processes over WiFi/4G.
   *
   * This method will fail silently on P5+ firmware (device returns INVALID_TOKEN).
   */
  async factoryReset(device: ConnectedDevice): Promise<void> {
    log.info('Sending factory reset to device', { deviceId: device.id });

    if (!this.isConnected(device.id)) {
      throw DeviceError.notConnected(device.id);
    }

    const resultPromise = this.waitForProvisioningResult(device.id);

    await this.bleManager.writeCharacteristic(
      device.id,
      SERVICE_BOTA_CONTROL,
      CHAR_DEVICE_COMMAND,
      Buffer.from([DEVICE_CMD_FACTORY_RESET])
    );

    try {
      await resultPromise;
    } catch {
      // Timeout is acceptable — device may disconnect before responding
      log.warn('Factory reset result not received (device may have disconnected)');
    }

    log.info('Factory reset sent', { deviceId: device.id });
  }

  /**
   * Check if a device is connected
   */
  isConnected(deviceId: string): boolean {
    return this.bleManager.isConnected(deviceId);
  }

  /**
   * Provision a device with a token
   */
  async provision(
    device: ConnectedDevice,
    deviceToken: string,
    environment: Environment = 'production',
    options?: ProvisionOptions
  ): Promise<void> {
    log.info('Provisioning device', {
      deviceId: device.id,
      environment,
      hasGrantFetcher: !!options?.fetchDeprovisionGrant,
    });

    if (!this.isConnected(device.id)) {
      throw DeviceError.notConnected(device.id);
    }

    try {
      await this.writeProvisioningOnce(device, deviceToken, environment);
    } catch (error) {
      // Auto-recover from ALREADY_PAIRED if a grant fetcher was supplied:
      // device retains a stale token from the previous owner — clear it via
      // grant-gated BLE deprovision (opcode 0x05, no reboot), then retry.
      if (
        error instanceof ProvisioningError &&
        error.code === 'ALREADY_PAIRED' &&
        options?.fetchDeprovisionGrant
      ) {
        log.info('Provision rejected with ALREADY_PAIRED — auto-deprovisioning then retrying', {
          deviceId: device.id,
        });

        const nonce = await this.readAuthNonce(device);
        if (!nonce) {
          log.warn(
            '[NONCE] readAuthNonce returned null — deprovision grant will be issued without nonce binding and the device will likely reject it. ' +
            'Check the [NONCE] read-probe / notify logs above to see what the firmware is actually serving on B07A0005-0002.',
            { deviceId: device.id }
          );
        }
        const grantBlob = await options.fetchDeprovisionGrant(nonce);
        const result = await this.deprovision(device, grantBlob);
        if (!result.success) {
          // The most common cause of invalid_token here is a nonce mismatch:
          // the SDK couldn't read the device's session nonce, so the backend
          // issued a grant bound to zeros, and the firmware's grant_check
          // rejected it. Surface that hypothesis in the error so the demo
          // app (and humans) can see what to investigate.
          const isLikelyNonceIssue = result.error === 'invalid_token' && !nonce;
          const detail = isLikelyNonceIssue
            ? 'invalid_token — likely nonce_d unavailable (could not read CHAR_AUTH_NONCE). ' +
              'Check the [NONCE] log lines from connect time.'
            : (result.error ?? 'unknown');
          throw new ProvisioningError(
            `Auto-deprovision failed: ${detail}`,
            'PROVISIONING_FAILED',
            device.id
          );
        }

        // Retry the original provision write — device should now be UNPAIRED
        await this.writeProvisioningOnce(device, deviceToken, environment);
        return;
      }

      log.error('Provisioning failed', error as Error, { deviceId: device.id });
      throw error;
    }
  }

  /**
   * Single provisioning attempt: writes API endpoint + token, waits for result,
   * throws a typed ProvisioningError on failure. No retry.
   */
  private async writeProvisioningOnce(
    device: ConnectedDevice,
    deviceToken: string,
    environment: Environment
  ): Promise<void> {
    const resultPromise = this.waitForProvisioningResult(device.id);

    await this.writeApiEndpoint(device.id, environment);
    await this.writeDeviceToken(device.id, deviceToken);

    const result = await resultPromise;

    if (!result.success) {
      switch (result.error) {
        case 'invalid_token':
          throw ProvisioningError.invalidToken(device.id);
        case 'storage_error':
          throw ProvisioningError.storageError(device.id);
        case 'chunk_error':
          throw ProvisioningError.chunkError(device.id);
        case 'already_paired':
          throw ProvisioningError.alreadyPaired(device.id);
        default:
          throw new ProvisioningError(
            'Provisioning failed',
            'PROVISIONING_FAILED',
            device.id
          );
      }
    }

    await this.syncTime(device.id);
    device.isProvisioned = true;

    log.info('Device provisioned successfully', { deviceId: device.id });
  }

  /**
   * Check if a device is provisioned
   */
  async isProvisioned(device: ConnectedDevice): Promise<boolean> {
    const pairingState = await this.readPairingState(device.id);
    return pairingState === 'paired';
  }

  /**
   * Read the device's Ed25519 public key (PK_D) from the Auth service.
   * Returns the 32-byte key as a 64-char lowercase hex string, or null if
   * the firmware does not expose the Auth service (legacy devices).
   */
  async readPublicKey(device: ConnectedDevice): Promise<string | null> {
    if (!this.isConnected(device.id)) {
      throw DeviceError.notConnected(device.id);
    }

    try {
      const data = await this.bleManager.readCharacteristic(
        device.id,
        SERVICE_BOTA_AUTH,
        CHAR_PK_D
      );

      if (data.length !== 64) {
        log.warn('PK_D read returned unexpected length', {
          deviceId: device.id,
          serialNumber: device.serialNumber,
          length: data.length,
        });
        return null;
      }

      const pkD = Buffer.from(data).toString('hex');
      log.debug('PK_D read', {
        deviceId: device.id,
        serialNumber: device.serialNumber,
        fingerprint: `${pkD.slice(0, 8)}...${pkD.slice(-8)}`,
        length: pkD.length,
      });
      return pkD;
    } catch (error) {
      log.debug('PK_D read failed', {
        deviceId: device.id,
        serialNumber: device.serialNumber,
        error: error instanceof Error ? error.message : String(error),
      });
      // Auth service absent on legacy firmware — treat as no key
      return null;
    }
  }

  /**
   * Subscribe to P6 session nonce notifications and cache the value.
   * Called once per connect. Handles the case where CHAR_AUTH_NONCE is NOTIFY-only
   * and the firmware sends the nonce when the CCC subscription is enabled.
   *
   * Also runs an explicit READ probe at subscription time so the logs always show
   * which transport (READ vs NOTIFY) the firmware actually serves, and at what length.
   */
  private subscribeToNonce(deviceId: string): void {
    // Clean up any stale subscription first
    this.nonceSubscriptions.get(deviceId)?.remove();
    this.nonceSubscriptions.delete(deviceId);

    log.debug('[NONCE] Setting up AUTH_NONCE subscription', { deviceId });

    let sub: Subscription | undefined;
    try {
      sub = this.bleManager.subscribeToCharacteristic(
        deviceId,
        SERVICE_BOTA_AUTH,
        CHAR_AUTH_NONCE,
        (data) => {
          log.debug('[NONCE] notify fired', { deviceId, length: data.length, hexPrefix: data.length > 0 ? data.subarray(0, 4).toString('hex') : '-' });
          if (data.length === 16) {
            const hex = Buffer.from(data).toString('hex');
            this.nonceCache.set(deviceId, hex);
            log.debug('[NONCE] cached from notify', { deviceId, nonce: hex });
          }
        },
        (error) => {
          log.warn('[NONCE] notify subscription ended', { deviceId, reason: error.message });
          this.nonceSubscriptions.delete(deviceId);
        }
      );
      this.nonceSubscriptions.set(deviceId, sub);
      log.debug('[NONCE] subscription registered', { deviceId });
    } catch (error) {
      log.warn('[NONCE] subscribe threw synchronously', {
        deviceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Probe READ in parallel (no await — runs in background, logs the result so we can
    // tell from the next pair attempt whether the firmware exposes the nonce as READ
    // or only via NOTIFY, or neither).
    this.bleManager
      .readCharacteristic(deviceId, SERVICE_BOTA_AUTH, CHAR_AUTH_NONCE)
      .then((data) => {
        log.debug('[NONCE] read probe', {
          deviceId,
          length: data.length,
          hexPrefix: data.length > 0 ? data.subarray(0, 4).toString('hex') : '-',
        });
        if (data.length === 16 && !this.nonceCache.has(deviceId)) {
          const hex = Buffer.from(data).toString('hex');
          this.nonceCache.set(deviceId, hex);
          log.debug('[NONCE] cached from read probe', { deviceId, nonce: hex });
        }
      })
      .catch((error) => {
        log.warn('[NONCE] read probe failed', {
          deviceId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  /**
   * Read the P6 session nonce from the device's AUTH_NONCE characteristic.
   *
   * P6 firmware generates a fresh 16-byte nonce on every BLE connection.
   * Pass this value as `nonce_d` to the backend grant endpoint so the grant
   * is cryptographically bound to this session. Returns null on pre-P6 firmware
   * (characteristic absent) — fall back to legacy grant flow without nonce.
   *
   * Checks the notification cache first (populated by subscribeToNonce on connect),
   * then falls back to a direct BLE read for firmware that exposes the nonce as READ.
   */
  async readAuthNonce(device: ConnectedDevice): Promise<string | null> {
    if (!this.isConnected(device.id)) {
      throw DeviceError.notConnected(device.id);
    }

    log.debug('[NONCE] readAuthNonce called', { deviceId: device.id });

    // Always issue a fresh BLE read first. The device rotates its session nonce
    // on EVERY well-formed grant attempt — both acceptance and most rejection
    // paths (bad version, nonce mismatch, expired) per firmware P6 design — so
    // any cached value is stale after the previous grant. Cache is kept only as
    // a fallback for NOTIFY-only firmware variants where READ isn't supported.
    try {
      const data = await this.bleManager.readCharacteristic(
        device.id,
        SERVICE_BOTA_AUTH,
        CHAR_AUTH_NONCE
      );

      log.debug('[NONCE] direct read returned', {
        deviceId: device.id,
        length: data.length,
        hexPrefix: data.length > 0 ? data.subarray(0, 4).toString('hex') : '-',
      });

      if (data.length === 16) {
        const hex = Buffer.from(data).toString('hex');
        this.nonceCache.set(device.id, hex);
        log.debug('[NONCE] returning from direct read', { deviceId: device.id, nonce: hex });
        return hex;
      }

      log.warn('[NONCE] unexpected length — falling back to cache', {
        deviceId: device.id,
        length: data.length,
      });
    } catch (error) {
      log.warn('[NONCE] direct read threw — falling back to cache', {
        deviceId: device.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Direct read failed — try the NOTIFY-populated cache as a fallback. May be
    // stale if the device rotated since the last notify, but better than nothing.
    const cached = this.nonceCache.get(device.id);
    if (cached) {
      log.debug('[NONCE] returning cached fallback', { deviceId: device.id, nonce: cached });
      return cached;
    }

    log.warn('[NONCE] no nonce available', { deviceId: device.id });
    return null;
  }

  /**
   * Get device status
   */
  async getStatus(device: ConnectedDevice): Promise<DeviceStatus> {
    if (!this.isConnected(device.id)) {
      throw DeviceError.notConnected(device.id);
    }

    const data = await this.bleManager.readCharacteristic(
      device.id,
      SERVICE_BOTA_CONTROL,
      CHAR_DEVICE_STATUS
    );

    return parseDeviceStatus(data);
  }

  /**
   * Subscribe to device status updates
   */
  subscribeToStatus(
    device: ConnectedDevice,
    callback: (status: DeviceStatus) => void
  ): () => void {
    if (!this.isConnected(device.id)) {
      throw DeviceError.notConnected(device.id);
    }

    // Remove existing subscription
    this.statusSubscriptions.get(device.id)?.remove();

    const subscription = this.bleManager.subscribeToCharacteristic(
      device.id,
      SERVICE_BOTA_CONTROL,
      CHAR_DEVICE_STATUS,
      (data) => {
        try {
          const status = parseDeviceStatus(data);
          this.emit('deviceStatusUpdated', device.id, status);
          callback(status);
        } catch (error) {
          log.error('Failed to parse status update', error as Error);
        }
      },
      (error) => {
        log.debug(`Status subscription ended: ${error?.message}`);
      }
    );

    this.statusSubscriptions.set(device.id, subscription);

    return () => {
      subscription.remove();
      this.statusSubscriptions.delete(device.id);
    };
  }

  /**
   * Subscribe to firmware debug log notifications.
   */
  async subscribeToDeviceLogs(
    device: ConnectedDevice,
    callback: (event: DeviceLogEvent) => void
  ): Promise<() => void> {
    if (!this.isConnected(device.id)) {
      throw DeviceError.notConnected(device.id);
    }

    if (this.deviceLogSubscriptions.has(device.id)) {
      throw new DeviceError(
        `Device logs are already subscribed for device ${device.id}`,
        'ALREADY_SUBSCRIBED',
        device.id
      );
    }

    const decoder = new DeviceLogDecoder();
    const subscription = this.bleManager.subscribeToCharacteristic(
      device.id,
      SERVICE_BOTA_DIAGNOSTICS,
      CHAR_DEVICE_LOG_DATA,
      (data) => {
        for (const event of decoder.push(data)) {
          callback(event);
        }
      },
      (error) => {
        log.debug(`Device log subscription ended: ${error?.message}`);
      },
      { logNotifications: false }
    );

    this.deviceLogSubscriptions.set(device.id, subscription);
    this.deviceLogDecoders.set(device.id, decoder);

    try {
      await this.bleManager.writeCharacteristic(
        device.id,
        SERVICE_BOTA_DIAGNOSTICS,
        CHAR_DEVICE_LOG_CONTROL,
        Buffer.from([DEVICE_LOG_CMD_START])
      );
    } catch (error) {
      this.removeDeviceLogSubscription(device.id, subscription);
      throw new DeviceError(
        'Device logging requires DEBUG=1 firmware',
        'FEATURE_UNAVAILABLE',
        device.id,
        error as Error
      );
    }

    return () => {
      if (this.deviceLogSubscriptions.get(device.id) !== subscription) {
        return;
      }

      void this.bleManager.writeCharacteristic(
        device.id,
        SERVICE_BOTA_DIAGNOSTICS,
        CHAR_DEVICE_LOG_CONTROL,
        Buffer.from([DEVICE_LOG_CMD_STOP])
      ).catch(() => {});
      this.removeDeviceLogSubscription(device.id, subscription);
    };
  }

  /**
   * Sync time to device
   */
  async syncTime(deviceId: string): Promise<void> {
    log.debug('Syncing time to device', { deviceId });

    const timeSyncData = createTimeSyncData();

    await this.bleManager.writeCharacteristic(
      deviceId,
      SERVICE_BOTA_CONTROL,
      CHAR_TIME_SYNC,
      timeSyncData
    );
  }

  /**
   * Read connection settings from device via Bluetooth DEVICE_SETTINGS characteristic.
   * Returns parsed settings (enabled connections + network preference).
   */
  async readConnectionSettings(device: ConnectedDevice): Promise<DeviceConnectionSettings> {
    log.debug('Reading connection settings', { deviceId: device.id });

    const data = await this.bleManager.readCharacteristic(
      device.id,
      SERVICE_BOTA_PROVISIONING,
      CHAR_DEVICE_SETTINGS
    );

    return parseConnectionSettings(data);
  }

  /**
   * Write connection settings to device via Bluetooth DEVICE_SETTINGS characteristic.
   * Serializes settings to 8-byte binary format.
   */
  async writeConnectionSettings(device: ConnectedDevice, settings: DeviceConnectionSettings): Promise<void> {
    if (!this.isConnected(device.id)) {
      log.debug('Skipping writeConnectionSettings — device not connected', { deviceId: device.id });
      return;
    }

    log.debug('Writing connection settings', { deviceId: device.id, settings });

    const data = serializeConnectionSettings(settings);

    await this.bleManager.writeCharacteristic(
      device.id,
      SERVICE_BOTA_PROVISIONING,
      CHAR_DEVICE_SETTINGS,
      data
    );
  }

  // Private helper methods

  private async readSerialNumber(deviceId: string): Promise<string> {
    const data = await this.bleManager.readCharacteristic(
      deviceId,
      SERVICE_DEVICE_INFO,
      CHAR_SERIAL_NUMBER
    );
    return data.toString('utf8').replace(/\0/g, '');
  }

  /**
   * Identify a reconnect candidate by connecting at the BLE layer and
   * reading its serial number (0x2A25). Returns the SN, or null if the candidate
   * could not be connected/read. On a successful read the link is left open so a
   * matching candidate can be finalized by connect() without reconnecting.
   */
  private async probeSerialNumber(deviceId: string): Promise<string | null> {
    const wasConnected = this.connectedDevices.has(deviceId);
    try {
      await this.bleManager.connect(deviceId, 'background');
      return await withTimeout(
        this.readSerialNumber(deviceId),
        POST_CONNECT_READ_TIMEOUT_MS,
        'reconnect serial-number probe',
      );
    } catch (error) {
      log.debug('Reconnect: SN probe failed', {
        deviceId,
        error: error instanceof Error ? error.message : String(error),
      });
      if (!wasConnected && !this.connectedDevices.has(deviceId)) {
        try { await this.bleManager.disconnect(deviceId, 'background'); } catch { /* ignore */ }
      }
      return null;
    }
  }

  private async readFirmwareVersion(deviceId: string): Promise<string> {
    const data = await this.bleManager.readCharacteristic(
      deviceId,
      SERVICE_DEVICE_INFO,
      CHAR_FIRMWARE_REVISION
    );
    return data.toString('utf8').replace(/\0/g, '');
  }

  private async readHardwareRevision(deviceId: string): Promise<string | undefined> {
    try {
      const data = await this.bleManager.readCharacteristic(
        deviceId,
        SERVICE_DEVICE_INFO,
        CHAR_HARDWARE_REVISION
      );
      return data.toString('utf8').replace(/\0/g, '');
    } catch {
      return undefined;
    }
  }

  private async readPairingState(deviceId: string): Promise<'unpaired' | 'pairing' | 'paired' | 'error'> {
    const data = await this.bleManager.readCharacteristic(
      deviceId,
      SERVICE_BOTA_PROVISIONING,
      CHAR_PAIRING_STATE
    );

    if (data.length < 1) {
      return 'unpaired';
    }

    return parsePairingState(data[0]);
  }

  async setApiEndpoint(
    device: ConnectedDevice,
    environment: Environment
  ): Promise<void> {
    if (!this.isConnected(device.id)) {
      throw DeviceError.notConnected(device.id);
    }
    await this.writeApiEndpoint(device.id, environment);
  }

  private async writeApiEndpoint(
    deviceId: string,
    environment: Environment
  ): Promise<void> {
    const endpointByte =
      environment === 'production' ? API_ENDPOINT_PROD :
      environment === 'gamma'      ? API_ENDPOINT_GAMMA :
                                     API_ENDPOINT_DEV;

    await this.bleManager.writeCharacteristic(
      deviceId,
      SERVICE_BOTA_PROVISIONING,
      CHAR_API_ENDPOINT,
      Buffer.from([endpointByte])
    );
  }

  /**
   * P4: Deliver the per-device X.509 leaf certificate + RSA-2048 private
   * key issued by the Bota Device CA at bind time. The device persists
   * both in syscfg and presents the cert on every WiFi/4G TLS handshake
   * (mTLS) — the API gateway authenticates by chain validation against
   * the Bota Device Root CA.
   *
   * Both PEMs are concatenated as a single payload separated by a newline:
   *
   *   <cert PEM>\n<privkey PEM>
   *
   * The firmware splits on the first `-----BEGIN ENCRYPTED|RSA|PRIVATE`
   * marker. Chunked over the same chunk-header protocol used for the
   * device token (max chunk = MTU-5; chunks prefixed with [index, total]).
   *
   * Call once after a successful `provision()`, before the first WiFi/4G
   * upload from the device.
   *
   * @param device      - Connected device
   * @param certPem     - PEM-encoded leaf certificate from bind response
   * @param privkeyPem  - PEM-encoded RSA private key from bind response
   */
  async deliverCert(
    device: ConnectedDevice,
    certPem: string,
    privkeyPem: string
  ): Promise<void> {
    if (!this.isConnected(device.id)) {
      throw DeviceError.notConnected(device.id);
    }
    log.info('P4: delivering device cert + privkey', {
      deviceId: device.id,
      certBytes: certPem.length,
      keyBytes: privkeyPem.length,
    });

    const payload = Buffer.from(`${certPem.trim()}\n${privkeyPem.trim()}\n`, 'utf8');
    const mtu = await this.bleManager.getMtu(device.id);
    const maxChunkSize = mtu - 5;
    const totalChunks = Math.ceil(payload.length / (maxChunkSize - 2));

    for (let i = 0; i < totalChunks; i++) {
      const start = i * (maxChunkSize - 2);
      const end = Math.min(start + (maxChunkSize - 2), payload.length);
      const chunkData = payload.slice(start, end);
      const chunk = Buffer.alloc(2 + chunkData.length);
      chunk.writeUInt8(i, 0);
      chunk.writeUInt8(totalChunks, 1);
      chunkData.copy(chunk, 2);

      await this.bleManager.writeCharacteristic(
        device.id,
        SERVICE_BOTA_AUTH,
        CHAR_DEVICE_CERT,
        chunk
      );
    }
  }

  /**
   * P10: Write the backend's X25519 BLE-e2e public key (32 raw bytes) to the
   * device's `CHAR_BACKEND_PUBKEY`. The device persists it in syscfg and uses
   * it to hybrid-encrypt audio chunks before BLE transfer; the app then
   * relays ciphertext it cannot read to `POST /v1/recordings/{id}/upload-relay`.
   *
   * Call this once after a successful `provision()` and again after any
   * pubkey rotation (re-fetch from `GET /v1/ble-pubkey`).
   *
   * @param device - Connected device
   * @param pubkey - 32-byte raw X25519 public key (Buffer or 32-byte Uint8Array)
   */
  async deliverBackendPubkey(device: ConnectedDevice, pubkey: Uint8Array): Promise<void> {
    if (pubkey.length !== 32) {
      throw new Error(`backend pubkey must be 32 bytes, got ${pubkey.length}`);
    }
    if (!this.isConnected(device.id)) {
      throw DeviceError.notConnected(device.id);
    }
    log.info('P10: delivering backend BLE-e2e pubkey', { deviceId: device.id });
    await this.bleManager.writeCharacteristic(
      device.id,
      SERVICE_BOTA_AUTH,
      CHAR_BACKEND_PUBKEY,
      Buffer.from(pubkey)
    );
  }

  private async writeDeviceToken(
    deviceId: string,
    token: string
  ): Promise<void> {
    const mtu = await this.bleManager.getMtu(deviceId);
    const maxChunkSize = mtu - 5; // Account for Bluetooth overhead + chunk header

    const tokenBuffer = Buffer.from(token, 'utf8');
    const totalChunks = Math.ceil(tokenBuffer.length / (maxChunkSize - 2));

    log.debug('Writing device token', {
      deviceId,
      tokenLength: token.length,
      totalChunks,
      mtu,
    });

    for (let i = 0; i < totalChunks; i++) {
      const start = i * (maxChunkSize - 2);
      const end = Math.min(start + (maxChunkSize - 2), tokenBuffer.length);
      const chunkData = tokenBuffer.slice(start, end);

      // Create chunk with header: [chunk_index, total_chunks, ...data]
      const chunk = Buffer.alloc(2 + chunkData.length);
      chunk.writeUInt8(i, 0);
      chunk.writeUInt8(totalChunks, 1);
      chunkData.copy(chunk, 2);

      await this.bleManager.writeCharacteristic(
        deviceId,
        SERVICE_BOTA_PROVISIONING,
        CHAR_DEVICE_TOKEN,
        chunk
      );

      log.debug('Wrote token chunk', { chunk: i + 1, total: totalChunks });
    }
  }

  private waitForProvisioningResult(
    deviceId: string,
    requireFactoryResetPayload = false
  ): Promise<ProvisioningResult> {
    return this.createProvisioningResultWait(
      deviceId,
      requireFactoryResetPayload
    ).promise;
  }

  private createProvisioningResultWait(
    deviceId: string,
    requireFactoryResetPayload = false
  ): {
    promise: Promise<ProvisioningResult>;
    cancel: (reason: unknown) => void;
  } {
    let subscription: Subscription | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    let rejectPromise: (reason: unknown) => void = () => {};

    const cleanup = () => {
      if (timeout) {
        clearTimeout(timeout);
      }
      subscription?.remove();
    };

    const promise = new Promise<ProvisioningResult>((resolve, reject) => {
      rejectPromise = reject;

      const resolveOnce = (result: ProvisioningResult) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };
      const rejectOnce = (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };

      timeout = setTimeout(() => {
        rejectOnce(ProvisioningError.timeout(deviceId));
      }, OPERATION_TIMEOUT);

      subscription = this.bleManager.subscribeToCharacteristic(
        deviceId,
        SERVICE_BOTA_PROVISIONING,
        CHAR_PROVISIONING_RESULT,
        (data) => {
          if (data.length < 1) {
            resolveOnce({ success: false, error: 'unknown' });
            return;
          }

          const resultCode = data[0];
          switch (resultCode) {
            case PROVISIONING_SUCCESS:
              if (requireFactoryResetPayload && data.length !== 3) {
                rejectOnce(new ProvisioningError(
                  `Factory reset result must be exactly 3 bytes, received ${data.length}`,
                  'INVALID_FACTORY_RESET_RESULT',
                  deviceId
                ));
                break;
              }
              resolveOnce({
                success: true,
                ...(data.length >= 3
                  ? { localRecordingsDeleted: data.readUInt16LE(1) }
                  : {}),
              });
              break;
            case PROVISIONING_INVALID_TOKEN:
              resolveOnce({ success: false, error: 'invalid_token' });
              break;
            case PROVISIONING_STORAGE_ERROR:
              resolveOnce({ success: false, error: 'storage_error' });
              break;
            case PROVISIONING_CHUNK_ERROR:
              resolveOnce({ success: false, error: 'chunk_error' });
              break;
            case PROVISIONING_ALREADY_PAIRED:
              resolveOnce({ success: false, error: 'already_paired' });
              break;
            default:
              resolveOnce({ success: false, error: 'unknown' });
          }
        },
        (error) => {
          rejectOnce(new ProvisioningError(
            `Provisioning notification error: ${error.message}`,
            'NOTIFICATION_ERROR',
            deviceId,
            error
          ));
        }
      );

      if (settled) {
        subscription.remove();
      }
    });

    return {
      promise,
      cancel: (reason: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        rejectPromise(reason);
      },
    };
  }

  // ============================================================================
  // Remote Recording Control (MVP)
  // ============================================================================

  /**
   * Write an HPKE grant blob to the device's CHAR_DEVICE_COMMAND characteristic.
   * The device decrypts and verifies the blob; subsequent recording commands within
   * the grant TTL are honoured.
   *
   * @param device - Connected device
   * @param grantBlob - Base64-encoded 171-byte HPKE grant blob from backend
   */
  async writeGrant(device: ConnectedDevice, grantBlob: string): Promise<void> {
    log.debug('Writing grant blob to device', { deviceId: device.id });

    if (!this.isConnected(device.id)) {
      throw DeviceError.notConnected(device.id);
    }

    const blob = Buffer.from(grantBlob, 'base64');
    await this.bleManager.writeCharacteristic(
      device.id,
      SERVICE_BOTA_CONTROL,
      CHAR_DEVICE_COMMAND,
      blob
    );
  }

  /**
   * Request to start recording on a device remotely.
   *
   * Two call shapes:
   * 1. `requestStartRecording(device, grantBlob)` — caller already fetched the
   *    grant blob (legacy / explicit usage).
   * 2. `requestStartRecording(device, fetchGrant)` — pass an async fetcher and
   *    the SDK runs the full P6 atomic sequence: read CHAR_AUTH_NONCE → invoke
   *    `fetchGrant(nonce)` → write grant → send opcode. This keeps the nonce
   *    read and grant fetch on a single BLE connection (avoids races where the
   *    nonce rotates between read and grant write).
   *
   * @param device      - Connected device
   * @param grantOrFetcher - Either a base64-encoded 171-byte grant blob, or an
   *                         async fetcher invoked with the device's session
   *                         nonce (16-byte hex, or null on pre-P6 firmware)
   *                         that returns the grant blob.
   * @param _options    - Reserved for future use
   * @returns Recording command result
   */
  async requestStartRecording(
    device: ConnectedDevice,
    grantOrFetcher: string | RecordingGrantFetcher,
    _options?: StartRecordingOptions
  ): Promise<{ success: boolean; error?: string }> {
    log.info('Requesting start recording', { deviceId: device.id });

    if (!this.isConnected(device.id)) {
      throw DeviceError.notConnected(device.id);
    }

    try {
      const grantBlob = typeof grantOrFetcher === 'string'
        ? grantOrFetcher
        : await this.fetchGrantWithNonce(device, grantOrFetcher);

      // Step 1: deliver grant blob to CHAR_DEVICE_COMMAND
      await this.writeGrant(device, grantBlob);

      // Step 2: subscribe for result, then send opcode to CHAR_RECORDING_CONTROL
      const resultPromise = this.waitForRecordingResult(device.id);

      await this.bleManager.writeCharacteristic(
        device.id,
        SERVICE_BOTA_CONTROL,
        CHAR_RECORDING_CONTROL,
        Buffer.from([RECORDING_CMD_GRANT_START])
      );

      const result = await resultPromise;

      log.info('Start recording result', { deviceId: device.id, result });

      return result;
    } catch (error) {
      log.error('Failed to start recording', error as Error, { deviceId: device.id });
      throw error;
    }
  }

  /** Read the device session nonce, then invoke the caller's fetcher.
   *  Encapsulates the P6 nonce-read-then-fetch sequence so callers can pass a
   *  one-line fetcher to {@link requestStartRecording} / {@link requestStopRecording}. */
  private async fetchGrantWithNonce(
    device: ConnectedDevice,
    fetcher: RecordingGrantFetcher
  ): Promise<string> {
    const nonce = await this.readAuthNonce(device).catch(() => null);
    return fetcher(nonce);
  }

  /**
   * Request to stop recording on a device remotely.
   *
   * Same two call shapes as {@link requestStartRecording} — accepts either a
   * pre-fetched grant blob or a fetcher that the SDK invokes after reading
   * the device's session nonce.
   *
   * @param device         - Connected device
   * @param grantOrFetcher - Base64 grant blob OR a fetcher (see {@link RecordingGrantFetcher})
   * @param _options       - Reserved for future use
   * @returns Recording command result
   */
  async requestStopRecording(
    device: ConnectedDevice,
    grantOrFetcher: string | RecordingGrantFetcher,
    _options?: StopRecordingOptions
  ): Promise<{ success: boolean; error?: string }> {
    log.info('Requesting stop recording', { deviceId: device.id });

    if (!this.isConnected(device.id)) {
      throw DeviceError.notConnected(device.id);
    }

    try {
      const grantBlob = typeof grantOrFetcher === 'string'
        ? grantOrFetcher
        : await this.fetchGrantWithNonce(device, grantOrFetcher);

      // Step 1: deliver grant blob to CHAR_DEVICE_COMMAND
      await this.writeGrant(device, grantBlob);

      // P10 streaming pacing: the three BLE ops in this handshake (grant
      // write above, result-char subscribe CCC, control-opcode write below)
      // compete with active streaming-data notifications on the same
      // connection. iOS CoreBluetooth's connection-event TX-slot scheduler
      // can drop a queued NOTIFY while servicing a host write burst —
      // firmware reports ret=0 on the send but the host SDK's native
      // callback never sees the packet. Fixed 50ms gap = ~1-2 BLE
      // connection events at the typical 30ms negotiation, giving the
      // controller time to drain pending notifications before the next
      // write blocks them. Adds ~100ms to stop-recording, invisible to
      // user. NOT a notification-quiescence wait — that was tried and
      // regressed: during active streaming, notifications arrive every
      // ~20-30ms so quiescence never triggers, the wait hits its max-cap
      // (500ms), then fires the write into an even more saturated queue.
      // See AGENT_DEBUG_HEURISTICS.md §5 for the original failure case.
      //
      // The nonce-read transaction (inside fetchGrantWithNonce above) can
      // ALSO cause a drop on its own, separate from these writes. Adding
      // a 4th delay after the fetch resolves did NOT help — by then the
      // drop already happened during the read. Pacing the read requires
      // a delay BEFORE the read, not after. Not currently implemented
      // because pacing is probabilistic anyway — single-digit-ms timing
      // jitter in iOS BLE means even correctly-placed delays don't drive
      // drops to zero.
      await this.delay(50);

      // Step 2: subscribe for result, then send opcode to CHAR_RECORDING_CONTROL
      const resultPromise = this.waitForRecordingResult(device.id);

      await this.delay(50);

      await this.bleManager.writeCharacteristic(
        device.id,
        SERVICE_BOTA_CONTROL,
        CHAR_RECORDING_CONTROL,
        Buffer.from([RECORDING_CMD_GRANT_STOP])
      );

      const result = await resultPromise;

      log.info('Stop recording result', { deviceId: device.id, result });

      return result;
    } catch (error) {
      log.error('Failed to stop recording', error as Error, { deviceId: device.id });
      throw error;
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Deprovision a device via a grant-gated BLE command (P5.B).
   *
   * Writes the recording grant blob, then sends opcode 0x05 to CHAR_DEVICE_COMMAND.
   * The device verifies the grant and clears its pairing state + token, allowing
   * re-provisioning without a physical firmware reflash.
   *
   * Call this BEFORE revoking the device token on the backend. Once the token is
   * revoked the backend can no longer issue a grant for this device.
   *
   * Falls back gracefully on old firmware (no 0x05 handler): the device ignores
   * the opcode and the result notification times out, which we treat as a soft
   * failure — the caller should still proceed with server-side unbind and rely on
   * the heartbeat factory_reset path for credential wipe.
   */
  async deprovision(
    device: ConnectedDevice,
    grantBlob: string
  ): Promise<{ success: boolean; error?: string }> {
    log.info('BLE deprovision', { deviceId: device.id });

    if (!this.isConnected(device.id)) {
      throw DeviceError.notConnected(device.id);
    }

    try {
      // Step 1: deliver grant blob so firmware can verify it
      await this.writeGrant(device, grantBlob);

      // Step 2: subscribe for result, then send deprovision opcode
      const resultPromise = this.waitForProvisioningResult(device.id);

      await this.bleManager.writeCharacteristic(
        device.id,
        SERVICE_BOTA_CONTROL,
        CHAR_DEVICE_COMMAND,
        Buffer.from([DEVICE_CMD_BLE_DEPROVISION])
      );

      const result = await resultPromise;
      log.info('BLE deprovision result', { deviceId: device.id, result });
      return result.success
        ? { success: true }
        : { success: false, error: result.error };
    } catch (error) {
      log.error('BLE deprovision failed', error as Error, { deviceId: device.id });
      throw error;
    }
  }

  /**
   * Full BLE factory reset (opcode 0x06). Requires a valid deprovision grant.
   *
   * Firmware first wipes all local recording artifacts and reports a durable,
   * three-byte result. The SDK awaits `persistResult` before sending result
   * receipt opcode 0x0A; only that receipt lets firmware clear project state and
   * reboot unpaired. If persistence or the receipt write fails, firmware keeps
   * the result in its WIPED phase for {@link resumeBleFactoryReset}.
   *
   * @param persistResult Must durably store the result before resolving. Reject
   *   to prevent the receipt and keep the firmware result replayable.
   */
  async bleFactoryReset(
    device: ConnectedDevice,
    grantBlob: string,
    persistResult: BleFactoryResetResultPersister
  ): Promise<BleFactoryResetResult> {
    log.info('BLE factory reset', { deviceId: device.id });

    if (!this.isConnected(device.id)) {
      throw DeviceError.notConnected(device.id);
    }

    try {
      await this.writeGrant(device, grantBlob);

      const resultWait = this.createProvisioningResultWait(device.id, true);

      try {
        await this.bleManager.writeCharacteristic(
          device.id,
          SERVICE_BOTA_CONTROL,
          CHAR_DEVICE_COMMAND,
          Buffer.from([DEVICE_CMD_BLE_FACTORY_RESET])
        );
      } catch (error) {
        resultWait.cancel(error);
        await resultWait.promise.catch(() => undefined);
        throw error;
      }

      const result = await resultWait.promise;
      log.info('BLE factory reset result', { deviceId: device.id, result });
      return await this.persistAndAcknowledgeFactoryReset(
        device,
        result,
        persistResult
      );
    } catch (error) {
      log.error('BLE factory reset failed', error as Error, { deviceId: device.id });
      throw error;
    }
  }

  /**
   * Resume a factory reset whose successful wipe result was not receipted.
   *
   * Firmware replays its durable WIPED result when the app subscribes after a
   * reconnect. This method deliberately sends neither a grant nor opcode 0x06.
   */
  async resumeBleFactoryReset(
    device: ConnectedDevice,
    persistResult: BleFactoryResetResultPersister
  ): Promise<BleFactoryResetResult> {
    log.info('Resuming BLE factory reset result receipt', { deviceId: device.id });

    if (!this.isConnected(device.id)) {
      throw DeviceError.notConnected(device.id);
    }

    try {
      const result = await this.waitForProvisioningResult(device.id, true);
      return await this.persistAndAcknowledgeFactoryReset(
        device,
        result,
        persistResult
      );
    } catch (error) {
      log.error('BLE factory reset resume failed', error as Error, { deviceId: device.id });
      throw error;
    }
  }

  private async persistAndAcknowledgeFactoryReset(
    device: ConnectedDevice,
    provisioningResult: ProvisioningResult,
    persistResult: BleFactoryResetResultPersister
  ): Promise<BleFactoryResetResult> {
    if (!provisioningResult.success) {
      return {
        success: false,
        error: provisioningResult.error ?? 'unknown',
      };
    }

    const result: BleFactoryResetResult = {
      success: true,
      localRecordingsDeleted: provisioningResult.localRecordingsDeleted!,
    };
    await persistResult(result);
    await this.bleManager.writeCharacteristic(
      device.id,
      SERVICE_BOTA_CONTROL,
      CHAR_DEVICE_COMMAND,
      Buffer.from([DEVICE_CMD_BLE_FACTORY_RESET_RESULT_ACK])
    );

    return result;
  }

  /**
   * Get current recording state from device
   */
  async getRecordingState(device: ConnectedDevice): Promise<RecordingState> {
    if (!this.isConnected(device.id)) {
      throw DeviceError.notConnected(device.id);
    }

    // Pending takes precedence — a start/stop command is in-flight and its
    // result will supersede whatever the device currently reports.
    const pending = this.recordingStatePending.get(device.id);
    if (pending) return pending;

    // Read fresh from BLE. Firmware exposes CHAR_RECORDING_STATUS as
    // READ | NOTIFY (see le_trans_data.c ATT_CHARACTERISTIC_B07A0002_0003
    // read handler), so we can ask the device for the current state directly.
    //
    // The previous notify-only assumption left the cache empty for physical-
    // button-started recordings — nothing in the SDK/app subscribes to this
    // characteristic outside of explicit start/stop command flows. Result:
    // useBleStreamingSync bailed at "device not recording or UUID unavailable"
    // and the streaming placeholder recording row was never created.
    try {
      const data = await this.bleManager.readCharacteristic(
        device.id,
        SERVICE_BOTA_CONTROL,
        CHAR_RECORDING_STATUS
      );
      const state = this.parseRecordingState(data);
      this.recordingStateCache.set(device.id, state);
      return state;
    } catch (err) {
      log.debug('getRecordingState read failed, using cache', {
        reason: err instanceof Error ? err.message : 'Unknown',
      });
      const cached = this.recordingStateCache.get(device.id);
      return cached ?? { active: false, initiatedBy: 'local' };
    }
  }

  /**
   * Subscribe to recording state changes
   */
  subscribeToRecordingState(
    device: ConnectedDevice,
    callback: (state: RecordingState) => void
  ): () => void {
    if (!this.isConnected(device.id)) {
      throw DeviceError.notConnected(device.id);
    }

    const subscription = this.bleManager.subscribeToCharacteristic(
      device.id,
      SERVICE_BOTA_CONTROL,
      CHAR_RECORDING_STATUS,
      (data) => {
        try {
          const state = this.parseRecordingState(data);
          callback(state);
        } catch (error) {
          log.error('Failed to parse recording state', error as Error);
        }
      },
      (error) => {
        log.debug(`Recording state subscription ended: ${error?.message}`);
      }
    );

    return () => {
      subscription.remove();
    };
  }

  /**
   * Wait for recording control result from device
   */
  private waitForRecordingResult(
    deviceId: string
  ): Promise<{ success: boolean; error?: string }> {
    // Set up a pending promise so getRecordingState() can await the result
    // rather than returning stale cache while the command is in-flight.
    let resolvePending!: (state: RecordingState) => void;
    const pendingPromise = new Promise<RecordingState>(resolve => { resolvePending = resolve; });
    this.recordingStatePending.set(deviceId, pendingPromise);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        subscription.remove();
        resolvePending({ active: false, initiatedBy: 'local' });
        this.recordingStatePending.delete(deviceId);
        resolve({ success: false, error: 'timeout' });
      }, OPERATION_TIMEOUT);

      const subscription = this.bleManager.subscribeToCharacteristic(
        deviceId,
        SERVICE_BOTA_CONTROL,
        CHAR_RECORDING_STATUS,
        (data) => {
          clearTimeout(timeout);
          subscription.remove();

          if (data.length < 1) {
            resolvePending({ active: false, initiatedBy: 'local' });
            this.recordingStatePending.delete(deviceId);
            resolve({ success: false, error: 'invalid_response' });
            return;
          }

          // Cache the parsed recording state and resolve pending for getRecordingState()
          const parsedState = this.parseRecordingState(data);
          this.recordingStateCache.set(deviceId, parsedState);
          resolvePending(parsedState);
          this.recordingStatePending.delete(deviceId);

          // Parse response: byte 0 = is_recording state
          const resultCode = data.length >= 6 ? data[5] : data[0];

          switch (resultCode) {
            case RECORDING_RESULT_SUCCESS:
              resolve({ success: true });
              break;
            case RECORDING_RESULT_ALREADY_RECORDING:
              resolve({ success: false, error: 'already_recording' });
              break;
            case RECORDING_RESULT_NOT_RECORDING:
              resolve({ success: false, error: 'not_recording' });
              break;
            case RECORDING_RESULT_INVALID_GRANT:
              resolve({ success: false, error: 'invalid_grant' });
              break;
            case RECORDING_RESULT_GRANT_EXPIRED:
              resolve({ success: false, error: 'grant_expired' });
              break;
            case RECORDING_RESULT_INVALID_STATE:
              resolve({ success: false, error: 'invalid_state' });
              break;
            default:
              // State 0x01 = recording, 0x00 = idle
              if (data[0] === 0x01 || data[0] === 0x00) {
                resolve({ success: true });
              } else {
                resolve({ success: false, error: 'unknown_error' });
              }
          }
        },
        (error) => {
          clearTimeout(timeout);
          subscription.remove();
          resolvePending({ active: false, initiatedBy: 'local' });
          this.recordingStatePending.delete(deviceId);
          reject(new DeviceError(
            `Recording control error: ${error.message}`,
            'RECORDING_CONTROL_ERROR',
            deviceId,
            error
          ));
        }
      );
    });
  }

  /**
   * Parse recording state from Bluetooth data
   */
  private parseRecordingState(data: Buffer): RecordingState {
    // Format from firmware bota_build_recording_status() (18 bytes):
    // Byte 0:     is_recording (0=idle, 1=active)
    // Byte 1:     initiated_by (0=button, 1=remote)
    // Bytes 2-17: recording_uuid (16 bytes)
    const active = data.length >= 1 && data[0] === 0x01;
    const initiatedBy: 'local' | 'remote' = data.length >= 2 && data[1] === 0x01 ? 'remote' : 'local';

    let recordingId: string | undefined;
    if (active && data.length >= 18) {
      const hex = data.slice(2, 18).toString('hex');
      if (hex !== '0'.repeat(32)) {
        recordingId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
      }
    }

    return { active, recordingId, initiatedBy };
  }

  // ============================================================================
  // WiFi Upload Configuration
  // ============================================================================

  /**
   * Configure WiFi credentials on device via BLE.
   * Requires a WiFi configuration grant from backend.
   *
   * @param deviceId - Connected device ID
   * @param credentials - WiFi network credentials
   * @param grant - WiFi config grant from backend
   * @returns Configuration result
   *
   * @example
   * ```typescript
   * // 1. Get grant from backend
   * const grant = await api.createWiFiConfigGrant(deviceId);
   *
   * // 2. Configure device via BLE
   * const result = await deviceManager.configureWiFi(
   *   deviceId,
   *   { ssid: 'MyNetwork', password: 'password123', securityType: 'WPA2' },
   *   grant
   * );
   *
   * if (result.success) {
   *   console.log('WiFi configured successfully');
   * }
   * ```
   */
  async configureWiFi(
    deviceId: string,
    credentials: WiFiCredentials,
    grant: WiFiConfigGrant
  ): Promise<WiFiConfigResult> {
    log.info('Configuring WiFi on device', { deviceId, ssid: credentials.ssid });

    try {
      // Step 1: Submit WiFi config grant to device
      const grantPacket = createWiFiGrantPacket(grant.grantBlob);
      await this.bleManager.writeCharacteristic(
        deviceId,
        SERVICE_BOTA_WIFI_CONFIG,
        CHAR_WIFI_GRANT,
        grantPacket
      );

      log.debug('WiFi grant submitted');

      // Step 2: Subscribe to result BEFORE writing credentials (avoid race)
      const resultPromise = this.waitForWiFiConfigResult(deviceId);

      // Step 3: Build plaintext credential packet
      // TODO: Re-enable encryption once firmware mbedtls boot crash is resolved
      // Format: [ssid_len (1)][ssid][pwd_len (1)][password]
      const ssidBuf = Buffer.from(credentials.ssid, 'utf-8');
      const pwdBuf = Buffer.from(credentials.password, 'utf-8');
      const credentialPacket = Buffer.alloc(1 + ssidBuf.length + 1 + pwdBuf.length);
      credentialPacket.writeUInt8(ssidBuf.length, 0);
      ssidBuf.copy(credentialPacket, 1);
      credentialPacket.writeUInt8(pwdBuf.length, 1 + ssidBuf.length);
      pwdBuf.copy(credentialPacket, 1 + ssidBuf.length + 1);

      log.debug('Sending WiFi credentials (plaintext mode)', {
        packetSize: credentialPacket.length,
        ssidLen: ssidBuf.length,
      });

      // Step 4: Write credentials to device
      await this.bleManager.writeCharacteristic(
        deviceId,
        SERVICE_BOTA_WIFI_CONFIG,
        CHAR_WIFI_CREDENTIAL,
        credentialPacket
      );

      // Step 5: Wait for configuration result (subscription set up before write)
      const result = await resultPromise;

      if (result.success) {
        log.info('WiFi configuration successful', { deviceId });
      } else {
        log.warn('WiFi configuration failed', { deviceId, error: result.error });
      }

      return result;
    } catch (error) {
      log.error('WiFi configuration error', error instanceof Error ? error : undefined);
      throw new DeviceError(
        `Failed to configure WiFi: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'WIFI_CONFIG_ERROR',
        deviceId,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Disconnect WiFi on device and forget stored credentials.
   *
   * @param deviceId - Connected device ID
   * @returns Configuration result
   */
  async disconnectWiFi(deviceId: string): Promise<WiFiConfigResult> {
    log.info('Disconnecting WiFi on device', { deviceId });

    try {
      // Subscribe to result before writing
      const resultPromise = this.waitForWiFiConfigResult(deviceId);

      // Send disconnect command: ssid_len=0
      await this.bleManager.writeCharacteristic(
        deviceId,
        SERVICE_BOTA_WIFI_CONFIG,
        CHAR_WIFI_CREDENTIAL,
        Buffer.from([0x00])
      );

      const result = await resultPromise;
      log.info('WiFi disconnect result', { deviceId, success: result.success });
      return result;
    } catch (error) {
      log.error('WiFi disconnect error', error instanceof Error ? error : undefined);
      throw new DeviceError(
        `Failed to disconnect WiFi: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'WIFI_DISCONNECT_ERROR',
        deviceId,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Get WiFi connection status from device.
   *
   * @param deviceId - Connected device ID
   * @returns WiFi status information
   *
   * @example
   * ```typescript
   * const status = await deviceManager.getWiFiStatus(deviceId);
   * console.log('WiFi status:', status.status);
   * if (status.status === 'connected') {
   *   console.log('Connected to:', status.ssid);
   *   console.log('Signal strength:', status.signalStrength);
   * }
   * ```
   */
  async getWiFiStatus(deviceId: string): Promise<WiFiStatusInfo> {
    log.debug('Reading WiFi status', { deviceId });

    try {
      const data = await this.bleManager.readCharacteristic(
        deviceId,
        SERVICE_BOTA_WIFI_CONFIG,
        CHAR_WIFI_STATUS
      );

      const status = parseWiFiStatusInfo(data);

      log.debug('WiFi status', { deviceId, status: status.status, ssid: status.ssid });

      this.updateWifiCacheFromInfo(deviceId, status);

      return status;
    } catch (error) {
      log.debug('Failed to read WiFi status', { reason: error instanceof Error ? error.message : 'Unknown' });
      throw new DeviceError(
        `Failed to read WiFi status: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'WIFI_STATUS_ERROR',
        deviceId,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Subscribe to WiFi status updates from device.
   *
   * @param deviceId - Connected device ID
   * @param callback - Callback function for status updates
   * @returns Subscription object (call .remove() to unsubscribe)
   *
   * @example
   * ```typescript
   * const subscription = deviceManager.subscribeToWiFiStatus(deviceId, (status) => {
   *   console.log('WiFi status update:', status.status);
   *   if (status.status === 'connected') {
   *     console.log('Connected to:', status.ssid);
   *   } else if (status.status === 'failed') {
   *     console.error('Connection failed:', status.lastError);
   *   }
   * });
   *
   * // Later: unsubscribe
   * subscription.remove();
   * ```
   */
  subscribeToWiFiStatus(
    deviceId: string,
    callback: (status: WiFiStatusInfo) => void
  ): Subscription {
    log.debug('Subscribing to WiFi status', { deviceId });

    return this.bleManager.subscribeToCharacteristic(
      deviceId,
      SERVICE_BOTA_WIFI_CONFIG,
      CHAR_WIFI_STATUS,
      (data) => {
        try {
          const status = parseWiFiStatusInfo(data);
          this.updateWifiCacheFromInfo(deviceId, status);
          callback(status);
        } catch (error) {
          log.error('Failed to parse WiFi status', error instanceof Error ? error : undefined);
        }
      },
      (error) => {
        // Characteristic may not exist on older firmware — log as debug, not error
        log.debug(`WiFi status subscription ended: ${error.message}`);
      }
    );
  }

  /**
   * Resolve a peripheral id to its paired-device serial number, the stable
   * identity the state cache is keyed by. Falls back to the reconnect
   * registry for the (uncommon) case where a probe read landed before the
   * full connect flow populated `connectedDevices`.
   */
  private resolveSerialNumber(deviceId: string): string | null {
    const connected = this.connectedDevices.get(deviceId);
    if (connected) return connected.serialNumber;
    for (const [sn, info] of Object.entries(this.reconnectRegistry)) {
      if (info.bleId === deviceId) return sn;
    }
    return null;
  }

  /**
   * Translate a parsed WiFiStatusInfo into a cache patch. The parsed value
   * uses `undefined` for "no information from the device on this field" — we
   * pass that through to the cache, which preserves the prior value. Cleared
   * networks (forget WiFi) come through as `status='disconnected'` with no
   * SSID — we keep the prior SSID since the device may reconnect; callers
   * who want an explicit wipe call `clearDeviceState(sn)` directly.
   */
  private updateWifiCacheFromInfo(deviceId: string, info: WiFiStatusInfo): void {
    const sn = this.resolveSerialNumber(deviceId);
    if (!sn) return;
    this.stateCache.update(sn, { wifiStatus: info });
  }

  // ─── Device State Cache — public API ─────────────────────────────────────

  /**
   * Synchronously read the last-known-good device-state snapshot for a paired
   * device, keyed by serial number. Returns `null` if nothing has been
   * observed since the SDK was instantiated.
   *
   * Populated by every `getWiFiStatus()` call and every
   * `subscribeToWiFiStatus()` notification. Survives BLE disconnects and
   * screen unmounts; does NOT survive app restart unless the consumer
   * rehydrates the snapshot (see `updateCachedDeviceState`).
   */
  getCachedDeviceState(serialNumber: string): CachedDeviceState | null {
    return this.stateCache.get(serialNumber);
  }

  /** Convenience: WiFi-only sub-record. Most consumers want just this. */
  getCachedWiFiStatus(serialNumber: string): WiFiStatusInfo | null {
    return this.stateCache.getWifi(serialNumber);
  }

  /**
   * Hydrate or patch the cache directly. Consumers use this to (a) restore a
   * persisted snapshot on app launch, or (b) push a value the SDK can't
   * observe BLE-side — e.g. the wifi-config screen knows the SSID the user
   * just typed before the firmware echoes it back. Merge rules match the
   * cache's own internal rules: `undefined` preserves prior, `null` clears.
   */
  updateCachedDeviceState(
    serialNumber: string,
    patch: { wifiStatus?: Partial<WiFiStatusInfo> | null }
  ): void {
    this.stateCache.update(serialNumber, patch);
  }

  /** Forget one device's cached state — call on unpair / factory-reset. */
  clearCachedDeviceState(serialNumber: string): void {
    this.stateCache.clear(serialNumber);
  }

  /** Forget every cached snapshot — call on logout, SDK destroy. */
  clearAllCachedDeviceStates(): void {
    this.stateCache.clearAll();
  }

  /** Subscribe to cache change events. Fires on every observable update. */
  onCachedDeviceStateChanged(
    listener: (
      serialNumber: string,
      patch: { wifiStatus?: Partial<WiFiStatusInfo> | null },
      state: CachedDeviceState
    ) => void
  ): { remove: () => void } {
    this.stateCache.on('stateChanged', listener);
    return {
      remove: () => this.stateCache.off('stateChanged', listener),
    };
  }

  /**
   * Scan for WiFi networks using the device's WiFi radio.
   * Sends a scan command via Bluetooth and waits for the device to report results.
   *
   * @param device - Connected device with WiFi capability
   * @returns Scan result with networks sorted by signal quality
   */
  async scanWiFiNetworks(device: ConnectedDevice): Promise<DeviceWiFiScanResult> {
    log.info('Starting device-side WiFi scan', { deviceId: device.id });

    if (!this.isConnected(device.id)) {
      throw DeviceError.notConnected(device.id);
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        subscription.remove();
        reject(new DeviceError(
          'WiFi scan timeout',
          'WIFI_SCAN_TIMEOUT',
          device.id
        ));
      }, WIFI_SCAN_TIMEOUT);

      const subscription = this.bleManager.subscribeToCharacteristic(
        device.id,
        SERVICE_BOTA_WIFI_CONFIG,
        CHAR_WIFI_SCAN,
        (data) => {
          try {
            const result = parseWiFiScanResult(data);
            if (result) {
              clearTimeout(timeout);
              subscription.remove();
              log.info('WiFi scan complete', {
                deviceId: device.id,
                networkCount: result.networks.length,
              });
              resolve(result);
            }
            // null = still scanning, keep waiting
          } catch (error) {
            clearTimeout(timeout);
            subscription.remove();
            reject(error);
          }
        },
        (error) => {
          clearTimeout(timeout);
          subscription.remove();
          reject(new DeviceError(
            `WiFi scan error: ${error.message}`,
            'WIFI_SCAN_ERROR',
            device.id,
            error
          ));
        }
      );

      // Send scan command after subscribing
      this.bleManager.writeCharacteristic(
        device.id,
        SERVICE_BOTA_WIFI_CONFIG,
        CHAR_WIFI_SCAN,
        createWiFiScanCommand()
      ).catch((error) => {
        clearTimeout(timeout);
        subscription.remove();
        reject(error);
      });
    });
  }

  /**
   * Wait for WiFi configuration result from device.
   */
  private waitForWiFiConfigResult(deviceId: string): Promise<WiFiConfigResult> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        subscription.remove();
        reject(new DeviceError(
          'WiFi configuration timeout',
          'WIFI_CONFIG_TIMEOUT',
          deviceId
        ));
      }, OPERATION_TIMEOUT);

      const subscription = this.bleManager.subscribeToCharacteristic(
        deviceId,
        SERVICE_BOTA_WIFI_CONFIG,
        CHAR_WIFI_STATUS,
        (data) => {
          try {
            // Configuration result comes via status updates
            const result = parseWiFiConfigResult(data);

            clearTimeout(timeout);
            subscription.remove();
            resolve(result);
          } catch (error) {
            // Ignore parse errors, wait for valid result
            log.debug('Ignoring invalid WiFi config result', { error: error instanceof Error ? error.message : String(error) });
          }
        },
        (error) => {
          clearTimeout(timeout);
          subscription.remove();
          reject(new DeviceError(
            `WiFi config result error: ${error.message}`,
            'WIFI_CONFIG_RESULT_ERROR',
            deviceId,
            error
          ));
        }
      );
    });
  }

  // Reconnect Registry Persistence

  private async loadReconnectRegistry(): Promise<void> {
    try {
      const data = await AsyncStorage.getItem(RECONNECT_REGISTRY_KEY);
      if (data) {
        this.reconnectRegistry = JSON.parse(data);
      }
    } catch (error) {
      log.warn('Failed to load reconnect registry', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  private async saveReconnectRegistry(): Promise<void> {
    try {
      await AsyncStorage.setItem(RECONNECT_REGISTRY_KEY, JSON.stringify(this.reconnectRegistry));
    } catch (error) {
      log.warn('Failed to save reconnect registry', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  private removeDeviceLogSubscription(deviceId: string, expected?: Subscription): void {
    const subscription = this.deviceLogSubscriptions.get(deviceId);
    if (!subscription || (expected && subscription !== expected)) {
      return;
    }

    subscription.remove();
    this.deviceLogSubscriptions.delete(deviceId);
    this.deviceLogDecoders.get(deviceId)?.reset();
    this.deviceLogDecoders.delete(deviceId);
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    log.info('Destroying DeviceManager');

    // Clean up all status subscriptions
    for (const sub of this.statusSubscriptions.values()) {
      sub.remove();
    }
    this.statusSubscriptions.clear();

    for (const deviceId of this.deviceLogSubscriptions.keys()) {
      this.removeDeviceLogSubscription(deviceId);
    }

    this.stateCache.clearAll();
    this.stateCache.removeAllListeners();

    this.connectedDevices.clear();
    this.removeAllListeners();
    this.isInitialized = false;
  }
}
