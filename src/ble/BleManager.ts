/**
 * Bluetooth Manager - Abstraction layer over react-native-ble-plx
 */

import {
  BleManager as RNBleManager,
  Device,
  State,
  Subscription,
  BleError,
} from 'react-native-ble-plx';
import { Buffer } from 'buffer';
import EventEmitter from 'eventemitter3';

import {
  // DEVICE_NAME_PREFIX, // TODO: Re-enable after debugging
  DEFAULT_MTU,
  MAX_MTU,
  CONNECTION_TIMEOUT,
  SCAN_TIMEOUT,
  SERVICE_BOTA_CONTROL,
  SERVICE_BOTA_PROVISIONING,
  SERVICE_BOTA_STORAGE,
} from './constants';
import type {
  DiscoveredDevice,
  DeviceType,
  PairingState,
  ScanOptions,
} from '../models/Device';
import { BluetoothError, DeviceError } from '../utils/errors';
import { logger } from '../utils/logger';
import {
  parseDeviceType,
  parsePairingState,
  parseFirmwareVersion,
} from './parsers';

const log = logger.tag('BleManager');

/**
 * Priority of a radio operation.
 * - `user`: initiated by an explicit user action (pairing, manual connect).
 *   Stops any in-flight scan and is never starved behind background work.
 * - `background`: auto-reconnect probes/connects. Yields to user operations.
 */
export type RadioPriority = 'user' | 'background';

/** Extract a human-readable message from a BleError (message is often null) */
function describeBleError(err: BleError | Error | null | undefined): string {
  if (!err) return 'Unknown error';
  const ble = err as BleError;
  if (ble.message) return ble.message;
  if (ble.reason) return ble.reason;
  const parts: string[] = [];
  if (ble.errorCode !== undefined) parts.push(`errorCode=${ble.errorCode}`);
  if ((ble as any).iosErrorCode != null) parts.push(`ios=${(ble as any).iosErrorCode}`);
  if ((ble as any).androidErrorCode != null) parts.push(`android=${(ble as any).androidErrorCode}`);
  return parts.length > 0 ? parts.join(', ') : 'Unknown Bluetooth error';
}

/**
 * Events emitted by BleManager
 */
interface BleManagerEvents {
  stateChange: (state: State) => void;
  deviceDiscovered: (device: DiscoveredDevice) => void;
  deviceConnected: (deviceId: string) => void;
  deviceDisconnected: (deviceId: string, error?: Error) => void;
}

/**
 * Bluetooth Manager class - singleton wrapper around react-native-ble-plx
 */
export class BleManager extends EventEmitter<BleManagerEvents> {
  private manager: RNBleManager;
  private stateSubscription: Subscription | null = null;
  private disconnectSubscriptions: Map<string, Subscription> = new Map();
  private connectedDevices: Map<string, Device> = new Map();
  private discoveredDevices: Map<string, DiscoveredDevice> = new Map();
  private pendingConnects: Map<string, Promise<Device>> = new Map();
  private isScanning = false;
  private cachedState: State = State.Unknown;
  // Radio arbiter: the BLE adapter is a single shared resource. connect and
  // disconnect run exclusively through this FIFO chain so two never race on the
  // adapter at once — covering both the pairing path and the auto-reconnect
  // path, which would otherwise collide (concurrent connectToDevice on one slot
  // tears the connection down — the 2A26-read disconnect during pairing).
  private radioChain: Promise<unknown> = Promise.resolve();
  // True while a `user`-priority radio op is queued or running. The
  // auto-reconnect loop reads this to yield, so pairing/manual connect preempts
  // background reconnection rather than racing it.
  private userOpInFlight = false;

  constructor() {
    super();
    this.manager = new RNBleManager();
    this.setupStateListener();
  }

  /**
   * Set up Bluetooth state change listener
   */
  private setupStateListener(): void {
    this.stateSubscription = this.manager.onStateChange((state) => {
      log.debug('Bluetooth state changed', { state });
      this.cachedState = state;
      this.emit('stateChange', state);
    }, true);
  }

  /**
   * Get current Bluetooth state
   */
  async getState(): Promise<State> {
    const state = await this.manager.state();
    this.cachedState = state;
    return state;
  }

  /**
   * Get cached Bluetooth state (synchronous)
   */
  getCachedState(): State {
    return this.cachedState;
  }

  /**
   * Check if Bluetooth is ready for operations
   */
  async isReady(): Promise<boolean> {
    const state = await this.getState();
    return state === State.PoweredOn;
  }

  /**
   * Wait for Bluetooth to be ready
   */
  async waitForReady(timeoutMs: number = 10000): Promise<void> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const state = await this.getState();

      if (state === State.PoweredOn) {
        return;
      }

      if (state === State.Unsupported) {
        throw BluetoothError.unavailable();
      }

      if (state === State.Unauthorized) {
        throw BluetoothError.unauthorized();
      }

      if (state === State.PoweredOff) {
        throw BluetoothError.poweredOff();
      }

      // Wait a bit before checking again
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    throw new BluetoothError('Bluetooth did not become ready in time', 'TIMEOUT');
  }

  /**
   * Start scanning for Bota devices
   */
  async startScan(options: ScanOptions = {}): Promise<void> {
    if (this.isScanning) {
      log.warn('Scan already in progress');
      return;
    }

    await this.waitForReady();

    const {
      timeout = SCAN_TIMEOUT,
      deviceTypes,
      pairingState,
      minRssi,
      allowDuplicates = false,
    } = options;

    log.info('Starting Bluetooth scan', { timeout, deviceTypes, pairingState });

    this.discoveredDevices.clear();
    this.isScanning = true;

    // Set up timeout
    const scanTimeout = setTimeout(() => {
      this.stopScan();
    }, timeout);

    // Start scanning
    this.manager.startDeviceScan(
      null, // Scan all services
      { allowDuplicates },
      (error, device) => {
        if (error) {
          // Scan errors during reconnection are often transient - log as warning
          const errorDesc = describeBleError(error);
          log.warn(`Scan error: ${errorDesc}`, { error });
          this.stopScan();
          clearTimeout(scanTimeout);
          return;
        }

        // Prioritize localName (from current advertisement) over name (iOS cached)
        const deviceName = device?.localName || device?.name;

        if (!device || !deviceName) {
          return;
        }
        // TODO: Re-enable this filter after debugging
        // if (!deviceName.startsWith(DEVICE_NAME_PREFIX)) {
        //   return;
        // }

        // Parse device information from advertisement
        const discovered = this.parseDiscoveredDevice(device);
        if (!discovered) {
          return;
        }

        // Apply filters
        if (deviceTypes && !deviceTypes.includes(discovered.deviceType)) {
          return;
        }

        if (pairingState && discovered.pairingState !== pairingState) {
          return;
        }

        if (minRssi !== undefined && discovered.rssi < minRssi) {
          return;
        }

        // Check for duplicates
        const existingDevice = this.discoveredDevices.get(device.id);
        if (existingDevice && !allowDuplicates) {
          // Update RSSI and merge fields that may arrive in separate packets
          // (ADV_DATA has the name, SCAN_RSP has manufacturer data with MAC)
          existingDevice.rssi = discovered.rssi;
          if (discovered.macAddress) existingDevice.macAddress = discovered.macAddress;
          if (discovered.manufacturerData) existingDevice.manufacturerData = discovered.manufacturerData;
          return;
        }

        // Store and emit
        this.discoveredDevices.set(device.id, discovered);
        this.emit('deviceDiscovered', discovered);
      }
    );

    // iOS won't re-advertise a peripheral it has already auto-reconnected at
    // the system level (a bonded device). `startDeviceScan` therefore never
    // surfaces such a device, even though it's sitting right there connected
    // to the phone. Pull those in explicitly via the system-connected list so
    // the app can claim a device that's stuck "Connected" in iOS Settings.
    // Fire-and-forget: must not block scan start, and failures are non-fatal.
    void this.discoverSystemConnectedDevices(options);
  }

  /**
   * Surface Bota peripherals already connected at the OS level (e.g. a bonded
   * device iOS auto-reconnected). These never appear in `startDeviceScan`
   * because a connected peripheral stops advertising. We query the system for
   * peripherals exposing the Bota services and feed them through the same
   * discovery pipeline as scanned devices.
   *
   * No RSSI / manufacturer data is available for system-connected peripherals
   * (there's no live advertisement), so `minRssi` is intentionally not applied
   * here and device-type / pairing-state fall back to name inference.
   */
  private async discoverSystemConnectedDevices(
    options: ScanOptions
  ): Promise<void> {
    try {
      const connected = await this.manager.connectedDevices([
        SERVICE_BOTA_CONTROL,
        SERVICE_BOTA_PROVISIONING,
        SERVICE_BOTA_STORAGE,
      ]);

      // Always log — count=0 is the diagnostic signal that iOS isn't
      // reporting the device as a system-connected Bota peripheral (either
      // it's not connected, or iOS hasn't cached the Bota service UUIDs on
      // the bonded link).
      log.info('System-connected Bota query', {
        count: connected.length,
        devices: connected.map((d: Device) => ({ id: d.id, name: d.name })),
      });
      if (connected.length === 0) return;

      const { deviceTypes, pairingState } = options;

      for (const device of connected) {
        // A scan callback may have already surfaced this device.
        if (this.discoveredDevices.has(device.id)) continue;

        // System-connected peripherals carry no advertisement, so
        // parseDiscoveredDevice can fail (no localName/manufacturerData) and
        // iOS may not have cached `name` yet. Surface them anyway with a
        // fallback — the whole point is to let the app claim a device iOS is
        // holding hostage; the app can connect by id regardless of name.
        const discovered = this.parseDiscoveredDevice(device) ?? {
          id: device.id,
          name: device.name || 'Bota device',
          deviceType: 'bota_pin' as DeviceType,
          firmwareVersion: '0.0.0',
          macAddress: null,
          pairingState: 'unpaired' as PairingState,
          rssi: device.rssi ?? -100,
          manufacturerData: undefined,
          discoveredAt: new Date(),
        };

        if (deviceTypes && !deviceTypes.includes(discovered.deviceType)) continue;
        if (pairingState && discovered.pairingState !== pairingState) continue;

        log.info('Surfacing system-connected device', {
          id: discovered.id,
          name: discovered.name,
        });
        this.discoveredDevices.set(device.id, discovered);
        this.emit('deviceDiscovered', discovered);
      }
    } catch (e) {
      // Non-fatal: scan still proceeds with advertising devices.
      log.warn('Failed to query system-connected devices', {
        error: describeBleError(e as BleError),
      });
    }
  }

  /**
   * Stop scanning for devices
   */
  stopScan(): void {
    if (!this.isScanning) {
      return;
    }

    log.info('Stopping Bluetooth scan');
    this.manager.stopDeviceScan();
    this.isScanning = false;
  }

  /**
   * Get list of discovered devices
   */
  getDiscoveredDevices(): DiscoveredDevice[] {
    return Array.from(this.discoveredDevices.values());
  }

  /**
   * Parse a discovered device from Bluetooth advertisement data
   */
  private parseDiscoveredDevice(device: Device): DiscoveredDevice | null {
    // Prioritize localName (from current advertisement) over name (iOS cached)
    // iOS caches device names, so localName is more accurate for renamed devices
    const deviceName = device.localName || device.name;

    if (!deviceName) {
      return null;
    }

    // Parse manufacturer data if available
    let deviceType: DeviceType = 'bota_pin';
    let firmwareVersion = '0.0.0';
    let pairingState: PairingState = 'unpaired';
    let macAddress: string | null = null;
    let manufacturerData: Uint8Array | undefined;

    if (device.manufacturerData) {
      try {
        manufacturerData = Buffer.from(device.manufacturerData, 'base64');

        // Check for Bota manufacturer data format:
        // [company_id_lo(0x7A), company_id_hi(0xB0), mac[0..5]]
        if (manufacturerData.length >= 8 &&
            manufacturerData[0] === 0x7A && manufacturerData[1] === 0xB0) {
          // Parse MAC address (6 bytes after company ID)
          const mac = manufacturerData.slice(2, 8);
          macAddress = Array.from(mac)
            .map((b) => b.toString(16).padStart(2, '0').toUpperCase())
            .join(':');
        }

        // Legacy format (no company ID): [device_type, fw_major, fw_minor, pairing_state]
        if (!macAddress && manufacturerData.length >= 4) {
          deviceType = parseDeviceType(manufacturerData[0]);
          firmwareVersion = parseFirmwareVersion(manufacturerData[1], manufacturerData[2]);
          pairingState = parsePairingState(manufacturerData[3]);
        }
      } catch (e) {
        log.warn('Failed to parse manufacturer data', { deviceId: device.id });
      }
    }

    // Infer device type from name if not parsed from manufacturer data
    // Check Pin variants before Note — names like "Bota_notepin_xxx" contain both
    if (deviceType === 'bota_pin') {
      if (deviceName.includes('Pin4G') || deviceName.includes('pin4g') || deviceName.includes('pin_4g')) {
        deviceType = 'bota_pin_4g';
      } else if (deviceName.includes('Pin') || deviceName.includes('pin')) {
        deviceType = 'bota_pin';
      } else if (deviceName.includes('Note') || deviceName.includes('note')) {
        deviceType = 'bota_note';
      }
    }

    return {
      id: device.id,
      name: deviceName,
      deviceType,
      firmwareVersion,
      macAddress,
      pairingState,
      rssi: device.rssi ?? -100,
      manufacturerData,
      discoveredAt: new Date(),
    };
  }

  /**
   * Run a radio-exclusive operation through the arbiter chain so it never
   * overlaps another connect/disconnect on the single BLE adapter. A `user` op
   * marks {@link isUserOpInFlight} so background work yields until it settles.
   */
  private runExclusive<T>(priority: RadioPriority, fn: () => Promise<T>): Promise<T> {
    if (priority === 'user') this.userOpInFlight = true;
    const run = this.radioChain.catch(() => undefined).then(fn);
    // Keep the chain alive regardless of this op's outcome.
    this.radioChain = run.catch(() => undefined);
    if (priority === 'user') {
      run.finally(() => { this.userOpInFlight = false; }).catch(() => undefined);
    }
    return run;
  }

  /** True while a user-initiated connect/disconnect is queued or running. */
  isUserOpInFlight(): boolean {
    return this.userOpInFlight;
  }

  /**
   * Connect to a device.
   * Deduplicates concurrent calls — if a connect is already in progress
   * for this device, callers share the same promise. Runs through the radio
   * arbiter so it never races another connect/disconnect on the adapter.
   *
   * @param priority `user` (default) for pairing/manual connect; `background`
   *   for auto-reconnect probes, which yield to user operations.
   */
  async connect(deviceId: string, priority: RadioPriority = 'user'): Promise<Device> {
    // Check if already connected
    if (this.connectedDevices.has(deviceId)) {
      log.debug('Device already connected', { deviceId });
      return this.connectedDevices.get(deviceId)!;
    }

    // Deduplicate: if a connect is already in progress, return the same promise
    const pending = this.pendingConnects.get(deviceId);
    if (pending) {
      log.debug('Connection already in progress, sharing promise', { deviceId });
      return pending;
    }

    const connectPromise = this.runExclusive(priority, () => this.doConnect(deviceId, priority));
    this.pendingConnects.set(deviceId, connectPromise);

    try {
      return await connectPromise;
    } finally {
      this.pendingConnects.delete(deviceId);
    }
  }

  private async doConnect(deviceId: string, priority: RadioPriority): Promise<Device> {
    log.info('Connecting to device', { deviceId });

    // Stop any in-flight scan before connecting. On iOS a running scan can
    // cancel an outgoing connection, so a connect always claims the radio from
    // any background reconnect scan first (no-ops if not scanning).
    this.stopScan();

    try {
      // Cancel any stale connection first (iOS may cache disconnected state
      // after supervision timeout, preventing a fresh connect). Skip on
      // `background` priority (auto-reconnect): that path arrives via a clean
      // device-side disconnect → re-advertise cycle, so there is no stale
      // iOS state to flush, and the call itself burns 2-3s on iOS even when
      // it's a no-op. Measured connect-phase savings: ~25%.
      if (priority === 'user') {
        try { await this.manager.cancelDeviceConnection(deviceId); } catch { /* ignore */ }
      }

      // Connect with timeout
      const device = await this.manager.connectToDevice(deviceId, {
        timeout: CONNECTION_TIMEOUT,
        requestMTU: MAX_MTU,
      });

      log.debug('Device connected, discovering services', { deviceId });

      // Discover services and characteristics
      await device.discoverAllServicesAndCharacteristics();

      // Store connected device
      this.connectedDevices.set(deviceId, device);

      // Set up disconnect listener
      const disconnectSub = device.onDisconnected((error, disconnectedDevice) => {
        const errorMsg = error ? describeBleError(error) : undefined;
        log.info('Device disconnected', {
          deviceId: disconnectedDevice.id,
          error: errorMsg,
        });
        this.connectedDevices.delete(disconnectedDevice.id);
        this.disconnectSubscriptions.get(disconnectedDevice.id)?.remove();
        this.disconnectSubscriptions.delete(disconnectedDevice.id);
        this.emit(
          'deviceDisconnected',
          disconnectedDevice.id,
          error ? new Error(errorMsg || 'Device disconnected') : undefined
        );
      });
      this.disconnectSubscriptions.set(deviceId, disconnectSub);

      this.emit('deviceConnected', deviceId);
      return device;
    } catch (error) {
      const msg = describeBleError(error as BleError);
      log.error('Connection failed', new Error(msg), { deviceId });
      throw DeviceError.connectionFailed(deviceId, new Error(msg));
    }
  }

  /**
   * Disconnect from a device. Runs through the radio arbiter so it serializes
   * against connects rather than tearing down a slot another op is using.
   *
   * @param priority `background` for auto-reconnect probe releases; `user`
   *   (default) for user-initiated disconnects.
   */
  async disconnect(deviceId: string, priority: RadioPriority = 'user'): Promise<void> {
    return this.runExclusive(priority, () => this.doDisconnect(deviceId));
  }

  private async doDisconnect(deviceId: string): Promise<void> {
    log.info('Disconnecting from device', { deviceId });

    const device = this.connectedDevices.get(deviceId);
    if (!device) {
      log.warn('Device not found in connected devices', { deviceId });
      return;
    }

    try {
      await device.cancelConnection();
    } catch (error) {
      log.warn('Disconnect error (may be expected)', { error: describeBleError(error as BleError) });
    }

    this.connectedDevices.delete(deviceId);
    this.disconnectSubscriptions.get(deviceId)?.remove();
    this.disconnectSubscriptions.delete(deviceId);
  }

  /**
   * Check if a device is connected
   */
  isConnected(deviceId: string): boolean {
    return this.connectedDevices.has(deviceId);
  }

  /**
   * Check if a connected device has a specific Bluetooth service
   */
  async hasService(deviceId: string, serviceUuid: string): Promise<boolean> {
    const device = this.connectedDevices.get(deviceId);
    if (!device) {
      log.warn('hasService: device not in connectedDevices', { deviceId });
      return false;
    }

    try {
      const services = await device.services();
      const serviceUuids = services.map(s => s.uuid);
      const found = services.some(s => s.uuid.toUpperCase() === serviceUuid.toUpperCase());
      log.info('hasService check', {
        deviceId,
        targetService: serviceUuid,
        discoveredServices: serviceUuids,
        found,
      });
      return found;
    } catch (error) {
      log.error('hasService failed', error as Error, { deviceId, serviceUuid });
      return false;
    }
  }

  /**
   * Get a connected device
   */
  getConnectedDevice(deviceId: string): Device | undefined {
    return this.connectedDevices.get(deviceId);
  }

  /**
   * Get negotiated MTU for a device.
   *
   * react-native-ble-plx captures `device.mtu` at the moment connectToDevice
   * resolves, which on iOS happens BEFORE the async ATT-MTU exchange
   * completes. The cached value stays at the BLE default (23) even after the
   * peripheral has negotiated up to its real maximum (e.g. 509 on JieLi).
   * Re-querying the Device through `manager.devices([id])` returns a fresh
   * object reflecting the current MTU. Falls back to the cached value if the
   * refresh fails. Polls briefly because the negotiation can lag the connect
   * by ~1 s; chunked writes that read MTU=23 explode into 200+ chunks and
   * pairing crawls.
   */
  async getMtu(deviceId: string): Promise<number> {
    const cached = this.connectedDevices.get(deviceId);
    if (!cached) {
      return DEFAULT_MTU;
    }

    // Poll for up to ~2 s for the negotiated MTU to settle above default.
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        const [fresh] = await this.manager.devices([deviceId]);
        const mtu = fresh?.mtu ?? cached.mtu ?? DEFAULT_MTU;
        if (mtu > DEFAULT_MTU) {
          return mtu;
        }
      } catch {
        // ignore — fall through to retry or default
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    // Settle for whatever the latest read returned, even if still default.
    try {
      const [fresh] = await this.manager.devices([deviceId]);
      return fresh?.mtu ?? cached.mtu ?? DEFAULT_MTU;
    } catch {
      return cached.mtu ?? DEFAULT_MTU;
    }
  }

  /**
   * Read a characteristic value
   */
  async readCharacteristic(
    deviceId: string,
    serviceUuid: string,
    characteristicUuid: string
  ): Promise<Buffer> {
    const device = this.connectedDevices.get(deviceId);
    if (!device) {
      throw DeviceError.notConnected(deviceId);
    }

    // [STATUS-LATENCY] Mark BLE reads in flight so a delayed status notify can
    // be correlated with concurrent on-link traffic (the suspected cause of the
    // intermittent record-start latency). Temporary instrumentation.
    log.debug('[STATUS-LATENCY] read start', { deviceId, characteristicUuid, t: Date.now() });
    try {
      const characteristic = await device.readCharacteristicForService(
        serviceUuid,
        characteristicUuid
      );

      log.debug('[STATUS-LATENCY] read end', { deviceId, characteristicUuid, t: Date.now() });
      if (!characteristic.value) {
        return Buffer.alloc(0);
      }

      return Buffer.from(characteristic.value, 'base64');
    } catch (error) {
      const msg = describeBleError(error as BleError);
      log.debug('Read characteristic failed', { deviceId, characteristicUuid, reason: msg });
      throw new DeviceError(
        `Failed to read characteristic: ${msg}`,
        'READ_FAILED',
        deviceId,
        new Error(msg)
      );
    }
  }

  /**
   * Write a characteristic value
   */
  async writeCharacteristic(
    deviceId: string,
    serviceUuid: string,
    characteristicUuid: string,
    data: Buffer,
    withResponse: boolean = true
  ): Promise<void> {
    const device = this.connectedDevices.get(deviceId);
    if (!device) {
      throw DeviceError.notConnected(deviceId);
    }

    const base64Data = data.toString('base64');

    // [STATUS-LATENCY] Mark BLE writes in flight — host write bursts are the
    // prime suspect for stalling an inbound status notify (iOS write/notify
    // arbitration). Correlate with '[STATUS-LATENCY] notify arrived'. Temporary.
    log.debug('[STATUS-LATENCY] write start', { deviceId, characteristicUuid, withResponse, t: Date.now() });
    try {
      if (withResponse) {
        await device.writeCharacteristicWithResponseForService(
          serviceUuid,
          characteristicUuid,
          base64Data
        );
      } else {
        await device.writeCharacteristicWithoutResponseForService(
          serviceUuid,
          characteristicUuid,
          base64Data
        );
      }
      log.debug('[STATUS-LATENCY] write end', { deviceId, characteristicUuid, t: Date.now() });
    } catch (error) {
      const msg = describeBleError(error as BleError);
      log.error('Write characteristic failed', new Error(msg), {
        deviceId,
        serviceUuid,
        characteristicUuid,
      });
      throw new DeviceError(
        `Failed to write characteristic: ${msg}`,
        'WRITE_FAILED',
        deviceId,
        new Error(msg)
      );
    }
  }

  /**
   * Subscribe to characteristic notifications
   */
  subscribeToCharacteristic(
    deviceId: string,
    serviceUuid: string,
    characteristicUuid: string,
    onData: (data: Buffer) => void,
    onError?: (error: Error) => void
  ): Subscription {
    const device = this.connectedDevices.get(deviceId);
    if (!device) {
      throw DeviceError.notConnected(deviceId);
    }

    const charShort = characteristicUuid.split('-')[1] || characteristicUuid;
    log.debug('Subscribe start', { charShort });

    return device.monitorCharacteristicForService(
      serviceUuid,
      characteristicUuid,
      (error, characteristic) => {
        if (error) {
          const errorMessage = error.message || 'Unknown Bluetooth error';
          log.debug('Subscription ended', { deviceId, charShort, reason: errorMessage });
          onError?.(new Error(errorMessage));
          return;
        }

        // Debug: log every callback invocation
        log.debug('Notify cb', {
          charShort,
          hasChar: !!characteristic,
          hasValue: !!characteristic?.value,
          valueLen: characteristic?.value?.length ?? 0,
        });

        if (characteristic?.value) {
          const data = Buffer.from(characteristic.value, 'base64');
          log.debug('Notify data', {
            charShort,
            len: data.length,
            first: data.length > 0 ? data[0].toString(16) : '-',
          });
          onData(data);
        }
      }
    );
  }

  /**
   * Destroy the Bluetooth manager and clean up resources
   */
  destroy(): void {
    log.info('Destroying Bluetooth manager');

    this.stopScan();

    // Remove all disconnect subscriptions
    for (const sub of this.disconnectSubscriptions.values()) {
      sub.remove();
    }
    this.disconnectSubscriptions.clear();

    // Disconnect all devices
    for (const deviceId of this.connectedDevices.keys()) {
      this.disconnect(deviceId).catch(() => {});
    }
    this.connectedDevices.clear();

    // Remove state subscription
    this.stateSubscription?.remove();
    this.stateSubscription = null;

    // Destroy the manager
    this.manager.destroy();

    this.removeAllListeners();
  }
}

/**
 * Singleton instance
 */
let instance: BleManager | null = null;

/**
 * Get or create the Bluetooth manager singleton
 */
export function getBleManager(): BleManager {
  if (!instance) {
    instance = new BleManager();
  }
  return instance;
}

/**
 * Reset the Bluetooth manager singleton (for testing)
 */
export function resetBleManager(): void {
  if (instance) {
    instance.destroy();
    instance = null;
  }
}
